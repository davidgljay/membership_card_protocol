/**
 * Request-orchestration logic for DELETE
 * /cards/{card_hash}/subcards/{subcard_hash}
 * (notification_relay.md v0.9 §Multi-Device Support "Deregistration").
 *
 * Prior to this, DELETE had zero authentication: anyone who knew a
 * card_hash/subcard_hash pair could wipe a legitimate device's UUID pool
 * (a denial-of-service against that device's message delivery until it
 * happened to re-register). This mirrors ../routes/subcard-uuid-registration.ts's
 * verification pipeline exactly — path/payload match, timestamp window,
 * on-chain pubkey resolution + binding check, signature verification,
 * nonce replay — with one shape difference: the signed payload has no
 * `uuids` field, since deregistration doesn't carry a UUID list, it just
 * proves control of the sub-card key.
 *
 * Factored out of server/routes/.../index.delete.ts for the same reason
 * subcard-uuid-registration.ts is factored out of uuids.post.ts: it's
 * plain async logic with no H3 dependency, directly unit-testable (see
 * wallet-service/test/subcard-deregistration.test.ts), matching this
 * codebase's convention of testing logic modules rather than route files.
 *
 * IMPORTANT — this endpoint's authentication is intentionally decoupled
 * from on-chain sub-card revocation: a signed deregistration request is
 * accepted purely on proof of sub-card key control, regardless of the
 * on-chain SubCardEntry.active flag. Deregistering here never sets
 * `active` and never affects message deliverability beyond emptying this
 * wallet-service instance's local UUID pool — the sub-card can always
 * re-register UUIDs afterward (POST .../uuids) and resume receiving
 * messages normally. See ../auth/subcard-uuid-signature.ts's
 * resolveSubcardPubkey doc comment for the full on-chain-revocation-vs-
 * local-deregistration rationale, which applies identically here.
 */

import type { Pool } from 'pg';
import { subcardHasAnyHistory, consumeAllForSubcard } from '../../server/db/uuid-pools.js';
import { recordSubcardActionNonceIfNew } from '../../server/db/subcard-action-nonces.js';
import type { WalletServiceConfig } from '../config.js';
import {
  verifySubcardDeregistrationEnvelope,
  type SubcardDeregistrationEnvelope,
} from '../auth/subcard-deregistration-signature.js';
import type { SubcardRegistryClient } from '../chain/subcard-registry.js';
import { HEX32_RE, TIMESTAMP_WINDOW_MS } from './subcard-uuid-registration.js';

export interface RawSubcardDeregistrationBody {
  payload?: {
    card_hash?: unknown;
    subcard_hash?: unknown;
    timestamp?: unknown;
    nonce?: unknown;
  };
  signature?: unknown;
}

/** Validates and narrows a raw request body to a SubcardDeregistrationEnvelope, or returns null. */
export function parseSubcardDeregistrationEnvelope(
  body: RawSubcardDeregistrationBody | null | undefined
): SubcardDeregistrationEnvelope | null {
  if (!body || typeof body !== 'object') return null;
  const { payload, signature } = body;
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string' || signature.length === 0) {
    return null;
  }
  const { card_hash, subcard_hash, timestamp, nonce } = payload;
  if (typeof card_hash !== 'string' || card_hash.length === 0) return null;
  if (typeof subcard_hash !== 'string' || subcard_hash.length === 0) return null;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;

  return {
    payload: { card_hash, subcard_hash, timestamp, nonce },
    signature,
  };
}

export type SubcardDeregistrationOutcome =
  | { ok: true }
  | { ok: false; statusCode: 400 | 401 | 403 | 404; statusMessage: string };

/**
 * Runs the signed-envelope verification pipeline and, if it all passes,
 * performs the original deregistration behavior (mark this
 * wallet-service instance's UUID pool for the subcard fully consumed).
 * Pure of any H3/Nitro dependency — takes an already-resolved
 * Pool/config/registryClient so tests can inject fakes/mocks, matching
 * handleUuidRegistration's shape.
 */
