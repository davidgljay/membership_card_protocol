# App SDK / Wallet SDK Split — Implementation Plan

**Strategic plan:** `sdk-split-strategic-plan.md` (read first — package names, capability table, and the four resolved decisions referenced throughout are defined there)

This plan covers only the split itself: spec division → codebase division → completion → verification → npm publish. The follow-on integration of the App SDK into wallet-service, press, and relay is a **separate plan**, written after both packages are published — not scoped here.

---

## Phase 1: Spec Division

### Step 1.1 — Split `specs/object_specs/client_sdk.md` into two specs
**What:** Using a subagent, divide `specs/object_specs/client_sdk.md` into `specs/object_specs/app_sdk.md` and `specs/object_specs/wallet_sdk.md`, following the capability table and four resolved decisions in the strategic plan. Each new spec keeps the source doc's format (Design Principles, Package Structure, Provider Interfaces, per-capability sections, Security Invariants, Result/Error Conventions, Implementation Status, Dependencies, Resolved Design Decisions) but scoped to that package's capabilities only. Explicitly write up the `deviceSubCard.ts` collapse (§ resolved decision) as a *planned* change in `wallet_sdk.md`, not a straight carry-forward — the current spec's §7.4 describes the old shape; the new spec must describe the target shape (Wallet SDK calling App SDK's `requestSubCard` + self-authorized consent). Cross-link the two new specs to each other and note in both that `specs/object_specs/client_sdk.md` is now historical (add a status banner to the old file pointing to the split, do not delete it).
**Who:** Claude (subagent)
**Context needed:** `specs/object_specs/client_sdk.md` (full), `plans/sdk-split-strategic-plan.md` (capability table + resolved decisions), the related process specs listed in `client_sdk.md`'s "Related Specs" section (only as needed for cross-reference, not full re-read)
**Done when:** `specs/object_specs/app_sdk.md` and `specs/object_specs/wallet_sdk.md` exist, together cover every capability in the original spec exactly once (no capability dropped, none duplicated), both explicitly describe the `deviceSubCard` collapse and the interface-only Node keystore decision, and `client_sdk.md` has a status banner marking it superseded.

### Phase 1 Milestone Review
**Context needed:** `specs/object_specs/app_sdk.md`, `specs/object_specs/wallet_sdk.md`, `specs/object_specs/client_sdk.md` (original, for diffing coverage)
**Done when:** Every §-numbered capability in the original spec is traceable to exactly one line in exactly one new spec (a checklist, not a vibe check); no contradictions in naming between the two new specs (e.g. both must call the same shared provider interfaces by the same names); the `deviceSubCard` collapse is described consistently (same target shape) in `wallet_sdk.md` and doesn't silently reappear as the old shape anywhere; a one-paragraph summary written to `plans/sdk-split/milestones/phase-1-summary.md`. If a capability's ownership is ambiguous, resolve it here before Phase 2 — don't carry an unresolved split into codebase work.

**Clarification checkpoint:** If the spec split surfaces a capability that doesn't cleanly fit either package (e.g., something that needs both custody and requester-side logic in a way the strategic plan's table didn't anticipate), stop and check in before finalizing the specs.

---

## Phase 2: Codebase Division (Scaffold + Salvage)

### Step 2.1 — Preserve reference copy
**What:** Copy `client-sdk/` to `client-sdk-old/` in full (matching the existing `relay-old/` precedent already in this repo), untouched, before any other Phase 2 work starts.
**Who:** Claude
**Context needed:** none
**Done when:** `client-sdk-old/` exists as an exact copy, `client-sdk/` is untouched, and this copy is committed as its own step (so it's a clean rollback point independent of everything after it).

### Step 2.2 — Scaffold and salvage `app-sdk/`
**What:** Using one subagent, scaffold a new `app-sdk/` pnpm workspace mirroring `client-sdk/`'s structure (`packages/app-sdk`, plus contributing to the shared `client-sdk-web`/`client-sdk-rn` provider packages per the strategic plan's platform-package decision — see Step 2.4). Then salvage: move (not recreate) the App SDK's capabilities from `client-sdk/packages/client-sdk/src/` — `providers/`, `crypto/`, `verification/`, `transport/`, `subcards/requestSubCard.ts`, `subcards/pressSubmission.ts`'s registration half, `messaging/*`, `offers/targetedOffer.ts`, `offers/openOffer.ts`, `offers/targetedOfferAcceptance.ts`'s `forwardCountersignedTargetedOffer` only (not `acceptTargetedOffer`) — along with each module's existing tests. Do not rewrite working code; port it and update imports. The one genuinely new piece of work in this step is the "sign arbitrary data with a subcard" primitive (thin wrapper over `SecureKeyProvider.sign`), since it doesn't exist as a standalone export today.
**Who:** Claude (subagent A)
**Context needed:** `specs/object_specs/app_sdk.md`, `client-sdk-old/` (source to salvage from — do not touch), strategic plan's capability table
**Done when:** `app-sdk/` builds, its salvaged tests pass unmodified (module-for-module parity with their `client-sdk-old` originals), the new "sign with subcard" primitive exists with a test, and `grep` across `app-sdk/` confirms zero references to keyring, backup, or recovery code.

