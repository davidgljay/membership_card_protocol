/**
 * In-process dispatcher for the routes the client-sdk talks to through
 * the oblivious path (client-sdk implementation plan Step 1.4c). Maps a
 * decapsulated `OhttpEnvelope` ({ path, method, body }) to the same plain
 * handler function the corresponding plaintext route calls — a direct
 * function call, not a second HTTP round-trip.
 *
 * Only these endpoints are reachable through the gateway; anything else is
 * rejected (404-equivalent) rather than silently forwarded. The keyring
 * rotation endpoints (challenge + PUT) are included alongside account
 * creation because `setupWallet`/`recoverWallet` call them immediately
 * after account creation over the same transport — leaving them
 * gateway-unreachable would make that one follow-up call reveal the
 * caller's IP correlated with `card_hash`, defeating the point of routing
 * the rest of account setup obliviously.
 *
 * Every handler returns a `{ ok: true, ... } | { ok: false, statusCode,
 * statusMessage }` outcome (see accounts-challenge.ts's doc for why —
 * these modules avoid Nitro's createError/enforceRateLimit, which aren't
 * available under plain vitest). This dispatcher folds every handler's
 * ok/fail outcome into one `OhttpResponseEnvelope` shape uniformly,
 * mirroring exactly what each plaintext route does with the same outcome
 * (translate ok:false into an HTTP error status).
 */

import type { Pool } from 'pg';
import { loadConfig } from './config.js';
import { handleAccountsChallenge } from './routes/accounts-challenge.js';
import { handleAccountsCreate, type RawCreateAccountBody } from './routes/accounts-create.js';
import { handleKeyringsGet } from './routes/keyrings-get.js';
import { handleKeyringChallenge } from './routes/keyring-challenge.js';
import { handleKeyringUpdate, type KeyringUpdateBody } from './routes/keyring-put.js';
import { handleMessagesCreate, type RawRoutingEnvelopeBody } from './routes/messages-create.js';
import {
  handleUuidRegistration,
  type RawUuidRegistrationBody,
} from './routes/subcard-uuid-registration.js';
import {
  handleSubcardDeregistration,
  type RawSubcardDeregistrationBody,
} from './routes/subcard-deregistration.js';
import type { OhttpEnvelope, OhttpResponseEnvelope } from './ohttp-gateway.js';

export interface DispatchContext {
  pool: Pool;
  ip: string;
}

function decodeBody<T>(body: string | undefined): T | undefined {
  if (!body) return undefined;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as T;
}

function encodeBody(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  return Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url');
}

function ok(status: number, body: unknown): OhttpResponseEnvelope {
  const encoded = encodeBody(body);
  return encoded === undefined ? { status, headers: {} } : { status, headers: {}, body: encoded };
}

function fail(statusCode: number, statusMessage: string): OhttpResponseEnvelope {
  return ok(statusCode, { error: statusMessage });
}

/** Matches `/cards/{card_hash}/subcards/{subcard_hash}(/uuids)?` and extracts the two hash params. */
function matchSubcardPath(path: string): { cardHash: string; subcardHash: string; uuids: boolean } | null {
  const match = /^\/cards\/([^/]+)\/subcards\/([^/]+)(\/uuids)?$/.exec(path);
  if (!match) return null;
  return { cardHash: match[1]!, subcardHash: match[2]!, uuids: !!match[3] };
}

function matchKeyringPath(path: string): { keyringId: string } | null {
  const match = /^\/keyrings\/([^/]+)$/.exec(path);
  if (!match) return null;
  return { keyringId: match[1]! };
}

/** Matches `/accounts/{card_hash}/keyring/challenge`. */
function matchKeyringChallengePath(path: string): { cardHash: string } | null {
  const match = /^\/accounts\/([^/]+)\/keyring\/challenge$/.exec(path);
  if (!match) return null;
  return { cardHash: match[1]! };
}

/** Matches `/accounts/{card_hash}/keyring`. */
function matchAccountKeyringPath(path: string): { cardHash: string } | null {
  const match = /^\/accounts\/([^/]+)\/keyring$/.exec(path);
  if (!match) return null;
  return { cardHash: match[1]! };
}

export async function dispatch(
  envelope: OhttpEnvelope,
  ctx: DispatchContext
): Promise<OhttpResponseEnvelope> {
  const { pool, ip } = ctx;
  const config = loadConfig();

  if (envelope.method === 'POST' && envelope.path === '/accounts/challenge') {
    const outcome = await handleAccountsChallenge({ pool, ip });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(200, { challenge: outcome.challenge, expires_at: outcome.expires_at });
  }

  if (envelope.method === 'POST' && envelope.path === '/accounts') {
    const rawBody = decodeBody<RawCreateAccountBody>(envelope.body);
    const outcome = await handleAccountsCreate({ pool, config, ip, rawBody });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    const { ok: _ok, ...body } = outcome;
    return ok(200, body);
  }

  const keyringMatch = envelope.method === 'GET' ? matchKeyringPath(envelope.path) : null;
  if (keyringMatch) {
    const outcome = await handleKeyringsGet({ pool, keyringId: keyringMatch.keyringId });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(200, { encrypted_blob: outcome.encrypted_blob });
  }

  const keyringChallengeMatch = envelope.method === 'POST' ? matchKeyringChallengePath(envelope.path) : null;
  if (keyringChallengeMatch) {
    const outcome = await handleKeyringChallenge({ pool, cardHash: keyringChallengeMatch.cardHash });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(200, { challenge: outcome.challenge, expires_at: outcome.expires_at });
  }

  const accountKeyringMatch = envelope.method === 'PUT' ? matchAccountKeyringPath(envelope.path) : null;
  if (accountKeyringMatch) {
    const rawBody = decodeBody<KeyringUpdateBody>(envelope.body);
    const outcome = await handleKeyringUpdate({ pool, cardHash: accountKeyringMatch.cardHash, body: rawBody });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(200, { service_secret: outcome.service_secret, keyring_id: outcome.keyring_id });
  }

  if (envelope.method === 'POST' && envelope.path === '/messages') {
    const rawBody = decodeBody<RawRoutingEnvelopeBody>(envelope.body);
    const outcome = await handleMessagesCreate({ pool, config, rawBody });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(outcome.status, outcome.body);
  }

  const subcardMatch = matchSubcardPath(envelope.path);
  if (subcardMatch && subcardMatch.uuids && envelope.method === 'POST') {
    const rawBody = decodeBody<RawUuidRegistrationBody>(envelope.body);
    const outcome = await handleUuidRegistration({
      pool,
      config,
      cardHashParam: subcardMatch.cardHash,
      subcardHashParam: subcardMatch.subcardHash,
      rawBody,
    });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(204, null);
  }

  if (subcardMatch && !subcardMatch.uuids && envelope.method === 'DELETE') {
    const rawBody = decodeBody<RawSubcardDeregistrationBody>(envelope.body);
    const outcome = await handleSubcardDeregistration({
      pool,
      config,
      cardHashParam: subcardMatch.cardHash,
      subcardHashParam: subcardMatch.subcardHash,
      rawBody,
    });
    if (!outcome.ok) return fail(outcome.statusCode, outcome.statusMessage);
    return ok(204, null);
  }

  return fail(404, `Not reachable through the OHTTP gateway: ${envelope.method} ${envelope.path}`);
}
