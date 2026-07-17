# App SDK / Wallet SDK Split — Implementation Plan

**Strategic plan:** `sdk-split-strategic-plan.md` (read first — package names, capability table, and the four resolved decisions referenced throughout are defined there)

This plan covers only the split itself: spec division → codebase division → completion → verification → npm publish. The follow-on integration of the App SDK into wallet-service, press, and relay is a **separate plan**, written after both packages are published — not scoped here.

---

## Phase 1: Spec Division

### Step 1.1 — Split `specs/object_specs/client_sdk.md` into two specs
**What:** Divide `specs/object_specs/client_sdk.md` into `specs/object_specs/app_sdk.md` and `specs/object_specs/wallet_sdk.md`, following the capability table and four resolved decisions in the strategic plan. Each new spec keeps the source doc's format (Design Principles, Package Structure, Provider Interfaces, per-capability sections, Security Invariants, Result/Error Conventions, Implementation Status, Dependencies, Resolved Design Decisions) but scoped to that package's capabilities only. Explicitly write up the `deviceSubCard.ts` collapse (§ resolved decision) as a *planned* change in `wallet_sdk.md`, not a straight carry-forward — the current spec's §7.4 describes the old shape; the new spec must describe the target shape (Wallet SDK calling App SDK's `requestSubCard` + self-authorized consent). Cross-link the two new specs to each other and note in both that `specs/object_specs/client_sdk.md` is now historical (add a status banner to the old file pointing to the split, do not delete it).
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
**What:** Scaffold a new `app-sdk/` pnpm workspace mirroring `client-sdk/`'s structure (`packages/app-sdk`). Reconciling the shared platform provider packages happens separately, in Step 2.4, after this step and 2.3 both land. Salvage: move (not recreate) the App SDK's capabilities from `client-sdk/packages/client-sdk/src/` — `providers/`, `crypto/`, `verification/`, `transport/`, `subcards/requestSubCard.ts`, `subcards/pressSubmission.ts`'s registration half, `messaging/*`, `offers/targetedOffer.ts`, `offers/openOffer.ts`, `offers/targetedOfferAcceptance.ts`'s `forwardCountersignedTargetedOffer` only (not `acceptTargetedOffer`) — along with each module's existing tests. Do not rewrite working code; port it and update imports. The one genuinely new piece of work in this step is the "sign arbitrary data with a subcard" primitive (thin wrapper over `SecureKeyProvider.sign`), since it doesn't exist as a standalone export today.
**Who:** Claude (subagent A)
**Context needed:** `specs/object_specs/app_sdk.md`, `client-sdk-old/` (source to salvage from — do not touch), strategic plan's capability table
**Done when:** `app-sdk/` builds, its salvaged tests pass unmodified (module-for-module parity with their `client-sdk-old` originals), the new "sign with subcard" primitive exists with a test, and `grep` across `app-sdk/` confirms zero references to keyring, backup, or recovery code.

### Step 2.3 — Scaffold and salvage `wallet-sdk/`
**What:** Scaffold `wallet-sdk/` the same way, run independently of Step 2.2 (both read only from `client-sdk-old/`, no shared state). Salvage: `wallet/setupWallet.ts`, `keyring.ts`, `kdf.ts`, `backupRegistration.ts`, `recovery.ts`, `subCardDeregistration.ts`, `subcards/handleSubCardRequest.ts`, `consent.ts`, `countersign.ts` (subcard-authorization countersign — distinct from offer countersign), `offers/offerVerification.ts`, `offers/countersign.ts` (offer countersign), `offers/newWalletOpenOfferAcceptance.ts`, `existingWalletOpenOfferAcceptance.ts`, `targetedOfferAcceptance.ts`'s `acceptTargetedOffer` only. `wallet-sdk/package.json` depends on `app-sdk` (workspace or published, per whichever is ready at scaffold time — likely a local `workspace:*` reference until Phase 4 publishes App SDK first). The one deliberately new piece of work here, not a straight port: rewrite `wallet/deviceSubCard.ts`'s `registerDeviceSubCard` to call App SDK's `requestSubCard` + self-authorize consent/countersign internally, per the resolved decision — do not port the old self-signing implementation unchanged.

**Executed-state note (written after this step landed):** `wallet-sdk` and `app-sdk` are separate top-level pnpm workspaces (not packages within one shared workspace), so `workspace:*` wasn't available — the actual dependency is `"@membership-card-protocol/app-sdk": "file:../../../app-sdk/packages/app-sdk"`, the same pattern `app-sdk` itself uses for its `@membership-card-protocol/verifier` dependency. This is now the established convention for any future package (including `sdk-providers-web`/`sdk-providers-rn`, Step 2.4) that needs to depend on an unpublished sibling workspace in this repo.
**Who:** Claude (subagent B, run independently from subagent A — no shared state, both read from `client-sdk-old/` only)
**Context needed:** `specs/object_specs/wallet_sdk.md`, `client-sdk-old/`, strategic plan's capability table and `deviceSubCard` resolution
**Done when:** `wallet-sdk/` builds against `app-sdk` as a workspace dependency, salvaged tests pass, `registerDeviceSubCard` is reimplemented on top of App SDK primitives (not the old code path) with a test proving it produces an equivalent `SignedSubCardDocument` to before, and `grep` confirms no duplicated crypto/provider/transport code (must import from `app-sdk`, never redefine).