### Step 2.3 — Scaffold and salvage `wallet-sdk/`
**What:** Using a second, separate subagent, scaffold `wallet-sdk/` the same way. Salvage: `wallet/setupWallet.ts`, `keyring.ts`, `kdf.ts`, `backupRegistration.ts`, `recovery.ts`, `subCardDeregistration.ts`, `subcards/handleSubCardRequest.ts`, `consent.ts`, `countersign.ts` (subcard-authorization countersign — distinct from offer countersign), `offers/offerVerification.ts`, `offers/countersign.ts` (offer countersign), `offers/newWalletOpenOfferAcceptance.ts`, `existingWalletOpenOfferAcceptance.ts`, `targetedOfferAcceptance.ts`'s `acceptTargetedOffer` only. `wallet-sdk/package.json` depends on `app-sdk` (workspace or published, per whichever is ready at scaffold time — likely a local `workspace:*` reference until Phase 4 publishes App SDK first). The one deliberately new piece of work here, not a straight port: rewrite `wallet/deviceSubCard.ts`'s `registerDeviceSubCard` to call App SDK's `requestSubCard` + self-authorize consent/countersign internally, per the resolved decision — do not port the old self-signing implementation unchanged.
**Who:** Claude (subagent B, run independently from subagent A — no shared state, both read from `client-sdk-old/` only)
**Context needed:** `specs/object_specs/wallet_sdk.md`, `client-sdk-old/`, strategic plan's capability table and `deviceSubCard` resolution
**Done when:** `wallet-sdk/` builds against `app-sdk` as a workspace dependency, salvaged tests pass, `registerDeviceSubCard` is reimplemented on top of App SDK primitives (not the old code path) with a test proving it produces an equivalent `SignedSubCardDocument` to before, and `grep` confirms no duplicated crypto/provider/transport code (must import from `app-sdk`, never redefine).

### Step 2.4 — Reconcile shared platform packages
**What:** Update `client-sdk-web`/`client-sdk-rn` (or rename to `sdk-providers-web`/`sdk-providers-rn` if clearer — your call at this step) so both `app-sdk` and `wallet-sdk` depend on them for default provider implementations, rather than either package vendoring its own copies. This step necessarily happens after 2.2 and 2.3 land since it needs to see what both packages actually import.
**Who:** Claude
**Context needed:** `app-sdk/` and `wallet-sdk/`'s provider imports (post-2.2/2.3), original `client-sdk-web`/`client-sdk-rn` source
**Done when:** one platform package per runtime, imported by both SDKs, no provider implementation exists in two places.

### Phase 2 Milestone Review
**Context needed:** `app-sdk/`, `wallet-sdk/`, both specs, `client-sdk-old/` (for diffing)
**Done when:** Both packages build and test independently; the import graph is exactly `wallet-sdk → app-sdk → verifier` with no cycle; a code-search confirms no crypto/canonicalization/provider logic is duplicated between the two packages; combined test count across both new packages is ≥ the original 243 (accounting for tests that moved rather than were dropped); phase summary written to `plans/sdk-split/milestones/phase-2-summary.md`.

**Clarification checkpoint:** Before deleting anything from `client-sdk/` itself (as opposed to leaving `client-sdk-old/` as the copy and `client-sdk/` untouched until this whole effort is done), check in — recommend leaving `client-sdk/` in place, unpublished and unmaintained, until both new packages are verified and published, then removing it in one final cleanup step you approve explicitly.

---

## Phase 3: Completion and Verification Against Spec

### Step 3.1 — Complete `app-sdk/`
**What:** Using a subagent, take `app-sdk/` from Step 2.2's state to full spec compliance with `specs/object_specs/app_sdk.md`: fill any gap the salvage step didn't cover (the new "sign with subcard" primitive gets full test coverage here if not already done), implement Phase 6-equivalent hardening items that apply to App SDK's scope (cross-platform scenario tests, doc comments), and write `app-sdk/README.md`.
**Who:** Claude (subagent)
**Context needed:** `specs/object_specs/app_sdk.md`, current `app-sdk/` state, `client-sdk_old`'s Phase 6 plan items from `plans/client-sdk/implementation-plan.md` (for what "cross-platform hardening" originally meant) filtered to App SDK's scope only
**Done when:** every capability in `app_sdk.md` has a corresponding implementation and passing test; `pnpm build && pnpm test && pnpm lint` clean; README exists.

