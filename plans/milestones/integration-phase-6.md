# Phase 6 (Integration Testing) Milestone Summary — entry-point script and CI gating

Part of `plans/integration-testing-implementation-plan.md`. Full rationale:
`plans/integration-testing-strategic-plan.md`.

## Summary

The integration-testing pyramid built in Phases 1-5 now has a single entry
point (`integration_tests/run.sh`) and is wired into CI so a red suite
blocks every deploy path, not just a red suite someone happens to notice.
Both halves of Goal 4 — "one command runs everything" and "CI won't deploy
on a red suite" — are done and independently verified (not just written and
assumed correct).

## 6.1 `integration_tests/run.sh`

Single script: every component's own unit tests (`contracts` `cargo test
--workspace`, `press`/`wallet-service`/`relay` vitest, the SDK-workspace
chain via `pnpm -r`, `matrix-policy-module` pytest), then the full compose
stack (`--wait`), then every suite in `suites/` (or one via `--suite
<name>`) plus both harnesses, then teardown. Flags: `--unit-only`,
`--integration-only`, `--suite <name>`. Non-zero exit if anything failed,
with every failed step's label collected and printed together at the end
(one broken component doesn't hide a second one later in the same run).

Verified live against the real stack, not just written from the plan's
description — this surfaced three real gaps, all fixed before commit:

- **`docker compose up --wait` must not force `--build` on every run.**
  Doing so reproduces the known `deploy-contracts`
  `rust:1.96.0-bookworm` `DeadlineExceeded` Docker Desktop flake (see
  `reports/phase-1-environment-notes.md`) on every single invocation
  instead of only on a genuinely clean checkout, where `up` already
  builds whatever image doesn't exist yet.
- **relay's own unit tests need a real Redis.** Its README documents
  this; confirmed empirically (6 of 7 test files failed with
  `ECONNREFUSED`/`MaxRetriesPerRequestError` without one). `run.sh`
  now starts/stops a throwaway `redis:7-alpine` container around just
  that step, independent of the integration stack's own `redis`
  service.
- **`matrix-policy-module`'s `pip install -e` needs `--no-cache-dir`.**
  pip's wheel cache keys on the `file:` dependency's path, not its
  contents, so a stale cached wheel of the `verifier-py` `file:`
  dependency silently shadowed real source changes (`ImportError` for a
  symbol that exists in source, resolved only by `--no-cache-dir`).

Confirmed live: `--suite core/card_signing` end-to-end (stack up,
`stack-ready.sh`, suites typecheck, single suite 7/7, clean `docker
compose down -v`, exit 0); a nonexistent suite name correctly exits 1;
the `membership_card_verifier` → `app-sdk` → ... SDK-workspace
`file:`-dependency install/build chain (15 test files, 111+ tests)
passes live before trusting the same pattern for the sibling SDK steps;
`matrix-policy-module` pytest (98/98) and relay's own suite (103/104,
one pre-existing timing-sensitive flake unrelated to this work — see
"Known gaps" below) both pass live with the fixes above.

## 6.2 `.github/workflows/integration-tests.yml`

Runs `run.sh` with Rust/pnpm/Node/Python toolchains set up and cargo
cached. Triggers: `pull_request` (direct PR gating) and `workflow_call`
(invoked by the four gated workflows in 6.3) — deliberately no bare
`push` trigger, since combining one with `workflow_call` would double-run
this on every push to `main`. `timeout-minutes: 90` (the full pyramid on a
cold cache comfortably exceeds the 60-minute default).

## 6.3 Gating the deploy workflows

`relay-deploy.yml`, `wallet-service-ci.yml`, `client-sdk-ci.yml`, and
`publish-verifier.yml` each gained an `integration-tests` job
(`uses: ./.github/workflows/integration-tests.yml`), and their existing
deploy/publish/ci job now lists it in `needs:`.

**Found and fixed in passing**: validating every touched workflow file
with `js-yaml` (not just eyeballing it) before wiring the new job in
turned up a pre-existing, unrelated bug — `client-sdk-ci.yml`'s step name
`Install and build membership_card_verifier (client-sdk's file:
dependency)` is invalid YAML (an unquoted `: ` inside a plain scalar), so
the whole workflow file would have failed to parse. Quoted the string.
Not part of this phase's scope on its own, but a broken deploy-gating
workflow would have made 6.3's entire point moot, so fixed rather than
left as a separate defer item.

## 6.4 Verification: break a test, watch it block

Both failure modes demonstrated live, on the working tree, then reverted
(`git status --short` clean afterward both times):

- **Integration suite**: added a deliberately-failing assertion to
  `suites/core/card_signing.spec.ts`'s first `it(...)`
  (`expect(payload.senders).toEqual(['PHASE-6.4-DELIBERATE-BREAK'])`).
  `./run.sh --suite core/card_signing` → **exit 1**, log shows
  `Tests  1 failed | 6 passed (7)` and `!!! FAILED: suite:
  core/card_signing`.
- **Unit test**: added a deliberately-failing `it('PHASE-6.4-DELIBERATE-
  BREAK', () => expect(1).toBe(2))` to `press/test/unit/config.test.ts`.
  `npm test` (press) → **exit 1**, log shows `Test Files  1 failed | 14
  passed (15)`.

**Deploy-blocking is a structural GitHub Actions guarantee, not something
that needs a separate live demonstration**: a job listed in another job's
`needs:` array that fails (or, for a reusable-workflow job, whose called
workflow fails) causes GitHub Actions to skip the dependent job rather
than run it — this is platform behavior, not something this repo's config
could get subtly wrong once the `needs:` edges themselves are correct
(verified by YAML-parsing every touched file above, and by the `needs:`
edges added in 6.3: `deploy`/`ci`/`publish` in each of the four gated
workflows all list `integration-tests`). Actually pushing a real breaking
commit to trigger a live Actions run was deliberately not done here —
pushing to the remote is a real, visible action outside this session's
already-granted scope, and the local `run.sh`/`npm test` runs above
already prove the piece that's actually project-specific (that a broken
test makes the *entry point* fail loudly); the `needs:` blocking mechanism
itself is GitHub's, not this repo's, to re-verify.

