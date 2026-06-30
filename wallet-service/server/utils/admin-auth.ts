/**
 * Operator-only auth for /admin/* endpoints (strategic-plan.md §Goal 5).
 * A single shared bearer token (ADMIN_API_KEY) — these endpoints are for
 * the operator running the instance, not end users or federation peers.
 */

import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../../src/config.js';

export function requireAdminAuth(event: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const header = getHeader(event as any, 'authorization');
  if (!header?.startsWith('Bearer ')) {
    throw createError({ statusCode: 401, statusMessage: 'Missing bearer token.' });
  }
  const provided = header.slice('Bearer '.length);
  const expected = loadConfig().ADMIN_API_KEY;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const valid = providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
  if (!valid) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid admin API key.' });
  }
}
