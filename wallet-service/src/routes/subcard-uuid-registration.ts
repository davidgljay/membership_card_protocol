/**
 * Request-orchestration logic for POST
 * /cards/{card_hash}/subcards/{subcard_hash}/uuids
 * (notification_relay.md v0.9 §Process 1 steps 6-8; security-audit
 * finding (a), implementation-plan.md §Step 2.7).
 *
 * Factored out of server/routes/.../uuids.post.ts so it's testable without
 * an H3Event — the wallet-service test suite has no H3-mocking convention
 * (see wallet-service/test/binding.test.ts, uuid-pools-registration.test.ts:
 * tests import logic modules directly, not route files, since route files
 * depend on Nitro's build-time auto-imports for defineEventHandler/
 * getRouterParam/readBody/etc., which aren't available under plain
 * vitest). The route handler is now a thin H3 adapter around
 * handleUuidRegistration below.
 *
 * See ../routes/subcard-deregistration.ts for the sibling DELETE flow,
 * which shares this module's nonce table (server/db/subcard-action-nonces.ts,
 * scoped by an `action` column) and the same resolveSubcardPubkey
 * (../auth/subcard-uuid-signature.ts) — see that module's doc comment for
 * why neither flow gates on SubCardEntry.active.
 */

import type { Pool } from 'pg';
import { registerUuids } from '../../server/db/uuid-pools.js';
import { findUnclearedMessagesForSubcard } from '../../server/db/messages.js';
import { deliverMessage } from '../../server/utils/message-delivery.js';
import { recordSubcardActionNonceIfNew } from '../../server/db/subcard-action-nonces.js';
import type { WalletServiceConfig } from '../config.js';
import { verifyUuidRegistrationEnvelope, type UuidRegistrationEnvelope } from '../auth/subcard-uuid-signature.js';
import type { SubcardRegistryClient } from '../chain/subcard-registry.js';

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

// Replay window: rejects timestamps more than 5 minutes from now in either
// direction. No pre-existing global convention for this exact concern was
// found elsewhere in the codebase (routing_nonces' 24h figure is a nonce
// *retention* window, not a request-timestamp tolerance) — 5 minutes is
// the task's own suggested default and is generous enough for normal
// clock skew/network latency while still bounding replay usefully.
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export interface RawUuidRegistrationBody {
  payload?: {
    card_hash?: unknown;
    subcard_hash?: unknown;
    uuids?: unknown;
    timestamp?: unknown;
    nonce?: unknown;
  };
  signature?: unknown;
}

/** Validates and narrows a raw request body to a UuidRegistrationEnvelope, or returns null. Deliberately does not fall back to the old bare-array shape. */
export function parseUuidRegistrationEnvelope(
  body: RawUuidRegistrationBody | null | undefined
): UuidRegistrationEnvelope | null {
  if (!body || typeof body !== 'object') return null;
  const { payload, signature } = body;
  if (!payload || typeof payload !== 'object' || typeof signature !== 'string' || signature.length === 0) {
    return null;
  }
  const { card_hash, subcard_hash, uuids, timestamp, nonce } = payload;
  if (typeof card_hash !== 'string' || card_hash.length === 0) return null;
  if (typeof subcard_hash !== 'string' || subcard_hash.length === 0) return null;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  if (!Array.isArray(uuids) || uuids.length === 0 || uuids.length > 100) return null;
  if (!uuids.every((u) => typeof u === 'string' && UUID_V4_RE.test(u))) return null;

  return {
    payload: { card_hash, subcard_hash, uuids, timestamp, nonce },
    signature,
  };
}

export type UuidRegistrationOutcome =
  | { ok: true; registeredCount: number; retransmittedCount: number }
  | { ok: false; statusCode: 400 | 401 | 403; statusMessage: string };

/**
 * Runs every check from notification_relay.md v0.9 §Process 1 steps 6-8
 * and, if they all pass, performs the original registration +
 * retransmission behavior. Pure of any H3/Nitro dependency — takes an
 * already-resolved Pool/config/registryClient so tests can inject
 * fakes/mocks the same way press/test/unit/gas.test.ts injects a fake
 * RegistryClient.
 */
export async function handleUuidRegistration(params: {
  pool: Pool;
  config: WalletServiceConfig;
  cardHashParam: string | undefined;
  subcardHashParam: string | undefined;
  rawBody: RawUuidRegistrationBody | null | undefined;
  registryClient?: SubcardRegistryClient;
}): Promise<UuidRegistrationOutcome> {
  const { pool, config, cardHashParam, subcardHashParam, rawBody, registryClient } = params;

  if (!cardHashParam || !subcardHashParam) {
    return { ok: false, statusCode: 400, statusMessage: 'card_hash and subcard_hash are required.' };
  }
  if (!HEX32_RE.test(subcardHashParam)) {
    return { ok: false, statusCode: 400, statusMessage: 'subcard_hash must be a 0x-prefixed 32-byte hex string.' };
  }

  const envelope = parseUuidRegistrationEnvelope(rawBody);
  if (!envelope) {
    return {
      ok: false,
      statusCode: 400,
      statusMessage:
        'Request body must be a signed envelope: { payload: { card_hash, subcard_hash, uuids, timestamp, nonce }, signature }.',
    };
  }

  // Step 2: payload params must match the route's path params — prevents a
  // signed envelope for one subcard being replayed against another's URL.
  if (envelope.payload.card_hash.toLowerCase() !== cardHashParam.toLowerCase()) {
    return { ok: false, statusCode: 403, statusMessage: 'payload.card_hash does not match the request path.' };
  }
  if (envelope.payload.subcard_hash.toLowerCase() !== subcardHashParam.toLowerCase()) {
    return { ok: false, statusCode: 403, statusMessage: 'payload.subcard_hash does not match the request path.' };
  }

  // Replay protection: timestamp window.
  const requestTime = Date.parse(envelope.payload.timestamp);
  if (Number.isNaN(requestTime) || Math.abs(Date.now() - requestTime) > TIMESTAMP_WINDOW_MS) {
    return {
      ok: false,
      statusCode: 401,
      statusMessage: 'timestamp is missing, invalid, or outside the allowed window.',
    };
  }

  // Steps 3-5: resolve on-chain pubkey, confirm keccak256(pubkey) ==
  // subcard_hash, verify the ML-DSA-44 signature.
  const verification = await verifyUuidRegistrationEnvelope(config, envelope, registryClient);
  if (!verification.ok) {
    return { ok: false, statusCode: 401, statusMessage: `Invalid signed envelope: ${verification.reason}.` };
  }

  // Replay protection: nonce, scoped per (subcard_hash, action). Checked
  // only after signature verification succeeds, so an attacker without a
  // valid signature can't burn a legitimate future nonce via probing.
  const nonceIsNew = await recordSubcardActionNonceIfNew(pool, subcardHashParam, 'register', envelope.payload.nonce);
  if (!nonceIsNew) {
    return { ok: false, statusCode: 401, statusMessage: 'nonce has already been used for this sub-card.' };
  }

  // Only after all checks pass: original registration + retransmission
  // logic, unchanged.
  const uuids = envelope.payload.uuids;
  await registerUuids(pool, cardHashParam, subcardHashParam, uuids);

  const uncleared = await findUnclearedMessagesForSubcard(pool, cardHashParam, subcardHashParam);
  for (const message of uncleared) {
    await deliverMessage(pool, message);
  }

  console.info(
    `[wallet-service] uuids registered card_hash=${cardHashParam} count=${uuids.length} retransmitted=${uncleared.length}`
  );

  return { ok: true, registeredCount: uuids.length, retransmittedCount: uncleared.length };
}
