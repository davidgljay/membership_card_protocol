import { canonicalize } from '../crypto/canonicalize.js';
import { keccak256 } from '../crypto/hashes.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';

/**
 * Open card offer assembly, signing, and claim-link generation — issuer
 * side (`open_offer_creation.md §Phase 1–2`, `protocol-objects.md §6
 * OpenCardOffer`).
 *
 * See `targetedOffer.ts`'s doc for the same judgment call this module
 * makes about signing via `SecureKeyProvider` + `keyId` rather than
 * assuming a specific card key.
 */
export interface AssembleOpenOfferOptions {
  secureKeyProvider: SecureKeyProvider;
  /** `SecureKeyProvider` key id for the issuer's own card key (`issuer_card`'s signing key). */
  issuerSigningKeyId: string;
  /** CID of the governing policy card. Must have `allow_open_offers: true` (not verified here — the caller's own responsibility, per `open_offer_creation.md` Phase 1 Step 1). */
  policyId: string;
  /** Mutable pointer of the approved press that will issue cards at claim time. */
  pressCard: string;
  /** Mutable pointer of the issuer's card. */
  issuerCard: string;
  /** ML-DSA-44 public key of the card referenced by `issuerCard`. */
  issuerPubkey: Uint8Array;
  /** Null/omitted = unconstrained. */
  maxAcceptances?: number | null;
  /** Null/omitted = unconstrained. Must be in the future if set. */
  expiresAt?: string | null;
  displayMessage?: string;
  redirectUrl?: string;
  /** Issuer-populated field values for cards issued under this offer. */
  proposedFields: Record<string, unknown>;
  /**
   * Required (and must be `true`) when both `maxAcceptances` and
   * `expiresAt` are unconstrained — `open_offer_creation.md`'s "requires
   * explicit issuer acknowledgment."
   */
  acknowledgeUnconstrained?: boolean;
}

export interface SignedOpenCardOffer {
  offer_type: 'open';
  policy_id: string;
  press_card: string;
  issuer_card: string;
  issuer_pubkey: string;
  max_acceptances: number | null;
  expires_at: string | null;
  display_message?: string;
  redirect_url?: string;
  proposed_fields: Record<string, unknown>;
  issuer_signature: string;
}

export interface AssembleOpenOfferResult {
  offer: SignedOpenCardOffer;
  /** `hash(canonical RFC 8785 JSON of the complete document including issuer_signature)` — keccak256, hex, matching this SDK's other address/ID derivations. */
  offerId: string;
  /** `mcard://claim?o=<base64url of offer>` (`open_offer_creation.md` Phase 3 Step 8's short form). The hosted-URL form is the wallet service's job, not this SDK's. */
  claimLink: string;
}

/**
 * `open_offer_creation.md §Phase 1–2` Steps 2–6: assemble, validate locally,
 * sign, and compute the offer ID and short-form claim link.
 */
export async function assembleAndSignOpenOffer(options: AssembleOpenOfferOptions): Promise<AssembleOpenOfferResult> {
  const maxAcceptances = options.maxAcceptances ?? null;
  const expiresAt = options.expiresAt ?? null;

  if (maxAcceptances === null && expiresAt === null && !options.acknowledgeUnconstrained) {
    throw new Error(
      'assembleAndSignOpenOffer: an offer with both max_acceptances and expires_at unconstrained requires acknowledgeUnconstrained: true.'
    );
  }
  if (expiresAt !== null && new Date(expiresAt).getTime() <= Date.now()) {
    throw new Error('assembleAndSignOpenOffer: expires_at must be in the future.');
  }

  const unsignedOffer: Omit<SignedOpenCardOffer, 'issuer_signature'> = {
    offer_type: 'open',
    policy_id: options.policyId,
    press_card: options.pressCard,
    issuer_card: options.issuerCard,
    issuer_pubkey: bytesToBase64Url(options.issuerPubkey),
    max_acceptances: maxAcceptances,
    expires_at: expiresAt,
    ...(options.displayMessage ? { display_message: options.displayMessage } : {}),
    ...(options.redirectUrl ? { redirect_url: options.redirectUrl } : {}),
    proposed_fields: options.proposedFields,
  };

  const signature = await options.secureKeyProvider.sign(options.issuerSigningKeyId, canonicalize(unsignedOffer));
  const offer: SignedOpenCardOffer = { ...unsignedOffer, issuer_signature: bytesToBase64Url(signature) };

  const canonicalOfferBytes = canonicalize(offer);
  const offerId = keccak256(canonicalOfferBytes);
  const claimLink = `mcard://claim?o=${bytesToBase64Url(canonicalOfferBytes)}`;

  return { offer, offerId, claimLink };
}
