import { canonicalize } from '../crypto/canonicalize.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { SubCardDocumentFields, WalletAppCardIdentity } from './types.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';

/**
 * Requester-side sub-card request (`subcards.md §Sub-Card Request Flow
 * Step 1`, `protocol-objects.md §16`) — the general, third-party-app side
 * of the request flow. Wallet SDK's own self-requesting case (a wallet
 * acting as its own requesting app) is a thin wrapper around this same
 * function rather than a parallel implementation. Uses `./types.js`'s
 * `SubCardDocumentFields`/`WalletAppCardIdentity` shapes —
 * `WalletAppCardIdentity`'s `{ cardPointer, publicKey, sign }` shape is
 * exactly "an app's own card identity + signing capability," which is what
 * any requesting app (not just a wallet acting as its own app) needs here.
 *
 * Per OQ-SDK-9's resolution, this SDK does not own request delivery: the
 * app sends the returned partially-signed document to the wallet via
 * whatever channel the platform integration layer provides (HTTPS
 * callback, deep link — `subcards.md`'s own "Delivery channel" note).
 */

/** A `SubCardDocument` with only `app_signature` applied — `holder_signature` is added later, by the wallet (Step 4.3/4.4), not by this module. */
export interface AppSignedSubCardDocument extends SubCardDocumentFields {
  app_signature: string;
}

export interface RequestSubCardOptions {
  secureKeyProvider: SecureKeyProvider;
  /** `SecureKeyProvider` key id for the new sub-card key. Caller-chosen. */
  subCardKeyId: string;
  /** The requesting app's own card identity. */
  appCard: WalletAppCardIdentity;
  /** Mutable pointer of the holder's primary card this sub-card will delegate from. */
  holderPrimaryCard: string;
  /** ML-DSA-44 public key of the card referenced by `holderPrimaryCard`. */
  holderPrimaryCardPubkey: Uint8Array;
  /** Whitelist of message-type strings this sub-card requests to sign. The wallet may grant a subset (Step 4.3) — this is the *request*, not the final grant. */
  capabilities: string[];
  attestationLevel: 'T1' | 'T2';
  /** Platform attestation assertion scoped to `hash(recipient_pubkey)` — required when `attestationLevel` is `'T2'`, omitted for `'T1'`. Obtaining this from the platform's attestation service (App Attest / Play Integrity) is the caller's responsibility; this module only carries it through. */
  attestationProof?: Uint8Array;
  validUntil?: string;
  /** Defaults to now. */
  issuedAt?: string;
}

export interface RequestSubCardResult {
  subCardPublicKey: Uint8Array;
  subCardKeyId: string;
  document: AppSignedSubCardDocument;
}

/**
 * `subcards.md §Sub-Card Request Flow Step 1`: generate a fresh, non-
 * exportable ML-DSA-44 keypair via `SecureKeyProvider`, assemble the
 * `SubCardDocument`, and sign with the app's own card key → `app_signature`.
 */
export async function requestSubCard(options: RequestSubCardOptions): Promise<RequestSubCardResult> {
  if (options.attestationLevel === 'T2' && !options.attestationProof) {
    throw new Error('requestSubCard: attestationProof is required when attestationLevel is "T2".');
  }

  const subCardPublicKey = await options.secureKeyProvider.generateKey(options.subCardKeyId);

  const unsignedFields: SubCardDocumentFields = {
    holder_primary_card: options.holderPrimaryCard,
    holder_primary_card_pubkey: bytesToBase64Url(options.holderPrimaryCardPubkey),
    app_card: options.appCard.cardPointer,
    app_card_pubkey: bytesToBase64Url(options.appCard.publicKey),
    capabilities: options.capabilities,
    recipient_pubkey: bytesToBase64Url(subCardPublicKey),
    issued_at: options.issuedAt ?? new Date().toISOString(),
    attestation_level: options.attestationLevel,
    ...(options.validUntil ? { valid_until: options.validUntil } : {}),
    ...(options.attestationProof ? { attestation_proof: bytesToBase64Url(options.attestationProof) } : {}),
  };

  const appSignature = await options.appCard.sign(canonicalize(unsignedFields));

  return {
    subCardPublicKey,
    subCardKeyId: options.subCardKeyId,
    document: { ...unsignedFields, app_signature: bytesToBase64Url(appSignature) },
  };
}