export async function handleSubcardDeregistration(params: {
  pool: Pool;
  config: WalletServiceConfig;
  cardHashParam: string | undefined;
  subcardHashParam: string | undefined;
  rawBody: RawSubcardDeregistrationBody | null | undefined;
  registryClient?: SubcardRegistryClient;
}): Promise<SubcardDeregistrationOutcome> {
  const { pool, config, cardHashParam, subcardHashParam, rawBody, registryClient } = params;

  if (!cardHashParam || !subcardHashParam) {
    return { ok: false, statusCode: 400, statusMessage: 'card_hash and subcard_hash are required.' };
  }
  if (!HEX32_RE.test(subcardHashParam)) {
    return { ok: false, statusCode: 400, statusMessage: 'subcard_hash must be a 0x-prefixed 32-byte hex string.' };
  }

  const envelope = parseSubcardDeregistrationEnvelope(rawBody);
  if (!envelope) {
    return {
      ok: false,
      statusCode: 400,
      statusMessage:
        'Request body must be a signed envelope: { payload: { card_hash, subcard_hash, timestamp, nonce }, signature }.',
    };
  }

  // Path/payload param match — prevents a signed envelope for one subcard
  // being replayed against another's URL.
  if (envelope.payload.card_hash.toLowerCase() !== cardHashParam.toLowerCase()) {
    return { ok: false, statusCode: 403, statusMessage: 'payload.card_hash does not match the request path.' };
  }
  if (envelope.payload.subcard_hash.toLowerCase() !== subcardHashParam.toLowerCase()) {
    return { ok: false, statusCode: 403, statusMessage: 'payload.subcard_hash does not match the request path.' };
  }

  // Replay protection: timestamp window. Same 5-minute window as
  // registration (TIMESTAMP_WINDOW_MS, imported from
  // subcard-uuid-registration.ts) for consistency — there's no reason for
  // the two envelope types to tolerate different clock skew/latency.
  const requestTime = Date.parse(envelope.payload.timestamp);
  if (Number.isNaN(requestTime) || Math.abs(Date.now() - requestTime) > TIMESTAMP_WINDOW_MS) {
    return {
      ok: false,
      statusCode: 401,
      statusMessage: 'timestamp is missing, invalid, or outside the allowed window.',
    };
  }

  // Resolve on-chain pubkey, confirm keccak256(pubkey) == subcard_hash,
  // verify the ML-DSA-44 signature. Deliberately does not consult
  // SubCardEntry.active — see this module's top-of-file comment.
  const verification = await verifySubcardDeregistrationEnvelope(config, envelope, registryClient);
  if (!verification.ok) {
    return { ok: false, statusCode: 401, statusMessage: `Invalid signed envelope: ${verification.reason}.` };
  }

  // Replay protection: nonce, scoped per (subcard_hash, action) — action
  // 'deregister' here keeps this nonce space disjoint from registration's
  // 'register' nonces for the same subcard_hash (server/db/subcard-action-nonces.ts).
  // Checked only after signature verification succeeds, so an attacker
  // without a valid signature can't burn a legitimate future nonce via
  // probing.
  const nonceIsNew = await recordSubcardActionNonceIfNew(pool, subcardHashParam, 'deregister', envelope.payload.nonce);
  if (!nonceIsNew) {
    return { ok: false, statusCode: 401, statusMessage: 'nonce has already been used for this sub-card.' };
  }

  // Only after all checks pass: original deregistration behavior,
  // unchanged from ea7ce3b1's predecessor (implementation-plan.md §Step
  // 5.2) — 404 if this subcard was never registered at all, otherwise
  // mark every UUID for it consumed.
  const everRegistered = await subcardHasAnyHistory(pool, cardHashParam, subcardHashParam);
  if (!everRegistered) {
    return { ok: false, statusCode: 404, statusMessage: 'Subcard not registered.' };
  }

  await consumeAllForSubcard(pool, cardHashParam, subcardHashParam);

  console.info(`[wallet-service] subcard uuid pool deregistered card_hash=${cardHashParam}`);

  return { ok: true };
}
