# Integration Testing — Strategic Plan

Companion: [integration-testing-implementation-plan.md](integration-testing-implementation-plan.md)

## Goals

1. **A deployment-faithful integration environment.** A single docker-compose stack in `integration_tests/` that runs every core object — Stylus contracts on an Arbitrum Nitro dev node, press and wallet-service under workerd/wrangler (matching their Cloudflare deployment), relay and Matrix (Synapse + policy module) as containers, and web/RN SDK harnesses — so integration failures surface here instead of in production.

2. **Spec-driven coverage of protocol behavior.** Every process spec and object spec in `specs/` has corresponding integration tests, built core-flows-first (card lifecycle → matrix/relay → long tail), so the specs stop being aspirational documents and become verified contracts.

3. **Actionable defect visibility.** The initial test runs produce written reports in `integration_tests/reports/` that identify concrete issues (spec violations, cross-component mismatches, environment gaps) with enough context to fix each one.

4. **Deployment gated on green tests.** All unit and integration tests run via a single entry-point script, wired into GitHub Actions so that any deploy workflow fails if any test fails.

## Rationale

**Goal 1** — The protocol has seven-plus independently developed components (contracts, press, wallet-service, relay, matrix module, two SDK families) whose unit tests all pass in isolation while cross-component assumptions (key formats, CID encodings, signature schemes, room-state semantics) drift. Each component already has a different deployment target — Cloudflare Workers for press/wallet, docker for relay/matrix, npm packages for SDKs — so only an environment that reproduces those runtimes catches runtime-specific failures (Workers CPU/memory limits, missing Node APIs in workerd, R2/KV binding behavior). The workerd choice costs setup effort but was chosen deliberately over the simpler node-server preset.

**Goal 2** — The specs directory is the source of truth for protocol behavior (per prior spec-consistency work in `plans/spec-consistency/`). Tests derived from specs, rather than from implementations, catch the class of bug where two components each "work" but disagree. Core flows first because card signing/offering/validation is the critical path every other flow depends on; a failure there invalidates downstream test results anyway.

**Goal 3** — The first run of a new integration suite against real components will mostly find pre-existing issues, not test bugs. Capturing them as a structured report (rather than a wall of red CI output) lets fixes be prioritized and delegated — including to cheaper models — without re-running the whole stack to rediscover context.

**Goal 4** — Existing workflows (`relay-deploy.yml`, `wallet-service-ci.yml`, `client-sdk-ci.yml`) each test their own component only. Nothing today prevents deploying a press build that breaks the relay. A single `run-all-tests` entry point invoked by CI makes "all tests pass" the deployment invariant.

## Key Objectives

**Goal 1 (environment)**
- `docker compose up` in `integration_tests/` brings up: Nitro dev node with contracts deployed, IPFS node, press (workerd), wallet-service (workerd), relay + redis, Synapse + policy module — all passing healthchecks.
- Web SDK harness (headless browser via Playwright container) and RN SDK harness (jest/react-native test runner container) can each complete a scripted end-to-end call against the stack.
- Cold start of the full stack completes in under ~5 minutes on a developer machine.

**Goal 2 (coverage)**
- Wave 1: integration tests exist and run for card_signing, card_offering_and_acceptance, card_validation, card_updates, open_offer_creation, and both open_offer_acceptance specs.
- Wave 2: matrix_room_membership, matrix_join_attestation_and_revocation, message_routing, notification_relay, room_discovery.
- Wave 3 (completion phase): all remaining process specs (migration, backup/recovery, log_auditing, oblivious_transport, policy/subcard specs, dns_governance_verifier) and object-spec conformance checks.
- Every test names the spec section it verifies.

**Goal 3 (reporting)**
- After each wave's first run, a dated report exists in `integration_tests/reports/` listing each failure with: spec reference, components involved, observed vs. expected behavior, and suspected cause.
- Issues from Wave 1's report are triaged (fix now / defer / test bug) before Wave 2 authoring begins.

**Goal 4 (CI gating)**
- `integration_tests/run.sh` (or equivalent) runs all unit tests across components plus the integration suite, exiting non-zero on any failure.
- A GitHub Actions workflow runs this script; all deploy workflows depend on it.
- A deliberately broken test demonstrably blocks a deploy workflow.

## Model Delegation Strategy

Steps are tiered Haiku/Sonnet only (per decision); anything too hard for Sonnet escalates to David rather than a larger model.

- **Haiku**: mechanical, well-specified, low-blast-radius — scaffolding directories, writing Dockerfiles from a given template, config files, report formatting, translating an existing test to a new spec section with a clear pattern to copy.
- **Sonnet**: judgment-bearing — docker-compose orchestration and healthchecks, authoring the first test of each pattern, workerd/wrangler emulation setup, diagnosing cross-component failures, milestone reviews, CI wiring.

Rule of thumb: Sonnet writes the first instance of anything; Haiku replicates the pattern across the remaining instances.

## Open Questions — all resolved 2026-07-16

1. **Contract deployment in-stack** — *Resolved by inspection*: `contracts/scripts/deploy.sh` supports only sepolia/mainnet with an external RPC and funded key. The stack needs a `local` network case targeting the Nitro devnode's pre-funded dev key; handled in Phase 1.
2. **workerd bindings** — *Resolved by inspection*: wallet-service has `wrangler.toml` (WALLET_KV; miniflare emulates KV under `wrangler dev`). Press has no wrangler.toml — one must be authored; its S3 access is via `@aws-sdk/client-s3`, emulated with MinIO. Press also reads `EXTERNAL_KV_URL`.
3. **Matrix stack shape** — *Resolved by inspection*: stock Synapse with the policy module built in via `wallet-service/matrix/Dockerfile`. No additional matrix infrastructure required.
4. **RN SDK simulation depth** — *David's decision*: jest + react-native preset in a docker container. No emulator.
5. **IPFS pinning** — *David's decision*: single local Kubo node; replication out of scope.
6. **Existing tests as seeds** — *David's decision*: reuse fixtures/helpers/test vectors from existing suites where possible (e.g. `contracts/test_params`, `gen_test_vectors.rs`).
