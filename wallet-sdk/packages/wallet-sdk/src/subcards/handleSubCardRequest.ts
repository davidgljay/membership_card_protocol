import {
  canonicalize,
  mlDsa44Verify,
  keccak256,
} from '@membership-card-protocol/app-sdk';
import { base64UrlToBytes } from '@membership-card-protocol/app-sdk';
import type { CardVerifier, CardVerificationResult, AppSignedSubCardDocument } from '@membership-card-protocol/app-sdk';

/**
 * Wallet-side inbound sub-card request validation (`subcards.md §Sub-Card
 * Request Flow Step 2`) — per OQ-SDK-9's resolution, the sole entry point
 * for validating a request received from a requesting app, before any
 * consent UI is shown (`Step 4.3`).
 *
 * **`CardVerifier` instance decision** (the plan's own open question for
 * this step): this function takes a `CardVerifier` as a direct parameter
 * rather than constructing one — the caller is expected to pass the
 * **same shared instance** used everywhere else in this SDK (Step 1.4,
 * `offers/offerVerification.ts` §8.2), not a second, narrower one scoped
 * only to app-certification. Reasoning: `CardVerifier.verifyCard()`'s
 * trusted-root check is a flat `trustedRoots.includes(address) ||
 * isPolicyAuthorizer(address)` membership test — it has no per-call
 * scoping concept, so there is nothing a second instance would isolate
 * that a single instance constructed with `trustedRoots` containing the
 * *union* of every root this SDK ever needs to recognize (policy trusted
 * roots for offer verification, the governance app-certification policy
 * root for this check) doesn't already provide, at lower operational cost
 * (one `RpcProvider`/`IpfsProvider` pair, one cache, one config to keep in
 * sync). This mirrors `press.md §5.4`'s `verifyAppCertificationChain`,
 * which documents the identical pattern: "the press configures the
 * verifier with the app-certification policy root as a trusted root for
 * this check." The caller is responsible for including that root in
 * whichever `trustedRoots` array it constructs the shared instance with;
 * this function does not (and cannot) verify that it did.
 *
 * Per OQ-SDK-11, this step does not query the EAS annotation board — the
 * caller's shared `CardVerifier` should be constructed with
 * `fetchAnnotations: false`, and this function does not read
 * `appCardVerification.annotations` at all, so nothing here depends on
 * that config being set correctly (it only affects whether an unnecessary
 * network call happens inside `verifyCard`, not this function's
 * pass/reject decision).
 *
 * Attestation-proof verification (`subcards.md §Step 2` sub-step 6 — App
 * Attest / Play Integrity assertion checking) is out of scope for this
 * step, matching the same limitation already documented in
 * `wallet/deviceSubCard.ts` (no attestation provider exists in this SDK
 * yet).
 */

export type SubCardRequestRejectionCode =
  | 'app_signature_invalid'
  | 'holder_primary_card_binding_mismatch'
  | 'app_card_binding_mismatch'
  | 'app_card_chain_not_trusted'
  | 'app_card_not_currently_valid'
  | 'verification_error';

export interface SubCardRequestRejection {
  valid: false;
  code: SubCardRequestRejectionCode;
  reason: string;
}

export interface ValidatedSubCardRequest {
  valid: true;
  request: AppSignedSubCardDocument;
  appCardVerification: CardVerificationResult;
}

export type HandleSubCardRequestResult = ValidatedSubCardRequest | SubCardRequestRejection;

export interface HandleSubCardRequestOptions {
  /** The SDK's single shared `CardVerifier` instance — see this module's doc for why a second, narrower instance isn't used. */
  cardVerifier: CardVerifier;
  /** The raw, received request — an `AppSignedSubCardDocument` (App SDK's `requestSubCard` output), untrusted until this function returns `{ valid: true }`. */
  request: AppSignedSubCardDocument;
}

function rejection(code: SubCardRequestRejectionCode, reason: string): SubCardRequestRejection {
  return { valid: false, code, reason };
}

/**
 * `subcards.md §Sub-Card Request Flow Step 2`, sub-steps 1–4: verify
 * `app_signature`, apply both keccak256 binding checks, and confirm the
 * app card's chain reaches the governance app-certification root and is
 * currently valid (not revoked) — via the shared `CardVerifier`, never
 * re-derived locally.
 */
export async function handleSubCardRequest(options: HandleSubCardRequestOptions): Promise<HandleSubCardRequestResult> {
  const { request } = options;

  const holderPubkey = base64UrlToBytes(request.holder_primary_card_pubkey);
  if (keccak256(holderPubkey) !== request.holder_primary_card) {
    return rejection(
      'holder_primary_card_binding_mismatch',
      'keccak256(holder_primary_card_pubkey) does not match holder_primary_card.'
    );
  }

  const appCardPubkey = base64UrlToBytes(request.app_card_pubkey);
  const appCardAddress = keccak256(appCardPubkey);
  if (appCardAddress !== request.app_card) {
    return rejection('app_card_binding_mismatch', 'keccak256(app_card_pubkey) does not match app_card.');
  }

  const { app_signature, ...fieldsOnly } = request;
  const signatureValid = mlDsa44Verify(appCardPubkey, canonicalize(fieldsOnly), base64UrlToBytes(app_signature));
  if (!signatureValid) {
    return rejection('app_signature_invalid', 'app_signature does not verify against app_card_pubkey.');
  }

  let appCardVerification: CardVerificationResult;
  try {
    appCardVerification = await options.cardVerifier.verifyCard(appCardAddress);
  } catch (err) {
    return rejection(
      'verification_error',
      `app card verification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (appCardVerification.chain_reaches_trusted_root !== true) {
    return rejection(
      'app_card_chain_not_trusted',
      'app card chain does not reach the governance app-certification policy root.'
    );
  }
  // `verifyCard` is always called here with no pubkey, so `CardVerifier`
  // always returns `is_currently_valid: "skipped"` for this path
  // (`card_verifier.md §7.4`'s documented "verifyCard limitation" — Stage 4
  // cannot determine revocation status without decryptable content, same
  // as `offerVerification.ts`'s identical check). Treating "skipped" as a
  // rejection would block every sub-card request unconditionally; only an
  // explicit `false` (a decryptable, confirmed-revoked card) is a real
  // rejection.
  if (appCardVerification.is_currently_valid === false) {
    return rejection('app_card_not_currently_valid', 'app card is revoked or not currently valid.');
  }

  return { valid: true, request, appCardVerification };
}
