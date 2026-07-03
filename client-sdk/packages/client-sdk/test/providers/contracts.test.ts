import { describe, it } from 'vitest';
import type { StorageProvider } from '../../src/providers/StorageProvider.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';
import type { MultiInstanceLock } from '../../src/providers/MultiInstanceLock.js';
import {
  storageProviderContractTests,
  secureKeyProviderContractTests,
  multiInstanceLockContractTests,
} from '../../src/testing/providerContracts.js';

/**
 * Sanity-checks the Step 1.2 provider-contract suites against trivial
 * in-memory reference implementations. Real coverage of a given provider
 * interface comes from running these same suites against the web (Step 1.5)
 * and RN (Step 1.6) default implementations — this file only proves the
 * contract suites themselves are well-formed and pass against a correct
 * implementation.
 */

class InMemoryStorageProvider implements StorageProvider {
  private store = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.store.get(key);
  }
  async set(key: string, value: Uint8Array) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

class InMemorySecureKeyProvider implements SecureKeyProvider {
  private keys = new Map<string, Uint8Array>();
  async generateKey(keyId: string) {
    const publicKey = new Uint8Array([1, 2, 3]);
    this.keys.set(keyId, publicKey);
    return publicKey;
  }
  async sign(keyId: string, _message: Uint8Array) {
    if (!this.keys.has(keyId)) throw new Error('unknown key');
    return new Uint8Array([9, 9, 9]);
  }
  async getPublicKey(keyId: string) {
    return this.keys.get(keyId);
  }
  async delete(keyId: string) {
    this.keys.delete(keyId);
  }
}

class InMemoryMultiInstanceLock implements MultiInstanceLock {
  private held = new Map<string, Promise<void>>();
  async acquire(name: string) {
    while (this.held.has(name)) {
      await this.held.get(name);
    }
    let release!: () => void;
    const heldPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(name, heldPromise);
    return () => {
      this.held.delete(name);
      release();
    };
  }
}

describe('StorageProvider contract (in-memory reference)', () => {
  for (const [name, run] of Object.entries(
    storageProviderContractTests(async () => new InMemoryStorageProvider())
  )) {
    it(name, run);
  }
});

describe('SecureKeyProvider contract (in-memory reference)', () => {
  for (const [name, run] of Object.entries(
    secureKeyProviderContractTests(async () => new InMemorySecureKeyProvider())
  )) {
    it(name, run);
  }
});

describe('MultiInstanceLock contract (in-memory reference)', () => {
  for (const [name, run] of Object.entries(
    multiInstanceLockContractTests(async () => new InMemoryMultiInstanceLock())
  )) {
    it(name, run);
  }
});