### Step 3.2 — Complete `wallet-sdk/`
**What:** Same, against `specs/object_specs/wallet_sdk.md`, run as a separate subagent in parallel with 3.1.
**Who:** Claude (subagent, independent of 3.1's)
**Context needed:** `specs/object_specs/wallet_sdk.md`, current `wallet-sdk/` state, Phase 6 items filtered to Wallet SDK's scope (this is also where CP-2, the pre-production security review from the original spec's §11, belongs — keyring/backup/recovery is exactly the surface that review was written for)
**Done when:** every capability in `wallet_sdk.md` implemented and tested; `pnpm build && pnpm test && pnpm lint` clean; CP-2-equivalent security review complete and findings resolved or explicitly tracked (mirroring the original CP-1 review's documented-gap pattern); README exists.

### Phase 3 Milestone Review
**Context needed:** both packages' final state, both specs, both README files
**Done when:** both packages independently pass `pnpm build && pnpm test && pnpm lint`; a fresh read-through of each spec's Implementation Status table shows nothing left as "Not started" that was in this plan's scope; the two READMEs don't contradict each other on the import relationship (`wallet-sdk` depends on `app-sdk` — this must be stated identically in both); phase summary written to `plans/sdk-split/milestones/phase-3-summary.md`.

**Clarification checkpoint:** If either subagent's security review (CP-2 equivalent) surfaces a finding as severe as the original CP-1 finding (a genuine cryptographic design flaw, not a documented lower-severity gap), stop and bring it to you before proceeding to publish — don't let a subagent self-resolve something at that severity.

---

## Phase 4: NPM Publish

### Step 4.1 — Publish `app-sdk` first
**What:** Version, tag, and publish `@membership-card-protocol/app-sdk` to npm. Must go first since `wallet-sdk` depends on it.
**Who:** Claude drafts the publish steps and package metadata; you run or approve the actual `npm publish` (credentials/registry access).
**Context needed:** `app-sdk/package.json`, CI config (`.github/workflows/client-sdk-ci.yml` as a template for a new `app-sdk-ci.yml`/`wallet-sdk-ci.yml`)
**Done when:** package is live on npm at the intended version, installable in a scratch project.

### Step 4.2 — Update `wallet-sdk`'s dependency and publish
**What:** Point `wallet-sdk/package.json` at the published `app-sdk` version instead of a workspace reference, re-run its full test suite against the published package (not the workspace copy) to catch anything the workspace link was silently papering over, then publish.
**Who:** Claude drafts; you run/approve publish.
**Context needed:** `wallet-sdk/package.json`, Step 4.1's published version number
**Done when:** `wallet-sdk` is live on npm, its test suite passes against the published `app-sdk` (not a local link), installable in a scratch project alongside `app-sdk`.

### Step 4.3 — Retire `client-sdk/`
**What:** With both new packages published and verified, remove `client-sdk/` from active use (deprecate on npm if it was ever published there; otherwise just archive) — `client-sdk-old/` remains as the permanent historical reference per the repo's existing `relay-old/` convention.
**Who:** Claude drafts, you approve before anything is deleted or deprecated.
**Context needed:** none beyond confirming Phase 4.1/4.2 are both live
**Done when:** you've explicitly signed off; `client-sdk/` is either removed or clearly marked deprecated; `client-sdk-old/` untouched.

### Phase 4 Milestone Review
**Context needed:** npm registry listings for both packages, CI status for both
**Done when:** both packages installable from npm in a clean project, CI green on both, `client-sdk/` disposition resolved per your sign-off. This is the trigger condition for the follow-on integration plan (wallet-service/press/relay each initiating subcard registration on startup) — write that plan only after this review closes.

---

## Summary of Clarification Checkpoints (collected)

1. End of Phase 1: any capability that doesn't cleanly fit either spec.
2. Before deleting anything from `client-sdk/` itself (Phase 2) — recommend leaving it in place, untouched, until Phase 4 completes.
3. End of Phase 3: any CP-2-severity security finding.
4. Before any actual `npm publish` command runs (Phase 4, both steps) — you run or explicitly approve.
5. Before `client-sdk/` is removed or deprecated (Step 4.3).
