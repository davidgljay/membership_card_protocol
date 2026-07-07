import { mlDsa44GenerateKeypair, mlDsa44Sign, canonicalize, keccak256 } from '@membership-card-protocol/app-sdk';
import { decryptKeyring, encryptKeyring } from '../wallet/keyring.js';
import { bytesToBase64Url } from '@membership-card-protocol/app-sdk';
import type {
  StorageProvider,
  SignedOpenCardOffer,
  CountersignedTargetedOffer,
} from '@membership-card-protocol/app-sdk';
import type { ApprovedTargetedOffer, ApprovedOpenOffer } from './offerVerification.js';

/**
 * Countersigning with the "persist before sign" invariant — shared by all
 * three acceptance paths (targeted, open-offer-new-wallet, open-offer-
 * existing-wallet) — `card_offering_and_acceptance.md §Phase 5 Step 15`,
 * `open_offer_acceptance_new_wallet.md §Phase 3 Step 11`,
 * `open_offer_acceptance_existing_wallet.md §Phase 2 Step 6`.
 *
 * Fully owned by this package — `wallet_sdk.md §7.2` — not App SDK, per
 * `plans/sdk-split-strategic-plan.md`'s capability table.
 *
 * `plans/client-sdk/strategic-plan.md`'s own rationale: "the new card's
 * private key goes into the keyring *before* the client countersigns...
 * specifically so the key is recoverable via backup even if the device is
 * lost between signing and card receipt... the failure mode (an
 * unrecoverable, already-committed card) is not something a later patch
 * can fix." This has to be a designed-in invariant, not something left to
 * each call site to remember — enforced here structurally: the internal
 * `generateAndPersistCardKey` helper is not exported, so the only way any
 * code in this SDK can obtain the new card's secret key is by first
 * awaiting a successful keyring write. If that write throws, the function
 * exits via that exception — there is no code path after it that could
 * still reach a `mlDsa44Sign` call.
 *
 * The new card key is generated via the in-memory crypto core
 * (`mlDsa44GenerateKeypair`), not `SecureKeyProvider` — this key belongs in
 * the recoverable keyring, not hardware-bound, non-exportable storage
 * (every relevant spec is explicit that per-card keys must be
 * backup-recoverable; `SecureKeyProvider`'s whole contract is the opposite
 * — see `deviceSubCard.ts`'s use of it for the *device* sub-card, which is
 * deliberately not backed up this way).
 *
 * Judgment call (matches this session's Phase 2 precedent): "confirm the
 * write" means the local `StorageProvider.set` call completes — the
 * durable local write Phase 2 established. Phase 2 never built (or
 * needed) a synchronous per-card federation-replicated write; the wallet
 * service only ever receives a full keyring blob rotation at the specific,
 * infrequent, master-key-authenticated moments Phase 2 covers (initial
 * setup, recovery re-registration) — routing every single accepted card
 * through that same heavyweight, master-key-signing flow would be a much
 * larger scope change than this step asks for. A queued sync of routine
 * keyring growth to the wallet service (the other option this step's plan
 * text allows for) is not built here.
 */

export interface KeyringWriteOptions {
  storageProvider: StorageProvider;
  /** The wallet's current `decryption_key` — caller-supplied, since neither `setupWallet` nor `recoverWallet` ever return it (see their own docs). */
  decryptionKey: Uint8Array;
  /** Defaults to `'keyring'`, matching `setupWallet.ts`/`recovery.ts`. */
  storageKey?: string;
}

interface GeneratedCardKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Not exported. The sole path to a fresh card keypair in this module:
 * decrypt the current keyring, append the new entry, re-encrypt, and
 * `await` the write — only then return the keypair to the caller.
 */
async function generateAndPersistCardKey(options: KeyringWriteOptions): Promise<GeneratedCardKey> {
  const storageKey = options.storageKey ?? 'keyring';
  const currentBlob = await options.storageProvider.get(storageKey);
  if (!currentBlob) {
    throw new Error('generateAndPersistCardKey: no keyring found in storage; cannot append a new card key.');
  }
  const existingEntries = decryptKeyring(currentBlob, options.decryptionKey);

  const keypair = mlDsa44GenerateKeypair();
  const cardAddress = keccak256(keypair.publicKey);
  const updatedEntries = [...existingEntries, { cardAddress, privateKey: keypair.secretKey }];
  const updatedBlob = encryptKeyring(updatedEntries, options.decryptionKey);

  // The write this whole module exists to enforce happens-before signing.
  await options.storageProvider.set(storageKey, updatedBlob);

  return { publicKey: keypair.publicKey, secretKey: keypair.secretKey };
}

export interface AcceptTargetedOfferResult {
  countersignedOffer: CountersignedTargetedOffer;
  newCardPublicKey: Uint8Array;
}

/**
 * `card_offering_and_acceptance.md §Phase 5 Step 15`: generate and persist
 * the new card key, add `recipient_pubkey`, and sign the offer plus
 * `recipient_pubkey` (excluding `holder_signature`/`press_signature`) with
 * the new key → `holder_signature`.
 *
 * Takes the already-{@link reviewTargetedOffer}-approved result, not a raw
 * offer — structurally, there's no way to reach this function without
 * having gone through the verification gate first.
 */
export async function acceptTargetedOfferAndCountersign(
  approved: ApprovedTargetedOffer,
  keyringWrite: KeyringWriteOptions
): Promise<AcceptTargetedOfferResult> {
  const { publicKey, secretKey } = await generateAndPersistCardKey(keyringWrite);

  const withRecipient = { ...approved.offer, recipient_pubkey: bytesToBase64Url(publicKey) };
  const holderSignature = mlDsa44Sign(secretKey, canonicalize(withRecipient));

  return {
    countersignedOffer: { ...withRecipient, holder_signature: bytesToBase64Url(holderSignature) },
    newCardPublicKey: publicKey,
  };
}

export interface OpenOfferClaimPayload {
  offer: SignedOpenCardOffer;
  recipient_pubkey: string;
}

export interface OpenOfferClaimSubmission {
  claim_payload: OpenOfferClaimPayload;
  recipient_signature: string;
}

export interface AcceptOpenOfferResult {
  claimSubmission: OpenOfferClaimSubmission;
  newCardPublicKey: Uint8Array;
}

/**
 * `open_offer_acceptance_new_wallet.md §Phase 3 Step 11` /
 * `open_offer_acceptance_existing_wallet.md §Phase 2 Step 6`: generate and
 * persist the new card key, then sign `claim_payload = { offer,
 * recipient_pubkey }` with it → `recipient_signature`
 * (`protocol-objects.md §7 OpenOfferClaimSubmission`).
 */
export async function acceptOpenOfferAndCountersign(
  approved: ApprovedOpenOffer,
  keyringWrite: KeyringWriteOptions
): Promise<AcceptOpenOfferResult> {
  const { publicKey, secretKey } = await generateAndPersistCardKey(keyringWrite);

  const claimPayload: OpenOfferClaimPayload = {
    offer: approved.offer,
    recipient_pubkey: bytesToBase64Url(publicKey),
  };
  const recipientSignature = mlDsa44Sign(secretKey, canonicalize(claimPayload));

  return {
    claimSubmission: { claim_payload: claimPayload, recipient_signature: bytesToBase64Url(recipientSignature) },
    newCardPublicKey: publicKey,
  };
}
