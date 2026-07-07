import { describe, it, expect, vi } from 'vitest';
import { assembleAndSignOpenOffer } from '../../src/offers/openOffer.js';
import { mlDsa44GenerateKeypair, mlDsa44Sign, mlDsa44Verify } from '../../src/crypto/mldsa.js';
import { canonicalize } from '../../src/crypto/canonicalize.js';
import { keccak256 } from '../../src/crypto/hashes.js';
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

describe('assembleAndSignOpenOffer', () => {
  it('serializes to the spec JSON shape, signs correctly, and computes a matching offer_id', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);

    const { offer, offerId, claimLink } = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: 'press-card-pointer',
      issuerCard: 'issuer-card-pointer',
      issuerPubkey: issuer.publicKey,
      maxAcceptances: 100,
      expiresAt: '2099-01-01T00:00:00.000Z',
      displayMessage: 'Welcome!',
      redirectUrl: 'https://example.com/onboard',
      proposedFields: { membership_tier: 'silver' },
    });

    expect(offer.offer_type).toBe('open');
    expect(offer.policy_id).toBe('policy-cid');
    expect(offer.press_card).toBe('press-card-pointer');
    expect(offer.issuer_card).toBe('issuer-card-pointer');
    expect(offer.issuer_pubkey).toBe(bytesToBase64Url(issuer.publicKey));
    expect(offer.max_acceptances).toBe(100);
    expect(offer.expires_at).toBe('2099-01-01T00:00:00.000Z');
    expect(offer.display_message).toBe('Welcome!');
    expect(offer.redirect_url).toBe('https://example.com/onboard');
    expect(offer.proposed_fields).toEqual({ membership_tier: 'silver' });
    expect(offer.issuer_signature).toBeTruthy();

    // issuer_signature verifies over canonical RFC 8785 JSON of every field
    // except itself, including issuer_pubkey.
    const { issuer_signature, ...withoutSignature } = offer;
    expect(mlDsa44Verify(issuer.publicKey, canonicalize(withoutSignature), base64UrlToBytes(issuer_signature))).toBe(true);

    // offer_id = keccak256(canonical RFC 8785 JSON of the complete document
    // including issuer_signature) — protocol-objects.md §6.
    expect(offerId).toBe(keccak256(canonicalize(offer)));

    // Claim link carries base64url of the same canonical bytes offerId was
    // computed from.
    const encoded = claimLink.replace('mcard://claim?o=', '');
    expect(base64UrlToBytes(encoded)).toEqual(canonicalize(offer));
  });

  it('defaults max_acceptances/expires_at to null when omitted, with acknowledgeUnconstrained required', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);

    await expect(
      assembleAndSignOpenOffer({
        secureKeyProvider,
        issuerSigningKeyId: 'issuer-key',
        policyId: 'policy-cid',
        pressCard: 'press-card',
        issuerCard: 'issuer-card',
        issuerPubkey: issuer.publicKey,
        proposedFields: {},
      })
    ).rejects.toThrow(/acknowledgeUnconstrained/);

    const { offer } = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: 'issuer-key',
      policyId: 'policy-cid',
      pressCard: 'press-card',
      issuerCard: 'issuer-card',
      issuerPubkey: issuer.publicKey,
      proposedFields: {},
      acknowledgeUnconstrained: true,
    });
    expect(offer.max_acceptances).toBeNull();
    expect(offer.expires_at).toBeNull();
  });

  it('rejects an expires_at already in the past', async () => {
    const issuer = mlDsa44GenerateKeypair();
    const secureKeyProvider = makeFakeSecureKeyProvider('issuer-key', issuer);

    await expect(
      assembleAndSignOpenOffer({
        secureKeyProvider,
        issuerSigningKeyId: 'issuer-key',
        policyId: 'policy-cid',
        pressCard: 'press-card',
        issuerCard: 'issuer-card',
        issuerPubkey: issuer.publicKey,
        maxAcceptances: 10,
        expiresAt: '2000-01-01T00:00:00.000Z',
        proposedFields: {},
      })
    ).rejects.toThrow(/expires_at must be in the future/);
  });

  it('produces a different offer_id for a different issuer signature (unforgeable, unique per issuer)', async () => {
    const issuerA = mlDsa44GenerateKeypair();
    const issuerB = mlDsa44GenerateKeypair();

    const resultA = await assembleAndSignOpenOffer({
      secureKeyProvider: makeFakeSecureKeyProvider('key', issuerA),
      issuerSigningKeyId: 'key',
      policyId: 'policy-cid',
      pressCard: 'press-card',
      issuerCard: 'issuer-card-a',
      issuerPubkey: issuerA.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });
    const resultB = await assembleAndSignOpenOffer({
      secureKeyProvider: makeFakeSecureKeyProvider('key', issuerB),
      issuerSigningKeyId: 'key',
      policyId: 'policy-cid',
      pressCard: 'press-card',
      issuerCard: 'issuer-card-b',
      issuerPubkey: issuerB.publicKey,
      maxAcceptances: 10,
      proposedFields: {},
    });

    expect(resultA.offerId).not.toBe(resultB.offerId);
  });
});
