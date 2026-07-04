import { canonicalize } from '../crypto/canonicalize.js';
import { keccak256 } from '../crypto/hashes.js';
import { mlDsa44Verify } from '../crypto/mldsa.js';
import { base64UrlToBytes } from '../util/base64url.js';
import type { CardVerifier, CardVerificationResult, RpcProvider } from '../verification/index.js';
import type { SignedTargetedOffer } from './targetedOffer.js';
import type { SignedOpenCardOffer } from './openOffer.js';

/**
 * Pre-display offer verification — the gate every acceptance path shares
 * (`card_offering_and_acceptance.md` step 12, `open_offer_acceptance_new_
 * wallet.md`/`open_offer_acceptance_existing_wallet.md` §Phase 1 step 2).
 * A hard rejection here must prevent the offer from ever reaching a
 * displayable state — every exported function returns a discriminated
 * `{ approved: false, ... }` result rather than throwing or returning a
 * partially-populated offer object, so a caller cannot accidentally render
 * an unverified offer by skipping error handling.
 *
 * Judgment calls (this step's scope is verification, not chain-resolution
 * machinery — `CardVerifier`'s public surface, per Goal 6, is the only
 * chain-walking/revocation-checking primitive this SDK is allowed to use,
 * and it doesn't expose a "resolve this address's current public key"
 * primitive beyond what {@link CardVerifier.verifyCard} already returns):
 *
 * - The on-chain **address** used to check press authorization
 *   (`policyAddress`) is supplied by the caller rather than re-derived
 *   from the offer's `policy_id` (a CID, not an address) — resolving a CID
 *   to its governing policy's on-chain address is a policy-resolution
 *   concern this step doesn't own.
 * - The policy's `approved_presses` (advisory-only, per this step's own
 *   "Done when" framing) is likewise caller-supplied — fetching and
 *   decrypting the policy card is out of scope here; omitting it simply
 *   skips the advisory cross-check, never the authoritative one.
 * - For a targeted offer, the issuer's public key is taken from
 *   `ancestry_pubkeys[0]` (`protocol-objects.md §1` documents this slot as
 *   "the issuer card's public key") — still treated as an untrusted hint,
 *   confirmed via the same `keccak256(entry_pubkey) == on-chain address`
 *   binding check the spec requires for every `ancestry_pubkeys` entry.
 *   An empty `ancestry_pubkeys` (issuer is itself a trusted root) has no
 *   such hint to check, so that case is a hard rejection rather than an
 *   unverified pass-through.
 */

export type OfferRejectionCode =
  | 'issuer_binding_mismatch'
  | 'issuer_signature_invalid'
  | 'issuer_chain_not_trusted'
  | 'issuer_card_not_currently_valid'
  | 'press_not_authorized'
  | 'verification_error';

export interface OfferRejection {
  approved: false;
  code: OfferRejectionCode;
  reason: string;
}

export interface OfferChainVerificationOptions {
  cardVerifier: CardVerifier;
  /** For the authoritative `getPressAuthorization` on-chain check. */
  rpc: RpcProvider;
  /** On-chain address of the policy governing this offer (see this module's doc for why this isn't re-derived from `policy_id`). */
  policyAddress: string;
  /** Advisory-only cross-check against the policy's `approved_presses`; omit to skip. */
  policyApprovedPresses?: string[];
}

export interface ApprovedTargetedOffer {
  approved: true;
  offer: SignedTargetedOffer;
  issuerVerification: CardVerificationResult;
  pressAdvisoryWarning?: string;
}

export interface ApprovedOpenOffer {
  approved: true;
  offer: SignedOpenCardOffer;
  issuerVerification: CardVerificationResult;
  pressAdvisoryWarning?: string;
}

export type TargetedOfferReviewResult = ApprovedTargetedOffer | OfferRejection;
export type OpenOfferReviewResult = ApprovedOpenOffer | OfferRejection;

function rejection(code: OfferRejectionCode, reason: string): OfferRejection {
  return { approved: false, code, reason };
}

