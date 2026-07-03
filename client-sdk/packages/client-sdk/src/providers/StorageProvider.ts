/**
 * Injected local-persistence abstraction (OQ-SDK-5).
 *
 * Every module that needs durable local state — card list, cached encrypted
 * keyring, per-subcard UUID pools, message/edit history for deduplication —
 * goes through an instance of this interface rather than talking to a
 * platform storage API directly. Keys are namespaced by a caller-supplied
 * prefix so unrelated modules sharing one `StorageProvider` instance can't
 * collide.
 *
 * Default implementations: IndexedDB-backed on web
 * (`@membership-card-protocol/client-sdk-web`), and a Phase 1-selected
 * backend on React Native (`@membership-card-protocol/client-sdk-rn`). A
 * host app may substitute its own implementation (e.g. one backed by a
 * SQLite/WatermelonDB layer it already runs) as long as it satisfies this
 * contract.
 */
export interface StorageProvider {
  /**
   * Read a previously stored value.
   *
   * @param key - Unprefixed key; the implementation applies its own
   *   namespace/prefix internally.
   * @returns The stored value, or `undefined` if no value is stored under
   *   `key`.
   */
  get(key: string): Promise<Uint8Array | undefined>;

  /**
   * Write a value, overwriting any existing value stored under `key`.
   */
  set(key: string, value: Uint8Array): Promise<void>;

  /**
   * Remove a value. A no-op (not an error) if `key` is not present.
   */
  delete(key: string): Promise<void>;
}
