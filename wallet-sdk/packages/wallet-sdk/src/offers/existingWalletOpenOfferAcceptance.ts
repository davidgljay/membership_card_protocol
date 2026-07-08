import { reviewOpenOffer, type OfferChainVerificationOptions, type OfferRejection } from './offerVerification.js';
import { acceptOpenOfferAndCountersign } from './countersign.js';
import { submitOpenOfferClaim } from './openOfferClaim.js';
import type { SignedOpenCardOffer, Scip, ObliviousProtocolTransport, StorageProvider } from '@membership-card-protocol/app-sdk';

/**
 * `open_offer_acceptance_existing_wallet.md` end-to-end — an existing card
 * holder adds a new card to their existing wallet. Per that spec's own
 * "Difference from New Wallet Flow" table: wallet setup is skipped
 * entirely, the passkey and master keypair already exist, and only the
 * keyring update (countersign) and claim submission are new work —
 * everything else the new-wallet flow does is simply not part of this
 * flow.
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
/**
 * Options for accepting an open offer in an existing wallet (no setup needed).
 *
 * @property offer - The signed open-card offer to review and accept.
 * @property chainVerification - Chain/press verification inputs for the review gate.
 * @property pressBaseUrl - The offer's named press URL — claim submission destination.
 * @property transport - Oblivious transport for claim submission.
 * @property storageProvider - Storage provider for keyring persistence during countersigning.
 * @property decryptionKey - The wallet's current `decryption_key` — caller-supplied, never derived internally.
 * @property storageKey - Optional key name for storage; defaults to standard keyring storage key.
 */
export interface AcceptOpenOfferForExistingWalletOptions {
  offer: SignedOpenCardOffer;
  chainVerification: OfferChainVerificationOptions;
  pressBaseUrl: string;
  transport: ObliviousProtocolTransport;
  storageProvider: StorageProvider;
  decryptionKey: Uint8Array;
  storageKey?: string;
}

/**
 * Result of successfully accepting an open offer in an existing wallet.
 *
 * @property approved - Always `true` — rejection cases return `OfferRejection` instead.
 * @property cardCid - IPFS CID of the newly-issued card from the press.
 * @property scip - Short-circuit-issuance proof from the press.
 * @property newCardPublicKey - The newly-generated public key for the accepted card.
 */
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

  // Countersign, keyring update only — the write happens before the sign,
  // enforced by acceptOpenOfferAndCountersign itself, not re-implemented
  // here.
  const { claimSubmission, newCardPublicKey } = await acceptOpenOfferAndCountersign(review, {
    storageProvider: options.storageProvider,
    decryptionKey: options.decryptionKey,
    ...(options.storageKey ? { storageKey: options.storageKey } : {}),
  });

  // Claim submission, identical to the new-wallet flow.
  const { cardCid, scip } = await submitOpenOfferClaim(
    options.transport,
    { baseUrl: options.pressBaseUrl },
    claimSubmission
  );

  return { approved: true, cardCid, scip, newCardPublicKey };
}
