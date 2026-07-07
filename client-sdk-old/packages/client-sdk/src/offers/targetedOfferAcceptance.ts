import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44Verify } from '../crypto/mldsa.js';
import { base64UrlToBytes } from '../util/base64url.js';
import { reviewTargetedOffer, type OfferChainVerificationOptions, type OfferRejection } from './offerVerification.js';
import {
  acceptTargetedOfferAndCountersign,
  type CountersignedTargetedOffer,
  type KeyringWriteOptions,
} from './countersign.js';
import type { SignedTargetedOffer } from './targetedOffer.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { Scip } from './openOfferClaim.js';

/**
 * `card_offering_and_acceptance.md §Phase 5–6`: recipient review/
 * verification/countersign (reusing Steps 3.2–3.3, both sides of a
 * targeted issuance) and the offerer's validate-and-forward-to-press step.
 * Unlike the open-offer flows, the recipient never talks to the press
 * directly here — Step 16 is explicit that "the offerer... forwards it to
 * the press," so the recipient-side function below returns the
 * countersigned card for out-of-band delivery back to the offerer (the
 * SDK doesn't own that delivery channel, same as it doesn't own initial
 * offer delivery — `card_offering_and_acceptance.md §Phase 4`), and a
 * separate offerer-side function does the forwarding.
 */

export interface AcceptTargetedOfferOptions {
  offer: SignedTargetedOffer;
  /** Chain/press verification inputs for Step 3.2's review gate. */
  chainVerification: OfferChainVerificationOptions;
  storageProvider: KeyringWriteOptions['storageProvider'];
  /** The recipient's current `decryption_key` — caller-supplied, same as the existing-wallet open-offer flow; this function never derives it. */
  decryptionKey: Uint8Array;
  storageKey?: string;
}

export interface AcceptedTargetedOffer {
  approved: true;
  /** Send this back to the offerer (out of band) to complete Phase 6. */
  countersignedOffer: CountersignedTargetedOffer;
  newCardPublicKey: Uint8Array;
}

export type TargetedOfferAcceptanceResult = AcceptedTargetedOffer | OfferRejection;

/**
 * Recipient side: `card_offering_and_acceptance.md §Phase 5` Steps 11–15.
 */
export async function acceptTargetedOffer(options: AcceptTargetedOfferOptions): Promise<TargetedOfferAcceptanceResult> {
  const review = await reviewTargetedOffer(options.offer, options.chainVerification);
  if (!review.approved) {
    return review;
  }

  const { countersignedOffer, newCardPublicKey } = await acceptTargetedOfferAndCountersign(review, {
    storageProvider: options.storageProvider,
    decryptionKey: options.decryptionKey,
    ...(options.storageKey ? { storageKey: options.storageKey } : {}),
  });

  return { approved: true, countersignedOffer, newCardPublicKey };
}

export interface ForwardTargetedOfferOptions {
  /** The offer this offerer itself issued (Step 3.1's output) — the trusted source of every field except `recipient_pubkey`/`holder_signature`. */
  originalOffer: SignedTargetedOffer;
  /** Only `recipient_pubkey` and `holder_signature` are read from this — every other field is taken from `originalOffer`, not echoed back from the recipient, so a tampered field can never reach the press even if a caller passes through a modified object. */
  countersignedOffer: Pick<CountersignedTargetedOffer, 'recipient_pubkey' | 'holder_signature'>;
  transport: ObliviousProtocolTransport;
  /** The press named in the offer (`offer.press_card`'s HTTPS base URL). */
  pressBaseUrl: string;
}

export type ForwardTargetedOfferResult =
  | { forwarded: true; cardCid: string; scip: Scip }
  | { forwarded: false; reason: string };

interface IssueFinalizeResponseBody {
  card_cid: string;
  scip: Scip;
}

/**
 * Offerer side: `card_offering_and_acceptance.md §Phase 6` Step 16 —
 * "confirms `holder_signature` verifies against `recipient_pubkey` and
 * covers the offer the offerer issued" — then `POST /issue/finalize`
 * (`press.md §4`), routed through `ObliviousProtocolTransport` the same as
 * every other press-facing call (`plans/client-sdk/strategic-plan.md
 * §Goal 7`).
 */
export async function forwardCountersignedTargetedOffer(
  options: ForwardTargetedOfferOptions
): Promise<ForwardTargetedOfferResult> {
  const recipientPubkeyB64 = options.countersignedOffer.recipient_pubkey;
  const recipientPubkey = base64UrlToBytes(recipientPubkeyB64);

  const expectedSignedPayload = { ...options.originalOffer, recipient_pubkey: recipientPubkeyB64 };
  const holderSignatureValid = mlDsa44Verify(
    recipientPubkey,
    canonicalize(expectedSignedPayload),
    base64UrlToBytes(options.countersignedOffer.holder_signature)
  );
  if (!holderSignatureValid) {
    return {
      forwarded: false,
      reason: "holder_signature does not verify against recipient_pubkey and the originally issued offer.",
    };
  }

  const completeCard: CountersignedTargetedOffer = {
    ...expectedSignedPayload,
    holder_signature: options.countersignedOffer.holder_signature,
  };

  const response = await options.transport.request(
    { kind: 'press', baseUrl: options.pressBaseUrl },
    {
      method: 'POST',
      path: '/issue/finalize',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(completeCard)),
    }
  );

  if (response.status < 200 || response.status >= 300) {
    return { forwarded: false, reason: `press rejected the finalization: status ${response.status}` };
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as IssueFinalizeResponseBody;
  return { forwarded: true, cardCid: body.card_cid, scip: body.scip };
}
