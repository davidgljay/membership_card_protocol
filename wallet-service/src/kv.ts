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
  /** Step 2.3/6.1: caps GET /service-secret to 10 calls per session token lifetime. */
  serviceSecretCalls: (sessionTokenId: string) => `wallet:rate:service-secret:${sessionTokenId}`,
  /** Step 2.1/2.2/6.1: rate-limits challenge issuance. */
  challengeRate: (purpose: string, key: string) => `wallet:rate:challenge:${purpose}:${key}`,
  /** Step 6.1: POST /accounts — 5 per (hashed) IP per hour. */
  accountCreationRate: (hashedIp: string) => `wallet:rate:account-creation:${hashedIp}`,
  /** Step 6.1: POST /accounts/{card_hash}/recovery — 3 per card per 24 hours. */
  recoveryInitiationRate: (cardHash: string) => `wallet:rate:recovery-initiation:${cardHash}`,
  /** Step 6.1: POST /bindings/announce — 100 per peer per minute. */
  bindingAnnounceRate: (walletServiceId: string) => `wallet:rate:binding-announce:${walletServiceId}`,
  /** Matrix Phase 4 Step 15c: caches a shadow account's minted Matrix access token so POST /matrix/token doesn't re-mint on every call. */
  matrixAccessToken: (matrixUserId: string) => `wallet:matrix:access-token:${matrixUserId}`,
  /**
   * Matrix Phase 4 Step 16c: abuse rate-limit counter for
   * POST /matrix/discover-rooms (specs/process_specs/room_discovery.md §3).
   * Deliberately the *only* state this endpoint keeps per card_hash — a
   * short-window request counter, not a durable record of which rooms a
   * card asked about. Same sliding-window counter mechanism (checkSlidingWindow
   * / enforceRateLimit) already used for every other rate limit in this
   * file, reused rather than inventing new abuse-tracking machinery.
   */
  discoverRoomsRate: (cardHash: string) => `wallet:rate:discover-rooms:${cardHash}`,
};
