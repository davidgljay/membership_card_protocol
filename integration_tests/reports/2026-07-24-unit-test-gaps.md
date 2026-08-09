# Unit-test gaps found running `run.sh --unit-only` for the first time

> **Resolved as of 2026-08-09.** All three gaps below are gone: the
> `app-sdk`/`client-sdk` `getCardEventLog` mock drift and wallet-service's
> `ARBITRUM_RPC_URL`/`registerFirst`/ESM-`cloudflare:` issues were fixed or
> turned into deliberate `.skip()`s by a separate, later session (not
> documented further here). wallet-service's suite is now fully green (219
> passed, 13 intentionally skipped) once a real, separate bug --
> `run.sh` never running `npx nitro prepare` before wallet-service's own
> `pnpm run typecheck`, previously masked by an already-generated local
> `.nitro/types/` -- was found and fixed running `integration-tests.yml`
> for real via `deploy-pipeline.yml` for the first time. See that commit
> for detail. Kept below for history.

`run.sh` (Phase 6.1) had never actually been run end-to-end before this —
only spot-checked step by step against a partially-warm local environment.
The first real `--unit-only` run surfaced two different classes of
problem: bugs in `run.sh` itself (all fixed, see the commit on this same
date), and real, pre-existing gaps in several components' own test suites
that predate this work and are out of `run.sh`'s own scope to fix. This
report is the record of the second class — David chose not to block on
these today; they need their own separate investigation.

## Fixed (run.sh bugs, not logged further here)

- `contracts`: scoped `cargo test` to `-p protocol-types` only — the other
  three crates depend on `stylus-sdk`, whose host functions have no native
  implementation and fail to link outside the Stylus/WASM VM.
- `press`, `wallet-service`: switched from `npm ci`/`npm test` to `pnpm` —
  both only ship `pnpm-lock.yaml`.
- `wallet-service`: added a throwaway Postgres container, migrations, and
  the env vars `wallet-service-ci.yml` already establishes (values now in
  `env/wallet-service/unit-test.env`, not inlined in run.sh).

Also fixed in passing (real, load-bearing bugs — these were blocking
`typecheck`/`build`, not test-fixture drift):

- `press/src/handlers/sub-card.ts`: a fallback `PolicyDocument` literal was
  missing the required `policy_id` field, force-cast around the type
  system (`as PolicyDocument`) rather than actually supplying it. Fixed by
  supplying the real value already in scope (`policyCid`).
- `client-sdk/src/matrix/discovery.ts` and `wallet-service/src/matrix/
  room-discovery.ts` (the same logic, duplicated in both packages):
  `evaluatePolicyMatch(...) === true`, but `evaluatePolicyMatch` returns
  `PolicyMatchResult | null` (`{ matched, reason }`), not a boolean, since
  an earlier, already-merged commit ("Add reason codes to
  evaluate_policy_match (G1)"). Fixed to `?.matched === true` in both.
- `wallet-service/test/matrix-discover-rooms.test.ts`: a mock result
  object was missing the required `chain_card_addresses` field.

## Known, NOT fixed here — `getCardEventLog` mock drift

`membership_card_verifier`'s `RpcProvider` interface gained a required
`getCardEventLog(cardAddress): Promise<CardChainEvent[]>` method (the
Stage 4 "ground-truth on-chain event replay" work). Several downstream
packages' own test suites construct a `fakeRpc`/mock `RpcProvider` object
that was never updated to implement it. This is **not caught by
`pnpm run typecheck`** in at least `app-sdk` and (presumably, not directly
confirmed) `client-sdk`, because those packages' `tsconfig.json` scopes
`include` to `src/**/*` only — `test/` is excluded from type-checking
entirely, so a missing-required-property bug in a test mock only surfaces
as a runtime `TypeError`, not a build-time error.

- **`app-sdk`**: `test/verification/CardVerifier.test.ts`'s `fakeRpc()` —
  fixed the crash (added a `getCardEventLog` mock returning a genesis
  entry matching the fixture's `log_head_cid`), but one assertion still
  fails: `result.is_currently_valid` is `'skipped'`, not `true`. Traced to
  `stage4.ts`'s `anyContentAvailable`/`anyContentUnavailable` bookkeeping,
  which the one-entry mock apparently doesn't satisfy the way a real
  `getCardEventLog` response would — the exact condition wasn't
  root-caused before stopping. 1 test.
- **`client-sdk`**: the identical pattern, but at much larger scale — 10
  test files, 24 tests, each with its own independently-written
  `fakeRpc`/mock-verifier fixture (no shared test helper to fix once):
  `test/verification/CardVerifier.test.ts`, `test/matrix/discovery.test.ts`,
  `test/offers/{offerVerification,targetedOfferAcceptance,
  existingWalletOpenOfferAcceptance,newWalletOpenOfferAcceptance}.test.ts`,
  `test/subcards/{consent,countersign,handleSubCardRequest,
  phase4EndToEnd}.test.ts`. Not attempted: applying the same one-line mock
  fix to all 10 blind risks reproducing app-sdk's same "fixes the crash,
  reveals a second semantic mismatch" pattern ten times over, each
  potentially needing its own stage4.ts-level investigation.

`build`/`typecheck` are clean for both `app-sdk` and `client-sdk` --- this
gap is entirely inside test fixtures, not production code.

## Known, NOT fixed here — `wallet-service`'s own suite

31 of 231 tests fail even with Postgres, migrations, and every env var
`wallet-service-ci.yml`'s own job sets. Three distinct sub-issues:

1. **`ARBITRUM_RPC_URL` missing** (11 tests: `message-delivery.test.ts`,
   `ohttp-gateway.test.ts`, `ohttp-router.test.ts`) — this env var isn't
   set by `wallet-service-ci.yml` either, which strongly suggests these
   specific tests have never passed in that CI workflow. Possibly added
   after the CI job's env block was last updated, or the CI job has been
   silently red/ignored. Worth checking `wallet-service-ci.yml`'s actual
   recent run history before assuming which side (test or CI config) is
   stale.
2. **A `registerFirst` test-helper cluster failing** (~15 tests across
   `subcard-deregistration.test.ts`, `subcard-uuid-registration.test.ts`,
   `subcard-uuid-signature.test.ts`) on `expected false to be true`,
   tracing to a real assertion message:
   `"keccak256(subcard_pubkey) does not match subcard_hash"`. Looks like a
   genuine crypto-fixture mismatch (a generated keypair/hash pair that no
   longer matches what the verification code expects), not an env-var
   issue -- not root-caused further.
3. **`test/integration/bundled-server-smoke.test.ts`** fails with
   `ERR_UNSUPPORTED_ESM_URL_SCHEME` on a `cloudflare:` import -- the test
   tries to run the Cloudflare-targeted bundle under plain Node, which
   can't resolve that import scheme. A real environment/build-target
   mismatch in the smoke test's own harness (`node-server-harness.ts`),
   unrelated to the other two categories.

## Recommendation

None of this blocks Phase 6 sign-off -- these are pre-existing gaps `run.sh`
surfaced by actually running end-to-end for the first time, not regressions
introduced by Phase 6's own work. But once `integration-tests.yml` starts
running for real on a PR, `wallet-service`'s and `client-sdk`'s unit-test
steps will report red until these are separately investigated and fixed.
Worth a dedicated pass on each, tracked outside this report.
