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
// these imports resolve.
import { secureKeyProviderContractTests } from '@membership-card-protocol/app-sdk/testing';
import { mlDsa44Verify } from '@membership-card-protocol/app-sdk';
import { SecureEnclaveKeyProvider } from '../../src/SecureKeyProvider.js';

beforeEach(() => {
  mockKeychainStore.clear();
});

describe('SecureEnclaveKeyProvider contract', () => {
  for (const [name, run] of Object.entries(
    secureKeyProviderContractTests(async () => new SecureEnclaveKeyProvider())
  )) {
    it(name, run);
  }
});

describe('SecureEnclaveKeyProvider — signature correctness and keychain usage', () => {
  it('produces a signature that actually verifies against the returned public key', async () => {
    const provider = new SecureEnclaveKeyProvider();
    const publicKey = await provider.generateKey('sign-check');
    const message = new TextEncoder().encode('card protocol test message');
    const signature = await provider.sign('sign-check', message);
    expect(mlDsa44Verify(publicKey, message, signature)).toBe(true);
  });

  it('the wrapping key is stored in the platform keychain, not alongside the wrapped secret key', async () => {
    const provider = new SecureEnclaveKeyProvider();
    await provider.generateKey('keychain-check');
    expect(mockKeychainStore.size).toBe(1);
    const [, entry] = [...mockKeychainStore.entries()][0]!;
    // The stored password is the wrapping key, not the raw ML-DSA-44 secret
    // key (~2560 bytes base64url-encoded would be far longer).
    expect(entry.password.length).toBeLessThan(100);
  });

  it('delete removes both the keychain entry and the wrapped-key record', async () => {
    const provider = new SecureEnclaveKeyProvider();
    await provider.generateKey('delete-check');
    await provider.delete('delete-check');
    expect(mockKeychainStore.size).toBe(0);
    expect(await provider.getPublicKey('delete-check')).toBeUndefined();
  });
});
