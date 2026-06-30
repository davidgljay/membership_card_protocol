/**
 * Storage-backend-agnostic KV interface used for session token revocation
 * and rate-limit counters. Implementations:
 *  - server/utils/kv.ts createNitroKvStore() — wraps useStorage('wallet'),
 *    backed by cloudflare-kv-binding on the Cloudflare preset.
 *  - src/kv-postgres.ts createPostgresKvStore() — fallback for
 *    node-server/aws-lambda presets where no KV binding is available.
 * No standalone Redis dependency either way (implementation-plan.md §1.4).
 */

export interface KvStore {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  removeItem(key: string): Promise<void>;
  increment(key: string, delta?: number): Promise<number>;
}

export const kvKeys = {
  sessionRevoked: (sessionTokenId: string) => `wallet:session:revoked:${sessionTokenId}`,
  /** Bulk-invalidation cutoff: tokens for this card_hash issued before this timestamp are rejected. */
  sessionMinIssuedAt: (cardHash: string) => `wallet:session:min-issued-at:${cardHash}`,
  /** Step 2.3: caps GET /service-secret to 10 calls per session token lifetime. */
  serviceSecretCalls: (sessionTokenId: string) => `wallet:rate:service-secret:${sessionTokenId}`,
  /** Step 2.1/2.2: rate-limits challenge issuance. */
  challengeRate: (purpose: string, key: string) => `wallet:rate:challenge:${purpose}:${key}`,
};