async function verifyIssuerChainAndPress(
  issuerAddress: string,
  pressCard: string,
  options: OfferChainVerificationOptions
): Promise<{ issuerVerification: CardVerificationResult; pressAdvisoryWarning?: string } | OfferRejection> {
  let issuerVerification: CardVerificationResult;
  try {
    issuerVerification = await options.cardVerifier.verifyCard(issuerAddress);
  } catch (err) {
    return rejection(
      'verification_error',
      `issuer card verification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (issuerVerification.chain_reaches_trusted_root !== true) {
    return rejection('issuer_chain_not_trusted', 'issuer card chain does not reach a trusted root.');
  }
  if (issuerVerification.is_currently_valid !== true) {
    return rejection('issuer_card_not_currently_valid', 'issuer card is revoked or not currently valid.');
  }

  let pressAuth;
  try {
    pressAuth = await options.rpc.getPressAuthorization(options.policyAddress, pressCard);
  } catch (err) {
    return rejection(
      'verification_error',
      `press authorization check failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!pressAuth || !pressAuth.active) {
    return rejection(
      'press_not_authorized',
      'named press is not active in on-chain PressAuthorizations for this policy.'
    );
  }

  const pressAdvisoryWarning =
    options.policyApprovedPresses && !options.policyApprovedPresses.includes(pressCard)
      ? "named press is on-chain authorized but does not appear in the policy's advisory approved_presses list."
      : undefined;

  return { issuerVerification, ...(pressAdvisoryWarning ? { pressAdvisoryWarning } : {}) };
}

/**
 * `card_offering_and_acceptance.md` step 12: keccak256 binding check on
 * `ancestry_pubkeys[0]`/`issuer_card`, `issuer_signature` verification, and
 * chain/press checks via {@link verifyIssuerChainAndPress}.
 */
export async function reviewTargetedOffer(
  offer: SignedTargetedOffer,
  options: OfferChainVerificationOptions
): Promise<TargetedOfferReviewResult> {
  const issuerPubkeyBase64 = offer.ancestry_pubkeys[0];
  if (!issuerPubkeyBase64) {
    return rejection(
      'issuer_binding_mismatch',
      'ancestry_pubkeys is empty; cannot resolve the issuer public key from this offer.'
    );
  }
  const issuerPubkey = base64UrlToBytes(issuerPubkeyBase64);
  const derivedIssuerAddress = keccak256(issuerPubkey);
  if (derivedIssuerAddress !== offer.issuer_card) {
    return rejection(
      'issuer_binding_mismatch',
      'keccak256(ancestry_pubkeys[0]) does not match issuer_card.'
    );
  }

  const { issuer_signature, ...withoutSignature } = offer;
  const signatureValid = mlDsa44Verify(
    issuerPubkey,
    canonicalize(withoutSignature),
    base64UrlToBytes(issuer_signature)
  );
  if (!signatureValid) {
    return rejection('issuer_signature_invalid', "issuer_signature does not verify against the issuer's public key.");
  }

  const chainResult = await verifyIssuerChainAndPress(derivedIssuerAddress, offer.press_card, options);
  if ('approved' in chainResult) return chainResult;

  return {
    approved: true,
    offer,
    issuerVerification: chainResult.issuerVerification,
    ...(chainResult.pressAdvisoryWarning ? { pressAdvisoryWarning: chainResult.pressAdvisoryWarning } : {}),
  };
}

/**
 * `open_offer_acceptance_new_wallet.md`/`open_offer_acceptance_existing_
 * wallet.md §Phase 1` step 2: keccak256 binding check on `issuer_pubkey`/
 * `issuer_card` (`protocol-objects.md §6`'s own "Binding check"),
 * `issuer_signature` verification, and chain/press checks.
 */
export async function reviewOpenOffer(
  offer: SignedOpenCardOffer,
  options: OfferChainVerificationOptions
): Promise<OpenOfferReviewResult> {
  const issuerPubkey = base64UrlToBytes(offer.issuer_pubkey);
  const derivedIssuerAddress = keccak256(issuerPubkey);
  if (derivedIssuerAddress !== offer.issuer_card) {
    return rejection('issuer_binding_mismatch', 'keccak256(issuer_pubkey) does not match issuer_card.');
  }

  const { issuer_signature, ...withoutSignature } = offer;
  const signatureValid = mlDsa44Verify(
    issuerPubkey,
    canonicalize(withoutSignature),
    base64UrlToBytes(issuer_signature)
  );
  if (!signatureValid) {
    return rejection('issuer_signature_invalid', "issuer_signature does not verify against the issuer's public key.");
  }

  const chainResult = await verifyIssuerChainAndPress(derivedIssuerAddress, offer.press_card, options);
  if ('approved' in chainResult) return chainResult;

  return {
    approved: true,
    offer,
    issuerVerification: chainResult.issuerVerification,
    ...(chainResult.pressAdvisoryWarning ? { pressAdvisoryWarning: chainResult.pressAdvisoryWarning } : {}),
  };
}
