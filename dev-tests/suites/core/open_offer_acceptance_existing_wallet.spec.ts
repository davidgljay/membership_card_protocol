/**
 * `specs/process_specs/open_offer_acceptance_existing_wallet.md` end-to-end,
 * against the live dev deployment. Ported from
 * integration_tests/suites/core/open_offer_acceptance_existing_wallet.spec.ts
 * unchanged in test logic -- only import sources changed (published
 * `app-sdk`/`verifier`, `governance`/`pressCardCid` obtained the same way as
 * `card_offering_and_acceptance.spec.ts`).
 *
 * Key difference from the new-wallet flow: wallet setup is skipped
 * entirely -- the recipient already has an active passkey, master keypair,
 * and device sub-card; this suite only covers key generation for the new
 * card, claim assembly/countersigning, submission, and press validation
 * (identical at the press level to the new-wallet flow).
 *
 * Known issue, unchanged from the original (same as the new-wallet suite):
 * press/src/handlers/open-offer.ts hardcodes `ancestry: []` -- every card
 * issued via open-offer claim currently looks like its own trusted root.
 * The happy-path `it.todo` is blocked for the same chain-of-trust reason as
 * the new-wallet suite and `card_validation.spec.ts`.
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

describe('open_offer_acceptance_existing_wallet.md (live dev deployment)', () => {
  let issuer: LiveIdentity;
  let governance: ReturnType<typeof ensureLiveGovernance>;
  let pressCardCid: string;

  beforeAll(async () => {
    issuer = await mintLiveCard('open-offer-acceptance-existing-issuer', {
      display_name: 'Open Offer Acceptance (Existing Wallet) Suite — Issuer',
    });
    governance = ensureLiveGovernance();
    pressCardCid = await getPressCardCid();
  }, 60_000);

  it.todo('Phase 3 + Phase 4: happy path — existing wallet claims open offer, press issues card', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 10,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      display_message: 'Existing wallet holder, claim your new card!',
      redirect_url: 'https://example.com/existing-wallet-onboarded',
      proposed_fields: { display_name: 'Existing Wallet Open Offer Card' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const newCardKeypair = mlDsa44GenerateKeypair();
    const newCardPubkeyB64 = bytesToBase64Url(newCardKeypair.publicKey);

    const claimPayload = {
      offer,
      recipient_pubkey: newCardPubkeyB64,
    };

    const claimBytes = appSdkCanonicalize(claimPayload);
    const claimSignature = mlDsa44Sign(newCardKeypair.secretKey, claimBytes);
    const claimSignatureB64 = bytesToBase64Url(claimSignature);

    const claimSubmission = {
      claim_payload: claimPayload,
      recipient_signature: claimSignatureB64,
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

    const claimVerifies = verifyWithVerifierPackage(claimPayload, newCardPubkeyB64, claimSignatureB64);
    expect(claimVerifies).toBe(true);
  });

  it('Phase 3 + Phase 4 Error path: P-06 rejects invalid recipient_signature', async () => {
    const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
      offer_type: 'open',
      policy_id: governance.policyId,
      press_card: pressCardCid,
      issuer_card: issuer.address,
      issuer_pubkey: bytesToBase64Url(issuer.publicKey),
      max_acceptances: 5,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      proposed_fields: { display_name: 'Invalid Sig Test (Existing Wallet)' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const newCardKeypair = mlDsa44GenerateKeypair();
    const newCardPubkeyB64 = bytesToBase64Url(newCardKeypair.publicKey);

    const claimPayload = {
      offer,
      recipient_pubkey: newCardPubkeyB64,
    };

    const validSignature = mlDsa44Sign(newCardKeypair.secretKey, appSdkCanonicalize(claimPayload));
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
      proposed_fields: { display_name: 'Sig Verify Test (Existing Wallet)' },
    };

    const issuerSignature = mlDsa44Sign(issuer.secretKey, appSdkCanonicalize(unsignedOffer));
    const offer: SignedOpenCardOffer = {
      ...unsignedOffer,
      issuer_signature: bytesToBase64Url(issuerSignature),
    };

    const newCardKeypair = mlDsa44GenerateKeypair();
    const newCardPubkeyB64 = bytesToBase64Url(newCardKeypair.publicKey);
    const claimPayload = {
      offer,
      recipient_pubkey: newCardPubkeyB64,
    };

    const claimBytes = appSdkCanonicalize(claimPayload);
    const claimSignature = mlDsa44Sign(newCardKeypair.secretKey, claimBytes);
    const claimSignatureB64 = bytesToBase64Url(claimSignature);

    const isValid = verifyWithVerifierPackage(claimPayload, newCardPubkeyB64, claimSignatureB64);
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
      proposed_fields: { display_name: 'Type Test (Existing Wallet)' },
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
      proposed_fields: { display_name: 'Issuer Verify Test (Existing Wallet)' },
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
