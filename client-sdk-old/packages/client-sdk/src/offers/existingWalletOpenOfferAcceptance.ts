import { reviewOpenOffer, type OfferChainVerificationOptions, type OfferRejection } from './offerVerification.js';
import { acceptOpenOfferAndCountersign } from './countersign.js';
import { submitOpenOfferClaim, type Scip } from './openOfferClaim.js';
import type { SignedOpenCardOffer } from './openOffer.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';
import type { StorageProvider } from '../providers/StorageProvider.js';

/**
 * `open_offer_acceptance_existing_wallet.md` end-to-end — an existing card
 * holder adds a new card to their existing wallet. Per that spec's own
 * "Difference from New Wallet Flow" table: wallet setup is skipped
 * entirely, the passkey and master keypair already exist, and only the
 * keyring update (Step 3.3's countersign) and claim submission are new
 * work — everything else Step 3.4 does is simply not part of this flow.
 *
 * Structural enforcement of the spec's own postcondition ("the recipient
 * did not need to set up a new passkey or re-derive the keyring decryption
 * key — the existing credential was used"): this function's option surface
 * has no `passkeyProvider` field at all, so there is no code path by which
 * calling it could create a second passkey. `decryptionKey` is a required,
 * direct parameter — obtained by the caller via whatever legitimate unlock
 * flow it already uses (asserting the existing passkey, fetching the
 * current `service_secret`) — this function never derives or re-derives
 * it itself; it has no `kdf.ts` import at all.
 */
export interface AcceptOpenOfferForExistingWalletOptions {
  offer: SignedOpenCardOffer;
  /** Chain/press verification inputs for Step 3.2's review gate. */
  chainVerification: OfferChainVerificationOptions;
  /** The offer's named press (`offer.press_card`'s HTTPS base URL) — claim submission destination. */
  pressBaseUrl: string;
  transport: ObliviousProtocolTransport;
  storageProvider: StorageProvider;
  /** The wallet's current `decryption_key` — caller-supplied; see this module's doc for why. */
  decryptionKey: Uint8Array;
  /** Defaults to `'keyring'`, matching `setupWallet.ts`/`recovery.ts`. */
  storageKey?: string;
}

export interface AcceptedOpenOfferForExistingWallet {
  approved: true;
  cardCid: string;
  scip: Scip;
  newCardPublicKey: Uint8Array;
}

export type AcceptOpenOfferForExistingWalletResult = AcceptedOpenOfferForExistingWallet | OfferRejection;

export async function acceptOpenOfferForExistingWallet(
  options: AcceptOpenOfferForExistingWalletOptions
): Promise<AcceptOpenOfferForExistingWalletResult> {
  const review = await reviewOpenOffer(options.offer, options.chainVerification);
  if (!review.approved) {
    return review;
  }

  // Phase 2 (Step 3.3): countersign, keyring update only — the write
  // happens before the sign, enforced by acceptOpenOfferAndCountersign
  // itself, not re-implemented here.
  const { claimSubmission, newCardPublicKey } = await acceptOpenOfferAndCountersign(review, {
    storageProvider: options.storageProvider,
    decryptionKey: options.decryptionKey,
    ...(options.storageKey ? { storageKey: options.storageKey } : {}),
  });

  // Phase 3–5: claim submission, identical to the new-wallet flow.
  const { cardCid, scip } = await submitOpenOfferClaim(
    options.transport,
    { baseUrl: options.pressBaseUrl },
    claimSubmission
  );

  return { approved: true, cardCid, scip, newCardPublicKey };
}
