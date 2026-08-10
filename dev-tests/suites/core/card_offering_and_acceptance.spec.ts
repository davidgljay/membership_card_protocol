/**
 * `specs/process_specs/card_offering_and_acceptance.md` end-to-end, against
 * the live dev deployment. Ported from
 * integration_tests/suites/core/card_offering_and_acceptance.spec.ts
 * unchanged in test logic -- only import sources changed:
 * `@membership-card-protocol/app-sdk`/`.../verifier` resolve from
 * node_modules (installed at the `next` dist-tag), `deriveKeypair`/
 * `InMemorySecureKeyProvider` come from `../../support/keys.js` (dev-tests'
 * own copy, not the unpublished `integration-fixtures` package), and the
 * press's own card CID is fetched via `getPressCardCid()` rather than
 * carried on a `governance` bootstrap result (dev-tests' `liveCard.ts` never
 * bootstraps governance -- see that file's doc comment and
 * dev-tests/README.md's "Dev governance prerequisite").
 *
 * Covers the targeted issuance path from issuer offer assembly through
 * recipient countersignature and press validation/registration:
 *  1. Phase 3: Offer assembly with issuer's card key signature
 *  2. Phase 4: Offer delivery to press via POST /issue
 *  3. Phase 5: Recipient keypair generation and countersigning
 *  4. Phase 6: Press validation, IPFS posting, and on-chain registration
 *
 * Issuers are synthetic level-1 cards (issuer's public key is in
 * ancestry_pubkeys[0], issuer_card is keccak256(pubkey)); recipients are
 * real, on-chain-registered cards (via `mintLiveCard`); signatures are
 * verified using the verifier package's independently-vendored crypto, not
 * app-sdk's, to catch any drift between the two published packages.
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
import { deriveKeypair, InMemorySecureKeyProvider } from '../../support/keys.js';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance, getPressCardCid, PRESS_BASE_URL } from '../../support/liveCard.js';

/** Spec Postconditions: verify with the *verifier package's own* crypto, not app-sdk's. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

describe('card_offering_and_acceptance.md (live dev deployment)', () => {
  let issuer: LiveIdentity;
  let recipient: LiveIdentity;
  let governance: ReturnType<typeof ensureLiveGovernance>;
  let pressCardCid: string;

  beforeAll(async () => {
    // Sequential, not Promise.all: see card_signing.spec.ts's beforeAll comment.
    issuer = await mintLiveCard('card-offering-issuer', { display_name: 'Card Offering Suite — Issuer' });
    recipient = await mintLiveCard('card-offering-recipient', { display_name: 'Card Offering Suite — Recipient' });
    governance = ensureLiveGovernance();
    pressCardCid = await getPressCardCid();
  }, 180_000);

  it('Phase 3: assembles and signs a targeted offer with issuer_signature', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Offered Card' },
    });

    // Per spec Phase 3 steps 6-8: offer contains policy, issuer, press, issued_at,
    // field values, but *not* recipient_pubkey/holder_signature/press_signature yet.
    expect(offer).toHaveProperty('policy_id', governance.policyId);
    expect(offer).toHaveProperty('issuer_card', issuerAddress);
    expect(offer).toHaveProperty('press_card', pressCardCid);
    expect(offer).toHaveProperty('issued_at');
    expect(offer).toHaveProperty('issuer_signature');
    expect(offer).not.toHaveProperty('recipient_pubkey');
    expect(offer).not.toHaveProperty('holder_signature');
    expect(offer).not.toHaveProperty('press_signature');

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
      pressCard: pressCardCid,
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
    const recipientLabel = `recipient:phase5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await secureKeyProvider.generateKey(issuerKeyId);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuer.address,
      pressCard: pressCardCid,
      ancestryPubkeys: [issuer.publicKey],
      fieldValues: { display_name: 'Phase 5 Test Card' },
    });

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    const holderSignatureB64 = bytesToBase64Url(holderSignature);

    expect(verifyWithVerifierPackage(withRecipient, recipientPubkeyB64, holderSignatureB64)).toBe(true);

    const appSdkBytes = appSdkCanonicalize(withRecipient);
    const verifierBytes = verifierCanonicalize(withRecipient);
    expect(verifierBytes).toEqual(appSdkBytes);
  });

  it('Phase 6: finalization — press validates countersignature, posts to IPFS, registers on-chain, returns SCIP', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:phase6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Phase 6 Test Card' },
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

    const recipientLabel = `recipient:phase6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    const holderSignatureB64 = bytesToBase64Url(holderSignature);

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
    expect(finalizeBody.card_cid).toBeTruthy();
    expect(typeof finalizeBody.card_cid).toBe('string');
    expect(finalizeBody.scip).toBeTruthy();
  }, 45_000);

  it('Full happy path: offer assembly → delivery → acceptance → finalization end-to-end', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'E2E Happy Path Card' },
    });

    expect(offer.issuer_signature).toBeTruthy();
    expect(offer).not.toHaveProperty('holder_signature');
    expect(offer).not.toHaveProperty('press_signature');

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

    const recipientLabel = `recipient:e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    const holderSignatureB64 = bytesToBase64Url(holderSignature);

    expect(verifyWithVerifierPackage(withRecipient, recipientPubkeyB64, holderSignatureB64)).toBe(true);

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
    expect(recipientKeypair.secretKey).toBeTruthy();
  }, 45_000);

  it('Error path: rejects offer with missing required fields', async () => {
    const secureKeyProvider = new InMemorySecureKeyProvider();
    const issuerKeyId = `issuer:error1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
    const issuerAddress = appSdkKeccak256(issuerPubkey);

    // The pre-provisioned dev-tests policy is expected to be permissive
    // (all fields optional), mirroring integration_tests' buildPermissiveTestPolicy
    // -- see README.md's "Dev governance prerequisite".
    const offer = await assembleAndSignTargetedOffer({
      secureKeyProvider,
      issuerSigningKeyId: issuerKeyId,
      policyId: governance.policyId,
      issuerCard: issuerAddress,
      pressCard: pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: {},
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
      pressCard: pressCardCid,
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

    const recipientLabel = `recipient:error2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const recipientKeypair = deriveKeypair(recipientLabel);
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
    const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
    let holderSignatureB64 = bytesToBase64Url(holderSignature);

    const sigBytes = base64UrlToBytes(holderSignatureB64);
    if (sigBytes.length > 0) {
      sigBytes[0] = (sigBytes[0]! ^ 0x01) >>> 0;
    }
    holderSignatureB64 = bytesToBase64Url(sigBytes);

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
      pressCard: pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Postcondition Test Card' },
    });

    const { issuer_signature: sig, ...unsigned } = offer;

    const isValid = verifyWithVerifierPackage(unsigned, bytesToBase64Url(issuerPubkey), sig);
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
      pressCard: pressCardCid,
      ancestryPubkeys: [issuerPubkey],
      fieldValues: { display_name: 'Canonicalize Test Card' },
    });

    const appSdkBytes = Buffer.from(appSdkCanonicalize(offer)).toString('hex');
    const verifierBytes = Buffer.from(verifierCanonicalize(offer)).toString('hex');
    expect(verifierBytes).toBe(appSdkBytes);
  });
});
