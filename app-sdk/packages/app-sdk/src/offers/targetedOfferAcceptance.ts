import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44Verify } from '../crypto/mldsa.js';
import { base64UrlToBytes } from '../util/base64url.js';
import type { SignedTargetedOffer } from './targetedOffer.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { Scip } from './scip.js';

/**
 * `card_offering_and_acceptance.md §Phase 6` Step 16 — the offerer's
 * validate-and-forward-to-press step. Unlike the open-offer flows, the
 * recipient never talks to the press directly here — Step 16 is explicit
 * that "the offerer... forwards it to the press," so the recipient-side
 * review/countersign flow (which reviews the offer and produces the
 * `recipient_pubkey`/`holder_signature` half, including generating and
 * persisting the new per-card keypair) is entirely Wallet SDK's concern
 * (`wallet_sdk.md §7`) — this module only implements the offerer side of
 * forwarding the completed card to the press.
 */

/**
 * The complete signed `CardDocument` once both `issuer_signature` (Step
 * 3.1, `targetedOffer.ts`) and `recipient_pubkey`/`holder_signature`
 * (recipient-side countersign, Wallet SDK) are present. A pure data shape
 * with no custody logic attached — Wallet SDK's own countersign flow
 * imports this type from this package rather than redefining it.
 */
export interface CountersignedTargetedOffer extends SignedTargetedOffer {
  recipient_pubkey: string;
  holder_signature: string;
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
