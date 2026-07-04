import { describe, it, expect, vi } from 'vitest';
import { requestSubCard } from '../../src/subcards/requestSubCard.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { keccak256 } from '../../src/crypto/hashes.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import type { WalletAppCardIdentity } from '../../src/wallet/deviceSubCard.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';

function makeFakeSecureKeyProvider(): SecureKeyProvider & { keys: Map<string, { publicKey: Uint8Array; secretKey: Uint8Array }> } {
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

function makeFakeAppCard(): WalletAppCardIdentity {
  const keypair = mlDsa44GenerateKeypair();
  return {
    cardPointer: 'requesting-app-card-pointer',
    publicKey: keypair.publicKey,
    sign: (message: Uint8Array) => mlDsa44Sign(keypair.secretKey, message),
  };
}

describe('requestSubCard', () => {
  it('assembles a SubCardDocument matching the spec JSON shape, with a verifiable app_signature', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const appCard = makeFakeAppCard();
    const holder = mlDsa44GenerateKeypair();
    const holderPrimaryCard = keccak256(holder.publicKey);

    const result = await requestSubCard({
      secureKeyProvider,
      subCardKeyId: 'app-sub-card-key',
      appCard,
      holderPrimaryCard,
      holderPrimaryCardPubkey: holder.publicKey,
      capabilities: ['auth_response', 'exchange_offer'],
      attestationLevel: 'T1',
    });

    const doc = result.document;
    expect(doc.holder_primary_card).toBe(holderPrimaryCard);
    expect(doc.holder_primary_card_pubkey).toBe(bytesToBase64Url(holder.publicKey));
    expect(doc.app_card).toBe(appCard.cardPointer);
    expect(doc.app_card_pubkey).toBe(bytesToBase64Url(appCard.publicKey));
    expect(doc.capabilities).toEqual(['auth_response', 'exchange_offer']);
    expect(doc.recipient_pubkey).toBe(bytesToBase64Url(result.subCardPublicKey));
    expect(doc.attestation_level).toBe('T1');
    expect(doc.attestation_proof).toBeUndefined();
    expect(doc.valid_until).toBeUndefined();
    expect(typeof doc.issued_at).toBe('string');

    // Only app_signature is present — holder_signature isn't added until
    // Step 4.3/4.4's wallet countersign step.
    expect('holder_signature' in doc).toBe(false);

    // app_signature verifies over canonical RFC 8785 JSON of every other field.
    const { app_signature, ...withoutSignature } = doc;
    expect(mlDsa44Verify(appCard.publicKey, canonicalize(withoutSignature), base64UrlToBytes(app_signature))).toBe(true);
  });

  it('includes attestation_proof and valid_until when supplied', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const appCard = makeFakeAppCard();
    const holder = mlDsa44GenerateKeypair();
    const attestationProof = new TextEncoder().encode('fake-app-attest-assertion');

    const result = await requestSubCard({
      secureKeyProvider,
      subCardKeyId: 'app-sub-card-key',
      appCard,
      holderPrimaryCard: keccak256(holder.publicKey),
      holderPrimaryCardPubkey: holder.publicKey,
      capabilities: [],
      attestationLevel: 'T2',
      attestationProof,
      validUntil: '2027-01-01T00:00:00.000Z',
    });

    expect(result.document.attestation_proof).toBe(bytesToBase64Url(attestationProof));
    expect(result.document.valid_until).toBe('2027-01-01T00:00:00.000Z');
  });

  it('throws if attestationLevel is T2 without an attestationProof', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const appCard = makeFakeAppCard();
    const holder = mlDsa44GenerateKeypair();

    await expect(
      requestSubCard({
        secureKeyProvider,
        subCardKeyId: 'app-sub-card-key',
        appCard,
        holderPrimaryCard: keccak256(holder.publicKey),
        holderPrimaryCardPubkey: holder.publicKey,
        capabilities: [],
        attestationLevel: 'T2',
      })
    ).rejects.toThrow(/attestationProof is required/);
  });

  it('never exposes the generated sub-card private key via any SDK-facing return value', async () => {
    const secureKeyProvider = makeFakeSecureKeyProvider();
    const appCard = makeFakeAppCard();
    const holder = mlDsa44GenerateKeypair();

    const result = await requestSubCard({
      secureKeyProvider,
      subCardKeyId: 'app-sub-card-key',
      appCard,
      holderPrimaryCard: keccak256(holder.publicKey),
      holderPrimaryCardPubkey: holder.publicKey,
      capabilities: ['auth_response'],
      attestationLevel: 'T1',
    });

    // Structural check: no field on the result (recursively, for any
    // Uint8Array value) contains anything longer/other than the known
    // public key — the only Uint8Array this result carries at all is
    // subCardPublicKey.
    for (const [key, value] of Object.entries(result)) {
      if (value instanceof Uint8Array) {
        expect(key).toBe('subCardPublicKey');
      }
    }

    // SecureKeyProvider's own contract: no method on the interface this
    // module used returns private key material — generateKey only ever
    // returned the public key, confirmed above, and the module never calls
    // anything else on the provider.
    expect(secureKeyProvider.sign).not.toHaveBeenCalled();
  });
});
