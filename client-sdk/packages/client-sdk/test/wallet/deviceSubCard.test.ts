import { describe, it, expect, vi } from 'vitest';
import { registerDeviceSubCard, type WalletAppCardIdentity, type SignedSubCardDocument } from '../../src/wallet/deviceSubCard.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';

function makeFakeSecureKeyProvider(): SecureKeyProvider & { keys: Map<string, Uint8Array> } {
  const keys = new Map<string, Uint8Array>();
  const secretKeys = new Map<string, Uint8Array>();
  return {
    keys,
    generateKey: vi.fn(async (keyId: string) => {
      const keypair = mlDsa44GenerateKeypair();
      keys.set(keyId, keypair.publicKey);
      secretKeys.set(keyId, keypair.secretKey);
      return keypair.publicKey;
    }),
    sign: vi.fn(async (keyId: string, message: Uint8Array) => {
      const secretKey = secretKeys.get(keyId);
      if (!secretKey) throw new Error('no key');
      return mlDsa44Sign(secretKey, message);
    }),
    getPublicKey: vi.fn(async (keyId: string) => keys.get(keyId)),
    delete: vi.fn(async (keyId: string) => {
      keys.delete(keyId);
      secretKeys.delete(keyId);
    }),
  };
}

function makeWalletAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'app-card-pointer',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

describe('registerDeviceSubCard (Step 2.2)', () => {
  it('assembles a SignedSubCardDocument with both signatures verifiable, and submits it for registration', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeWalletAppCard();
    const master = mlDsa44GenerateKeypair();
    const registerSubCard = vi.fn(async (_doc: SignedSubCardDocument) => ({ registered: true }));

    const result = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash: 'deadbeef',
      masterPublicKey: master.publicKey,
      masterSecretKey: master.secretKey,
      walletAppCard,
      registerSubCard,
      capabilities: ['auth_response'],
    });

    expect(result.registered).toBe(true);
    expect(registerSubCard).toHaveBeenCalledTimes(1);
    expect(registerSubCard).toHaveBeenCalledWith(result.document);

    const doc = result.document;
    expect(doc.holder_primary_card).toBe('deadbeef');
    expect(doc.recipient_pubkey).toBe(bytesToBase64Url(result.subCardPublicKey));
    expect(doc.attestation_level).toBe('T1');
    expect(doc.attestation_proof).toBeUndefined();
    expect(doc.valid_until).toBeUndefined();

    const { app_signature, holder_signature, ...withoutSignatures } = doc;
    expect(mlDsa44Verify(walletAppCard.publicKey, canonicalize(withoutSignatures), base64UrlToBytes(app_signature))).toBe(
      true
    );
    const withAppSignature = { ...withoutSignatures, app_signature };
    expect(
      mlDsa44Verify(master.publicKey, canonicalize(withAppSignature), base64UrlToBytes(holder_signature))
    ).toBe(true);
  });

  it('respects an explicit subCardKeyId and validUntil', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeWalletAppCard();
    const master = mlDsa44GenerateKeypair();
    const registerSubCard = vi.fn(async () => ({ registered: true }));
    const validUntil = '2027-01-01T00:00:00.000Z';

    const result = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash: 'cafebabe',
      masterPublicKey: master.publicKey,
      masterSecretKey: master.secretKey,
      walletAppCard,
      registerSubCard,
      capabilities: [],
      subCardKeyId: 'custom-key-id',
      validUntil,
    });

    expect(result.subCardKeyId).toBe('custom-key-id');
    expect(secureKeyProvider.keys.has('custom-key-id')).toBe(true);
    expect(result.document.valid_until).toBe(validUntil);
  });

  it('propagates registered: false when the test registry rejects the submission', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const walletAppCard = makeWalletAppCard();
    const master = mlDsa44GenerateKeypair();
    const registerSubCard = vi.fn(async () => ({ registered: false }));

    const result = await registerDeviceSubCard({
      secureKeyProvider,
      cardHash: 'abc123',
      masterPublicKey: master.publicKey,
      masterSecretKey: master.secretKey,
      walletAppCard,
      registerSubCard,
      capabilities: [],
    });

    expect(result.registered).toBe(false);
  });
});
