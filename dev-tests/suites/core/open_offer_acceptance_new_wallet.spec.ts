/**
 * `specs/process_specs/open_offer_acceptance_new_wallet.md` end-to-end,
 * against the live dev deployment. Ported from
 * integration_tests/suites/core/open_offer_acceptance_new_wallet.spec.ts
 * unchanged in test logic -- only import sources changed (published
 * `app-sdk`/`verifier`, `governance`/`pressCardCid` obtained the same way
 * as `card_offering_and_acceptance.spec.ts`).
 *
 * Covers the flow where a first-time recipient claims an open offer,
 * generating a fresh keypair for the new card:
 *  1. Phase 1: Offer verification before display (issuer binding, signature, chain)
 *  2. Phase 3: Keypair generation and claim assembly
 *  3. Claim countersigning and submission to press via HTTP
 *  4. Phase 4: Press validation (recipient signature, offer expiry/capacity)
 *  5. Error paths (invalid recipient signature, capacity exhaustion)
 *
 * Scope notes and known issue, unchanged from the original:
 *  - Phase 2 (wallet setup) is wallet-service responsibility, out of scope.
 *  - press/src/handlers/open-offer.ts hardcodes `ancestry: []` when
 *    assembling the completed card ("Phase 3 placeholder") -- every card
 *    issued via open-offer claim currently looks like its own trusted root.
 *    This suite does not verify ancestry propagation.
 *  - The happy-path `it.todo` is blocked for the same reason as
 *    `card_validation.spec.ts`'s primary test: press's evaluatePredicates
 *    requires the issuer's card chain to reach a trusted root, which
 *    `mintLiveCard`'s synthetic issuer doesn't have.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mlDsa44GenerateKeypair,
  mlDsa44Sign,
  bytesToBase64Url,
  base64UrlToBytes,
  canonicalize as appSdkCanonicalize,
} from '@membership-card-protocol/app-sdk';
import type { SignedOpenCardOffer } from '@membership-card-protocol/app-sdk';
import { canonicalize as verifierCanonicalize, mlDsa44Verify as verifierMlDsa44Verify } from '@membership-card-protocol/verifier';
import { mintLiveCard, type LiveIdentity, ensureLiveGovernance, getPressCardCid, PRESS_BASE_URL } from '../../support/liveCard.js';

/** Verify signature with the verifier package's own crypto, not app-sdk's. */
function verifyWithVerifierPackage(payload: unknown, publicKeyB64: string, signatureB64: string): boolean {
  return verifierMlDsa44Verify(
    base64UrlToBytes(publicKeyB64),
    verifierCanonicalize(payload),
    base64UrlToBytes(signatureB64)
  );
}

describe('open_offer_acceptance_new_wallet.md (live dev deployment)', () => {
  let issuer: LiveIdentity;
  let governance: ReturnType<typeof ensureLiveGovernance>;
  let pressCardCid: string;

  beforeAll(async () => {
    issuer = await mintLiveCard('open-offer-acceptance-issuer', {
      display_name: 'Open Offer Acceptance Suite — Issuer',
    });
    governance = ensureLiveGovernance();
    pressCardCid = await getPressCardCid();
  }, 60_000);

  it.todo('Phase 3 + Phase 4: happy path — new wallet claims open offer, press issues card', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 10,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      display_message: 'Welcome to the open offer!',
      redirect_url: 'https://example.com/onboarded',
      proposed_fields: { display_name: 'Open Offer Acceptance Test Card' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const recipientKeypair = mlDsa44GenerateKeypair();
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);

    const claimPayload = {
      offer,
      recipient_pubkey: recipientPubkeyB64,
    };

    const claimBytes = appSdkCanonicalize(claimPayload);
    const recipientSignature = mlDsa44Sign(recipientKeypair.secretKey, claimBytes);
    const recipientSignatureB64 = bytesToBase64Url(recipientSignature);

    const claimSubmission = {
      claim_payload: claimPayload,
      recipient_signature: recipientSignatureB64,
    };

    const pressResponse = await fetch(`${PRESS_BASE_URL}/api/open-offer/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claimSubmission),
    });

    if (!pressResponse.ok) {
      const errorBody = await pressResponse.json();
      console.error('Press error:', pressResponse.status, errorBody);
    }
    expect(pressResponse.ok).toBe(true);
    const { card_cid: cardCid, scip } = (await pressResponse.json()) as {
      card_cid: string;
      scip: { nonce: string; timestamp: number; proof: string };
    };

    expect(cardCid).toBeTruthy();
    expect(typeof cardCid).toBe('string');

    expect(scip).toHaveProperty('nonce');
    expect(scip).toHaveProperty('timestamp');
    expect(scip).toHaveProperty('proof');

    const claimVerifies = verifyWithVerifierPackage(claimPayload, recipientPubkeyB64, recipientSignatureB64);
    expect(claimVerifies).toBe(true);
  });

  it('Error path: P-06 rejects invalid recipient_signature', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 5,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      proposed_fields: { display_name: 'Invalid Sig Test Card' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const recipientKeypair = mlDsa44GenerateKeypair();
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);
    const claimPayload = {
      offer,
      recipient_pubkey: recipientPubkeyB64,
    };

    const validSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(claimPayload));
    const corruptedSigBytes = new Uint8Array(validSignature);
    if (corruptedSigBytes.length > 0) {
      corruptedSigBytes[0] = (corruptedSigBytes[0]! ^ 0x01) >>> 0;
    }
    const invalidSignatureB64 = bytesToBase64Url(corruptedSigBytes);

    const claimSubmission = {
      claim_payload: claimPayload,
      recipient_signature: invalidSignatureB64,
    };

    const pressResponse = await fetch(`${PRESS_BASE_URL}/api/open-offer/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claimSubmission),
    });

    expect(pressResponse.status).not.toBe(200);
    const errorBody = (await pressResponse.json()) as { pressCode?: string; message?: string };
    expect(errorBody.pressCode || errorBody.message).toContain('P-06');
  });

  it('Postcondition: recipient_signature verifies correctly with verifier crypto', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 3,
      expires_at: null,
      proposed_fields: { display_name: 'Sig Verify Test Card' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const recipientKeypair = mlDsa44GenerateKeypair();
    const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);
    const claimPayload = {
      offer,
      recipient_pubkey: recipientPubkeyB64,
    };

    const claimBytes = appSdkCanonicalize(claimPayload);
    const recipientSignature = mlDsa44Sign(recipientKeypair.secretKey, claimBytes);
    const recipientSignatureB64 = bytesToBase64Url(recipientSignature);

    const isValid = verifyWithVerifierPackage(claimPayload, recipientPubkeyB64, recipientSignatureB64);
    expect(isValid).toBe(true);
  });

  it('Postcondition: offer_type is "open" in all generated offers', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 7,
      expires_at: null,
      proposed_fields: { display_name: 'Type Test Card' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    expect(offer.offer_type).toBe('open');
  });

  it('Postcondition: offer issuer_signature verifies against issuer_pubkey', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 4,
      expires_at: null,
      proposed_fields: { display_name: 'Issuer Verify Test Card' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const { issuer_signature: sig, ...unsigned } = offer;

    const isValid = verifyWithVerifierPackage(unsigned, bytesToBase64Url(issuer.publicKey), sig);
    expect(isValid).toBe(true);
  });

  it.todo('Error path: P-07 rejects expired offer (if expiry setup is straightforward)');

  it.todo('Error path: P-08 rejects capacity-exhausted offer (second claim when max_acceptances: 1)');
});
