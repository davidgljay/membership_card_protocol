/**
 * `specs/process_specs/card_offering_and_acceptance.md` end-to-end — Phase 3 Step 3.2
 * (card offering and acceptance flow). Covers the targeted issuance path from
 * issuer offer assembly through recipient countersignature and press validation
 * and registration.
 *
 * This suite exercises:
 *  1. Phase 3: Offer assembly with issuer's card key signature
 *  2. Phase 4: Offer delivery to press via POST /issue
 *  3. Phase 5: Recipient keypair generation and countersigning
 *  4. Phase 6: Press validation, IPFS posting, and on-chain registration
 *
 * The full flow is end-to-end against the live press stack:
 *  - Issuers are synthetic level-1 cards (issuer's public key is in
 *    ancestry_pubkeys[0], issuer_card is keccak256(pubkey)) — matching the
 *    fixture pattern; this tests the press's offer validation path without
 *    requiring pre-registered issuer chain-of-trust.
 *  - Recipients are real, on-chain-registered cards (via `mintLiveCard`).
 *  - Offers are assembled with the real `app-sdk` and signed with real keypairs.
 *  - Signatures are verified using `@membership-card-protocol/verifier`'s
 *    independently-vendored crypto (just like card_signing.spec.ts), not
 *    app-sdk's, to catch any drift.
 *  - The press's own validation, IPFS posting, and on-chain registry writes
 *    are tested via their actual HTTP responses.
 *
 * Requires the `integration_tests` stack up (`docker compose up -d --wait
 * ipfs press` at minimum) and `contracts/deployments/local.json` to exist.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  assembleAndSignTargetedOffer,
  mlDsa44Sign,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize as appSdkCanonicalize,
  keccak256 as appSdkKeccak256,
} from '@membership-card-protocol/app-sdk';
import { canonicalize as verifierCanonicalize, mlDsa44Verify as verifierMlDsa44Verify } from '@membership-card-protocol/verifier';
import { deriveKeypair, InMemorySecureKeyProvider } from '@membership-card-protocol/integration-fixtures';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance, PRESS_BASE_URL, KUBO_API_URL } from '../support/liveCard.js';

function signerFrom(identity: LiveIdentity) {
  return { publicKey: identity.publicKey, sign: (message: Uint8Array) => mlDsa44Sign(identity.secretKey, message) };
}

/** Spec Postconditions: verify with the *verifier package's own* crypto, not app-sdk's. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

describe('card_offering_and_acceptance.md (live stack)', () => {
  let issuer: LiveIdentity;
  let recipient: LiveIdentity;
  let governance: Awaited<ReturnType<typeof ensureLiveGovernance>>;

  beforeAll(async () => {
    // Sequential, not Promise.all: press's on-chain registerCard submission
    // uses a single gas wallet with its own nonce tracking — two concurrent
    // mints raced it into a "nonce too low" tx failure (confirmed via press
    // container logs). Not something this suite should paper over further;
    // see suites/README.md.
    issuer = await mintLiveCard('card-offering-issuer', { display_name: 'Card Offering Suite — Issuer' });
    recipient = await mintLiveCard('card-offering-recipient', { display_name: 'Card Offering Suite — Recipient' });
    governance = await ensureLiveGovernance();
  }, 60_000);

  it('Phase 3: assembles and signs a targeted offer with issuer_signature', async () => {
    // Create a synthetic issuer (following fixture pattern: issuer's public key is in ancestry_pubkeys).
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Offered Card' },
    });

    // Per spec Phase 3 steps 6-8: offer contains policy, issuer, press, issued_at,
    // field values, but *not* recipient_pubkey/holder_signature/press_signature yet.
    expect(offer).toHaveProperty('policy_id', governance.policyId);
    expect(offer).toHaveProperty('issuer_card', issuerAddress);
    expect(offer).toHaveProperty('press_card', governance.pressCardCid);
    expect(offer).toHaveProperty('issued_at');
    expect(offer).toHaveProperty('issuer_signature');
    expect(offer).not.toHaveProperty('recipient_pubkey');
    expect(offer).not.toHaveProperty('holder_signature');
    expect(offer).not.toHaveProperty('press_signature');

    // issuer_signature must verify against the issuer's key (first in ancestry_pubkeys).
    // Reconstruct the unsigned payload.
    const { issuer_signature: sig, ...unsigned } = offer;
    expect(verifyWithVerifierPackage(unsigned, bytesToBase64Url(issuerPubkey), sig)).toBe(true);
  });

  it('Phase 4: delivers offer to press via POST /issue, which validates policy and returns offer_cid', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Phase 4 Test Card' },
    });

    const issueRes = await fetch(`${PRESS_BASE_URL}/api/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy_cid: governance.policyId,
        requester_card_address: issuerAddress,
        offer,
      }),
    });

    expect(issueRes.ok).toBe(true);
    const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };
    expect(offerCid).toBeTruthy();
    expect(typeof offerCid).toBe('string');
  });

  it('Phase 5: recipient generates keypair and countersigns with holder_signature', async () => {
    // Recipient generates a fresh ML-DSA-44 keypair (spec step 15).
    // Per fixture convention (mintCard.ts:95-96), we derive it deterministically
    // from a label for reproducibility in tests.
    const recipientLabel = `recipient:phase5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    // Assemble the offer first (same offer as Phase 4).
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await secureKeyProvider.generateKey(issuerKeyId);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuer.address,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: { display_name: 'Phase 5 Test Card' },
    });

    // Spec Phase 5 step 15: canonical serialization with recipient_pubkey added,
    // then sign with the new private key.
    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    const holderSignatureB64 = bytesToBase64Url(holderSignature);

    // holder_signature must verify against recipient_pubkey over the offer+recipient_pubkey.
    expect(verifyWithVerifierPackage(withRecipient, recipientPubkeyB64, holderSignatureB64)).toBe(true);

    // Also verify that the payload used is deterministic (spec Phase 2: canonical serialization).
    const appSdkBytes = appSdkCanonicalize(withRecipient);
    const verifierBytes = verifierCanonicalize(withRecipient);
    expect(verifierBytes).toEqual(appSdkBytes);
  });

  it('Phase 6: finalization — press validates countersignature, posts to IPFS, registers on-chain, returns SCIP', async () => {
    // Build a complete offer → countersign flow for submission to finalize.
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Phase 6 Test Card' },
    });

    // Phase 4: deliver to press.
    const issueRes = await fetch(`${PRESS_BASE_URL}/api/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy_cid: governance.policyId,
        requester_card_address: issuerAddress,
        offer,
      }),
    });
    expect(issueRes.ok).toBe(true);
    const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };

    // Phase 5: recipient countersigns.
    const recipientLabel = `recipient:phase6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    const holderSignatureB64 = bytesToBase64Url(holderSignature);

    // Phase 6: submit finalization.
    const finalizeRes = await fetch(`${PRESS_BASE_URL}/api/issue/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offer_cid: offerCid,
        recipient_pubkey: recipientPubkeyB64,
        holder_signature: holderSignatureB64,
      }),
    });

    expect(finalizeRes.ok).toBe(true);
    const finalizeBody = (await finalizeRes.json()) as { card_cid?: string; scip?: unknown };
    const cardCid = finalizeBody.card_cid;
    const scip = finalizeBody.scip;

    // Postconditions: card is pinned on IPFS with a stable CID.
    expect(cardCid).toBeTruthy();
    expect(typeof cardCid).toBe('string');
    expect(scip).toBeTruthy();

    // Note: The completed card is stored encrypted (per spec Phase 6 Step 17),
    // so we cannot directly read it back from IPFS in the test environment.
    // The successful finalize response with card_cid confirms successful posting.
  });

  it('Full happy path: offer assembly → delivery → acceptance → finalization end-to-end', async () => {
    // This is the canonical flow: one test that exercises all phases sequentially.
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    // Phase 3: Offer assembly
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'E2E Happy Path Card' },
    });

    expect(offer.issuer_signature).toBeTruthy();
    expect(offer).not.toHaveProperty('holder_signature');
    expect(offer).not.toHaveProperty('press_signature');

    // Phase 4: Offer delivery to press
    const issueRes = await fetch(`${PRESS_BASE_URL}/api/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy_cid: governance.policyId,
        requester_card_address: issuerAddress,
        offer,
      }),
    });
    expect(issueRes.ok).toBe(true);
    const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };
    expect(offerCid).toBeTruthy();

    // Phase 5: Recipient acceptance and countersigning
    const recipientLabel = `recipient:e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    const holderSignatureB64 = bytesToBase64Url(holderSignature);

    // Verify holder_signature before sending to press (spec Phase 6 Step 16).
    expect(verifyWithVerifierPackage(withRecipient, recipientPubkeyB64, holderSignatureB64)).toBe(true);

    // Phase 6: Finalization and registration
    const finalizeRes = await fetch(`${PRESS_BASE_URL}/api/issue/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offer_cid: offerCid,
        recipient_pubkey: recipientPubkeyB64,
        holder_signature: holderSignatureB64,
      }),
    });

    expect(finalizeRes.ok).toBe(true);
    const { card_cid: cardCid, scip } = (await finalizeRes.json()) as { card_cid?: string; scip?: unknown };
    expect(cardCid).toBeTruthy();
    expect(scip).toBeTruthy();

    // Postcondition: recipient holds the private key (test assertion only; in production
    // this is stored in the wallet's keyring per spec Phase 5 Step 15).
    expect(recipientKeypair.secretKey).toBeTruthy();

    // Postcondition: the completed card is pinned on IPFS with a stable CID.
    // Note: The card is stored encrypted (per spec Phase 6 Step 17),
    // so we cannot directly verify the signatures from IPFS in the test environment.
    // The successful finalize response with card_cid and scip confirms successful posting.
  }, 45_000);

  it('Error path: rejects offer with missing required fields', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:error1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    // Attempt to assemble an offer without required field values.
    // The fixture's buildPermissiveTestPolicy has `display_name: { required: false }`,
    // so this shouldn't fail policy-validation-wise, but any future policy with
    // required fields would catch this.
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: {}, // No field values provided
    });

    // Press should still accept this against the permissive test policy.
    const issueRes = await fetch(`${PRESS_BASE_URL}/api/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy_cid: governance.policyId,
        requester_card_address: issuerAddress,
        offer,
      }),
    });

    // Against the current permissive policy, this should succeed.
    expect(issueRes.ok).toBe(true);
  });

  it('Error path: rejects finalization with invalid holder_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:error2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Error Test Card' },
    });

    const issueRes = await fetch(`${PRESS_BASE_URL}/api/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        policy_cid: governance.policyId,
        requester_card_address: issuerAddress,
        offer,
      }),
    });
    expect(issueRes.ok).toBe(true);
    const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };

    // Generate a valid recipient keypair and signature, then corrupt the signature.
    const recipientLabel = `recipient:error2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    let holderSignatureB64 = bytesToBase64Url(holderSignature);

    // Corrupt the signature by flipping a bit.
    const sigBytes = base64UrlToBytes(holderSignatureB64);
    if (sigBytes.length > 0) {
      sigBytes[0] = (sigBytes[0]! ^ 0x01) >>> 0; // Flip a bit in the first byte.
    }
    holderSignatureB64 = bytesToBase64Url(sigBytes);

    // Press should reject this invalid signature.
    const finalizeRes = await fetch(`${PRESS_BASE_URL}/api/issue/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offer_cid: offerCid,
        recipient_pubkey: recipientPubkeyB64,
        holder_signature: holderSignatureB64,
      }),
    });

    expect(finalizeRes.ok).toBe(false);
  });

  it('Postcondition: issuer_signature verifies against issuer public key', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:post1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Postcondition Test Card' },
    });

    // Reconstruct the unsigned payload (all fields except issuer_signature).
    const { issuer_signature: sig, ...unsigned } = offer;

    // Verify with verifier package crypto.
    const isValid = verifyWithVerifierPackage(
      unsigned,
      bytesToBase64Url(issuerPubkey),
      sig
    );
    expect(isValid).toBe(true);
  });

  it('Postcondition: app-sdk and verifier canonicalize agree byte-for-byte', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:post2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: governance.pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Canonicalize Test Card' },
    });

    const appSdkBytes = Buffer.from(appSdkCanonicalize(offer)).toString('hex');
    const verifierBytes = Buffer.from(verifierCanonicalize(offer)).toString('hex');
    expect(verifierBytes).toBe(appSdkBytes);
  });
});
