import { setupWallet, type WalletSetupOptions, type WalletSetupResult } from '../wallet/setupWallet.js';
import { reviewOpenOffer, type OfferChainVerificationOptions, type OfferRejection } from './offerVerification.js';
import { acceptOpenOfferAndCountersign } from './countersign.js';
import { submitOpenOfferClaim, type Scip } from './openOfferClaim.js';
import type { SignedOpenCardOffer } from './openOffer.js';

/**
 * `open_offer_acceptance_new_wallet.md` end-to-end — a first-time recipient
 * with no existing wallet claims an open offer, creating a wallet as part
 * of the same guided flow (`§Phase 2`'s framing: "the recipient must
 * complete [wallet setup] before countersigning").
 *
 * Phases 1 (offer review, Step 3.2), 2 (wallet setup, Phase 2), and 3
 * (countersign + claim submission, Step 3.3) are chained here. Phase 2 is
 * "invoked inline" via `setupWallet`'s `postSetupHook` (see that option's
 * doc) rather than by calling `setupWallet` as an opaque black box and
 * separately re-deriving `decryption_key` afterward — `setupWallet` never
 * exposes it, by design, and this flow doesn't need a new way to re-derive
 * it: the hook runs the claim countersigning while it's still valid, in
 * the same function-scoped lifetime `setupWallet` itself already
 * establishes.
 *
 * If Phase 1 rejects the offer, wallet setup is never attempted — a
 * rejected offer must not create a device/service side effect.
 */
export interface AcceptOpenOfferForNewWalletOptions extends Omit<WalletSetupOptions<void>, 'postSetupHook'> {
  offer: SignedOpenCardOffer;
  /** Chain/press verification inputs for Step 3.2's review gate. */
  chainVerification: OfferChainVerificationOptions;
  /** The offer's named press (`offer.press_card`'s HTTPS base URL) — claim submission destination. */
  pressBaseUrl: string;
}

export interface AcceptedOpenOfferForNewWallet {
  approved: true;
  walletSetup: Omit<WalletSetupResult<unknown>, 'postSetupHookResult'>;
  cardCid: string;
  scip: Scip;
  newCardPublicKey: Uint8Array;
}

export type AcceptOpenOfferForNewWalletResult = AcceptedOpenOfferForNewWallet | OfferRejection;

interface ClaimHookResult {
  newCardPublicKey: Uint8Array;
  cardCid: string;
  scip: Scip;
}

export async function acceptOpenOfferForNewWallet(
  options: AcceptOpenOfferForNewWalletOptions
): Promise<AcceptOpenOfferForNewWalletResult> {
  const review = await reviewOpenOffer(options.offer, options.chainVerification);
  if (!review.approved) {
    return review;
  }

  const walletSetup = await setupWallet<ClaimHookResult>({
    ...options,
    postSetupHook: async (decryptionKey) => {
      const { claimSubmission, newCardPublicKey } = await acceptOpenOfferAndCountersign(review, {
        storageProvider: options.storageProvider,
        decryptionKey,
        ...(options.storageKey ? { storageKey: options.storageKey } : {}),
      });
      const { cardCid, scip } = await submitOpenOfferClaim(
        options.transport,
        { baseUrl: options.pressBaseUrl },
        claimSubmission
      );
      return { newCardPublicKey, cardCid, scip };
    },
  });

  const { postSetupHookResult, ...walletSetupWithoutHookResult } = walletSetup;

  return {
    approved: true,
    walletSetup: walletSetupWithoutHookResult,
    cardCid: postSetupHookResult.cardCid,
    scip: postSetupHookResult.scip,
    newCardPublicKey: postSetupHookResult.newCardPublicKey,
  };
}
