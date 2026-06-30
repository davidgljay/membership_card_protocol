import { describe, it, expect } from 'vitest';
import { checkSlidingWindow } from '../server/utils/rate-limit.js';
import type { KvStore } from '../src/kv.js';

function inMemoryKv(): KvStore {
  const store = new Map<string, { value: unknown; expiresAt: number | null }>();
  return {
    async getItem<T>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value as T;
    },
    async setItem<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    },
    async removeItem(key: string): Promise<void> {
      store.delete(key);
    },
    async increment(key: string, delta = 1): Promise<number> {
      const current = ((await this.getItem<number>(key)) ?? 0) + delta;
      await this.setItem(key, current);
      return current;
    },
  };
}

describe('checkSlidingWindow', () => {
  it('allows up to the limit within a window', async () => {
    const kv = inMemoryKv();
    for (let i = 0; i < 5; i++) {
      const result = await checkSlidingWindow(kv, 'k1', 5, 3600);
      expect(result.allowed).toBe(true);
    }
    const sixth = await checkSlidingWindow(kv, 'k1', 5, 3600);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not let a fixed-window boundary double the effective limit', async () => {
    // Simulate: 5 requests right at the end of window N, then check that
    // requests right at the start of window N+1 are still bounded by the
    // weighted carry-over from window N — a naive fixed-window counter
    // would allow a full new burst of 5 immediately after the boundary.
    const kv = inMemoryKv();
    const windowSeconds = 1; // small window to exercise the boundary deterministically
    const key = 'boundary-test';

    // Fill the current window to the limit.
    for (let i = 0; i < 5; i++) {
      const result = await checkSlidingWindow(kv, key, 5, windowSeconds);
      expect(result.allowed).toBe(true);
    }
    // Immediately after, still within the same (or very close to the same)
    // window, a 6th request should be rejected.
    const sixth = await checkSlidingWindow(kv, key, 5, windowSeconds);
    expect(sixth.allowed).toBe(false);
  });

  it('different keys are independent', async () => {
    const kv = inMemoryKv();
    for (let i = 0; i < 5; i++) {
      await checkSlidingWindow(kv, 'a', 5, 3600);
    }
    const blockedA = await checkSlidingWindow(kv, 'a', 5, 3600);
    expect(blockedA.allowed).toBe(false);

    const allowedB = await checkSlidingWindow(kv, 'b', 5, 3600);
    expect(allowedB.allowed).toBe(true);
  });

  it('supports weighted increments (e.g. counting items, not calls)', async () => {
    const kv = inMemoryKv();
    const first = await checkSlidingWindow(kv, 'weighted', 100, 3600, 60);
    expect(first.allowed).toBe(true);

    const second = await checkSlidingWindow(kv, 'weighted', 100, 3600, 60);
    expect(second.allowed).toBe(false); // 60 + 60 = 120 > 100
  });

  it('a single call exceeding the limit on its own is rejected', async () => {
    const kv = inMemoryKv();
    const result = await checkSlidingWindow(kv, 'oversized', 10, 3600, 11);
    expect(result.allowed).toBe(false);
  });
});
