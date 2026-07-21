/**
 * Operator-only auth for /api/admin/* endpoints — mirrors wallet-service's
 * server/utils/admin-auth.ts's intent (a single shared bearer token,
 * PRESS_ADMIN_API_KEY, for the operator running the instance, not end
 * users or federation peers), but can't reuse its implementation: press
 * runs under `wrangler dev`'s Workers `nodejs_compat` polyfill layer,
 * which doesn't implement `node:crypto`'s `timingSafeEqual` (confirmed
 * empirically — throws "[unenv] crypto.timingSafeEqual is not implemented
 * yet!"). Compares manually instead, in plain JS with no early exit on
 * mismatch, avoiding both the missing Node API and a length-revealing
 * short-circuit.
 */

import { loadConfig } from '../../src/config.js';

function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLength; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function requireAdminAuth(event: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const header = getHeader(event as any, 'authorization');
  if (!header?.startsWith('Bearer ')) {
    throw createError({ statusCode: 401, statusMessage: 'Missing bearer token.' });
  }
  const provided = header.slice('Bearer '.length);
  const expected = loadConfig().PRESS_ADMIN_API_KEY;

  if (!constantTimeEqual(provided, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid admin API key.' });
  }
}
