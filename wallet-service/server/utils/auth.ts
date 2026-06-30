/**
 * H3/Nitro request helpers wrapping the framework-agnostic auth functions
 * in src/auth/. Not registered as global middleware — each protected route
 * calls the relevant helper explicitly, since auth requirements differ
 * per-endpoint (session token vs. master card signature vs. peer signature).
 */

import { loadConfig } from '../../src/config.js';
import { verifySessionToken, type SessionTokenPayload } from '../../src/auth/session-token.js';
import { createKvStore } from './kv-store.js';

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export interface VerifiedSession {
  token: string;
  payload: SessionTokenPayload;
}

/** Returns both the verified payload and the raw token — callers that need a stable per-token rate-limit key (Step 2.3) require the latter. */
export async function requireSessionTokenRaw(event: unknown): Promise<VerifiedSession> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const header = getHeader(event as any, 'authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new AuthError(401, 'Missing bearer token.');
  }
  const token = header.slice('Bearer '.length);
  const config = loadConfig();
  const kv = createKvStore();
  const result = await verifySessionToken(token, config.SESSION_TOKEN_SECRET, kv);
  if (!result.ok) {
    throw new AuthError(401, `Invalid session token: ${result.reason}.`);
  }
  return { token, payload: result.payload };
}

export async function requireSessionToken(event: unknown): Promise<SessionTokenPayload> {
  return (await requireSessionTokenRaw(event)).payload;
}
