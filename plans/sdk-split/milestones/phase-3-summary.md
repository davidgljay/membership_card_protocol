# Phase 3 Milestone Review — Completion and Verification Against Spec

**Date:** 2026-07-08
**Status:** Complete

Both packages were brought from Step 2.4's salvaged-but-unfinished state to full spec compliance, through the ten substeps (3.1a–3.1e, 3.2a–3.2g) `plans/sdk-split-implementation-plan.md`'s Phase 3 scope-correction defined. All ten are done: two spec-bookkeeping fixes, four real cross-platform scenario-test additions, one genuinely new implementation (`active_subcards` code-510/511 posting), two README expansions, and the CP-2 security review (§3.2f), each independently verified against the actual filesystem and test output rather than trusted from agent self-reports.

## Verification

All four packages — `app-sdk`, `wallet-sdk`, and the two platform packages Step 2.4 introduced (`sdk-providers-web`, `sdk-providers-rn`) — independently pass `pnpm build && pnpm test && pnpm lint` clean under Node 22 (each package's declared minimum):

| Package | Tests |
|---|---|
| app-sdk | 162 |
| wallet-sdk | 105 passed + 1 documented `it.todo` (confirmed RN/Vitest toolchain gap) |
| sdk-providers-web | 31 |
| sdk-providers-rn | 28 |
| **Total** | **326** (vs. the original unified `client-sdk`'s 243) |

A fresh read-through of both specs' Implementation Status tables (Step 3.1e, Step 3.2g) confirms nothing left as "Not started" or "Planned" that was in this plan's scope — the only remaining "Not started" rows in either spec (§6.2, real deployed OHTTP endpoint validation) are explicitly and correctly out of scope, deferred to the follow-on wallet-service/press/relay integration plan per this plan's own stated exclusion.

Both READMEs were checked against each other for consistency on the import relationship: `app-sdk/README.md` states wallet-side applications should depend on `wallet-sdk`, which depends on `app-sdk`; `wallet-sdk/README.md` states it imports `app-sdk` and that integrators don't need to install it separately. No contradiction.

## What Step 3.2f (CP-2) found

The pre-production security review of `wallet-sdk`'s custody surface — conducted directly, not delegated, per the plan's explicit instruction — found no CRITICAL or HIGH finding (nothing at the original CP-1 review's severity). Two findings surfaced, both resolved or explicitly accepted rather than silently dropped:

1. **MEDIUM, resolved:** `sdk-providers-rn`'s `SecureEnclaveKeyProvider` doc comment overstated its hardware-confinement guarantee — corrected to accurately describe `Keychain.getGenericPassword()` as a plaintext-retrieval API, and to clarify (per direct product guidance) that hardware backing is the expected norm on real RN devices but is device-dependent, with no equivalent on web.
2. **LOW, tracked and accepted as-is:** neither platform package's `SecureKeyProvider.sign()` explicitly zeros the transiently-reconstructed secret key — extends CP-1's already-tracked, already-accepted pattern to code CP-1 predates.

Full detail: `plans/sdk-split/milestones/cp2-security-review.md`.

**Clarification checkpoint status:** not triggered. No finding at CP-1 severity surfaced, so no check-in was required before proceeding.

## Other findings surfaced and corrected during this phase

Beyond the plan's own listed substeps, direct verification (not agent self-reports) caught and fixed:

1. **Two lint gaps** in code salvaged by earlier phases, surfaced only once build/test/lint were actually run together rather than checked individually (`sdk-providers-rn` missing a test-file eslint override; a stray `any` type in a ported wallet-sdk test).
2. **A real, pre-existing functional gap**, found via insisting on genuine (non-mocked) provider scenario tests rather than accepting a workaround: `WebAuthnPasskeyProvider` (the shipped default web `PasskeyProvider`) never requests or reads the WebAuthn PRF extension, so it can never populate `prfOutput` — which `setupWallet`/`recoverWallet` hard-require. **The shipped default web provider cannot currently complete wallet setup in a real browser.** Confirmed to predate the SDK split entirely (same gap, unchanged, in `client-sdk-old`). Documented as a tracked, open gap in both `app_sdk.md` §4.3 and `wallet_sdk.md` §5.3, with a regression-guarded test pinning the exact failure point.
3. **A real toolchain gap**, also found during scenario-test work: Vitest cannot load `sdk-providers-rn`'s real provider classes (they require Jest's `react-native` preset for Flow-syntax stripping and native-module mocking) — confirmed empirically, recorded as an honest `it.todo()` with the captured error and full diagnosis, never importing the failing package so it doesn't break the suite.
4. **Two agent-scope violations**, corrected during review: an out-of-scope, factually-wrong README created at the wrong path (`app-sdk/packages/app-sdk/README.md`, referencing functions that don't exist) — deleted; a correctly-written README initially placed at the wrong path (`wallet-sdk/packages/wallet-sdk/README.md` instead of the workspace-root `wallet-sdk/README.md`) — moved, with its relative links corrected for the new depth.
5. **`sdk-providers-rn`'s new scenario tests initially failed to build under Jest** (the same `react-native-keychain`/`async-storage` Flow-syntax parsing issue as Finding 3, but for App SDK's own Step 3.1b scenario tests, not Step 3.2c's) — missed by the original Step 3.1b verification pass (which only re-ran `sdk-providers-web`, not `sdk-providers-rn`, after that step landed) and caught only during this milestone review's final four-package sweep. Fixed by applying the same `jest.mock()` boundary the package's own existing provider tests already use.

## Ready for Phase 4

All four packages installable together, no `client-sdk`/`client-sdk-old` modification anywhere in this phase's work (confirmed via `git status` at each verification pass). Phase 4 (NPM Publish) can proceed — starting with Step 4.0 (CI configs, none of the four packages has one yet).
