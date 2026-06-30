/**
 * H3 wrapper around checkSlidingWindow (implementation-plan.md §Step 6.1):
 * throws a 429 with an accurate Retry-After header when a limit is
 * exceeded, otherwise returns silently.
 */

import { checkSlidingWindow } from './rate-limit.js';
import { createKvStore } from './kv-store.js';
import { auditLog } from './audit-log.js';

export async function enforceRateLimit(
  event: unknown,
  key: string,
  limit: number,
  windowSeconds: number,
  weight = 1
): Promise<void> {
  const kv = createKvStore();
  const result = await checkSlidingWindow(kv, key, limit, windowSeconds, weight);
  if (!result.allowed) {
    // `key` is always either a non-reversible hash (IP) or an already-opaque
    // identifier (card_hash, subcard_hash, session_token_id, wallet_service_id)
    // — safe to log per implementation-plan.md §Step 6.2.
    auditLog('warn', 'rate_limit_exceeded', { key, limit, window_seconds: windowSeconds });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setResponseHeader(event as any, 'Retry-After', result.retryAfterSeconds);
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' });
  }
}