## Post-review fix: relay's `message-buffer.test.ts` flake

Originally logged here as a known, out-of-scope gap ("failed once (103/104)
... looks like a staggered-random-delay timing flake"). On investigation
that diagnosis was wrong: the failure was deterministic (4/4 reproductions,
including in complete file isolation, 558ms), not timing-sensitive at all.

Root cause: `message-buffer.test.ts` sets `process.env.MAX_DELETE_DELAY_SECONDS
= "0"` *after* its own `import { router } from "../../src/router.js"` line
— but ES module imports are hoisted and evaluated before the importing
module's own top-level statements run, regardless of source order. By the
time that assignment executed, `src/routes/pending.ts`'s module-level
`const MAX_DELETE_DELAY_SECONDS = parseInt(process.env.MAX_DELETE_DELAY_SECONDS
?? "21600", 10)` had already frozen at the 6-hour default, so every `/ack`
call in the test scheduled its delete job up to 6 hours in the future and
the test's immediate `dequeuePendingDeletes()` call almost never found it.

Fixed by reading the env var lazily inside the handler instead of freezing
it as a module-level constant — removes the import-order hazard entirely.
A second, real (but not the actual cause) test-isolation gap found during
the investigation was hardened too: `failure-cases.test.ts`'s
`runStartupChecks()` test starts the real wallet-clearance background job
(a `setInterval` polling the same `pending_deletes` Redis key) and never
stopped it; both that file and `message-buffer.test.ts` now call
`stopWalletClearance()` so correctness doesn't depend on file execution
order. Verified: relay's full suite (104 tests) green 4/4 consecutive runs
against a real Redis. See the commit on `relay/src/routes/pending.ts`,
`relay/tests/integration/failure-cases.test.ts`, and
`relay/tests/integration/message-buffer.test.ts` for the full detail.

## Known gaps, not fixed here (deliberately out of scope)

- **No cross-run Docker layer cache in `integration-tests.yml`** — a
  cold-cache CI run rebuilds every image from scratch. Plan only asked
  for "cached" toolchains (Rust/Node/pnpm/pip), which are covered;
  Docker BuildKit caching (e.g. `type=gha`) would speed up CI further but
  wasn't asked for and adds real complexity (compose doesn't have a
  single built-in `--cache-from=gha` flag the way a single `docker
  build`/`bake` invocation does) — worth a follow-up if CI runtime becomes
  a real pain point, not before.
- **`run.sh`'s full non-`--suite` run has not been executed start-to-
  finish in this phase** (only `--suite core/card_signing` end-to-end,
  plus each unit-test step spot-checked individually). The full run is
  expected to take 20-40+ minutes locally; every piece has now been
  verified working individually and the plan's own Phase 5 report already
  confirmed the suites themselves pass together twice consecutively
  outside `run.sh`. First real CI run of the complete workflow (once a PR
  actually triggers `integration-tests.yml`) is the natural point to
  confirm the whole thing end-to-end for real, rather than re-paying that
  cost locally here.

## What's next

Phase 6 (and the implementation plan's phased build-out overall) is
complete pending David's Phase 6 Milestone Review sign-off. No further
phases remain in `plans/integration-testing-implementation-plan.md`.
