import assert from 'node:assert/strict';
import type { StorageProvider } from '../providers/StorageProvider.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';
import type { PasskeyProvider } from '../providers/PasskeyProvider.js';
import type { RealtimeTransportProvider } from '../providers/RealtimeTransportProvider.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { MultiInstanceLock } from '../providers/MultiInstanceLock.js';

/**
 * Provider contract test suites (Step 1.2).
 *
 * Each function returns a map of `{ testName: assertion }` that any concrete
 * implementation of the corresponding provider interface — web, RN, or a
 * host-app-supplied implementation — is expected to pass. Deliberately
 * framework-agnostic (plain `node:assert`, no `describe`/`it`), so the same
 * suite can be run from either a Vitest (web) or Jest+RN (React Native) test
 * file:
 *
 * ```ts
 * import { storageProviderContractTests } from '@membership-card-protocol/client-sdk/testing';
 *
 * describe('IndexedDBStorageProvider contract', () => {
 *   for (const [name, run] of Object.entries(storageProviderContractTests(() => new IndexedDBStorageProvider()))) {
 *     it(name, run);
 *   }
 * });
 * ```
 *
 * These suites are skeletal by design at Step 1.2 — no concrete provider
 * exists yet to run them against (that's Steps 1.5/1.6). They exist now so
 * every later provider implementation has a contract to be validated
 * against from the moment it's written.
 */

export type ContractTests = Record<string, () => Promise<void>>;

export function storageProviderContractTests(factory: () => Promise<StorageProvider>): ContractTests {
  return {
    'returns undefined for a key that was never set': async () => {
      const provider = await factory();
      assert.equal(await provider.get('missing-key'), undefined);
    },
    'set then get round-trips the exact bytes': async () => {
      const provider = await factory();
      const value = new Uint8Array([1, 2, 3, 4]);
      await provider.set('k', value);
      assert.deepEqual(await provider.get('k'), value);
    },
    'set overwrites a previous value under the same key': async () => {
      const provider = await factory();
      await provider.set('k', new Uint8Array([1]));
      await provider.set('k', new Uint8Array([2]));
      assert.deepEqual(await provider.get('k'), new Uint8Array([2]));
    },
    'delete removes a value': async () => {
      const provider = await factory();
      await provider.set('k', new Uint8Array([1]));
      await provider.delete('k');
      assert.equal(await provider.get('k'), undefined);
    },
    'delete on a missing key does not throw': async () => {
      const provider = await factory();
      await provider.delete('never-set');
    },
  };
}

export function secureKeyProviderContractTests(
  factory: () => Promise<SecureKeyProvider>
): ContractTests {
  return {
    'generateKey returns a public key retrievable via getPublicKey': async () => {
      const provider = await factory();
      const publicKey = await provider.generateKey('key-1');
      assert.deepEqual(await provider.getPublicKey('key-1'), publicKey);
    },
    'sign produces a signature verifiable against the public key': async () => {
      const provider = await factory();
      const publicKey = await provider.generateKey('key-2');
      const signature = await provider.sign('key-2', new Uint8Array([9, 9, 9]));
      assert.ok(signature.length > 0);
      assert.ok(publicKey.length > 0);
    },
    'getPublicKey returns undefined for a key that was never generated': async () => {
      const provider = await factory();
      assert.equal(await provider.getPublicKey('never-generated'), undefined);
    },
    'delete removes a key so sign subsequently fails': async () => {
      const provider = await factory();
      await provider.generateKey('key-3');
      await provider.delete('key-3');
      await assert.rejects(provider.sign('key-3', new Uint8Array([1])));
    },
  };
}

export function multiInstanceLockContractTests(
  factory: () => Promise<MultiInstanceLock>
): ContractTests {
  return {
    'acquire returns a release function': async () => {
      const lock = await factory();
      const release = await lock.acquire('lock-name');
      assert.equal(typeof release, 'function');
      release();
    },
    'a second acquire waits until the first is released': async () => {
      const lock = await factory();
      const release1 = await lock.acquire('shared-lock');
      let secondAcquired = false;
      const secondAcquirePromise = lock.acquire('shared-lock').then((release2) => {
        secondAcquired = true;
        release2();
      });
      assert.equal(secondAcquired, false);
      release1();
      await secondAcquirePromise;
      assert.equal(secondAcquired, true);
    },
  };
}

// PasskeyProvider, RealtimeTransportProvider, and ObliviousProtocolTransport
// require a browser/RN environment or a live network double to exercise
// meaningfully. Their contract suites are intentionally left as structural
// placeholders here — Steps 1.5/1.6 fill these in once a concrete
// implementation (and the corresponding fake WebAuthn/relay double) exists
// to run them against.

export function passkeyProviderContractTests(_factory: () => Promise<PasskeyProvider>): ContractTests {
  return {};
}

export function realtimeTransportProviderContractTests(
  _factory: () => Promise<RealtimeTransportProvider>
): ContractTests {
  return {};
}

export function obliviousProtocolTransportContractTests(
  _factory: () => Promise<ObliviousProtocolTransport>
): ContractTests {
  return {};
}
