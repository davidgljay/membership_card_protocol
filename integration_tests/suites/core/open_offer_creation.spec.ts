/**
 * `specs/process_specs/open_offer_creation.md` end-to-end — Phase 3 Wave 1
 * (open offer creation flow). Covers the issuer-side assembly, signing,
 * and short-form claim-link generation for open card offers.
 *
 * This suite exercises:
 *  1. Phase 1: Offer assembly with all required and optional fields
 *  2. Phase 2: Signing with issuer's sub-card key and offer ID computation
 *  3. Short-form claim link generation (`mcard://claim?o=...`)
 *  4. Signature verification (including tampering detection)
 *  5. Error cases (unconstrained offers without acknowledgment, expired expiresAt)
 *
 * Scope notes:
 *  - Phase 3 (hosted-form claim link serving) is out of scope: the spec
 *    flags an open architecture question about which component owns this
 *    endpoint (`wallet.md` and `press.md` don't define it yet).
 *  - Claim-redemption (Phase 4 Distribution) is covered by separate suites
 *    (`open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`).
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * ipfs press` at minimum) and `contracts/deployments/local.json` to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  assembleAndSignOpenOffer,
  mlDsa44Sign,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize as appSdkCanonicalize,
  keccak256 as appSdkKeccak256,
} from '@membership-card-protocol/app-sdk';
import { canonicalize as verifierCanonicalize, mlDsa44Verify as verifierMlDsa44Verify } from '@membership-card-protocol/verifier';
import { deriveKeypair, InMemorySecureKeyProvider } from '@membership-card-protocol/integration-fixtures';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance } from '../support/liveCard.js';

/** Verify signature with the verifier package's own crypto, not app-sdk's. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

describe('open_offer_creation.md (live stack)', () => {
  let issuer: LiveIdentity;
  let governance: Awaited<ReturnType<typeof ensureLiveGovernance>>;

  beforeAll(async () => {
    // Sequential, not Promise.all: press's on-chain registerCard submission
    // uses a single gas wallet with its own nonce tracking — see suites/README.md.
    issuer = await mintLiveCard('open-offer-issuer', { display_name: 'Open Offer Suite — Issuer' });
    governance = await ensureLiveGovernance();
  }, 60_000);

  it('Phase 1 + Phase 2: assembles and signs an open offer with issuer_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-phase1-2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 100,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), // 24h in future
      displayMessage: 'Claim your card here!',
      redirectUrl: 'https://example.com/onboarding',
      proposedFields: { display_name: 'Open Offer Test Card' },
      acknowledgeUnconstrained: false,
    });

    // Per spec Phase 1 Steps 2–3: offer contains all specified fields.
    expect(result.offer).toHaveProperty('offer_type', 'open');
    expect(result.offer).toHaveProperty('policy_id', governance.policyId);
    expect(result.offer).toHaveProperty('press_card', governance.pressCardCid);
    expect(result.offer).toHaveProperty('issuer_card', issuer.address);
    expect(result.offer).toHaveProperty('issuer_pubkey');
    expect(result.offer).toHaveProperty('max_acceptances', 100);
    expect(result.offer).toHaveProperty('expires_at');
    expect(result.offer).toHaveProperty('display_message', 'Claim your card here!');
    expect(result.offer).toHaveProperty('redirect_url', 'https://example.com/onboarding');
    expect(result.offer).toHaveProperty('proposed_fields', { display_name: 'Open Offer Test Card' });

    // Per spec Phase 2 Step 5: issuer_signature is present (signed with issuer's sub-card key).
    expect(result.offer).toHaveProperty('issuer_signature');
    expect(typeof result.offer.issuer_signature).toBe('string');
    expect(result.offer.issuer_signature.length).toBeGreaterThan(0);

    // Per spec Phase 2 Step 6: offer_id is computed.
    expect(result.offerId).toBeTruthy();
    expect(typeof result.offerId).toBe('string');
    // offer_id should be a keccak256 hash (hex, 64 chars).
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
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 50,
      proposedFields: { display_name: 'Signature Test Card' },
      acknowledgeUnconstrained: false,
    });

    // Reconstruct the unsigned payload (all fields except issuer_signature).
    const { issuer_signature: sig, ...unsigned } = result.offer;

    // Verify with verifier package crypto.
    const isValid = verifyWithVerifierPackage(
      unsigned,
      bytesToBase64Url(issuerPubkey),
      sig
    );
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
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 25,
      proposedFields: { display_name: 'Offer ID Test Card' },
      acknowledgeUnconstrained: false,
    });

    // Per spec Phase 2 Step 6: offer_id = hash(canonical JSON of complete offer including signature).
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
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 10,
      proposedFields: { display_name: 'Claim Link Test Card' },
      acknowledgeUnconstrained: false,
    });

    // Per spec Phase 3 Step 8: short-form claim link.
    expect(result.claimLink).toMatch(/^mcard:\/\/claim\?o=[A-Za-z0-9_-]+$/);

    // The claim link contains the base64url-encoded canonical offer.
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

    // Attempt to assemble an unconstrained offer without acknowledgment.
    let caught = false;
    let errorMessage = '';
    try {
      await assembleAndSignOpenOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        pressCard: governance.pressCardCid,
        issuerCard: issuer.address,
        issuerPubkey,
        maxAcceptances: null,
        expiresAt: null,
        proposedFields: { display_name: 'Unconstrained Test Card' },
        // acknowledgeUnconstrained: false (default)
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

    // Assemble an unconstrained offer WITH acknowledgment.
    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: null,
      expiresAt: null,
      proposedFields: { display_name: 'Unconstrained Acknowledged Card' },
      acknowledgeUnconstrained: true,
    });

    // Should succeed with null constraints.
    expect(result.offer.max_acceptances).toBe(null);
    expect(result.offer.expires_at).toBe(null);
    expect(result.offer.issuer_signature).toBeTruthy();
    expect(result.offerId).toBeTruthy();
  });

  it('Error path: rejects expires_at in the past', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-expiry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    // Attempt to assemble an offer with expires_at already in the past.
    let caught = false;
    let errorMessage = '';
    try {
      await assembleAndSignOpenOffer({
        secureKeyProvider,
        issuerSigningKeyId: issuerKeyId,
        policyId: governance.policyId,
        pressCard: governance.pressCardCid,
        issuerCard: issuer.address,
        issuerPubkey,
        maxAcceptances: 5,
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour in past
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
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 30,
      proposedFields: { display_name: 'Tamper Test Card' },
      acknowledgeUnconstrained: false,
    });

    // Tamper with issuer_pubkey in the offer.
    const tamperedOffer = { ...result.offer };
    const tamperedKeyBytes = base64UrlToBytes(tamperedOffer.issuer_pubkey);
    if (tamperedKeyBytes.length > 0) {
      tamperedKeyBytes[0] = (tamperedKeyBytes[0]! ^ 0x01) >>> 0; // Flip a bit
    }
    tamperedOffer.issuer_pubkey = bytesToBase64Url(tamperedKeyBytes);

    // Reconstruct unsigned payload with tampered pubkey.
    const { issuer_signature: sig, ...unsigned } = tamperedOffer;

    // Verification should fail against the tampered pubkey.
    const isValid = verifyWithVerifierPackage(
      unsigned,
      tamperedOffer.issuer_pubkey,
      sig
    );
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
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 20,
      proposedFields: { display_name: 'Original Name' },
      acknowledgeUnconstrained: false,
    });

    // Tamper with a field value.
    const tamperedOffer = {
      ...result.offer,
      proposed_fields: { display_name: 'Tampered Name' },
    };

    // Reconstruct unsigned payload with tampered fields.
    const { issuer_signature: sig, ...unsigned } = tamperedOffer;

    // Verification should fail.
    const isValid = verifyWithVerifierPackage(
      unsigned,
      bytesToBase64Url(issuerPubkey),
      sig
    );
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
      pressCard: governance.pressCardCid,
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
    // This is the canonical flow: one test that exercises all phases sequentially.
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:open-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);

    // Phase 1: Offer assembly
    const result = await assembleAndSignOpenOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      pressCard: governance.pressCardCid,
      issuerCard: issuer.address,
      issuerPubkey,
      maxAcceptances: 100,
      expiresAt: new Date(Date.now() + 604800000).toISOString(), // 7 days in future
      displayMessage: 'Join our community!',
      redirectUrl: 'https://example.com/welcome',
      proposedFields: {
        display_name: 'E2E Happy Path Card',
        role: 'member',
      },
      acknowledgeUnconstrained: false,
    });

    // Postcondition: offer is fully assembled with all fields.
    expect(result.offer.offer_type).toBe('open');
    expect(result.offer.policy_id).toBe(governance.policyId);
    expect(result.offer.issuer_card).toBe(issuer.address);
    expect(result.offer.max_acceptances).toBe(100);
    expect(result.offer.display_message).toBe('Join our community!');
    expect(result.offer.issuer_signature).toBeTruthy();

    // Postcondition: issuer_signature verifies.
    const { issuer_signature: sig, ...unsigned } = result.offer;
    const isValid = verifyWithVerifierPackage(
      unsigned,
      bytesToBase64Url(issuerPubkey),
      sig
    );
    expect(isValid).toBe(true);

    // Postcondition: offer_id is deterministic.
    const canonicalBytes = appSdkCanonicalize(result.offer);
    const expectedOfferId = appSdkKeccak256(canonicalBytes);
    expect(result.offerId).toBe(expectedOfferId);

    // Postcondition: claim link is properly formatted and encodes the offer.
    expect(result.claimLink).toMatch(/^mcard:\/\/claim\?o=[A-Za-z0-9_-]+$/);
    const linkMatch = result.claimLink.match(/\?o=(.+)$/);
    const encodedOffer = linkMatch![1]!;
    const decodedOffer = base64UrlToBytes(encodedOffer);
    expect(decodedOffer).toEqual(canonicalBytes);
  });
});
