import { describe, it, expect, vi } from 'vitest';
import { assembleAndSignTargetedOffer } from '../../src/offers/targetedOffer.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';
import type { SecureKeyProvider } from '../../src/providers/SecureKeyProvider.js';

function makeFakeSecureKeyProvider(keyId: string, keypair: { publicKey: Uint8Array; secretKey: Uint8Array }): SecureKeyProvider {
  return {
    generateKey: vi.fn(async () => keypair.publicKey),
    sign: vi.fn(async (id: string, message: Uint8Array) => {
      if (id !== keyId) throw new Error(`no key for ${id}`);
      return mlDsa44Sign(keypair.secretKey, message);
    }),
    getPublicKey: vi.fn(async (id: string) => (id === keyId ? keypair.publicKey : undefined)),
    delete: vi.fn(),
  };
}

const ANCESTOR_A = mlDsa44GenerateKeypair();
const ANCESTOR_B = mlDsa44GenerateKeypair();

describe('assembleAndSignTargetedOffer', () => {
  it('serializes to the spec JSON shape and signs correctly, leaving recipient/holder/press fields absent', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid-123',
      issuerCard: 'issuer-card-pointer',
      pressCard: 'press-card-pointer',
      ancestryPubkeys: [ANCESTOR_A.publicKey, ANCESTOR_B.publicKey],
      fieldValues: { membership_tier: 'gold', display_name: 'Alice' },
      issuedAt: '2026-01-01T00:00:00.000Z',
    });

    // Protocol-required offer-phase fields.
    expect(offer.policy_id).toBe('policy-cid-123');
    expect(offer.issuer_card).toBe('issuer-card-pointer');
    expect(offer.press_card).toBe('press-card-pointer');
    expect(offer.issued_at).toBe('2026-01-01T00:00:00.000Z');
    expect(offer.ancestry_pubkeys).toEqual([bytesToBase64Url(ANCESTOR_A.publicKey), bytesToBase64Url(ANCESTOR_B.publicKey)]);
    expect(offer.issuer_signature).toBeTruthy();

    // Policy-defined fields merged in at the top level, per protocol-objects.md §1.
    expect(offer.membership_tier).toBe('gold');
    expect(offer.display_name).toBe('Alice');

    // Offer-phase fields are absent, not null (protocol convention).
    expect('recipient_pubkey' in offer).toBe(false);
    expect('holder_signature' in offer).toBe(false);
    expect('press_signature' in offer).toBe(false);
    expect('protocol_version' in offer).toBe(false);
    expect('past_keys' in offer).toBe(false);

    // issuer_signature verifies over canonical RFC 8785 JSON of every other field.
    const { issuer_signature, ...withoutSignature } = offer;
    expect(mlDsa44Verify(issuer.publicKey, canonicalize(withoutSignature), base64UrlToBytes(issuer_signature as string))).toBe(
      true
    );
  });

  it('includes past_keys, oldest-first, only when supplied', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);
    const oldKey = mlDsa44GenerateKeypair();

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: 'issuer-card',
      pressCard: 'press-card',
      ancestryPubkeys: [],
      fieldValues: {},
      pastKeys: [{ pubkey: oldKey.publicKey, validFrom: '2025-01-01T00:00:00.000Z', rotatedAt: '2025-06-01T00:00:00.000Z' }],
    });

    expect(offer.past_keys).toEqual([
      {
        pubkey: bytesToBase64Url(oldKey.publicKey),
        valid_from: '2025-01-01T00:00:00.000Z',
        rotated_at: '2025-06-01T00:00:00.000Z',
      },
    ]);
  });

  it('supports ancestry_pubkeys: [] for a card whose parent is (or is) a trusted root', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      issuerCard: 'issuer-card',
      pressCard: 'press-card',
      ancestryPubkeys: [],
      fieldValues: {},
    });

    expect(offer.ancestry_pubkeys).toEqual([]);
  });

  it('rejects fieldValues that use a protocol-reserved field name', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);

    await expect(
      assembleAndSignTargetedOffer({
        secureKeyProvider,
        issuerSigningKeyId: 'issuer-key',
        policyId: 'policy-cid',
        issuerCard: 'issuer-card',
        pressCard: 'press-card',
        ancestryPubkeys: [],
        fieldValues: { press_signature: 'not-allowed' },
      })
    ).rejects.toThrow(/protocol-reserved field name/);
  });
});
