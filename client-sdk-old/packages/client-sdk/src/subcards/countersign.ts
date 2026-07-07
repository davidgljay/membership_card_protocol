import { canonicalize } from '../crypto/canonicalize.js';
import { mlDsa44Sign } from '../crypto/mldsa.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { RegisterSubCardFn, SignedSubCardDocument } from '../wallet/deviceSubCard.js';
import type { SubCardConsentData } from './consent.js';

/**
 * `subcards.md §Sub-Card Request Flow Step 4`: the holder's primary card
 * key countersigns the app-signed request → `holder_signature`, and the
 * completed `SubCardDocument` is submitted for registration.
 *
 * **Self-signing exception:** when the requesting app is the wallet
 * itself, this module is not used at all — `wallet/deviceSubCard.ts`'s
 * `registerDeviceSubCard` (Step 2.2) already implements that entire path
 * directly (no request/validation/consent pipeline exists for it, since
 * the wallet signs its own request as one continuous operation) and
 * remains unchanged. "Wiring this back to Step 2.2" means exactly this:
 * the self-signing path's mechanism *is* Step 2.2's existing function;
 * nothing here needs to be shared with or called by it.
 *
 * **Why `approvedCapabilities` cannot narrow the signed document below
 * what the app requested, even though `subcards.md §Capabilities` says
 * "the wallet may grant a subset of what was requested but never more":**
 * `app_signature` is computed by the requesting app over canonical RFC
 * 8785 JSON of the *entire* document, including `capabilities`, before the
 * wallet ever sees it (Step 4.1). `holder_signature` then covers that same
 * document plus `app_signature` itself — meaning both signatures are
 * defined over one fixed, immutable set of field values. If this function
 * silently rewrote `capabilities` to a narrower set before countersigning,
 * the resulting document's `app_signature` would fail to verify against
 * its own `capabilities` field (any verifier recomputes the canonical
 * bytes from the document as stored and checks the signature over
 * exactly that) — an invalid, undeliverable document. A wallet that wants
 * to grant fewer capabilities than requested cannot do so within this
 * document; the only sound options are (a) reject outright, or (b) ask
 * the app to submit a new request for the narrower set, which the app
 * then signs itself. This function enforces this structurally: it
 * requires `approvedCapabilities` to exactly match
 * `consentData.requestedCapabilities`, and returns `{ countersigned:
 * false }` — never a signature — otherwise.
 */

export interface ConsentDecision {
  approved: boolean;
  /** Must exactly equal `consentData.requestedCapabilities` for a countersignature to be produced — see this module's doc. */
  approvedCapabilities: string[];
}

export interface CountersignSubCardRequestOptions {
  consentData: SubCardConsentData;
  decision: ConsentDecision;
  /** The holder's primary card key. Caller-supplied, same shape as every other place in this package that needs it (`recovery.ts`'s `cancelRecovery`, `subCardDeregistration.ts`) — this package has no general "unlock the wallet's master key" primitive. */
  masterSecretKey: Uint8Array;
  /** Stands in for Step 4.4's real press-submission flow, same injected-callback pattern as `deviceSubCard.ts`'s `registerDeviceSubCard`. */
  registerSubCard: RegisterSubCardFn;
}

export type CountersignSubCardRequestOutcome =
  | { countersigned: true; document: SignedSubCardDocument; registered: boolean }
  | { countersigned: false; reason: string };

export async function countersignSubCardRequest(
  options: CountersignSubCardRequestOptions
): Promise<CountersignSubCardRequestOutcome> {
  if (!options.decision.approved) {
    return { countersigned: false, reason: 'consent decision was not approved.' };
  }

  const requested = options.consentData.requestedCapabilities;
  const approved = options.decision.approvedCapabilities;
  const exactMatch = requested.length === approved.length && requested.every((capability) => approved.includes(capability));
  if (!exactMatch) {
    return {
      countersigned: false,
      reason:
        'approvedCapabilities must exactly match the requested set — narrowing capabilities would change the signed document and invalidate app_signature. Ask the app to submit a new request for the narrower set instead.',
    };
  }

  const request = options.consentData.validatedRequest.request;
  const holderSignature = mlDsa44Sign(options.masterSecretKey, canonicalize(request));
  const document: SignedSubCardDocument = { ...request, holder_signature: bytesToBase64Url(holderSignature) };

  const { registered } = await options.registerSubCard(document);
  return { countersigned: true, document, registered };
}
