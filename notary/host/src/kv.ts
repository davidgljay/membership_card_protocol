/**
 * Durable-state KV interface (notary_host.md §7). A thin subset of nitropack's `useStorage()`; the Redis driver is
 * configured in nitro.config.ts. In-memory implementation for tests. Pattern copied from press/src/kv.ts
 * (the press is an application, not a package, so it is copied rather than imported: code-plan principle 4).
 */
export interface KvStore {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** Keys starting with `prefix`. */
  getKeys(prefix: string): Promise<string[]>;
}

export function createInMemoryKv(now: () => number = Date.now): KvStore & { failNextWrite(): void } {
  const store = new Map<string, { v: unknown; exp?: number }>();
  let failWrite = false;
  const live = (k: string) => { const e = store.get(k); if (!e) return undefined; if (e.exp !== undefined && e.exp <= now()) { store.delete(k); return undefined; } return e; };
  return {
    async getItem<T>(key: string) { return (live(key)?.v as T | undefined) ?? null; },
    async setItem<T>(key: string, value: T, opts?: { ttlSeconds?: number }) {
      if (failWrite) { failWrite = false; throw new Error("simulated storage failure"); }
      store.set(key, { v: structuredClone(value), ...(opts?.ttlSeconds ? { exp: now() + opts.ttlSeconds * 1000 } : {}) });
    },
    async removeItem(key: string) { store.delete(key); },
    async getKeys(prefix: string) { return [...store.keys()].filter((k) => k.startsWith(prefix) && live(k)); },
    failNextWrite() { failWrite = true; },
  };
}
