# Integration Testing — Implementation Plan

Strategic plan: [integration-testing-strategic-plan.md](integration-testing-strategic-plan.md)

**Model delegation**: each step is tagged **[Haiku]** or **[Sonnet]**. Haiku handles mechanical, pattern-following work; Sonnet handles first-of-a-kind authoring, orchestration, and diagnosis. Anything Sonnet can't resolve escalates to David — never to a larger model. Rule of thumb: Sonnet writes the first instance of a pattern, Haiku replicates it.

**Target layout**:

```
integration_tests/
  docker-compose.yml
  run.sh
  env/                 # per-service Dockerfiles, wrangler configs, bootstrap scripts
  fixtures/            # shared keys, cards, test vectors (reused from existing suites)
  suites/
    core/              # Wave 1: card lifecycle
    matrix-relay/      # Wave 2
    extended/          # Wave 3: remaining specs
    conformance/       # object-spec checks
  harnesses/
    web/               # Playwright container driving web SDK
    rn/                # jest + react-native preset container
  reports/
```

---

## Phase 1: Environment — the docker stack

**Deliverable**: `docker compose up` brings up chain + contracts, IPFS, MinIO, press, wallet-service, relay+redis, Synapse — all healthy.

**1.1 Scaffold `integration_tests/`** — [Haiku]
- What: create the directory layout above with placeholder READMEs; add `integration_tests/README.md` describing the stack and how to run it (skeleton, filled in later).
- Context: this plan §Target layout. Otherwise none.
- Done when: layout exists, committed.

