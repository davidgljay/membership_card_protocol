jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockKeychainStore = new Map<string, { username: string; password: string }>();

jest.mock('react-native-keychain', () => ({
  SECURITY_LEVEL: { SECURE_HARDWARE: 'SECURE_HARDWARE', SECURE_SOFTWARE: 'SECURE_SOFTWARE', ANY: 'ANY' },
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  setGenericPassword: jest.fn(
    async (username: string, password: string, options: { service: string }) => {
      mockKeychainStore.set(options.service, { username, password });
      return { service: options.service, storage: 'keystore' };
    }
  ),
  getGenericPassword: jest.fn(async (options: { service: string }) => {
    const entry = mockKeychainStore.get(options.service);
    if (!entry) return false;
    return { service: options.service, ...entry, storage: 'keystore' };
  }),
  resetGenericPassword: jest.fn(async (options: { service: string }) => {
    mockKeychainStore.delete(options.service);
    return true;
  }),
}));

// jest.mock() calls are hoisted, so mock registration above runs before
// these imports resolve — matches test/providers/SecureKeyProvider.test.ts's
// established pattern. react-native-keychain's real module ships unbundled
// Flow-typed source Jest cannot parse, so it must always be mocked, never
// imported for real, under this test runner.
import {
  requestSubCard,
  signWithSubCard,
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  mlDsa44Verify,
} from '@membership-card-protocol/app-sdk';
import { SecureEnclaveKeyProvider } from '../../src/SecureKeyProvider.js';

/**
 * Step 3.1b Scenario test (RN provider set): Sub-card request + signing
 * end-to-end using the real SecureEnclaveKeyProvider (hardware-backed
 * wrapping key via react-native-keychain, mocked at the native-module
 * boundary per the doc comment above — the provider's own glue code,
 * key generation, and signing logic are all real and exercised).
 *
 * Mirrors `sdk-providers-web/test/scenarios/subCardRequestAndSigning.test.ts`
 * exactly, confirming that the same flows work identically on both provider
 * sets with platform-specific storage backends (IndexedDB on web,
 * Keychain on RN).
 */

describe('Sub-card request and signing end-to-end (Step 3.1b, RN provider set)', () => {
  let provider: SecureEnclaveKeyProvider;

  beforeEach(() => {
    provider = new SecureEnclaveKeyProvider();
  });

  afterEach(async () => {
    // Clean up any generated keys
    const keys = ['test-subcard-key', 'test-signing-key'];
    for (const keyId of keys) {
      try {
        await provider.delete(keyId);
      } catch {
        // Key may not exist; this is okay.
      }
    }
  });

  it('generates a key via requestSubCard and uses it to sign a message via signWithSubCard, with the signature verifying', async () => {
    // Step 1: Simulate a requesting app's own card identity (in practice, this comes from the app's own setup).
    const appCardKeypair = mlDsa44GenerateKeypair();
    let appSignatureCounter = 0;
    const appCard = {
      cardPointer: 'app:example.com/app-card',
      publicKey: appCardKeypair.publicKey,
      sign: async (data: Uint8Array) => {
        appSignatureCounter++;
        return mlDsa44Sign(appCardKeypair.secretKey, data);
      },
    };

    // Step 2: Request a sub-card for this holder's primary card.
    const requestResult = await requestSubCard({
      secureKeyProvider: provider,
      subCardKeyId: 'test-subcard-key',
      appCard,
      holderPrimaryCard: 'holder:example.com/primary',
      holderPrimaryCardPubkey: new Uint8Array(32).fill(0xaa), // Dummy holder primary key
      capabilities: ['text', 'reaction'],
      attestationLevel: 'T1',
    });

    expect(requestResult.subCardPublicKey).toBeDefined();
    expect(requestResult.subCardKeyId).toBe('test-subcard-key');
    expect(requestResult.document).toBeDefined();
    expect(requestResult.document.app_signature).toBeDefined();
    expect(appSignatureCounter).toBe(1); // App signed the request exactly once

    // Step 3: Use the generated key to sign an arbitrary message.
    const messageToSign = new TextEncoder().encode('proof of sub-card ownership');
    const signature = await signWithSubCard({
      secureKeyProvider: provider,
      keyId: 'test-subcard-key',
      message: messageToSign,
    });

    expect(signature).toBeDefined();
    expect(signature.length).toBeGreaterThan(0);

    // Step 4: Verify the signature against the public key returned from requestSubCard.
    const isValid = mlDsa44Verify(requestResult.subCardPublicKey, messageToSign, signature);
    expect(isValid).toBe(true);

    // Step 5: Verify that a different message would NOT verify against the same signature.
    const differentMessage = new TextEncoder().encode('different message');
    const isInvalid = mlDsa44Verify(requestResult.subCardPublicKey, differentMessage, signature);
    expect(isInvalid).toBe(false);
  });

  it('confirms that the private key is never exportable from the provider', async () => {
    // Generate a key.
    const publicKeyReturned = await provider.generateKey('test-signing-key');
    expect(publicKeyReturned).toBeDefined();

    // Attempt to retrieve it via getPublicKey (the only "read-back" method).
    const publicKeyFetched = await provider.getPublicKey('test-signing-key');
    expect(publicKeyFetched).toBeDefined();
    // Verify the bytes are identical.
    if (publicKeyFetched && publicKeyReturned) {
      expect(publicKeyFetched.length).toBe(publicKeyReturned.length);
      for (let i = 0; i < publicKeyFetched.length; i++) {
        expect(publicKeyFetched[i]).toBe(publicKeyReturned[i]);
      }
    }

    // The provider should never have a method to export the private key.
    // TypeScript should prevent calling `export()` or similar on the provider.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(provider));
    expect(methods).not.toContain('exportKey');
    expect(methods).not.toContain('exportPrivateKey');
    expect(methods).not.toContain('getPrivateKey');
  });

  it('a signature created via signWithSubCard verifies correctly even after the key is retrieved independently', async () => {
    // Generate and sign.
    await provider.generateKey('test-signing-key');
    const message = new TextEncoder().encode('test message');
    const signature = await signWithSubCard({
      secureKeyProvider: provider,
      keyId: 'test-signing-key',
      message,
    });

    // Independently retrieve the public key and verify.
    const retrievedPublicKey = await provider.getPublicKey('test-signing-key');
    expect(retrievedPublicKey).toBeDefined();

    const isValid = mlDsa44Verify(retrievedPublicKey!, message, signature);
    expect(isValid).toBe(true);
  });
});
