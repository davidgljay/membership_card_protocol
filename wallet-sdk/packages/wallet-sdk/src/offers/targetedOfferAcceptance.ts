import { reviewTargetedOffer, type OfferChainVerificationOptions, type OfferRejection } from './offerVerification.js';
import { acceptTargetedOfferAndCountersign, type KeyringWriteOptions } from './countersign.js';
import type { SignedTargetedOffer, CountersignedTargetedOffer } from '@membership-card-protocol/app-sdk';

/**
 * Recipient side of `card_offering_and_acceptance.md §Phase 5–6`: review/
 * verification/countersign. The offerer-side half —
 * `forwardCountersignedTargetedOffer`, the validate-and-forward-to-press
 * step — lives in App SDK (`offers/targetedOfferAcceptance.ts`), per
 * `plans/sdk-split-implementation-plan.md` Step 2.3: this package only
 * ports `acceptTargetedOffer` (recipient-side), not the offerer-side
 * function. `CountersignedTargetedOffer` is imported from App SDK rather
 * than redefined — it's the exact shape App SDK's own
 * `forwardCountersignedTargetedOffer` expects as input, so both packages
 * share one definition rather than two structurally-identical-but-distinct
 * types.
 *
 * Unlike the open-offer flows, the recipient never talks to the press
 * directly here — the offerer "forwards it to the press," so this
 * function returns the countersigned card for out-of-band delivery back
 * to the offerer (the SDK doesn't own that delivery channel, same as it
 * doesn't own initial offer delivery — `card_offering_and_acceptance.md
 * §Phase 4`). The offerer then calls App SDK's
 * `forwardCountersignedTargetedOffer` to finalize with the press.
 */

/**
 * Options for accepting a targeted offer.
 *
 * @property offer - The signed targeted offer to review and accept.
 * @property chainVerification - Chain/press verification inputs for the review gate.
 * @property storageProvider - Storage provider for keyring persistence during countersigning.
 * @property decryptionKey - The recipient's current `decryption_key` — caller-supplied, never derived internally.
 * @property storageKey - Optional key name for storage; defaults to standard keyring storage key.
 */
export interface AcceptTargetedOfferOptions {
  offer: SignedTargetedOffer;
  chainVerification: OfferChainVerificationOptions;
  storageProvider: KeyringWriteOptions['storageProvider'];
  decryptionKey: Uint8Array;
  storageKey?: string;
}

/**
 * Result of successfully accepting a targeted offer.
 *
 * @property approved - Always `true` — rejection cases return `OfferRejection` instead.
 * @property countersignedOffer - The countersigned offer; send back to offerer (out of band) for press finalization.
 * @property newCardPublicKey - The newly-generated public key for the accepted card.
 */
export interface AcceptedTargetedOffer {
  approved: true;
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
