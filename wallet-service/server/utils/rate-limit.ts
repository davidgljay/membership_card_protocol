/**
 * Minimal fixed-window rate limiter on top of the KV abstraction. Full
 * sliding-window limits with `Retry-After` headers land in Phase 6 Step
 * 6.1; this covers the specific limits called out earlier in the plan
 * (Step 2.1's challenge rate limit, Step 2.3's 10-per-session cap).
 */

import type { KvStore } from '../../src/kv.js';

/** Returns true if the call is allowed (count is now <= limit), false if it should be rejected. */
export async function checkAndIncrement(
  kv: KvStore,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const count = await kv.increment(key, 1);
  if (count === 1) {
    // increment() doesn't take a TTL; set one only on first write in this window.
    await kv.setItem(key, count, windowSeconds);
  }
  return count <= limit;
}
