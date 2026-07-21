/**
 * Mints a fresh, spec-conformant card against a live press instance —
 * exercises the real `POST /issue` → `POST /issue/finalize` flow using
 * app-sdk's actual `assembleAndSignTargetedOffer` (the real client SDK
 * function every wallet uses), not a reimplementation.
 *
 * Scope: a brand-new holder accepting a targeted offer with no prior card.
 * Press only evaluates chain-of-trust predicates when the request carries
 * a `recipient_card_address` (an *existing* card) — see
 * `press/src/functions/issuance.ts`'s `validateIssuanceRequest` — so this
 * helper never needs a real on-chain issuer hierarchy. The holder
 * signature is produced directly with app-sdk's `mlDsa44Sign`/
 * `canonicalize` rather than through `wallet-sdk`'s
 * `acceptTargetedOfferAndCountersign` — that function requires an
 * already-initialized wallet keyring and its own `reviewTargetedOffer`
 * trust-chain gate (which hard-rejects an empty `ancestry_pubkeys`, a
 * separate client-side policy this fixture's issuer doesn't attempt to
 * satisfy). Exercising the full wallet-sdk keyring/review flow end-to-end
 * against a live wallet-service is Phase 2's harness scope (2.2/2.3), not
 * this fixture's.
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
  /** Press's base URL, e.g. `http://localhost:3001`. */
  pressBaseUrl: string;
  /** CID of a policy document already pinned and trusting this press (see `buildPermissiveTestPolicy`). */
  policyId: string;
  /** Distinguishes this mint's keys from any other fixture run sharing the same seed namespace. */
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
 * The issuer for a fixture mint is a synthetic level-1 card: its own
 * `ancestry_pubkeys` is `[]` (nothing above it is asserted), and its
 * on-chain address is `keccak256(issuerPubkey)` — i.e. it acts as its own
 * immediate parent reference for the *new* card being minted. This is
 * exactly `protocol-objects.md §1`'s "ancestry_pubkeys: [] if issuerCard
 * is itself a trusted root or its immediate parent is" case from the new
 * card's perspective, with the issuer playing that immediate-parent role.
 */
export async function mintCard(options: MintCardOptions): Promise<MintedCard> {
  const issuerKeyId = `issuer:${options.label}`;
  const secureKeyProvider = new InMemorySecureKeyProvider();
  const issuerPubkey = await secureKeyProvider.generateKey(issuerKeyId);
  // app-sdk's keccak256 already returns lowercase hex, unprefixed (see its
  // own doc comment) — not raw bytes, unlike press's own keccak256. Card
  // addresses stay unprefixed throughout the offer/verifier layer;
  // press's verifyIssuerSignature (functions/issuance.ts) compares
  // issuer_card against this exact same unprefixed convention.
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
 * The offer's `press_card` field must equal `PRESS_CARD_CID` exactly:
 * `handleIssueFinalize` (`press/src/handlers/issue.ts:112-116`)
 * unconditionally overwrites `press_card` with `ctx.config.PRESS_CARD_CID`
 * before re-verifying `holder_signature`, so whatever the offer was signed
 * with must match that same CID or the signature check fails. (A
 * plausible-looking alternative — the press's on-chain registry `address`,
 * since `getPressAuthorization`'s on-chain arg is address-shaped — is
 * *not* it; that was tried and breaks signature verification here.)
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
