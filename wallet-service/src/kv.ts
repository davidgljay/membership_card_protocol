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
  registrationTokenUsed: (cardHash: string) => `wallet:reg-token:used:${cardHash}`,
};
