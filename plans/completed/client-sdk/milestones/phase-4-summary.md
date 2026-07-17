# Phase 4 Milestone Review — Sub-Card Request, Consent, Countersigning, and Revocation

**Date:** 2026-07-04
**Scope:** `client-sdk/packages/client-sdk/src/subcards/` (Steps 4.1–4.4) plus the already-built deregistration primitive from Phase 2 Step 2.5 (`wallet/subCardDeregistration.ts`), which this phase's own Step 4.4 was originally slated to build.

## Summary

`requestSubCard` (4.1) generalizes the wallet's own self-signing `SubCardDocument` assembly (`wallet/deviceSubCard.ts`, Phase 2) to the third-party-app case: a fresh, non-exportable ML-DSA-44 keypair via `SecureKeyProvider`, `app_signature` only, no IPFS post, returned for the host app to deliver via whatever channel it implements (OQ-SDK-9). `handleSubCardRequest` (4.2) is the sole inbound validation entry point — signature, both binding checks, and chain/revocation status via the shared `CardVerifier`, resolving the plan's own open question by reusing one instance with a unioned `trustedRoots` rather than a second, narrower one. `assembleSubCardConsent` + `countersignSubCardRequest` (4.3) produce the consent screen's data and the holder's countersignature; `pressSubmission.ts` + `revocation.ts` (4.4) submit the completed document to a press and implement 8xx revocation via the general update-intent flow.

A full loop — one fake "SDK instance" requesting a sub-card, a separate one validating, producing consent, countersigning, and registering it, then revoking it — passes end-to-end against a stub press/registry (`test/subcards/phase4EndToEnd.test.ts`). 206 tests pass in the `client-sdk` core package (up from 190 at the start of this phase); build/typecheck/lint clean across the whole workspace.

## "Done when" checklist

- Full request → validate → consent → countersign → register → revoke loop passes end-to-end against stub press/registry: yes (`phase4EndToEnd.test.ts`).
- 9xx-exclusion test passes: yes — `SubCardRevocationCode`'s literal type (`800 | 801 | 810 | 811`) makes a 9xx value unconstructable through `revokeSubCard`'s signature; a test force-casts one past TypeScript and confirms the runtime check rejects it before any network call (`revocation.test.ts`).
- Primary-key-only-deregistration test passes: yes — this was Phase 2 Step 2.5's own deliverable (`wallet/subCardDeregistration.test.ts`), not rebuilt here; `deregisterSubCard` has no signer parameter other than `masterSecretKey`, confirmed by a test verifying the produced signature against the master public key specifically.
- Phase summary written: this document.
- `specs/object_specs/client_sdk.md` §9 and its §14 status table updated to mark Steps 4.2–4.4 (and this milestone) **Done**: done as part of this same change.

## A finding from implementation, not anticipated by the plan text

`subcards.md §Capabilities` — "the wallet may grant a subset of what was requested but never more" — reads as though the wallet can rewrite a request's `capabilities` field to a narrower list before countersigning. It cannot, without invalidating the document: `app_signature` covers the entire document including `capabilities`, and `holder_signature` covers that plus `app_signature`; both are defined over one fixed set of field values, so silently narrowing `capabilities` here would make the stored document's own `app_signature` fail to verify against its own `capabilities` field for any later verifier. `countersignSubCardRequest` (Step 4.3) requires the approved capability set to exactly match what was requested and refuses — never signing — otherwise; narrowing what's granted requires rejecting the request and having the app resubmit a narrower one, which the app signs itself. `grantableCapabilities` in the consent structure remains useful as *advisory* information for the consent UI (and for deciding whether to reject), just not as something this function can apply directly to an already-app-signed document.

## What was **not** built in this phase (explicitly out of scope, not gaps)

- EAS annotation-board lookups and annotation-triggered auto-revocation (OQ-SDK-11) — `fetchAnnotations: false` throughout; confirmed by a test that the annotation board is never called during validation.
- Attestation-proof verification (App Attest / Play Integrity) — no attestation provider exists in this package yet, matching the same limitation already documented for the wallet's own device sub-card (Step 2.2).
- `POST /issue`-equivalent initial sub-card *request* transport/delivery, and any shipped consent UI — per OQ-SDK-9, this package exposes only the validation entry point; delivery and UI are host-app concerns.

## Next

Phase 5 (messaging and UUID/relay management) proceeds next.