### Step 2.4 — Reconcile shared platform packages

**Scope correction (written after 2.2/2.3 landed, replacing this step's original one-paragraph description):** Now that `app-sdk/` and `wallet-sdk/` actually exist, the dependency direction in the original wording ("so both app-sdk and wallet-sdk depend on them") is backwards and the task is smaller than it sounded. Facts established by 2.2/2.3, not assumptions:

- All seven provider interfaces (`StorageProvider`, `SecureKeyProvider`, `PasskeyProvider`, `YubiKeyProvider`, `RealtimeTransportProvider`, `MultiInstanceLock`, `ObliviousProtocolTransport`) are defined exactly once, in `app-sdk`. `wallet-sdk` imports/re-exports them from `app-sdk`; it never redefines one. There is no wallet-side provider interface to reconcile.
- `client-sdk-old/packages/client-sdk-web/` and `client-sdk-old/packages/client-sdk-rn/` each implement exactly five of those interfaces (`ObliviousProtocolTransport` is platform-independent and lives in `app-sdk` itself, per `app_sdk.md` §4.7; no concrete `YubiKeyProvider` exists on either platform yet, per `app_sdk.md` §4.4) — a small, well-bounded surface (5 files + an `index.ts` barrel + one platform-specific helper file each: `indexeddb.ts` on web, `base64url.ts` on RN).
- Provider implementations are host-app-injected, never a hard dependency of the SDK core packages. Neither `app-sdk` nor `wallet-sdk` should gain a runtime dependency on a platform package — a host app depends on `app-sdk` (or `wallet-sdk`) *and separately* on the relevant platform package, then wires a provider instance in itself. The platform package depends on `app-sdk` (for the interface types its classes implement), never the reverse.
- Renaming to `sdk-providers-web`/`sdk-providers-rn` (the plan's own "your call at this step" option) is the right call: keeping the name `client-sdk-web` next to a package that imports from `app-sdk`, not `client-sdk`, would misdescribe the dependency. Resolved: rename.

Split into three sub-steps so the mechanical porting (well-specified, low-judgment, same pattern already proven in 2.2/2.3) can go to a lighter-weight agent, with a separate reconciliation pass to catch anything the mechanical steps can't self-check.

#### Step 2.4a — Scaffold and salvage `sdk-providers-web/`
**What:** Scaffold a new top-level `sdk-providers-web/` pnpm workspace (sibling to `app-sdk/`, `wallet-sdk/`), package name `@membership-card-protocol/sdk-providers-web`, mirroring `app-sdk/`'s tooling conventions. Salvage all five provider implementations plus `indexeddb.ts` and the `index.ts` barrel from `client-sdk-old/packages/client-sdk-web/src/`, porting their tests unmodified in assertions. Update the package's dependency from `@membership-card-protocol/client-sdk` (`workspace:*`) to `@membership-card-protocol/app-sdk` via a `file:` reference (matching the convention `wallet-sdk/packages/wallet-sdk/package.json` already established for its own `app-sdk` dependency), and update every provider class's interface imports accordingly. Do not modify `client-sdk-old/`, `client-sdk/`, `app-sdk/`, or `wallet-sdk/`.
**Who:** Claude (haiku) — mechanical port, same shape as prior salvage steps, no design judgment required.
**Context needed:** `client-sdk-old/packages/client-sdk-web/` (source), `app-sdk/packages/app-sdk/src/providers/` (interfaces to implement against), `app-sdk/packages/app-sdk/package.json` (tooling/dependency-declaration template), `wallet-sdk/packages/wallet-sdk/package.json` (the `file:` dependency pattern to replicate).
**Done when:** `sdk-providers-web/` builds and tests pass with the same assertions as the `client-sdk-old` originals; `git status` shows zero changes to `client-sdk/`, `client-sdk-old/`, `app-sdk/`, `wallet-sdk/`; a `.gitignore` (`node_modules/`, `dist/`, etc., matching `app-sdk/.gitignore`) exists so `pnpm install` output never gets staged.

#### Step 2.4b — Scaffold and salvage `sdk-providers-rn/`
**What:** Same as 2.4a, for `sdk-providers-rn/` (`@membership-card-protocol/sdk-providers-rn`), salvaging from `client-sdk-old/packages/client-sdk-rn/src/` (five provider implementations, `base64url.ts`, `index.ts`). Same dependency-direction fix (`app-sdk` via `file:`, not the old `client-sdk`).
**Who:** Claude (haiku) — run independently of 2.4a; both read only from `client-sdk-old/`, no shared state, can go in parallel.
**Context needed:** `client-sdk-old/packages/client-sdk-rn/` (source), `app-sdk/packages/app-sdk/src/providers/` (interfaces), `app-sdk/packages/app-sdk/package.json`, `wallet-sdk/packages/wallet-sdk/package.json` (dependency pattern).
**Done when:** `sdk-providers-rn/` builds and tests pass with the same assertions as the `client-sdk-old` originals; `git status` shows zero changes to `client-sdk/`, `client-sdk-old/`, `app-sdk/`, `wallet-sdk/`; `.gitignore` present.

#### Step 2.4c — Reconciliation review
**What:** Verify 2.4a and 2.4b's output against each other and against the rest of the split, catching anything the mechanical ports can't self-check: confirm neither `sdk-providers-web` nor `sdk-providers-rn` redefines a provider interface rather than importing it from `app-sdk` (grep for `interface StorageProvider` etc. — should find zero matches outside `app-sdk`); confirm no provider *implementation* logic is duplicated between the two platform packages beyond genuinely platform-specific code; confirm `app-sdk`'s and `wallet-sdk`'s own `package.json` files did **not** gain a new dependency on either platform package (they shouldn't need one); update `app_sdk.md` and `wallet_sdk.md`'s remaining references from `client-sdk-web`/`client-sdk-rn` to `sdk-providers-web`/`sdk-providers-rn` wherever they still name the old packages.
**Who:** Claude (direct, not delegated — this is a judgment/consistency pass, not a mechanical port).
**Done when:** both platform packages build and test independently; the full four-package import graph is `wallet-sdk → app-sdk`, `sdk-providers-web → app-sdk`, `sdk-providers-rn → app-sdk`, with no other edges and no cycle; both specs' cross-references to the platform packages use the new names; findings (if any) fixed before Phase 2 Milestone Review.

### Phase 2 Milestone Review
**Context needed:** `app-sdk/`, `wallet-sdk/`, `sdk-providers-web/`, `sdk-providers-rn/`, both specs, `client-sdk-old/` (for diffing)
**Done when:** All four packages build and test independently; the import graph is exactly `wallet-sdk → app-sdk → verifier`, `sdk-providers-web → app-sdk`, `sdk-providers-rn → app-sdk`, with no cycle and no edge from `app-sdk`/`wallet-sdk` to either platform package; a code-search confirms no crypto/canonicalization/provider-interface logic is duplicated across any of the four packages; combined test count across all four ≥ the original 243 (accounting for tests that moved rather than were dropped); phase summary written to `plans/sdk-split/milestones/phase-2-summary.md`.

**Clarification checkpoint:** Before deleting anything from `client-sdk/` itself (as opposed to leaving `client-sdk-old/` as the copy and `client-sdk/` untouched until this whole effort is done), check in — recommend leaving `client-sdk/` in place, unpublished and unmaintained, until both new packages are verified and published, then removing it in one final cleanup step you approve explicitly.

---

## Phase 3: Completion and Verification Against Spec

**Scope correction (written after Step 2.4 landed, replacing Steps 3.1/3.2's original one-paragraph descriptions).** Those two paragraphs pointed at "Phase 6-equivalent hardening" without saying what that actually means for two already-split packages. Grounded against `plans/client-sdk/implementation-plan.md`'s Phase 6 (Steps 6.1–6.3 + CP-2, the only phase of the original plan not fully executed) and the current, real state of both specs' Implementation Status tables:

- **Two items in Phase 6 (Step 6.1's "against real, non-stub local wallet-service/press/relay instances" and all of Step 6.2's OHTTP-endpoint latency/fallback validation) require live deployments of three other codebases.** That's out of scope here — this plan's own intro already excludes "the follow-on integration of the App SDK into wallet-service, press, and relay," and that follow-on plan is the right home for infrastructure-dependent validation. The tractable, in-scope equivalent of "cross-platform hardening" is validating against **real platform providers** (WebCrypto, `react-native-keychain`, IndexedDB, `AsyncStorage`, WebAuthn, `react-native-passkey`, native `EventSource`/`WebSocket`, `react-native-sse`) with stubbed backend responses — exactly the pattern `sdk-providers-web`/`sdk-providers-rn`'s existing `test/scenarios/realtimeDelivery.test.ts` already establishes for App SDK's messaging module. Steps 3.1b/3.2c below extend that same pattern to the rest of each package's flows.
- **A real, ungrounded architectural question the scenario-test extension surfaces:** `sdk-providers-web`/`sdk-providers-rn` depend only on `app-sdk` (Step 2.4's reconciliation), so App SDK-owned flows' scenario tests can keep living in the platform packages' own `test/scenarios/`, importing `app-sdk` functions against real providers — no graph change needed. Wallet SDK-owned flows have no such path: extending the platform packages' *runtime* dependency to `wallet-sdk` would contradict Step 2.4c's established graph. Resolved: `wallet-sdk/packages/wallet-sdk/package.json` takes `sdk-providers-web`/`sdk-providers-rn` as **devDependencies only** (same `file:` convention, `devDependencies` not `dependencies`), and wallet-sdk's own scenario tests live in `wallet-sdk/packages/wallet-sdk/test/scenarios/`. This doesn't touch the runtime import graph Phase 2's milestone review verified (`wallet-sdk → app-sdk` only) — devDependencies used solely for a package's own test suite were never part of that criterion.
- **Two spec Implementation Status rows are stale, not actually open work.** `app_sdk.md` §7.2 (`signWithSubCard`) has been implemented, with a test, since Step 2.2 — the spec still says "Planned." `wallet_sdk.md`'s "§5.4 Device sub-card collapse" row still says "Planned — part of split implementation," but the collapse is exactly what Step 2.3 built (`registerDeviceSubCard` as a thin wrapper over App SDK's `requestSubCard`). Both are corrected in Steps 3.1a/3.2a below — pure spec bookkeeping, no code change.
- **One real, new-code gap exists:** `wallet_sdk.md` §6.6, the `active_subcards` code-510/511 posting requirement, is genuinely unimplemented (confirmed — `grep -rn "510\|511" wallet-sdk/packages/wallet-sdk/src/` finds nothing). This is the one substep in this phase that's new logic, not a port, a test-writing pass, or a doc pass — scoped precisely in Step 3.2b below, grounded directly against `specs/update_codes.md` §5xx and `specs/process_specs/card_updates.md`'s "Sub-Card Directory Updates (Codes 510/511/512)" section, mirroring the existing `subcards/revocation.ts` module's structure (`POST /update` via `ObliviousProtocolTransport`, primary-key-signed) as closely as the different payload shape allows.
- **Both packages already pass `pnpm build && pnpm test && pnpm lint` clean** (verified directly, not assumed, after fixing two lint gaps surfaced by that verification: a missing `no-require-imports` test-file override in `sdk-providers-rn`'s eslint config, and a stray `any` type in a ported wallet-sdk test fixture). Steps 3.1e/3.2g re-confirm this holds after the substeps below land, rather than re-deriving it from scratch.
- **Both packages already have a `README.md`**, but both are thin workspace-scaffolding stubs (dev commands + a one-line package description) — neither meets the original Step 6.3 bar ("a developer unfamiliar with the SDK's internals can follow the README to wire up a minimal app"). Steps 3.1d/3.2e close this gap.

### Step 3.1 — Complete `app-sdk/`

Five independent substeps. 3.1a–3.1d can run in parallel (different files, no shared state); 3.1e runs last, after the others land.

#### Step 3.1a — Correct stale spec status
**What:** In `specs/object_specs/app_sdk.md`: change §7.2 "Signing Arbitrary Data with a Sub-Card"'s heading and body from "(Planned)" to "(Implemented)" — `subcards/signWithSubCard.ts` and its test already exist (built during Step 2.2's salvage, per `plans/sdk-split/milestones/phase-2-summary.md`). Update the Implementation Status table's "7.2 Signing arbitrary data with a sub-card" row from "Planned" to "Implemented." No other section needs to change — this is the only stale-status item in this spec.
**Who:** Claude (haiku) — single-file, single-fact correction, no judgment.
**Context needed:** `specs/object_specs/app_sdk.md` §7.2 and Implementation Status table, `app-sdk/packages/app-sdk/src/subcards/signWithSubCard.ts` and its test (to confirm the fact being recorded).
**Done when:** both locations updated; `grep -n "Planned" specs/object_specs/app_sdk.md` no longer matches §7.2 or its status-table row.

#### Step 3.1b — Cross-platform scenario tests against real providers
**What:** Extend `sdk-providers-web/packages/sdk-providers-web/test/scenarios/` and `sdk-providers-rn/packages/sdk-providers-rn/test/scenarios/` (both already contain `realtimeDelivery.test.ts` — use it as the structural template: import the App SDK function(s) under test, construct real platform provider instances from the local package, stub only the network boundary) with new scenario tests covering App SDK flows not yet scenario-tested: (1) `requestSubCard` + `signWithSubCard` end-to-end using a real `SecureKeyProvider` (WebCrypto on web, Keychain on RN) — confirm the generated key is usable for both operations and never exportable via the real provider; (2) `assembleAndSignTargetedOffer`/`assembleAndSignOpenOffer` using a real `SecureKeyProvider`; (3) `buildMessagePayload` → `signMessageEnvelope` → `fanOutMessageToSubCards` → `handleInboundRoutingEnvelope` round-trip using real crypto (this one has no platform-provider dependency beyond what's already exercised — confirm whether it's worth a scenario test here or whether the existing unit tests already cover it at this level, and skip if redundant, noting why in the report). Each new scenario test file gets one counterpart in each platform package (same test, real web providers vs. real RN providers), matching `realtimeDelivery.test.ts`'s existing pairing.
**Who:** Claude (haiku) — mechanical extension of an established, already-working pattern.
**Context needed:** `sdk-providers-web/packages/sdk-providers-web/test/scenarios/realtimeDelivery.test.ts` and `sdk-providers-rn/.../test/scenarios/realtimeDelivery.test.ts` (the template), `app-sdk/packages/app-sdk/src/subcards/`, `app-sdk/packages/app-sdk/src/offers/`, `app-sdk/packages/app-sdk/src/messaging/` (the functions being scenario-tested).
**Done when:** new scenario test files exist in both platform packages' `test/scenarios/`, pass under each platform's real default providers, and `pnpm test` in both `sdk-providers-web/` and `sdk-providers-rn/` remains green.

#### Step 3.1c — TSDoc completeness pass
**What:** Audit every exported function, class, and type in `app-sdk/packages/app-sdk/src/` for a TSDoc comment block explaining purpose, parameters, and return value where not already self-evident from the name and existing inline comments. Most modules already have detailed doc comments (e.g. `subcards/requestSubCard.ts`, `offers/targetedOfferAcceptance.ts`) — this is a gap-filling pass, not a rewrite. Do not touch existing comments that are already adequate; do not add comments that restate the function name without adding information.
**Who:** Claude (haiku) — mechanical audit against an established in-repo style, low judgment once the bar ("does this doc comment tell a reader something the signature doesn't") is set.
**Context needed:** `app-sdk/packages/app-sdk/src/` (full), a well-documented module as the style reference (e.g. `subcards/revocation.ts`'s wallet-sdk equivalent, or `messaging/replenishment.ts`).
**Done when:** every exported symbol in `app-sdk/packages/app-sdk/src/` has a doc comment; `pnpm build` still succeeds (comments only, no behavior change); a diff review confirms no logic was altered.

#### Step 3.1d — Expand `app-sdk/README.md` to real integrator documentation
**What:** Replace the current workspace-scaffolding stub with real integrator docs, matching the bar the original plan's Step 6.3 set: how to supply/override each of the six provider interfaces this package owns (pointing to `sdk-providers-web`/`sdk-providers-rn` as the shipped defaults, and to `app_sdk.md` §4 for the interface contracts), the disclosed web-vs-native `SecureKeyProvider` security-posture gap (OQ-SDK-1), the interface-only Node keystore decision for server-side integrators (Split-SDK-2), and one worked example (construct the SDK with default web providers, call `requestSubCard`, describe what a host app does with the result) — a second RN-flavored worked example if the web one doesn't obviously generalize.
**Who:** Claude (haiku) — writing task against material that already exists in the spec; no new design decisions.
**Context needed:** `specs/object_specs/app_sdk.md` (full, especially §4 and §15/16), current `app-sdk/README.md`, `sdk-providers-web/README.md`/`sdk-providers-rn/README.md` if they exist (check and cross-link).
**Done when:** README covers provider override, the disclosed security-posture gap, and at least one worked example; a reader unfamiliar with the package's internals could follow it to construct the SDK and make one real call.

#### Step 3.1e — Verification
**What:** Confirm 3.1a–3.1d's combined output: every capability in `app_sdk.md` has a corresponding implementation and passing test (re-read the Implementation Status table fresh, confirm nothing in this plan's scope still says "Planned" or "Not started"), `pnpm build && pnpm test && pnpm lint` clean, README meets the 3.1d bar.
**Who:** Claude (direct, not delegated) — judgment/consistency pass, not a mechanical task.
**Context needed:** `app_sdk.md` (full), `app-sdk/` final state.
**Done when:** all of the above confirmed; any gap found gets fixed here rather than silently carried into the Phase 3 Milestone Review.

### Step 3.2 — Complete `wallet-sdk/`

Seven independent substeps, run in parallel with Step 3.1 (different packages, no shared state) and mostly independent of each other. 3.2a–3.2e can run in parallel; 3.2f (security review) should run after 3.2b lands, since it needs to review the new code that step adds; 3.2g runs last.

#### Step 3.2a — Correct stale spec status
**What:** In `specs/object_specs/wallet_sdk.md`: the Implementation Status table's "2.2 Device sub-card (old parallel path)" row and the separate "§5.4 Device sub-card collapse (refactor to thin wrapper)" row both describe outdated states — the collapse is what Step 2.3 actually built (`registerDeviceSubCard` is the thin wrapper over App SDK's `requestSubCard`, not the old parallel path, per `plans/sdk-split/milestones/phase-2-summary.md`). Consolidate these into one row: "5.4 Device sub-card (collapsed, thin wrapper over App SDK's `requestSubCard`)" — **Implemented**. Update §5.4's own prose if it still frames the collapse as forward-looking rather than describing the code that exists today.
**Who:** Claude (haiku) — single-file, single-fact correction.
**Context needed:** `specs/object_specs/wallet_sdk.md` §5.4 and Implementation Status table, `wallet-sdk/packages/wallet-sdk/src/wallet/deviceSubCard.ts` and its test (to confirm the fact being recorded).
**Done when:** both locations updated; no remaining text in `wallet_sdk.md` describes the device sub-card collapse as unbuilt.

#### Step 3.2b — Implement `active_subcards` code-510/511 posting (§6.6)
**What:** The one genuinely new module in this phase. Per `specs/update_codes.md` §5xx and `specs/process_specs/card_updates.md`'s "Sub-Card Directory Updates (Codes 510/511/512)" section: implement `wallet-sdk/packages/wallet-sdk/src/subcards/activeSubcardsUpdate.ts` (or a name matching this package's existing file-naming convention), mirroring `subcards/revocation.ts`'s structure as closely as the different payload shape allows, with these confirmed-from-spec differences from the 8xx pattern `revocation.ts` implements:
  - **Payload shape:** `field_updates: [{ field: 'active_subcards', value: <full new array> }]`, not a `revocation: {...}` object. The caller supplies the current `active_subcards` array (base64url pubkeys) plus the one pubkey to add (code 510) or remove (code 511); the function computes the full new array (append, or filter-out-one) and puts it in `field_updates`.
  - **Updater is always the master card itself** — `target_card === updater_card`, both pointing at the holder's own master card, signed with the current master/primary key (a direct `masterSecretKey`-shaped signer parameter, matching `deregisterSubCard`'s no-callback-substitution pattern from §6.5 — not an injected `UpdateIntentSigner` like 8xx's app-or-device-signed cases, since 510/511/512 are hardcoded holder-only per `protocol-objects.md §1.1` and cannot be signed by anything else).
  - **Two exported functions**, `postSubCardAddedToDirectory` (code 510) and `postSubCardRemovedFromDirectory` (code 511) — not one function taking a code parameter like `revokeSubCard` does, since the payload-construction logic (append vs. filter) genuinely differs, not just the numeric code.
  - Code 512 (atomic rotation) is explicitly out of scope for this step — not required by any capability this plan's specs currently document; leave it for a future step if the need arises.
  - Wire the caller side minimally: this step builds and tests the two primitives themselves. Do **not** modify `wallet/deviceSubCard.ts`, `subcards/countersign.ts`, `subcards/revocation.ts`, or `wallet/subCardDeregistration.ts` to auto-invoke these — that's a separate, higher-risk change touching several already-tested modules' call sites and signatures, deliberately out of scope here. Note this explicitly in `wallet_sdk.md` §6.6 as the current caller-composes-explicitly contract (matching how `deregisterSubCardsAfterRecovery` already composes multiple primitives together explicitly rather than something implicitly cascading).
**Who:** Claude (haiku) — the spec above is precise enough (exact payload shape, exact signer semantics, an existing sibling module to mirror line-for-line except for the documented differences) that this should be tractable without further design judgment; if the agent finds the spec insufficiently precise to proceed without guessing, it should stop and report rather than improvise.
**Context needed:** `specs/update_codes.md` §5xx (full), `specs/process_specs/card_updates.md`'s "Sub-Card Directory Updates" section (full), `wallet-sdk/packages/wallet-sdk/src/subcards/revocation.ts` (the structural template), `wallet-sdk/packages/wallet-sdk/src/wallet/subCardDeregistration.ts` (the no-signer-substitution pattern to match for the primary-key-only constraint).
**Done when:** both functions exist with tests covering: correct `field_updates` computation (append for 510, filter-exactly-one for 511), a test proving no code path can construct one of these requests signed by anything other than a direct `masterSecretKey` parameter (mirroring §6.5's existing test pattern), and a wire-format test confirming the request body matches the spec's documented shape exactly; `wallet_sdk.md` §6.6 updated from "Planned" to "Implemented" (caller-composes-explicitly, per above) and its Implementation Status row updated to match.

#### Step 3.2c — Cross-platform scenario tests against real providers
**What:** Add `sdk-providers-web`/`sdk-providers-rn` as `devDependencies` (via `file:`, matching the runtime-dependency convention already used elsewhere in this split) to `wallet-sdk/packages/wallet-sdk/package.json`, and create `wallet-sdk/packages/wallet-sdk/test/scenarios/`, following the same structural template as `sdk-providers-web/rn`'s existing `realtimeDelivery.test.ts` (import the function under test, construct real platform providers from the newly-added devDependency, stub only the network boundary). Cover: (1) `setupWallet` end-to-end using real `PasskeyProvider` + `StorageProvider` + `SecureKeyProvider` on both platforms; (2) `recoverWallet` using the same real providers; (3) `handleSubCardRequest` → `assembleSubCardConsent` → `countersignSubCardRequest` using a real `SecureKeyProvider`-backed master key; (4) `acceptTargetedOffer`/`acceptOpenOfferAndCountersign` using real `StorageProvider` for the keyring write, confirming the persist-before-sign invariant holds against a real (not fake) storage backend on both platforms.
**Who:** Claude (haiku) — mechanical extension of an established pattern, same shape as 3.1b.
**Context needed:** `sdk-providers-web/.../test/scenarios/realtimeDelivery.test.ts` (template), `wallet-sdk/packages/wallet-sdk/src/wallet/`, `src/subcards/`, `src/offers/` (the functions being scenario-tested).
**Done when:** new scenario test files exist in `wallet-sdk/packages/wallet-sdk/test/scenarios/`, pass against real providers from both platform packages, `pnpm test` remains green, and `git status` confirms neither `sdk-providers-web/` nor `sdk-providers-rn/` was modified (the devDependency edit is entirely within `wallet-sdk/`'s own `package.json`).

#### Step 3.2d — TSDoc completeness pass
**What:** Same as Step 3.1c, scoped to `wallet-sdk/packages/wallet-sdk/src/`.
**Who:** Claude (haiku).
**Context needed:** `wallet-sdk/packages/wallet-sdk/src/` (full), `subcards/revocation.ts` as the in-package style reference.
**Done when:** every exported symbol has a doc comment; `pnpm build` still succeeds; a diff review confirms no logic was altered.

#### Step 3.2e — Expand `wallet-sdk/README.md` to real integrator documentation
**What:** Same bar as Step 3.1d, scoped to Wallet SDK: how a wallet integrator supplies providers (all inherited from App SDK — cross-link `app-sdk/README.md` rather than re-documenting the interfaces), the master-key custody invariants from `wallet_sdk.md` §10 stated plainly for an integrator audience (not just the spec's own security-invariant framing), and one worked example (construct the SDK, call `setupWallet`, describe what a host app does with the result — including that `app-sdk` is a transitive dependency the integrator does not need to install separately, since it's already a `wallet-sdk` dependency).
**Who:** Claude (haiku).
**Context needed:** `specs/object_specs/wallet_sdk.md` (full, especially §5.3 and §10), current `wallet-sdk/README.md`, the (by this point expanded) `app-sdk/README.md` to cross-link consistently.
**Done when:** README covers provider sourcing, custody invariants stated for an integrator, and one worked example; doesn't contradict `app-sdk/README.md` on the dependency relationship.

#### Step 3.2f — CP-2-equivalent security review
**What:** An independent review of `wallet-sdk/`'s custody surface, mirroring the gravity and scope of the original Phase 6 CP-2 (and this split's own CP-1, which caught a real cryptographic design flaw — see `plans/client-sdk/milestones/cp1-security-review.md`). Cover, against the actual code (not just the spec's description of it): (a) the "persist before sign" invariant (`offers/countersign.ts`) — confirm by direct code reading that no exported function can produce a countersignature without a prior confirmed keyring write, not just that a test happens to pass; (b) `SecureKeyProvider` non-exportability — confirm both platform packages' implementations (`sdk-providers-web`, `sdk-providers-rn`) never return private key material, reading the actual provider code, not the interface contract; (c) the sub-card 9xx-exclusion (`subcards/revocation.ts`'s `SubCardRevocationCode` literal union) and primary-key-only deregistration (`wallet/subCardDeregistration.ts`) checks — confirm neither can be bypassed via any exported function's type signature, including the new Step 3.2b primitives (confirm those are equally hardcoded holder-only, not accidentally accepting a substitutable signer); (d) grep the full `wallet-sdk/packages/wallet-sdk/src/` and `test/` trees for `console.log`/`console.error`/`console.warn` near any function handling `decryptionKey`, `masterSecretKey`, `serviceSecret`, or a raw private key, confirming no secret material is ever logged; (e) re-confirm the two lower-severity CP-1 findings already tracked open (`wallet_sdk.md` §10 — transient secrets not explicitly zeroed, partial keyring-entry clearing) are still accurately described and haven't grown into something more severe now that Step 3.2b adds new key-touching code paths.
**Who:** Claude (direct or Sonnet subagent — **not haiku**; this mirrors CP-1's own gravity, and CP-1 found a genuine crypto bug a lower-effort review would likely have missed).
**Context needed:** `wallet-sdk/packages/wallet-sdk/src/` (full), `sdk-providers-web/packages/sdk-providers-web/src/SecureKeyProvider.ts`, `sdk-providers-rn/packages/sdk-providers-rn/src/SecureKeyProvider.ts`, `plans/client-sdk/milestones/cp1-security-review.md` (the review this mirrors, for calibration on depth/rigor expected).
**Done when:** all five review points above are checked against the actual code and documented (finding or explicit clean bill), findings resolved or explicitly tracked following the CP-1 documented-gap pattern (not silently dropped), and `wallet_sdk.md` §10/§14(Implementation Status) updated to record the review's completion and any newly-tracked gaps.

#### Step 3.2g — Verification
**What:** Same as Step 3.1e, scoped to `wallet-sdk/`: confirm every capability in `wallet_sdk.md` implemented and tested, `pnpm build && pnpm test && pnpm lint` clean, README meets the 3.2e bar, and Step 3.2f's review is complete with findings resolved or tracked.
**Who:** Claude (direct, not delegated).
**Context needed:** `wallet_sdk.md` (full), `wallet-sdk/` final state, Step 3.2f's findings.
**Done when:** all of the above confirmed.

### Phase 3 Milestone Review
**Context needed:** both packages' final state, both specs, both README files, Step 3.2f's security review findings
**Done when:** both packages independently pass `pnpm build && pnpm test && pnpm lint`; a fresh read-through of each spec's Implementation Status table shows nothing left as "Not started" or "Planned" that was in this plan's scope; the two READMEs don't contradict each other on the import relationship (`wallet-sdk` depends on `app-sdk` — stated identically in both, including the devDependency-only relationship to the platform packages Step 3.2c introduced); phase summary written to `plans/sdk-split/milestones/phase-3-summary.md`.

**Clarification checkpoint:** If Step 3.2f's security review surfaces a finding as severe as the original CP-1 finding (a genuine cryptographic design flaw, not a documented lower-severity gap), stop and bring it to you before proceeding to Phase 4 — don't let a subagent, or this review step itself, self-resolve something at that severity.

---

## Phase 4: NPM Publish

**Scope correction (written after Step 2.4 landed):** the original two publish steps only named `app-sdk`/`wallet-sdk` — Step 2.4 added two more real, tested packages (`sdk-providers-web`, `sdk-providers-rn`) that also need to ship, and none of the four has a CI config yet (only the old, soon-to-be-retired `client-sdk-ci.yml` exists under `.github/workflows/`). Added Step 4.0 to close the CI gap before any publish, and folded the platform packages into the publish sequence at the point their dependency (`app-sdk`) is actually available (they don't depend on `wallet-sdk`, so they can publish in parallel with it, not after).

### Step 4.0 — CI configs for all four packages
**What:** Create `.github/workflows/app-sdk-ci.yml`, `wallet-sdk-ci.yml`, `sdk-providers-web-ci.yml`, `sdk-providers-rn-ci.yml`, adapting `.github/workflows/client-sdk-ci.yml`'s existing structure (lint → typecheck → test → build, per-package working directory) to each new package's location and its own package manager/test-runner specifics (`sdk-providers-rn` uses Jest, not Vitest — mirror `client-sdk-ci.yml`'s handling of the old `client-sdk-rn` package's Jest step, if it has one, rather than copying the Vitest step verbatim).
**Who:** Claude (haiku) — mechanical adaptation of an existing, working template, four times.
**Context needed:** `.github/workflows/client-sdk-ci.yml` (the template), each of the four packages' `package.json` scripts (`lint`/`typecheck`/`test`/`build`).
**Done when:** all four workflows exist, are syntactically valid, and pass on a clean push (green CI) for each package independently.

### Step 4.1 — Publish `app-sdk` first
**What:** Version, tag, and publish `@membership-card-protocol/app-sdk` to npm. Must go first since `wallet-sdk`, `sdk-providers-web`, and `sdk-providers-rn` all depend on it.
**Who:** Claude drafts the publish steps and package metadata; you run or approve the actual `npm publish` (credentials/registry access).
**Context needed:** `app-sdk/package.json`, Step 4.0's `app-sdk-ci.yml`
**Done when:** package is live on npm at the intended version, installable in a scratch project.

### Step 4.2 — Update dependents and publish `wallet-sdk`, `sdk-providers-web`, `sdk-providers-rn`
**What:** Point each of the three dependent packages' `package.json` at the published `app-sdk` version instead of a local `file:` reference, re-run each package's full test suite against the published package (not the local copy) to catch anything the `file:` link was silently papering over, then publish all three. Since none of the three depends on either of the other two, they can be versioned/published independently, in parallel — the only ordering constraint is that all three come after Step 4.1.
**Who:** Claude drafts; you run/approve each publish.
**Context needed:** each package's `package.json`, Step 4.1's published version number
**Done when:** all three are live on npm, each package's test suite passes against the published `app-sdk` (not a local link), all four packages are installable together in a scratch project.

### Step 4.3 — Retire `client-sdk/`
**What:** With all four new packages published and verified, remove `client-sdk/` from active use (deprecate on npm if it was ever published there; otherwise just archive) — `client-sdk-old/` remains as the permanent historical reference per the repo's existing `relay-old/` convention. Also retire `.github/workflows/client-sdk-ci.yml`, now fully superseded by Step 4.0's four new workflows.
**Who:** Claude drafts, you approve before anything is deleted or deprecated.
**Context needed:** none beyond confirming Steps 4.1/4.2 are all live
**Done when:** you've explicitly signed off; `client-sdk/` is either removed or clearly marked deprecated; `client-sdk-old/` untouched; `client-sdk-ci.yml` removed.

### Phase 4 Milestone Review
**Context needed:** npm registry listings for all four packages, CI status for all four
**Done when:** all four packages installable from npm in a clean project, CI green on all four, `client-sdk/` disposition resolved per your sign-off. This is the trigger condition for the follow-on integration plan (wallet-service/press/relay each initiating subcard registration on startup) — write that plan only after this review closes.

---

## Summary of Clarification Checkpoints (collected)

1. End of Phase 1: any capability that doesn't cleanly fit either spec.
2. Before deleting anything from `client-sdk/` itself (Phase 2) — recommend leaving it in place, untouched, until Phase 4 completes.
3. End of Phase 3: any CP-2-severity security finding.
4. Before any actual `npm publish` command runs (Phase 4, Steps 4.1 and 4.2 — four packages total) — you run or explicitly approve.
5. Before `client-sdk/` is removed or deprecated (Step 4.3).