**1.2 Chain container + contract bootstrap** — [Sonnet]
- What: add an Arbitrum Nitro dev-node service (`offchainlabs/nitro-node` dev mode or nitro-devnode image) to compose. Add a `local` network case to `contracts/scripts/deploy.sh` using the devnode RPC and its pre-funded dev key, plus a one-shot `env/deploy-contracts` container that runs it and writes `deployments/local.json` to a shared volume. Requires `cargo-stylus` + forge in the bootstrap image.
- Context: `contracts/scripts/deploy.sh`, `contracts/Cargo.toml`, `contracts/deployments/`, decision: local devnode with pre-funded key (strategic plan §Open Questions 1).
- Done when: from a clean stack, contracts deploy automatically and `local.json` contains the three wired contract addresses; a `cast call` against the logic contract succeeds.
- **Amended 2026-07-18 (David's decision):** this criterion is met for deployment (confirmed twice end-to-end) but not for the `cast call` half — calling deployed Stylus contracts on the local devnode doesn't work (see `integration_tests/reports/phase-1-environment-notes.md`). Deferred rather than resolved; the stack's default chain component is now the existing Sepolia deployment instead (strategic plan §Open Questions 1 amendment). This step's local-devnode work stays in place behind Compose profile `local-chain` for a later revisit.

**1.3 IPFS service** — [Haiku]
- What: add `ipfs/kubo` (single node, per decision) with healthcheck and named volume. **Amended 2026-07-18:** MinIO is no longer needed — press's IPFS pinning is now behind a pluggable `IpfsPinningProvider` (see the IPFS-provider-abstraction commit) with a `kubo` implementation (`press/src/ipfs/kubo.ts`) that talks to Kubo's HTTP API directly, so there's no need to fake Filebase's S3-with-CID-metadata behavior on top of a generic object store. Kubo's gateway defaults to subdomain-style redirects (`<cid>.ipfs.localhost`), which don't resolve for path-style fetches from other containers — fixed via a `/container-init.d/` script (`env/ipfs/001-gateway-config.sh`) disabling `UseSubdomains`.
- Context: compose file from 1.2; `press/src/ipfs/kubo.ts`, `press/src/config.ts` (`IPFS_PROVIDER`, `KUBO_API_URL`, `KUBO_GATEWAY_URL`).
- Done when: `ipfs id` healthcheck passes; a real add-then-fetch round trip via the HTTP API and gateway succeeds (confirmed).

**1.4 Relay + redis** — [Haiku]
- What: adapt `relay/docker-compose.yml` services into the integration compose (build from `relay/Dockerfile`, redis 7-alpine, same healthchecks), with a test `config/apps.json`.
- Context: `relay/docker-compose.yml`, `relay/Dockerfile`, `relay/config/`.
- Done when: relay `/health` returns 200 inside the stack.

**1.5 Synapse + policy module** — [Sonnet]
- What: add the Synapse image built from `wallet-service/matrix/Dockerfile` with a generated homeserver config (registration open for tests, policy module enabled and pointed at the stack's IPFS/chain endpoints).
- Context: `wallet-service/matrix/Dockerfile`, `wallet-service/matrix-policy-module/README.md` + `src/`, `specs/object_specs/matrix_synapse_module.md`.
- Done when: Synapse healthcheck passes; a test user can register and create a room via the client-server API; policy module logs show it loaded. **Confirmed 2026-07-18** via `curl`: `/register` + `/createRoom` both succeed, `Loaded module <PolicyModule ...>` appears in logs.
- **Amended 2026-07-18:** `wallet-service/matrix/homeserver.yaml.template` couldn't be reused verbatim — it disables registration and requires an Application Service registration file for wallet-service's shadow-account bridge, which isn't in the stack until Phase 1.7 (Synapse refuses to start if that file is missing). `env/synapse/homeserver.yaml.template` is an integration-tests-specific variant: registration enabled via shared secret, no `app_service_config_files` (add back once wallet-service joins). Secret generation (`wallet-service/scripts/generate-matrix-secrets.ts`) is coupled to wallet-service's own Postgres/config, so `env/synapse/init.sh` is a standalone one-shot init service generating the same four artifacts (signing key, registration shared secret, membership-registry key, rendered config) without that dependency — the signing key specifically is generated via Synapse's own `generate` mode into a scratch dir rather than hand-rolled, to avoid the DER-parsing risk `generate-matrix-secrets.ts`'s own header comment flags. `REGISTRY_CONTRACT_ADDRESS` is Sepolia's `logic_contract` (checksummed — web3.py rejects lowercase addresses), per `specs/object_specs/matrix_synapse_module.md`'s note that this field is the upgradeable logic contract. `ARBITRUM_RPC_WS_URL` turned out to be required by config parsing despite being otherwise unused right now (Arbitrum has no official public WSS; PublicNode's free unauthenticated endpoint is used as a placeholder). Found and noted separately, not fixed: the policy module's Watcher background loops throw `RuntimeError: no running event loop` at startup — doesn't block module loading or this step's criteria (`reports/phase-1-environment-notes.md`).

**1.6 Press under workerd** — [Sonnet]
- What: author `press/wrangler.toml` (nodejs_compat, vars for chain RPC, IPFS API, `PRESS_KV` binding); build with `NITRO_PRESET=cloudflare-module`; run under `wrangler dev` in a container. Wire env to the stack's services.
- Context: `press/nitro.config.ts`, `press/package.json`, `wallet-service/wrangler.toml` (as the pattern), `specs/object_specs/press.md`, decision: workerd fidelity (strategic plan §Rationale Goal 1). §Open Questions 2's MinIO answer is superseded — see the 2026-07-18 IPFS-provider-abstraction commit.
- Done when: press health endpoint responds from inside the compose network, running under workerd, and can reach chain, IPFS, and KV. **Confirmed 2026-07-18**: `{"status":"ok"}` from a live container.
- **Amended 2026-07-18:** three real workerd-compatibility bugs found and fixed getting here, all documented in `specs/object_specs/press.md`'s 2026-07-18 amendment: (1) `ioredis` (behind the `redis` KV driver) can't run under Workers' `nodejs_compat` at all — crashes on boot; fixed by switching the default preset to a native `cloudflare-kv-binding`. (2) `defineNitroPlugin`'s callback runs outside any request's execution context under Workers, and workerd hard-rejects async I/O there; fixed by deferring the startup readiness checks to a `request` hook, awaited (not fire-and-forget — a detached background promise's I/O got silently stuck once its triggering request's handler returned, confirmed empirically). (3) The startup RPC check hardcoded Arbitrum One (42161), unconditionally failing against Sepolia; fixed with a new optional `EXPECTED_CHAIN_ID` config, set to Sepolia's `421614` in `env/press/.dev.vars`. Note (3) only fixes the readiness check — `src/chain/{registry,gas}.ts` and `reconcile-cids.ts` still hardcode `arbitrum` for transaction construction, so this doesn't make press's write paths chain-agnostic.

**1.7 Wallet-service under workerd** — [Haiku], escalated to [Sonnet] for the pg.Pool fix
- What: replicate 1.6's container pattern for wallet-service using its existing `wrangler.toml` (miniflare provides WALLET_KV locally); wire env vars for Synapse, chain, IPFS. Own Postgres + one-shot `node-pg-migrate` init container (env/wallet-service/Dockerfile doubles as both, matching env/synapse's init/run split).
- Context: 1.6's Dockerfile/pattern, `wallet-service/wrangler.toml`, `wallet-service/nitro.config.ts`, `wallet-service/server/db/migrations/`.
- Done when: wallet-service health endpoint responds under workerd with KV reads/writes working. **Confirmed 2026-07-19**: 15/15 consecutive `/health` requests returned `{"status":"ok",...}` from a live container.
- **Amended 2026-07-19:** unlike press, wallet-service's KV story was already workerd-ready (`KV_BACKEND=cloudflare-kv`, existing `WALLET_KV` binding, no code change) and its health-check I/O already runs lazily inside the request handler rather than eagerly in a plugin, so it didn't hit press's two bugs. It hit a different one: `server/db/client.ts`'s module-scope `pg.Pool`, cached and reused across requests (the standard Node pattern, used by all ~37 call sites via `getPool()`) — a connection established during one request intermittently hung and got force-killed by the Workers runtime's watchdog when reused during a *later*, different request (~50% failure rate on a plain health-check query). Confirmed empirically that local Hyperdrive emulation does not fix this (`wrangler dev`'s `localConnectionString` is a passthrough with no pooling). Since every one of the ~37 call sites already calls `getPool()` fresh per request rather than caching it themselves, the fix was entirely inside `getPool()`: on the Workers runtime (detected via the documented `navigator.userAgent === 'Cloudflare-Workers'` check), return a brand-new `max: 1` `Pool` per call instead of the cached singleton, so its connection is always established and used within the same request; `idleTimeoutMillis`/`allowExitOnIdle` let it clean itself up without threading an explicit `.end()` through every caller. No call site anywhere in the codebase uses transactions or pool introspection (checked), so `max: 1` changes nothing observable. `node-server`/`aws-lambda` presets are unaffected — they still get the real persistent pool. `wallet-service/docs/operations.md` had a stale claim that raw TCP sockets don't work under Workers at all without Hyperdrive; corrected.

**1.8 Stack-wide healthcheck + startup ordering** — [Sonnet]
- What: add `depends_on` conditions across all services, a `stack-ready` script that polls every healthcheck, and fix any startup races. Measure cold-start time (target ≤ ~5 min).
- Context: full compose file; outputs of 1.2–1.7.
- Done when: `docker compose up --wait` succeeds repeatedly from clean state on a dev machine. **Confirmed 2026-07-19**: two consecutive clean-state (`docker compose down -v`) runs of `docker compose up --wait` both succeeded in ~27s, well under the 5-min target.
- **Amended 2026-07-19:** the `depends_on` graph built up incrementally across 1.3–1.7 was already sufficient — a single unstaged `docker compose up -d` from a clean volume converged all 8 default-stack services to healthy in ~20s with no manual sleeps, the same result the earlier per-service verification passes got by staging services up by hand. One gap found by reviewing every service's env vars against its `depends_on`: `wallet-service` reads `IPFS_GATEWAY_URL` (same as `press`) but, unlike `press`, had no `depends_on: ipfs`. Added, for consistency — not currently exercised by `/health`, but avoids a confusing failure if a future endpoint calls IPFS before the container's had a chance to see it come up. Added `integration_tests/stack-ready.sh`, a small polling script for the case `docker compose up --wait` doesn't cover: confirming an already-running stack (started in a separate step, e.g. by CI) is ready before a suite runs against it — Phase 2's harnesses/suites should call this rather than re-invoking `docker compose up`.

**Phase 1 Milestone Review** — [Sonnet]
- Context needed: `integration_tests/docker-compose.yml`, all `env/` files, `deployments/local.json` output, `stack-ready` output, strategic plan §Key Objectives Goal 1.
- Done when: every Goal-1 objective verified; service naming/env-var conventions consistent across containers; any workerd limitations discovered (missing Node APIs etc.) written to `integration_tests/reports/phase-1-environment-notes.md`; one-paragraph summary in `plans/milestones/integration-phase-1.md`.
- **Confirmed 2026-07-19**: full review written to `plans/milestones/integration-phase-1.md`. Every Goal-1 objective checked against the strategic plan's actual wording: environment, IPFS, press, wallet-service, relay+redis, and Synapse are all done and healthy; the Nitro-devnode-with-fresh-contracts bullet is deliberately descoped to Sepolia (documented deviation, not a gap); the web/RN SDK harness bullet is Phase 2 scope per the implementation plan's own phase split, not Phase 1's. Env-var/naming conventions checked across all `env/` files and `docker-compose.yml` — consistent, with `IPFS_GATEWAY_URL` vs. press's `KUBO_*` naming noted as an intentional (not accidental) divergence. No new workerd limitations found beyond what 1.6/1.7 already documented.

---

## Phase 2: Harnesses and fixtures

**Deliverable**: web and RN SDK harnesses each complete a scripted end-to-end call against the stack; shared fixtures package exists.

**2.1 Shared fixtures package** — [Sonnet]
- What: create `integration_tests/fixtures/` importing/reexporting key material and test vectors from existing suites (`contracts/test_params`, `contracts/scripts/gen_test_vectors.rs` outputs, `press/test`, `relay/tests`, `wallet-service/test`) plus helpers to mint fresh wallets/cards against the live stack. Document what each fixture represents.
- Context: the four existing test dirs, `specs/object_specs/ipfs_card.md`, decision: reuse fixtures (strategic plan §Open Questions 6).
- Done when: a fixture helper can produce a signed card accepted by the live press.
- **Confirmed 2026-07-20**: `integration_tests/fixtures/` built — `mintCard` signs a real offer with `app-sdk`'s actual `assembleAndSignTargetedOffer` and mints a card through a live press's `/issue`/`/issue/finalize`, confirmed twice consecutively end-to-end including real on-chain registration on Sepolia. The four existing test dirs turned out to hold only per-test throwaway fixtures, not shared/importable ones (see `fixtures/README.md`) — reuse happens through `app-sdk` (the real SDK code) instead, which is arguably more faithful to the stated goal anyway. **This step surfaced and fixed six independent, previously-undetected bugs in press's chain integration** (spec-shape signature mismatch, ABI function-name casing, missing `press_address` params, `bytes` vs `uint8[]` encoding, reads needing to target the storage contract not logic, and a `uint8[]`-multi-return tuple-decoding issue), plus a Workers `crypto.createCipheriv` compatibility gap and an already-flagged-but-unfixed hardcoded-mainnet-chain-object bug — none of which any existing unit test suite (all mocked) could have caught. The Sepolia deployment itself also turned out to be stale (missing `getProtocolVersion()` in its bytecode) and was redeployed. Full writeup: `integration_tests/reports/phase-1-environment-notes.md`'s "Press's chain integration" entry.

**2.2 Web SDK harness** — [Sonnet]
- What: Playwright container (`mcr.microsoft.com/playwright`) loading a minimal page that exercises `sdk-providers-web` + `client-sdk`/`app-sdk` against the stack; one smoke test: create wallet → accept an offer → validate card.
- Context: `sdk-providers-web/packages/`, `app-sdk/packages/`, `specs/object_specs/wallet_sdk.md`, `specs/object_specs/app_sdk.md`, fixtures from 2.1.
- Done when: smoke test passes in the container against the live stack.

**2.3 RN SDK harness** — [Haiku]
- What: jest + react-native-preset container for `sdk-providers-rn`, mirroring 2.2's smoke test (per decision: no emulator).
- Context: 2.2 harness as pattern, `sdk-providers-rn/packages/`, decision: jest-only RN simulation (strategic plan §Open Questions 4).
- Done when: the same smoke flow passes under the RN preset.

**Phase 2 Milestone Review** — [Sonnet]
- Context needed: `fixtures/` README, both harness smoke-test outputs, phase-1 environment notes.
- Done when: both harnesses green; fixtures documented; API mismatches between web and RN SDKs (if any) logged as issues; summary in `plans/milestones/integration-phase-2.md`.

---

## Phase 3: Wave 1 — core card lifecycle tests + initial report

**Deliverable**: tests for the core process specs; first issues report.

**3.1 First lifecycle test (pattern-setter)** — [Sonnet]
- What: write `suites/core/card_signing.spec.ts` covering `specs/process_specs/card_signing.md` end-to-end (wallet → press co-sign → IPFS publish → registry). Establish the suite conventions: one file per process spec, each test annotated with the spec section it verifies, run via vitest from the compose network.
- Context: `specs/process_specs/card_signing.md`, `specs/object_specs/press.md`, `specs/object_specs/ipfs_card.md`, fixtures 2.1.
- Done when: test runs against the stack; conventions documented in `suites/README.md`.

**3.2 Remaining Wave-1 suites** — [Haiku] (one delegation per spec)
- What: following 3.1's pattern, author suites for: `card_offering_and_acceptance.md`, `card_validation.md`, `card_updates.md`, `open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`.
- Context per suite: the one process spec + `suites/README.md` conventions + fixtures. Nothing else.
- Done when: each suite runs (pass or fail) with every spec assertion represented.
- Escalation: if a spec is ambiguous or the pattern doesn't fit, hand that suite to Sonnet rather than guessing.

**3.3 Wave 1 run + report** — [Sonnet]
- What: run all core suites against a clean stack; write `integration_tests/reports/2026-MM-DD-wave-1.md` — for each failure: spec reference, components involved, observed vs. expected, suspected cause, and a triage tag (fix-now / defer / test-bug). Haiku may format the report from Sonnet's raw findings.
- Context: suite outputs, service logs, relevant specs.
- Done when: report exists and every failure is triaged.

**⛔ Checkpoint — David reviews the Wave 1 report and decides which fix-now issues to address (and who fixes them) before Phase 4 begins.** Product-code fixes are out of scope for this plan unless David assigns them here.

**Phase 3 Milestone Review** — [Sonnet]
- Context needed: all `suites/core/` files, Wave-1 report, strategic plan §Key Objectives Goal 2 (Wave 1) & Goal 3.
- Done when: coverage cross-checked against each Wave-1 spec's sections; test-bug-tagged failures fixed; summary in `plans/milestones/integration-phase-3.md`.

---

## Phase 4: Wave 2 — matrix and relay flows

**4.1 First matrix flow test (pattern-setter)** — [Sonnet]
- What: `suites/matrix-relay/matrix_room_membership.spec.ts` per `specs/process_specs/matrix_room_membership.md`, exercising Synapse + policy module + wallet-service; extend conventions for matrix-specific setup (user registration, room creation, attestation fixtures).
- Context: the spec, `matrix_join_attestation_and_revocation.md` (adjacent semantics), `specs/object_specs/matrix_synapse_module.md`, `matrix_room.md`, phase-1 Synapse config.
- Done when: test runs; matrix conventions appended to `suites/README.md`.

**4.2 Remaining Wave-2 suites** — [Haiku] (one delegation per spec)
- What: suites for `matrix_join_attestation_and_revocation.md`, `message_routing.md`, `notification_relay.md`, `room_discovery.md` following 4.1's pattern.
- Context per suite: the one spec + conventions + fixtures. Relay suites additionally get `specs/object_specs/relay.md` + `relay_data_model.md`.
- Done when: each suite runs with every spec assertion represented. Same escalation rule as 3.2.

**4.3 Wave 2 run + report** — [Sonnet]
- What: as 3.3; report to `reports/2026-MM-DD-wave-2.md`.
- Done when: report exists, failures triaged.

**⛔ Checkpoint — David reviews the Wave 2 report before Phase 5.**

**Phase 4 Milestone Review** — [Sonnet]
- Context needed: `suites/matrix-relay/` files, Wave-2 report, phase-3 summary.
- Done when: coverage verified against Wave-2 specs; conventions still consistent with core suites; summary in `plans/milestones/integration-phase-4.md`.

---

## Phase 5: Wave 3 — full spec coverage

**5.1 Remaining process-spec suites** — [Haiku], escalating per 3.2's rule
- What: `suites/extended/` suites for: `card_migration.md`, `wallet_backup_and_recovery.md`, `log_auditing.md`, `oblivious_transport.md`, `policy_creation.md`, `subcard_creation_policy.md`, `dns_governance_verifier.md`, plus any Wave-1/2 spec sections deferred earlier. `oblivious_transport` and `dns_governance_verifier` are likely Sonnet-grade — assign directly to Sonnet.
- Context per suite: the one spec + conventions + fixtures.
- Done when: every process spec in `specs/process_specs/` has a suite.

**5.2 Object-spec conformance checks** — [Haiku]
- What: `suites/conformance/` — for each object spec not already covered implicitly (e.g. `card_verifier.md`, `registry_contract.md`, `wallet.md`, `client_sdk.md`), a suite asserting the object's documented interface/invariants against the live stack.
- Context per suite: the one object spec + conventions.
- Done when: every object spec maps to either a conformance suite or a named process suite that covers it (mapping table in `suites/README.md`).

**5.3 Full run + report** — [Sonnet]
- What: full-suite run on clean stack; `reports/2026-MM-DD-full-coverage.md` with triage as before, plus a coverage table (spec → suite → status).
- Done when: report exists; coverage table complete.

**⛔ Checkpoint — David reviews the full-coverage report before CI gating (a red suite wired into CI would block all deploys).**

**Phase 5 Milestone Review** — [Sonnet]
- Context needed: coverage table, all three reports, strategic plan §Key Objectives Goals 2–3.
- Done when: no spec uncovered; disposition (fixed/deferred-with-issue) recorded for every open failure; summary in `plans/milestones/integration-phase-5.md`.

---

## Phase 6: Entry-point script and CI gating

**6.1 `integration_tests/run.sh`** — [Sonnet]
- What: single script that (a) runs every component's unit tests (`contracts` cargo test, `press`/`wallet-service`/`relay` vitest, SDK workspaces, `matrix-policy-module` pytest), (b) brings the stack up with `--wait`, (c) runs all integration suites + harness smoke tests, (d) tears down, exiting non-zero if anything failed. Flags: `--unit-only`, `--integration-only`, `--suite <name>`.
- Context: all package.json/Cargo test commands, compose file, suites layout.
- Done when: script exits 0 on green, non-zero on any injected failure, from a clean checkout.

**6.2 GitHub Actions workflow** — [Haiku]
- What: `.github/workflows/integration-tests.yml` running `run.sh` on PR and pre-deploy (docker + rust + node toolchains, cached).
- Context: `run.sh`, existing workflows in `.github/workflows/` as style reference.
- Done when: workflow green on a clean branch.

**6.3 Gate deploy workflows** — [Haiku]
- What: make `relay-deploy.yml`, `wallet-service-ci.yml`, `client-sdk-ci.yml`, `publish-verifier.yml` (and any future deploy job) depend on the integration-tests workflow (`workflow_call` or shared job with `needs:`).
- Context: the four workflow files, 6.2's workflow.
- Done when: deploy jobs show the dependency in the Actions graph.

**6.4 Verification: break a test, watch it block** — [Sonnet]
- What: on a branch, deliberately break one unit test and one integration test; confirm `run.sh` fails and the deploy workflows are blocked; revert.
- Context: none beyond 6.1–6.3 outputs.
- Done when: both failure modes demonstrably blocked deploys; screenshot/log noted in `plans/milestones/integration-phase-6.md`.

**Phase 6 Milestone Review** — [Sonnet]
- Context needed: `run.sh`, all workflow files, 6.4 evidence, strategic plan §Key Objectives Goal 4.
- Done when: all Goal-4 objectives verified; `integration_tests/README.md` finalized (how to run locally, how CI uses it); summary in `plans/milestones/integration-phase-6.md`.

---

## Clarification Checkpoints (consolidated)

Pause and check with David when:

1. **After each wave's report** (3.3, 4.3, 5.3) — before starting the next phase, David triages which issues get fixed and by whom. Fixing product code is otherwise out of scope.
2. **Before modifying anything outside `integration_tests/`** other than the pre-agreed changes: `deploy.sh` local case (1.2), `press/wrangler.toml` (1.6), CI workflows (6.2–6.3). Any other product-code change requires sign-off first.
3. **Before wiring CI gating (Phase 6)** if any suite is still red — a red suite in CI blocks all deploys.
4. **If workerd can't run press or wallet-service** for a fundamental reason (missing API with no polyfill), stop and present options (node-preset fallback vs. code change) rather than silently downgrading fidelity.
5. **If a spec contradicts implemented behavior** during test authoring, don't pick a side — log it in the wave report and flag it (per the spec-correction convention: state current behavior plainly).
6. **If Phase 1 exceeds ~2 sessions of effort** (the workerd emulation is the highest-risk item), check in with a status summary rather than grinding.
