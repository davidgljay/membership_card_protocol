import type { ValidatedSubCardRequest } from './handleSubCardRequest.js';

/**
 * Consent data structure assembly (`subcards.md §Sub-Card Request Flow
 * Step 3`) — run on a successful Step 4.2 validation, before any
 * user-facing consent UI.
 *
 * Judgment calls:
 * - **App identity** (name/version/publisher) is caller-supplied, not
 *   resolved here. Reading these fields means fetching and decrypting the
 *   app card's IPFS content — `CardVerifier.verifyCard()` (Step 4.2) never
 *   exposes decrypted card content, only verification results, and this
 *   package has no independent IPFS-fetch-and-decrypt primitive outside
 *   `CardVerifier`'s own internals (which aren't exposed). Building one
 *   just for this field would mean reimplementing content decryption
 *   outside the shared verifier, which Goal 6 explicitly rules out. The
 *   caller resolves app identity however it already does (its own IPFS
 *   fetch, or a cached copy) and passes it through.
 * - **`grantableCapabilities`** is informational, for display in the
 *   consent UI, not a final decision this module makes. It is simply
 *   `requestedCapabilities` intersected with the wallet's own configured
 *   whitelist of capabilities it's ever willing to grant to any app
 *   (`subcards.md §Capabilities`: "the wallet may grant a subset of what
 *   was requested but never more"). See `countersign.ts`'s doc comment for
 *   why the *actual* countersigned document cannot silently narrow
 *   `capabilities` below what the app requested, even though the wallet
 *   is described as being able to.
 * - **Annotation warnings** are always empty — no EAS annotation-board
 *   lookup is performed (`fetchAnnotations: false`, OQ-SDK-11), matching
 *   Step 4.2's own scope limit.
 */

export interface SubCardConsentAppIdentity {
  name: string;
  version?: string;
  publisher?: string;
}

export interface SubCardConsentData {
  appIdentity: SubCardConsentAppIdentity;
  /** The full capability whitelist the app requested (`request.capabilities`), unmodified. */
  requestedCapabilities: string[];
  /** `requestedCapabilities` narrowed to what the wallet's own config is willing to grant at all — informational, see this module's doc. */
  grantableCapabilities: string[];
  /** Always `[]` for now — see this module's doc (OQ-SDK-11). */
  annotationWarnings: string[];
  /** A default/suggested expiry for the consent UI to pre-fill; the user may set a shorter one. Caller-supplied — this module has no opinion on a default duration. */
  suggestedValidUntil?: string;
  /** Step 4.2's validated request, carried through for `countersignSubCardRequest`. */
  validatedRequest: ValidatedSubCardRequest;
}

export interface AssembleSubCardConsentOptions {
  /** Must be an already-`{ valid: true }` result from `handleSubCardRequest` (Step 4.2) — there is no path to a consent structure that skips validation. */
  validated: ValidatedSubCardRequest;
  appIdentity: SubCardConsentAppIdentity;
  /** The wallet's own configured whitelist of capabilities it will ever grant, to any app. */
  walletGrantableCapabilities: string[];
  suggestedValidUntil?: string;
}

/**
 * `subcards.md §Sub-Card Request Flow Step 3`: assemble the consent
 * screen's data — app identity, requested vs. grantable capabilities,
 * annotation status (always clean, OQ-SDK-11), and a suggested `valid_until`.
 */
export function assembleSubCardConsent(options: AssembleSubCardConsentOptions): SubCardConsentData {
  const requestedCapabilities = options.validated.request.capabilities;
  const grantableSet = new Set(options.walletGrantableCapabilities);
  const grantableCapabilities = requestedCapabilities.filter((capability) => grantableSet.has(capability));

  return {
    appIdentity: options.appIdentity,
    requestedCapabilities,
    grantableCapabilities,
    annotationWarnings: [],
    ...(options.suggestedValidUntil ? { suggestedValidUntil: options.suggestedValidUntil } : {}),
    validatedRequest: options.validated,
  };
}
