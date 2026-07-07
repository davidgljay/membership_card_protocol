import { describe, it, expect, vi } from 'vitest';
import { signWithSubCard } from '../../src/subcards/signWithSubCard.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';

function makeFakeSecureKeyProvider(): SecureKeyProvider & {
  keys: Map<string, { publicKey: Uint8Array; secretKey: Uint8Array }>;
} {
  const keys = new Map<string, { publicKey: Uint8Array; secretKey: Uint8Array }>();
  return {
    keys,
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      keys.set(keyId, keypair);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const keypair = keys.get(keyId);
      if (!keypair) throw new Error('no key');
      return mlDsa44Sign(keypair.secretKey, message);
    }),
    getPublicKey: vi.fn(async (keyId: string) => keys.get(keyId)?.publicKey),
    delete: vi.fn(),
  };
}

describe('signWithSubCard', () => {
  it('calls SecureKeyProvider.sign with the given keyId and message, and returns its result', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const keyId = 'my-sub-card-key';
    await secureKeyProvider.generateKey(keyId);
    const message = new TextEncoder().encode('a challenge to sign');

    const signature = await signWithSubCard({ secureKeyProvider, keyId, message });

    expect(secureKeyProvider.sign).toHaveBeenCalledTimes(1);
    expect(secureKeyProvider.sign).toHaveBeenCalledWith(keyId, message);

    const keypair = secureKeyProvider.keys.get(keyId)!;
    expect(mlDsa44Verify(keypair.publicKey, message, signature)).toBe(true);
  });

  it('propagates whatever SecureKeyProvider.sign returns, without transforming it', async () => {
    const fakeSignature = new Uint8Array([1, 2, 3, 4]);
    const secureKeyProvider: SecureKeyProvider = {
      generateKey: vi.fn(),
      sign: vi.fn(async () => fakeSignature),
      getPublicKey: vi.fn(),
      delete: vi.fn(),
    };

    const result = await signWithSubCard({
      secureKeyProvider,
      keyId: 'some-key',
      message: new Uint8Array([9, 9, 9]),
    });

    expect(result).toBe(fakeSignature);
  });
});
