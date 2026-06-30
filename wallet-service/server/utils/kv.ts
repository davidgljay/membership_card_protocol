/**
 * Nitro KV adapter — wraps useStorage('wallet') with the KvStore interface.
 * Driver is configured in nitro.config.ts (cloudflare-kv-binding by
 * default). useStorage() is a Nitro auto-import available in all
 * server-context files.
 */

import type { KvStore } from '../../src/kv.js';

export function createNitroKvStore(): KvStore {
  const s = () => useStorage('wallet');
  type Wrapped<T> = { value: T; expiresAt: number | null };

  async function getRaw<T>(key: string): Promise<T | null> {
    const wrapped = await s().getItem<Wrapped<T>>(key);
    if (!wrapped) return null;
    if (wrapped.expiresAt !== null && wrapped.expiresAt < Date.now()) {
      await s().removeItem(key);
      return null;
    }
    return wrapped.value;
  }

  return {
    getItem: getRaw,

    async setItem<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      // Nitro's storage abstraction has no native TTL on every driver; we
      // store an explicit expiry alongside the value and check it on read.
      const wrapped: Wrapped<T> = {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      };
      await s().setItem(key, wrapped as never);
    },

    async removeItem(key: string): Promise<void> {
      await s().removeItem(key);
    },

    async increment(key: string, delta = 1): Promise<number> {
      // Preserve any existing expiry so a TTL set on the first call in a
      // window survives subsequent increments within that window.
      const existing = await s().getItem<Wrapped<number>>(key);
      const expired = existing?.expiresAt !== null && existing?.expiresAt !== undefined && existing.expiresAt < Date.now();
      const current = existing && !expired ? existing.value : 0;
      const next = current + delta;
      const expiresAt = existing && !expired ? existing.expiresAt : null;
      await s().setItem(key, { value: next, expiresAt } as never);
      return next;
    },
  };
}
