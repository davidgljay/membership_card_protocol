/**
 * Sliding-window-counter rate limiter (implementation-plan.md §Step 6.1),
 * on top of the KV abstraction (same KV-backed driver as session
 * revocation, Step 1.4 — no standalone Redis dependency).
 *
 * Approximates a true sliding log using two fixed windows (current +
 * previous), weighting the previous window's count by how much of it
 * still overlaps the trailing `windowSeconds` — the standard
 * "sliding window counter" algorithm (the same approach Cloudflare's own
 * rate limiter uses). This needs only two KV reads/writes per check,
 * unlike a sliding log (one entry per request) or a naive fixed window
 * (which allows up to 2x the limit at window boundaries).
 */

import type { KvStore } from '../../src/kv.js';

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller should retry — conservative (time remaining in the current fixed window), not the precise moment the weighted count drops below the limit. */
  retryAfterSeconds: number;
}

export async function checkSlidingWindow(
  kv: KvStore,
  key: string,
  limit: number,
  windowSeconds: number,
  weight = 1
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowIndex = Math.floor(now / 1000 / windowSeconds);
  const elapsedInCurrentMs = now - windowIndex * windowSeconds * 1000;
  const fractionElapsed = elapsedInCurrentMs / (windowSeconds * 1000);

  const currentKey = `${key}:${windowIndex}`;
  const previousKey = `${key}:${windowIndex - 1}`;

  const [currentCount, previousCount] = await Promise.all([
    kv.getItem<number>(currentKey),
    kv.getItem<number>(previousKey),
  ]);

  const weightedCount = (previousCount ?? 0) * (1 - fractionElapsed) + (currentCount ?? 0);
  const retryAfterSeconds = Math.ceil(windowSeconds * (1 - fractionElapsed));

  if (weightedCount + weight > limit) {
    return { allowed: false, retryAfterSeconds };
  }

  const newCount = (currentCount ?? 0) + weight;
  // TTL covers this window plus the next, so a key created near the end of
  // a window is still readable as "previous" partway into the next one.
  await kv.setItem(currentKey, newCount, windowSeconds * 2);

  return { allowed: true, retryAfterSeconds };
}
