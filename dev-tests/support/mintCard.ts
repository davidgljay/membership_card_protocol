/**
 * Mints a fresh, spec-conformant card against the live dev press instance —
 * exercises the real `POST /issue` -> `POST /issue/finalize` flow using
 * app-sdk's actual `assembleAndSignTargetedOffer` (the real client SDK
 * function every wallet uses), not a reimplementation.
 *
 * Ported from integration_tests/fixtures/src/mintCard.ts unchanged in logic
 * -- only the import source changed (app-sdk resolves from node_modules at
 * the `next` dist-tag here, not a monorepo `file:` path) and the doc
 * comment's cross-references. See that file's original for the full
 * scope-and-rationale comment on why a synthetic level-1 issuer is
 * sufficient and wallet-sdk's own keyring/review flow is deliberately not
 * exercised here.
 *
 * Requires DEV_TESTS_POLICY_ID to already be a real, pinned, press-trusting
 * policy on the live dev registry (see dev-tests/README.md's "Dev
 * governance prerequisite") -- this helper never creates or pins a policy
 * itself.
 */

import {
  assembleAndSignTargetedOffer,
  canonicalize,
  mlDsa44Sign,
  keccak256,
  bytesToBase64Url,
} from '@membership-card-protocol/app-sdk';
import { InMemorySecureKeyProvider, deriveKeypair } from './keys.js';

export interface MintCardOptions {
  /** Dev press's base URL, e.g. `https://press-dev.<account>.workers.dev`. */
  pressBaseUrl: string;
  /** CID of the pre-provisioned dev policy document (see README.md). */
  policyId: string;
  /** Distinguishes this mint's keys from any other dev-tests run sharing the same seed namespace. */
  label: string;
  fieldValues?: Record<string, unknown>;
}

export interface MintedCard {
  cardCid: string;
  scip: unknown;
  issuerAddress: string;
  holderPublicKey: Uint8Array;
}

/**
 * The issuer for a dev-tests mint is a synthetic level-1 card: its own
 * `ancestry_pubkeys` is `[]`, and its on-chain address is
 * `keccak256(issuerPubkey)` -- it acts as its own immediate parent
 * reference for the new card being minted (protocol-objects.md §1's
 * "ancestry_pubkeys: [] if issuerCard is itself a trusted root or its
 * immediate parent is" case, with the issuer playing that role).
 */
export async function mintCard(options: MintCardOptions): Promise<MintedCard> {
  const issuerKeyId = `issuer:${options.label}`;
  const secureKeyProvider = new InMemorySecureKeyProvider();
  const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
  const issuerAddress = keccak256(issuerPubkey);

  const pressBaseUrl = options.pressBaseUrl.replace(/\/$/, '');

  const offer = await assembleAndSignTargetedOffer({
    secureKeyProvider,
    issuerSigningKeyId: issuerKeyId,
    policyId: options.policyId,
    issuerCard: issuerAddress,
    pressCard: await fetchPressCardCid(pressBaseUrl),
    ancestryPubkeys: [issuerPubkey],
    fieldValues: options.fieldValues ?? {},
  });

  const issueRes = await fetch(`${pressBaseUrl}/api/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      policy_cid: options.policyId,
      requester_card_address: issuerAddress,
      offer,
    }),
  });
  if (!issueRes.ok) {
    throw new Error(`mintCard: POST /issue failed: HTTP ${issueRes.status}: ${await issueRes.text()}`);
  }
  const { offer_cid: offerCid } = (await issueRes.json()) as { offer_cid: string };

  const holder = deriveKeypair(`holder:${options.label}`);
  const holderPubkeyB64 = bytesToBase64Url(holder.publicKey);
  const withRecipient = { ...offer, recipient_pubkey: holderPubkeyB64 };
  const holderSignature = mlDsa44Sign(holder.secretKey, canonicalize(withRecipient));

  const finalizeRes = await fetch(`${pressBaseUrl}/api/issue/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer_cid: offerCid,
      recipient_pubkey: holderPubkeyB64,
      holder_signature: bytesToBase64Url(holderSignature),
    }),
  });
  if (!finalizeRes.ok) {
    throw new Error(`mintCard: POST /issue/finalize failed: HTTP ${finalizeRes.status}: ${await finalizeRes.text()}`);
  }
  const { card_cid: cardCid, scip } = (await finalizeRes.json()) as { card_cid: string; scip: unknown };

  return { cardCid, scip, issuerAddress, holderPublicKey: holder.publicKey };
}

/**
 * The offer's `press_card` field must equal the dev press's own
 * `PRESS_CARD_CID` exactly -- see the original fixture's identical comment
 * in integration_tests/fixtures/src/mintCard.ts for the full explanation
 * (press's `handleIssueFinalize` overwrites `press_card` before
 * re-verifying `holder_signature`).
 */
async function fetchPressCardCid(pressBaseUrl: string): Promise<string> {
  const res = await fetch(`${pressBaseUrl}/api/press`);
  if (!res.ok) {
    throw new Error(`mintCard: GET /press failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { press_card_cid?: string };
  if (!body.press_card_cid) {
    throw new Error('mintCard: GET /press response did not include press_card_cid');
  }
  return body.press_card_cid;
}
