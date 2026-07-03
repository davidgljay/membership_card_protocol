import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StorageProvider } from '@membership-card-protocol/client-sdk';
import { bytesToBase64Url, base64UrlToBytes } from './base64url.js';

/**
 * Default React Native `StorageProvider` (OQ-SDK-5): backed by
 * `@react-native-async-storage/async-storage`.
 *
 * Backend choice, evaluated per Step 1.6 against this SDK's actual access
 * pattern (key-value, moderate write volume — card list, keyring cache,
 * UUID pools, message history dedup index):
 *
 * - **AsyncStorage (chosen):** simple key-value shape matches this SDK's
 *   needs exactly with no unused surface; ships an official, actively
 *   maintained Jest mock (`@react-native-async-storage/async-storage/jest/async-storage-mock`),
 *   which made it the easiest of the three to give real test coverage in
 *   this package rather than relying entirely on hand-rolled fakes; no JSI
 *   native-module linking requirement beyond the standard RN autolinking
 *   already needed for the other RN providers in this package.
 * - **MMKV:** faster (JSI, no bridge serialization), but requires
 *   RN's New Architecture / a Nitro-module-capable RN version, adding a
 *   host-app build-configuration requirement this SDK shouldn't impose by
 *   default. A host app with an existing MMKV dependency can still supply
 *   its own `StorageProvider` implementation.
 * - **SQLite:** the SDK's storage needs (opaque key → bytes) never require
 *   relational queries; adopting SQLite would mean carrying an unused
 *   query surface and a heavier native dependency for no benefit here.
 *
 * Values are stored as base64url strings (AsyncStorage is string-only).
 */
export class AsyncStorageProvider implements StorageProvider {
  readonly #namespace: string;

  constructor(namespace: string) {
    this.#namespace = namespace;
  }

  #namespacedKey(key: string): string {
    return `${this.#namespace}:${key}`;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const stored = await AsyncStorage.getItem(this.#namespacedKey(key));
    return stored === null ? undefined : base64UrlToBytes(stored);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await AsyncStorage.setItem(this.#namespacedKey(key), bytesToBase64Url(value));
  }

  async delete(key: string): Promise<void> {
    await AsyncStorage.removeItem(this.#namespacedKey(key));
  }
}
