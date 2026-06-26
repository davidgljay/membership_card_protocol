/**
 * Typed accessors for all press state in the external KV store.
 *
 * The KvStore interface is a thin subset of Nitro's useStorage() API —
 * enough for the press's needs. In server/ files, createKvStore wraps
 * Nitro's useStorage('press'). In tests, pass a Map-backed mock.
 */

// ---------------------------------------------------------------------------
// KV store interface
// ---------------------------------------------------------------------------

export interface KvStore {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** Atomic increment — adds `delta` to the current numeric value; initializes to 0 if absent. */
  increment(key: string, delta?: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory KV (for tests and local development)
// ---------------------------------------------------------------------------

export function createInMemoryKv(): KvStore {
  const store = new Map<string, unknown>();
  return {
    async getItem<T>(key: string): Promise<T | null> {
      return (store.get(key) as T | undefined) ?? null;
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async removeItem(key: string): Promise<void> {
      store.delete(key);
    },
    async increment(key: string, delta = 1): Promise<number> {
      const current = (store.get(key) as number | undefined) ?? 0;
      const next = current + delta;
      store.set(key, next);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// KV value types
// ---------------------------------------------------------------------------

export interface LogHeadRecord {
  log_head_cid: string;
  seq: number;
  updated_at: number;
}

export interface OfferRecord {
  policy_cid: string;
  created_at: number;
  finalized: boolean;
  expires_at: number | null;
}

export interface AppGasRecord {
  balance_wei: string;
  last_funded_at: number | null;
  last_debited_at: number | null;
}

export interface ReconcileCheckpoint {
  last_block: number;
}

// ---------------------------------------------------------------------------
// Key builders — never construct keys manually outside this file
// ---------------------------------------------------------------------------

export const kvKeys = {
  logHead: (policyCid: string) => `press:log_head:${policyCid}`,
  offer: (offerCid: string) => `press:offer:${offerCid}`,
  rateEntity: (
    entityAddress: string,
    entityType: string,
    operation: string,
    policyAddress: string,
    windowStart: number
  ) =>
    `press:rate:${entityAddress}:${entityType}:${operation}:${policyAddress}:${windowStart}`,
  policyWrites: (policyAddress: string, windowStart: number) =>
    `press:policy_writes:${policyAddress}:${windowStart}`,
  appGas: (appCardAddress: string) => `press:app_gas:${appCardAddress}`,
  reconcileLastBlock: () => 'press:reconcile:last_block',
} as const;
