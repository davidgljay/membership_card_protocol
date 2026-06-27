/**
 * Nitro KV adapter — wraps useStorage('press') with the KvStore interface.
 *
 * The underlying driver is configured in nitro.config.ts (redis by default).
 * useStorage() is a Nitro auto-import available in all server-context files.
 *
 * increment() is implemented as getItem + setItem. Redis drivers support
 * native INCR, but Nitro's abstraction layer doesn't expose it. For rate-
 * limit counters, the occasional race condition on concurrent increments is
 * acceptable (a few double-counts won't compromise security).
 */

import type { KvStore } from '../../src/kv.js';

export function createNitroKvStore(): KvStore {
  const s = () => useStorage('press');
  return {
    async getItem<T>(key: string): Promise<T | null> {
      return s().getItem<T>(key);
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      await s().setItem(key, value as never);
    },

    async removeItem(key: string): Promise<void> {
      await s().removeItem(key);
    },

    async increment(key: string, delta = 1): Promise<number> {
      const current = (await s().getItem<number>(key)) ?? 0;
      const next = current + delta;
      await s().setItem(key, next as never);
      return next;
    },
  };
}
