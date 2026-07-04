import { canonicalize } from '../crypto/canonicalize.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { SecureKeyProvider } from '../providers/SecureKeyProvider.js';

/**
 * Targeted card offer assembly and signing — issuer side
 * (`card_offering_and_acceptance.md §Phase 3`, `protocol-objects.md §1
 * CardDocument`).
 *
 * Produces the offer-phase `CardDocument`: every protocol-required field
 * except `recipient_pubkey`, `holder_signature`, `press_signature`, and
 * `protocol_version` (all added later, by the recipient and press — see
 * `protocol-objects.md §1`'s "Signing sequence"), plus whatever
 * policy-defined field values the caller supplies, signed with
 * `issuer_signature`.
 *
 * Judgment call: `ancestryPubkeys` (the ordered chain of ancestor public
 * keys this offer's `issuer_card` needs a verifier to walk to a trusted
 * root) is supplied by the caller, not resolved here. Chain resolution is
 * `CardVerifier`'s job (Step 1.4); this function's stated scope is
 * assembly and signing, not re-deriving what the caller's own wallet
 * already knows about its own card's ancestry (established when that card
 * was itself issued).
 *
 * Judgment call: "the offerer's own card key" (`card_offering_and_
 * acceptance.md` step 8) is not necessarily the device sub-card
 * specifically — it's whichever card the offerer is acting as (`issuer_
 * card`). This accepts a `SecureKeyProvider` + `keyId` pair rather than
 * hardcoding a device-sub-card assumption, matching the SDK's established
 * "routine signing never touches the master key" pattern (`deviceSubCard.
 * ts`).
 */
export interface PastKeyInput {
  pubkey: Uint8Array;
  validFrom: string;
  rotatedAt: string;
}

export interface AssembleTargetedOfferOptions {
  secureKeyProvider: SecureKeyProvider;
  /** `SecureKeyProvider` key id for the issuer's own card key (`issuer_card`'s signing key). */
  issuerSigningKeyId: string;
  /** CID of the governing policy card. */
  policyId: string;
  /** Mutable pointer of the offerer's own card. */
  issuerCard: string;
  /** Mutable pointer of the press that will validate and register the card. */
  pressCard: string;
  /** Ordered ML-DSA-44 public keys, immediate parent toward the trusted root. `[]` if `issuerCard` is itself a trusted root or its immediate parent is. */
  ancestryPubkeys: Uint8Array[];
  /** Policy-defined field values for this offer. Must not use a protocol-reserved field name. */
  fieldValues: Record<string, unknown>;
  /** Present only when this card is the product of a master-key rotation (`protocol-objects.md §1`'s `past_keys`), oldest-first. */
  pastKeys?: PastKeyInput[];
  /** Defaults to now. */
  issuedAt?: string;
}

export interface SignedTargetedOffer {
  policy_id: string;
  issuer_card: string;
  press_card: string;
  issued_at: string;
  ancestry_pubkeys: string[];
  past_keys?: Array<{ pubkey: string; valid_from: string; rotated_at: string }>;
  issuer_signature: string;
  [fieldName: string]: unknown;
}

const RESERVED_FIELD_NAMES = new Set([
  'policy_id',
  'issuer_card',
  'press_card',
  'issued_at',
  'ancestry_pubkeys',
  'past_keys',
  'issuer_signature',
  'recipient_pubkey',
  'holder_signature',
  'press_signature',
  'protocol_version',
  'supersedes',
  'supersession_note',
]);

/**
 * `card_offering_and_acceptance.md §Phase 3` Steps 6–8: assemble, canonically
 * serialize, and sign the offer with the offerer's own card key.
 */
export async function assembleAndSignTargetedOffer(
  options: AssembleTargetedOfferOptions
): Promise<SignedTargetedOffer> {
  for (const key of Object.keys(options.fieldValues)) {
    if (RESERVED_FIELD_NAMES.has(key)) {
      throw new Error(`assembleAndSignTargetedOffer: fieldValues must not use protocol-reserved field name "${key}".`);
    }
  }

  const unsignedOffer: Record<string, unknown> = {
    ...options.fieldValues,
    policy_id: options.policyId,
    issuer_card: options.issuerCard,
    press_card: options.pressCard,
    issued_at: options.issuedAt ?? new Date().toISOString(),
    ancestry_pubkeys: options.ancestryPubkeys.map(bytesToBase64Url),
    ...(options.pastKeys
      ? {
          past_keys: options.pastKeys.map((entry) => ({
            pubkey: bytesToBase64Url(entry.pubkey),
            valid_from: entry.validFrom,
            rotated_at: entry.rotatedAt,
          })),
        }
      : {}),
  };

  const signature = await options.secureKeyProvider.sign(options.issuerSigningKeyId, canonicalize(unsignedOffer));

  return {
    ...unsignedOffer,
    issuer_signature: bytesToBase64Url(signature),
  } as SignedTargetedOffer;
}
