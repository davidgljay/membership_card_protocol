import type { StorageProvider } from '@membership-card-protocol/app-sdk';
import { KV_STORE, idbGet, idbPut, idbDelete } from './indexeddb.js';

/**
 * Default web `StorageProvider` (OQ-SDK-5): IndexedDB-backed.
 *
 * `namespace` scopes every key this instance reads/writes so unrelated
 * modules sharing the same underlying IndexedDB database (card list,
 * keyring cache, UUID pools, message history) can't collide — each caller
 * constructs its own instance with a distinct namespace.
 */
export class IndexedDBStorageProvider implements StorageProvider {
  readonly #namespace: string;

  constructor(namespace: string) {
    this.#namespace = namespace;
  }

  #namespacedKey(key: string): string {
    return `${this.#namespace}:${key}`;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return idbGet<Uint8Array>(KV_STORE, this.#namespacedKey(key));
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await idbPut(KV_STORE, this.#namespacedKey(key), value);
  }

  async delete(key: string): Promise<void> {
    await idbDelete(KV_STORE, this.#namespacedKey(key));
  }
}
