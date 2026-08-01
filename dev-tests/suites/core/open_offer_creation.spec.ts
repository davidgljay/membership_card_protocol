/**
 * `specs/process_specs/open_offer_creation.md` end-to-end, against the live
 * dev deployment. Ported from
 * integration_tests/suites/core/open_offer_creation.spec.ts unchanged in
 * test logic -- only import sources changed: published `app-sdk`/`verifier`,
 * `InMemorySecureKeyProvider` from `../../support/keys.js`, and the press's
 * own card CID fetched via `getPressCardCid()` instead of carried on a
 * `governance` bootstrap result (see `card_offering_and_acceptance.spec.ts`'s
 * file header for why).
 *
 * Covers the issuer-side assembly, signing, and short-form claim-link
 * generation for open card offers:
 *  1. Phase 1: Offer assembly with all required and optional fields
 *  2. Phase 2: Signing with issuer's sub-card key and offer ID computation
 *  3. Short-form claim link generation (`mcard://claim?o=...`)
 *  4. Signature verification (including tampering detection)
 *  5. Error cases (unconstrained offers without acknowledgment, expired expiresAt)
 *
 * Scope notes, unchanged from the original:
 *  - Phase 3 (hosted-form claim link serving) is out of scope: the spec
 *    flags an open architecture question about which component owns this
 *    endpoint.
 *  - Claim-redemption (Phase 4 Distribution) is covered by separate suites
 *    (`open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  assembleAndSignOpenOffer,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize as appSdkCanonicalize,
  keccak256 as appSdkKeccak256,
} from '@membership-card-protocol/app-sdk';
import { canonicalize as verifierCanonicalize, mlDsa44Verify as verifierMlDsa44Verify } from '@membership-card-protocol/verifier';
import { InMemorySecureKeyProvider } from '../../support/keys.js';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance, getPressCardCid } from '../../support/liveCard.js';

/** Verify signature with the verifier package's own crypto, not app-sdk's. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

describe('open_offer_creation.md (live dev deployment)', () => {
  let issuer: LiveIdentity;
  let governance: ReturnType<typeof ensureLiveGovernance>;
  let pressCardCid: string;

  beforeAll(async () => {
    issuer = await mintLiveCard('open-offer-issuer', { display_name: 'Open Offer Suite — Issuer' });
    governance = ensureLiveGovernance();
    pressCardCid = await getPressCardCid();
  }, 60_000);

  it('Phase 1 + Phase 2: assembles and signs an open offer with issuer_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-phase1-2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 100,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      displayMessage: 'Claim your card here!',
      redirectUrl: 'https://example.com/onboarding',
      proposedFields: { display_name: 'Open Offer Test Card' },
      acknowledgeUnconstrained: false,
    });

    expect(result.offer).toHaveProperty('offer_type', 'open');
    expect(result.offer).toHaveProperty('policy_id', governance.policyId);
    expect(result.offer).toHaveProperty('press_card', pressCardCid);
    expect(result.offer).toHaveProperty('issuer_card', issuer.address);
    expect(result.offer).toHaveProperty('issuer_pubkey');
    expect(result.offer).toHaveProperty('max_acceptances', 100);
    expect(result.offer).toHaveProperty('expires_at');
    expect(result.offer).toHaveProperty('display_message', 'Claim your card here!');
    expect(result.offer).toHaveProperty('redirect_url', 'https://example.com/onboarding');
    expect(result.offer).toHaveProperty('proposed_fields', { display_name: 'Open Offer Test Card' });

    expect(result.offer).toHaveProperty('issuer_signature');
    expect(typeof result.offer.issuer_signature).toBe('string');
    expect(result.offer.issuer_signature.length).toBeGreaterThan(0);

    expect(result.offerId).toBeTruthy();
    expect(typeof result.offerId).toBe('string');
    expect(result.offerId).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('Phase 2: issuer_signature verifies against issuer_pubkey', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-sig-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 50,
      proposedFields: { display_name: 'Signature Test Card' },
      acknowledgeUnconstrained: false,
    });

    const { issuer_signature: sig, ...unsigned } = result.offer;

    const isValid = verifyWithVerifierPackage(unsigned, bytesToBase64Url(issuerPubkey), sig);
    expect(isValid).toBe(true);
  });

  it('Phase 2: offer_id is derived from canonical JSON of complete document including issuer_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-offerid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 25,
      proposedFields: { display_name: 'Offer ID Test Card' },
      acknowledgeUnconstrained: false,
    });

    const canonicalBytes = appSdkCanonicalize(result.offer);
    const expectedOfferId = appSdkKeccak256(canonicalBytes);
    expect(result.offerId).toBe(expectedOfferId);
  });

  it('Phase 3: generates short-form claim link mcard://claim?o=...', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-claimlink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 10,
      proposedFields: { display_name: 'Claim Link Test Card' },
      acknowledgeUnconstrained: false,
    });

    expect(result.claimLink).toMatch(/^mcard:\/\/claim\?o=[A-Za-z0-9_-]+$/);

    const linkMatch = result.claimLink.match(/\?o=(.+)$/);
    expect(linkMatch).toBeTruthy();
    const encodedOffer = linkMatch![1]!;
    const decodedOffer = base64UrlToBytes(encodedOffer);
    const canonicalBytes = appSdkCanonicalize(result.offer);
    expect(decodedOffer).toEqual(canonicalBytes);
  });

  it('Error path: rejects unconstrained offer (both max_acceptances and expires_at null) without acknowledgeUnconstrained', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-unconstrained-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    let caught = false;
    let errorMessage = '';
    try {
      await assembleAndSignOpenOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        pressCard: pressCardCid,
        issuerCard: issuer.address,
        issuerPubkey,
        maxAcceptances: null,
        expiresAt: null,
        proposedFields: { display_name: 'Unconstrained Test Card' },
      });
    } catch (err) {
      caught = true;
      errorMessage = (err as Error).message;
    }

    expect(caught).toBe(true);
    expect(errorMessage).toContain('acknowledgeUnconstrained');
  });

  it('Error path: permits unconstrained offer only with acknowledgeUnconstrained: true', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-unconstrained-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: null,
      expiresAt: null,
      proposedFields: { display_name: 'Unconstrained Acknowledged Card' },
      acknowledgeUnconstrained: true,
    });

    expect(result.offer.max_acceptances).toBe(null);
    expect(result.offer.expires_at).toBe(null);
    expect(result.offer.issuer_signature).toBeTruthy();
    expect(result.offerId).toBeTruthy();
  });

  it('Error path: rejects expires_at in the past', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-expiry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    let caught = false;
    let errorMessage = '';
    try {
      await assembleAndSignOpenOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        pressCard: pressCardCid,
        issuerCard: issuer.address,
        issuerPubkey,
        maxAcceptances: 5,
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        proposedFields: { display_name: 'Expired Test Card' },
      });
    } catch (err) {
      caught = true;
      errorMessage = (err as Error).message;
    }

    expect(caught).toBe(true);
    expect(errorMessage).toContain('expires_at');
  });

  it('Postcondition: tampering with issuer_pubkey invalidates issuer_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-tamper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 30,
      proposedFields: { display_name: 'Tamper Test Card' },
      acknowledgeUnconstrained: false,
    });

    const tamperedOffer = { ...result.offer };
    const tamperedKeyBytes = base64UrlToBytes(tamperedOffer.issuer_pubkey);
    if (tamperedKeyBytes.length > 0) {
      tamperedKeyBytes[0] = (tamperedKeyBytes[0]! ^ 0x01) >>> 0;
    }
    tamperedOffer.issuer_pubkey = bytesToBase64Url(tamperedKeyBytes);

    const { issuer_signature: sig, ...unsigned } = tamperedOffer;

    const isValid = verifyWithVerifierPackage(unsigned, tamperedOffer.issuer_pubkey, sig);
    expect(isValid).toBe(false);
  });

  it('Postcondition: tampering with proposed_fields invalidates issuer_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-tamper-fields-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 20,
      proposedFields: { display_name: 'Original Name' },
      acknowledgeUnconstrained: false,
    });

    const tamperedOffer = {
      ...result.offer,
      proposed_fields: { display_name: 'Tampered Name' },
    };

    const { issuer_signature: sig, ...unsigned } = tamperedOffer;

    const isValid = verifyWithVerifierPackage(unsigned, bytesToBase64Url(issuerPubkey), sig);
    expect(isValid).toBe(false);
  });

  it('Postcondition: app-sdk and verifier canonicalize agree byte-for-byte', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-canon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 15,
      proposedFields: { display_name: 'Canonicalize Test Card' },
      acknowledgeUnconstrained: false,
    });

    const appSdkBytes = Buffer.from(appSdkCanonicalize(result.offer)).toString('hex');
    const verifierBytes = Buffer.from(verifierCanonicalize(result.offer)).toString('hex');
    expect(verifierBytes).toBe(appSdkBytes);
  });

  it('Full happy path: offer assembly → signing → claim link end-to-end', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 100,
      expiresAt: new Date(Date.now() + 604800000).toISOString(),
      displayMessage: 'Join our community!',
      redirectUrl: 'https://example.com/welcome',
      proposedFields: {
        display_name: 'E2E Happy Path Card',
        role: 'member',
      },
      acknowledgeUnconstrained: false,
    });

    expect(result.offer.offer_type).toBe('open');
    expect(result.offer.policy_id).toBe(governance.policyId);
    expect(result.offer.issuer_card).toBe(issuer.address);
    expect(result.offer.max_acceptances).toBe(100);
    expect(result.offer.display_message).toBe('Join our community!');
    expect(result.offer.issuer_signature).toBeTruthy();

    const { issuer_signature: sig, ...unsigned } = result.offer;
    const isValid = verifyWithVerifierPackage(unsigned, bytesToBase64Url(issuerPubkey), sig);
    expect(isValid).toBe(true);

    const canonicalBytes = appSdkCanonicalize(result.offer);
    const expectedOfferId = appSdkKeccak256(canonicalBytes);
    expect(result.offerId).toBe(expectedOfferId);

    expect(result.claimLink).toMatch(/^mcard:\/\/claim\?o=[A-Za-z0-9_-]+$/);
    const linkMatch = result.claimLink.match(/\?o=(.+)$/);
    const encodedOffer = linkMatch![1]!;
    const decodedOffer = base64UrlToBytes(encodedOffer);
    expect(decodedOffer).toEqual(canonicalBytes);
  });
});
