import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assembleAndSignTargetedOffer,
  assembleAndSignOpenOffer,
  mlDsa44Verify,
  canonicalize,
  base64UrlToBytes,
} from '@membership-card-protocol/app-sdk';
import { WebCryptoSecureKeyProvider } from '../../src/SecureKeyProvider.js';

/**
 * Step 3.1b Scenario test (web provider set): Offer construction
 * end-to-end using the real WebCryptoSecureKeyProvider.
 *
 * Confirms: (1) both assembleAndSignTargetedOffer and assembleAndSignOpenOffer
 * work with real key storage/signing, (2) the resulting offer's signature
 * verifies against the issuer's public key.
 */

describe('Offer construction end-to-end (Step 3.1b, web provider set)', () => {
  let provider: WebCryptoSecureKeyProvider;

  beforeEach(() => {
    provider = new WebCryptoSecureKeyProvider();
  });

  afterEach(async () => {
    const keys = ['issuer-card-key', 'issuer-key-2'];
    for (const keyId of keys) {
      try {
        await provider.delete(keyId);
      } catch {
        // Key may not exist; this is okay.
      }
    }
  });

  it('assembles and signs a targeted offer using a real SecureKeyProvider, and the signature verifies', async () => {
    // Generate and store the issuer's card key via the provider.
    const issuerPubkey = await provider.generateKey('issuer-card-key');

    // Assemble a targeted offer.
    const offerResult = await assembleAndSignTargetedOffer({
      secureKeyProvider: provider,
      issuerSigningKeyId: 'issuer-card-key',
      policyId: 'policy:example.com/policy-1',
      issuerCard: 'issuer:example.com/issuer-card',
      pressCard: 'press:example.com/press',
      ancestryPubkeys: [], // Direct child of root
      fieldValues: {
        name: 'Test Card',
        level: 1,
      },
    });

    expect(offerResult).toBeDefined();
    expect(offerResult.issuer_signature).toBeDefined();
    expect(offerResult.policy_id).toBe('policy:example.com/policy-1');
    expect(offerResult.issuer_card).toBe('issuer:example.com/issuer-card');
    // Field values are spread into the offer object itself
    expect(offerResult.name).toBe('Test Card');
    expect(offerResult.level).toBe(1);

    // Verify the signature by re-canonicalizing and checking against the issuer's public key.
    const unsignedOffer = { ...offerResult };
    delete unsignedOffer.issuer_signature;

    const signatureBytes = base64UrlToBytes(offerResult.issuer_signature);
    const canonicalUnsigned = canonicalize(unsignedOffer);

    // Verify using the key that was actually generated in the provider.
    const isValid = mlDsa44Verify(issuerPubkey, canonicalUnsigned, signatureBytes);
    expect(isValid).toBe(true);
  });

  it('assembles and signs an open offer using a real SecureKeyProvider, and the signature verifies', async () => {
    // Generate and store the issuer's card key.
    const generatedPubkey = await provider.generateKey('issuer-card-key');

    // Set a future expiration.
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    // Assemble an open offer.
    const offerResult = await assembleAndSignOpenOffer({
      secureKeyProvider: provider,
      issuerSigningKeyId: 'issuer-card-key',
      policyId: 'policy:example.com/policy-1',
      pressCard: 'press:example.com/press',
      issuerCard: 'issuer:example.com/issuer-card',
      issuerPubkey: generatedPubkey,
      maxAcceptances: 100,
      expiresAt: futureDate.toISOString(),
      displayMessage: 'Welcome!',
      proposedFields: {
        tier: 'premium',
        region: 'us-west',
      },
    });

    expect(offerResult).toBeDefined();
    expect(offerResult.offer).toBeDefined();
    expect(offerResult.offerId).toBeDefined();
    expect(offerResult.claimLink).toBeDefined();
    expect(offerResult.claimLink).toMatch(/^mcard:\/\/claim\?o=/);

    const offer = offerResult.offer;
    expect(offer.offer_type).toBe('open');
    expect(offer.policy_id).toBe('policy:example.com/policy-1');
    expect(offer.max_acceptances).toBe(100);
    expect(offer.display_message).toBe('Welcome!');
    expect(offer.issuer_signature).toBeDefined();

    // Verify the signature.
    const unsignedOffer = { ...offer };
    delete unsignedOffer.issuer_signature;

    const signatureBytes = base64UrlToBytes(offer.issuer_signature);
    const canonicalUnsigned = canonicalize(unsignedOffer);

    const isValid = mlDsa44Verify(generatedPubkey, canonicalUnsigned, signatureBytes);
    expect(isValid).toBe(true);
  });

  it('confirms that both offer types can be constructed sequentially from the same SecureKeyProvider without interference', async () => {
    // Generate a key for use across both offers.
    await provider.generateKey('issuer-card-key');

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);

    // Construct a targeted offer.
    const targetedResult = await assembleAndSignTargetedOffer({
      secureKeyProvider: provider,
      issuerSigningKeyId: 'issuer-card-key',
      policyId: 'policy:example.com/policy-1',
      issuerCard: 'issuer:example.com/issuer-card',
      pressCard: 'press:example.com/press',
      ancestryPubkeys: [],
      fieldValues: { name: 'Targeted' },
    });

    expect(targetedResult.issuer_signature).toBeDefined();

    // Construct an open offer from the same key.
    const issuerPubkey = await provider.getPublicKey('issuer-card-key');
    expect(issuerPubkey).toBeDefined();

    const openResult = await assembleAndSignOpenOffer({
      secureKeyProvider: provider,
      issuerSigningKeyId: 'issuer-card-key',
      policyId: 'policy:example.com/policy-2',
      pressCard: 'press:example.com/press',
      issuerCard: 'issuer:example.com/issuer-card',
      issuerPubkey: issuerPubkey!,
      maxAcceptances: 50,
      expiresAt: futureDate.toISOString(),
      proposedFields: { tier: 'basic' },
    });

    expect(openResult.offer.issuer_signature).toBeDefined();

    // Both signatures should be well-formed and different (since the offers differ).
    expect(targetedResult.issuer_signature).not.toBe(openResult.offer.issuer_signature);

    // Both should verify against the same public key.
    const targetedUnsigned = { ...targetedResult };
    delete targetedUnsigned.issuer_signature;
    const targetedSigBytes = base64UrlToBytes(targetedResult.issuer_signature);
    const targetedCanonical = canonicalize(targetedUnsigned);

    const openUnsigned = { ...openResult.offer };
    delete openUnsigned.issuer_signature;
    const openSigBytes = base64UrlToBytes(openResult.offer.issuer_signature);
    const openCanonical = canonicalize(openUnsigned);

    // Verify both against the issuer's public key (retrieved earlier).
    const targetedIsValid = mlDsa44Verify(issuerPubkey!, targetedCanonical, targetedSigBytes);
    const openIsValid = mlDsa44Verify(issuerPubkey!, openCanonical, openSigBytes);

    expect(targetedIsValid).toBe(true);
    expect(openIsValid).toBe(true);
  });
});
