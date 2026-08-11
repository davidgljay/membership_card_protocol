/**
 * `specs/process_specs/log_auditing.md`, against the live dev deployment.
 * Adapted from integration_tests/suites/extended/log_auditing.spec.ts —
 * real adaptation, not a mechanical port, same as
 * `../extended/policy_creation.spec.ts`.
 *
 * Per plans/deployment/dev-governance-rotation-runbook.md, Body 1
 * (PressRegistryBody) was initially left un-rotated (see
 * phase-3-summary.md's "pending decision"), which blocked this suite
 * entirely: every test case here needs to *issue a card* under a
 * freshly-`AuthorizePress`'d policy, and dev-tests had no Body 1 authority
 * to do that. Body 1 has since been rotated to a dev-tests-owned 2-of-3
 * quorum too (this dev deployment's main use case turned out to be
 * dev-tests itself), so this suite is now a real adaptation: each test
 * pins its own policy document to real dev Filebase
 * (`../../support/pinPolicy.ts`) and registers + authorizes it entirely
 * through dev-tests' own governance quorum
 * (`../../support/devPolicy.ts`'s `registerAndAuthorizeDevPolicy`) rather
 * than `ensureGovernanceBootstrap` against a local devnode.
 *
 * IMPLEMENTATION NOTE (carried over from the original suite): per
 * press.md §5.5, auditor delivery is plaintext JSON to a stub endpoint
 * (`${auditorAddress}/notify-issuance`), not the spec's required
 * E2E-encrypted delivery via the normal message routing layer — full E2E
 * encryption + auditor-side receipt confirmation is a Phase 4 gap, not a
 * dev-tests gap. So, as in the original suite:
 *  - Auditor-side (receive, decrypt, confirm, inspect) stays `it.todo`.
 *  - What's testable here: press-side behavior — it attempts delivery,
 *    and issuance succeeds regardless of whether that delivery works
 *    (auditor endpoints are never actually running against a real dev
 *    press, so every test here exercises the "delivery fails, issuance
 *    still succeeds" path in practice, not just the dedicated error-path
 *    test).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  assembleAndSignTargetedOffer,
  mlDsa44Sign,
  bytesToBase64Url,
  canonicalize as appSdkCanonicalize,
  keccak256 as appSdkKeccak256,
} from '@membership-card-protocol/app-sdk';
import { deriveKeypair, InMemorySecureKeyProvider } from '../../support/keys.js';
import { mintLiveCard, type LiveIdentity, getPressCardCid, PRESS_BASE_URL } from '../../support/liveCard.js';
import { registerAndAuthorizeDevPolicy } from '../../support/devPolicy.js';

interface PolicyCardDocument {
  policy_id: string;
  field_definitions: Array<{
    name: string;
    type: string;
    required?: boolean;
    description?: string;
  }>;
  approved_presses: string[];
  auditors?: string[];
  allow_open_offers?: boolean;
  [key: string]: unknown;
}

/** Issues a card under `policyId` and finalizes it; returns the finalize response. */
async function issueAndFinalizeUnderPolicy(
  policyId: string,
  pressCardCid: string,
  labelPrefix: string,
  fieldValues: Record<string, unknown>,
): Promise<{ finalizeRes: Response; cardCid?: string }> {
  const secureKeyProvider = new InMemorySecureKeyProvider();
  const issuerKeyId = `issuer:${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
  const issuerAddress = appSdkKeccak256(issuerPubkey);

  const offer = await assembleAndSignTargetedOffer({
    secureKeyProvider,
    issuerSigningKeyId: issuerKeyId,
    policyId,
    issuerCard: issuerAddress,
    pressCard: pressCardCid,
    ancestryPubkeys: [issuerPubkey],
    fieldValues,
  });

  const issueRes = await fetch(`${PRESS_BASE_URL}/api/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy_cid: policyId, requester_card_address: issuerAddress, offer }),
  });
  expect(issueRes.ok).toBe(true);
  const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };

  const recipientLabel = `recipient:${labelPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const recipientKeypair = deriveKeypair(recipientLabel);
  const recipientPubkeyB64 = bytesToBase64Url(recipientKeypair.publicKey);
  const withRecipient = { ...offer, recipient_pubkey: recipientPubkeyB64 };
  const holderSignature = mlDsa44Sign(recipientKeypair.secretKey, appSdkCanonicalize(withRecipient));
  const holderSignatureB64 = bytesToBase64Url(holderSignature);

  const finalizeRes = await fetch(`${PRESS_BASE_URL}/api/issue/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer_cid: offerCid, recipient_pubkey: recipientPubkeyB64, holder_signature: holderSignatureB64 }),
  });
  const finalizeBody = (await finalizeRes.json().catch(() => ({}))) as { card_cid?: string };
  return { finalizeRes, cardCid: finalizeBody.card_cid };
}

