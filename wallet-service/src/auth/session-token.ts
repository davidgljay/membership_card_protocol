/**
 * sessionTokenAuth (implementation-plan.md §Step 1.4, §Step 2.1).
 *
 * Tokens are HMAC-SHA256 over a JSON payload `{ card_hash, issued_at,
 * expires_at }`, 15-minute TTL. Format: base64url(payload).base64url(hmac).
 * Revocation is checked against the KvStore (session_token_id = sha256 of
 * the full token, never the token itself — see audit logging prohibitions
 * in implementation-plan.md §Step 6.2).
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { KvStore } from '../kv.js';
import { kvKeys } from '../kv.js';

const SESSION_TTL_SECONDS = 15 * 60;

export interface SessionTokenPayload {
  card_hash: string;
  issued_at: number;
  expires_at: number;
}

export interface SessionTokenResult {
  token: string;
  payload: SessionTokenPayload;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function sessionTokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSessionToken(cardHash: string, secret: string): SessionTokenResult {
  const issuedAt = Date.now();
  const payload: SessionTokenPayload = {
    card_hash: cardHash,
    issued_at: issuedAt,
    expires_at: issuedAt + SESSION_TTL_SECONDS * 1000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(payloadB64, secret);
  return { token: `${payloadB64}.${sig}`, payload };
}

export type SessionTokenVerifyResult =
  | { ok: true; payload: SessionTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'revoked' };

export async function verifySessionToken(
  token: string,
  secret: string,
  kv: KvStore
): Promise<SessionTokenVerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts as [string, string];

  const expectedSig = sign(payloadB64, secret);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.card_hash !== 'string' || typeof payload.expires_at !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.expires_at < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  const revoked = await kv.getItem<boolean>(kvKeys.sessionRevoked(sessionTokenId(token)));
  if (revoked) {
    return { ok: false, reason: 'revoked' };
  }

  // Bulk invalidation cutoff (Step 2.4: keyring rotation invalidates every
  // session token issued before the rotation, without needing to know
  // their individual hashes).
  const cutoff = await kv.getItem<number>(kvKeys.sessionMinIssuedAt(payload.card_hash));
  if (cutoff !== null && payload.issued_at < cutoff) {
    return { ok: false, reason: 'revoked' };
  }

  return { ok: true, payload };
}

export async function revokeSessionToken(token: string, kv: KvStore): Promise<void> {
  // TTL matches the maximum remaining lifetime of any session token so the
  // revocation entry doesn't outlive tokens it could apply to.
  await kv.setItem(kvKeys.sessionRevoked(sessionTokenId(token)), true, SESSION_TTL_SECONDS);
}

/**
 * Invalidates every session token previously issued for `cardHash`
 * (implementation-plan.md §Step 2.4: keyring rotation invalidates old
 * sessions). Tokens issued after this call remain valid.
 */
export async function invalidateSessionsForCard(cardHash: string, kv: KvStore): Promise<void> {
  await kv.setItem(kvKeys.sessionMinIssuedAt(cardHash), Date.now(), SESSION_TTL_SECONDS);
}
