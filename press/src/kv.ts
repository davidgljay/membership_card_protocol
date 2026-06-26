/**
 * Typed accessors for all press state in the external KV store.
 * Keys are namespaced under press: to avoid collisions.
 *
 * All reads return null when absent; callers fall back to on-chain reads
 * for log_head entries per spec §3.3.
 */

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

// Key builders — one function per namespace so callers never construct keys manually.

export const kvKeys = {
  logHead: (policyCid: string) => `press:log_head:${policyCid}`,
  offer: (offerCid: string) => `press:offer:${offerCid}`,
  rateEntity: (
    entityAddress: string,
    entityType: string,
    operation: string,
    policyAddress: string,
    windowStart: number
  ) => `press:rate:${entityAddress}:${entityType}:${operation}:${policyAddress}:${windowStart}`,
  policyWrites: (policyAddress: string, windowStart: number) =>
    `press:policy_writes:${policyAddress}:${windowStart}`,
  appGas: (appCardAddress: string) => `press:app_gas:${appCardAddress}`,
  reconcileLastBlock: () => 'press:reconcile:last_block',
} as const;