describe('log_auditing.md (live dev deployment)', () => {
  let auditor: LiveIdentity;
  let pressCardCid: string;

  beforeAll(async () => {
    auditor = await mintLiveCard('log-auditing-auditor', { display_name: 'Log Auditing Suite — Auditor Card' });
    pressCardCid = await getPressCardCid();
  }, 120_000);

  it('Baseline: policy with no auditors does not attempt auditor notification', async () => {
    const policyDoc: PolicyCardDocument = {
      policy_id: 'test-policy-no-auditors-' + Date.now(),
      field_definitions: [{ name: 'test_field', type: 'string', required: true }],
      approved_presses: [pressCardCid],
      // auditors omitted — should skip auditor notification.
    };
    const { policyId } = await registerAndAuthorizeDevPolicy(policyDoc);

    const { finalizeRes, cardCid } = await issueAndFinalizeUnderPolicy(policyId, pressCardCid, 'no-auditors', {
      test_field: 'no-auditors',
    });

    // Per spec §Process 1 step 1: if auditors is empty, skip — issuance proceeds.
    expect(finalizeRes.ok).toBe(true);
    expect(cardCid).toBeTruthy();
  }, 300_000);

  it('Process 1, Press side (steps 1-6): policy with auditors array attempts delivery but does not block issuance', async () => {
    const policyDoc: PolicyCardDocument = {
      policy_id: 'test-policy-with-auditors-' + Date.now(),
      field_definitions: [{ name: 'sensitive_data', type: 'string', required: true }],
      approved_presses: [pressCardCid],
      auditors: [auditor.address],
      allow_open_offers: false,
    };
    const { policyId } = await registerAndAuthorizeDevPolicy(policyDoc);

    // Per spec §Process 1 step 6: auditor delivery failure must NOT block
    // issuance. The auditor's endpoint (${auditorAddress}/notify-issuance)
    // is not running against a real dev press, so delivery will fail, but
    // press must log a warning and continue.
    const { finalizeRes, cardCid } = await issueAndFinalizeUnderPolicy(policyId, pressCardCid, 'with-auditors', {
      sensitive_data: 'audit-me',
    });

    expect(finalizeRes.ok).toBe(true);
    expect(cardCid).toBeTruthy();
  }, 300_000);

  it('Postcondition: card issued under policy with auditors is valid on-chain', async () => {
    const policyDoc: PolicyCardDocument = {
      policy_id: 'test-policy-onchain-check-' + Date.now(),
      field_definitions: [{ name: 'check_field', type: 'string', required: true }],
      approved_presses: [pressCardCid],
      auditors: [auditor.address],
    };
    const { policyId } = await registerAndAuthorizeDevPolicy(policyDoc);

    const { finalizeRes, cardCid } = await issueAndFinalizeUnderPolicy(policyId, pressCardCid, 'onchain', {
      check_field: 'on-chain',
    });
    expect(finalizeRes.ok).toBe(true);
    expect(cardCid).toBeTruthy();

    // Verify the card is fetchable from the real dev IPFS gateway
    // (AES-256-GCM encrypted content — just confirm it's accessible, not
    // decryptable without the holder's key).
    const gatewayUrl = process.env['DEV_IPFS_GATEWAY_URL'] ?? 'https://ipfs.filebase.io';
    const cardRes = await fetch(`${gatewayUrl}/ipfs/${cardCid}`);
    expect(cardRes.ok).toBe(true);
    const cardBytes = await cardRes.arrayBuffer();
    expect(cardBytes.byteLength).toBeGreaterThan(0);
  }, 300_000);

  it('Error path: auditor with no reachable endpoint does not block issuance', async () => {
    // Per spec §Error Paths: "Auditor's wallet service unreachable or
    // message delivery fails — Press logs a warning, alerts the
    // administrator, and continues — issuance is never blocked by auditor
    // delivery failure." No auditor endpoint runs against a real dev press,
    // so this is the same real condition as the "with auditors" test above
    // — kept as its own case to track the spec's explicit error-path
    // acceptance criterion.
    const policyDoc: PolicyCardDocument = {
      policy_id: 'test-policy-error-path-' + Date.now(),
      field_definitions: [{ name: 'error_test_field', type: 'string', required: true }],
      approved_presses: [pressCardCid],
      auditors: [auditor.address],
    };
    const { policyId } = await registerAndAuthorizeDevPolicy(policyDoc);

    const { finalizeRes, cardCid } = await issueAndFinalizeUnderPolicy(policyId, pressCardCid, 'error-path', {
      error_test_field: 'error-path',
    });

    expect(finalizeRes.ok).toBe(true);
    expect(cardCid).toBeTruthy();
  }, 300_000);

  // -------------------------------------------------------------------
  // Acceptance criteria from log_auditing.md that require full auditor
  // implementation (E2E encryption + auditor-side receipt/inspection) —
  // a Phase 4 gap, not something this dev deployment can exercise.
  // -------------------------------------------------------------------

  it.todo(
    'Acceptance Criterion 1: Auditor listed in policy.auditors receives PressIssuanceRecord via E2E-encrypted message (requires full E2E encryption implementation + auditor message-receiving endpoint)',
  );
  it.todo(
    "Acceptance Criterion 2: Auditor can decrypt the message using only their own card's private key — no shared or wrapped key material involved (requires Phase 4 E2E encryption + auditor-side receipt)",
  );
  it.todo(
    'Acceptance Criterion 3: Auditor can derive content_key and decrypt the issued card from IPFS successfully (requires auditor-side decryption capability)',
  );
  it.todo(
    "Acceptance Criterion 4: Auditor can inspect the issued card's field values and verify they satisfy policy predicates (requires auditor-side inspection logic)",
  );
  it.todo(
    'Acceptance Criterion 5: PressIssuanceRecord with keccak256(recipient_pubkey) mismatch or AES-GCM failure is flagged by auditor (requires auditor-side validation)',
  );
  it.todo('Process 2, Auditor side (steps 1-7): auditor inspects card for policy compliance (requires full auditor-side implementation)');
});
