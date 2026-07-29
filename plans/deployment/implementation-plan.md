Strategic plan: [strategic-plan.md](./strategic-plan.md)

# Deployment — Implementation Plan

Scope: press, wallet-service, relay (Droplet + docker-compose on DigitalOcean), and four npm packages — app-sdk, wallet-sdk, sdk-providers-web, sdk-providers-rn, membership_card_verifier. `client-sdk` and `contracts` are explicitly out of scope (superseded, and governance-gated, respectively).

---

## Phase 1: Per-package deploy scripts + READMEs

**1.1 — press**
- What: Add `press/scripts/deploy.sh` taking `dev`/`prod` as an argument, wrapping `nitro build --preset cloudflare-module` + `wrangler deploy` with environment-scoped `wrangler.toml` env blocks (`[env.dev]` / `[env.prod]`). Add `press/DEPLOYMENT.md`: required Cloudflare account/API token, required env vars (S3 credentials, IPFS endpoint, verifier build dependency), and setup steps for a first-time deploy.
- Who: Claude
- Context needed: `press/wrangler.toml`, `press/package.json` scripts, `press/OPERATOR.md` (existing operator doc — check for overlap/reuse), `relay/README.md` §2.2 (existing pattern for "required secrets" documentation to mirror)
- Done when: `press/scripts/deploy.sh dev` and `press/scripts/deploy.sh prod` both run to completion against a real or dry-run Cloudflare target, and `press/DEPLOYMENT.md` lists every env var the script/wrangler.toml references.

**1.2 — wallet-service**
- What: Add `wallet-service/scripts/deploy.sh` (`dev`/`prod`), wrapping `pnpm run build` (Cloudflare preset) + migrations (`node-pg-migrate up`) + `wrangler deploy`, with a pre-flight secret-presence check mirroring `wallet-service-ci.yml`'s pattern. Add `wallet-service/DEPLOYMENT.md` covering Postgres, WebCrypto/KMS master key, WebAuthn RP config, and the Arbitrum RPC/registry contract address per environment.
- Who: Claude
- Context needed: `wallet-service/wrangler.toml`, `wallet-service/docs/` (check existing docs first), `.github/workflows/wallet-service-ci.yml` (full existing env var list — reuse names exactly), `wallet-service/scripts/` (existing scripts to avoid duplicating)
- Done when: deploy script runs migrations then deploys without manual intervention for a fresh dev Postgres + Cloudflare Worker, and `DEPLOYMENT.md` env var list matches (or explains deltas from) `wallet-service-ci.yml`'s env block.

**1.3 — relay**
- What: Add `relay/scripts/deploy.sh` (`dev`/`prod`) that deploys `relay/Dockerfile` to a DigitalOcean App Platform app via `doctl apps create-deployment` (or `doctl apps update` on first run using an app spec `relay/.do/app.yaml` checked into the repo, one per environment or parameterized). Isolate the actual platform call in one clearly-named function (`deploy_to_app_platform`) so it can be swapped for a Droplet+docker-compose path later for a different service without touching the rest of the script. Add `relay/DEPLOYMENT.md` covering: DO App Platform app creation (via `relay/.do/app.yaml`), managed Redis provisioning (replaces self-hosted Redis — check DO Managed Databases pricing before committing), and every secret from the old `relay-deploy.yml` `validate-secrets` job, updated for the App Platform target (drop `CLOUDFLARE_*`, add `DIGITALOCEAN_ACCESS_TOKEN`).
- Who: Claude, with David confirming DO account/billing setup (Claude cannot provision billed infrastructure directly)
- Context needed: `relay/docker-compose.yml`, `relay/docker-compose.dev.yml` (for local dev only — not used in the App Platform deploy path), `relay/Dockerfile`, `.github/workflows/relay-deploy.yml` (superseded — reuse its secret list and validate-secrets pattern, drop Cloudflare-specific steps), `relay/README.md` §2.2, strategic-plan.md Open Question 2 (App Platform vs. Droplet rationale)
- Done when: `relay/scripts/deploy.sh dev` deploys a working relay to a real dev App Platform app reachable over HTTP/WS, `relay/DEPLOYMENT.md` documents setup from zero (a person with a blank DO account could follow it), and the `deploy_to_app_platform` function is isolated enough that swapping in a Droplet path later is a one-function change, not a rewrite.

**1.4 — npm packages (app-sdk, wallet-sdk, sdk-providers-web, sdk-providers-rn, membership_card_verifier)**
- What: Add a `scripts/publish.sh` (or shared root-level script parameterized by package) per package: version bump → build → `npm publish --tag next` for dev, `--tag latest` for prod, following `publish-verifier.yml`'s existing pattern (provenance, `NODE_AUTH_TOKEN`). Add a `DEPLOYMENT.md` (or extend existing README) per package noting the `file:` dependency chain (verifier must publish/build before app-sdk/wallet-sdk if they depend on it — check `package.json` deps to confirm order) and the `NPM_TOKEN` secret requirement.
- Who: Claude
- Context needed: `.github/workflows/publish-verifier.yml`, each package's `package.json` (dependency chain — check for `file:` refs the way `client-sdk`/`press`/`wallet-service` have to `membership_card_verifier`), `pnpm-workspace.yaml` per package
- Done when: each package has a working `publish.sh dev` that publishes a real prerelease version under the `next` tag to npm (or a dry-run `--dry-run` flag is used for verification without polluting the registry), and dependency order between the five packages is documented and enforced in the script.

**Phase 1 Milestone Review**
Context needed: `press/DEPLOYMENT.md`, `wallet-service/DEPLOYMENT.md`, `relay/DEPLOYMENT.md`, and the five package `DEPLOYMENT.md`/README updates; all `deploy.sh`/`publish.sh` scripts written in 1.1–1.4
Done when: every script accepts the same `dev`/`prod` argument convention and fails loudly (not silently) on missing config; env var naming is consistent across scripts and docs (e.g. no package calling the same concept by two different names); a one-paragraph phase summary is written to `plans/deployment/phase-1-summary.md`; any assumptions from the strategic plan's Open Questions that turned out wrong during this phase (e.g. actual DO droplet setup requirements) are corrected in `strategic-plan.md` before Phase 2 begins.

**Clarification checkpoint:** Before creating any real DigitalOcean resources (droplet, container registry) or publishing any real package version to npm (even under a dev tag), stop and confirm with David — these have external cost/visibility even in "dev" mode.

---

## Phase 2: Master deployment script

**2.1 — Master script**
- What: Add `scripts/deploy-all.sh <dev|prod>` at repo root that calls, in order: membership_card_verifier publish → app-sdk/wallet-sdk/sdk-providers-web/sdk-providers-rn publish → press deploy → wallet-service deploy → relay deploy. Each step's failure halts the script (no partial-deploy-and-continue). Script explicitly refuses to touch `contracts/` — add a guard (e.g., a comment banner plus a check that greps its own step list for "contracts" and fails if found, as a tripwire against future accidental additions).
- Who: Claude
- Context needed: all `deploy.sh`/`publish.sh` scripts from Phase 1, dependency order confirmed in 1.4
- Done when: `scripts/deploy-all.sh dev` runs all six deploy/publish steps against real dev infrastructure end to end without manual intervention, and a deliberate test (temporarily adding a fake "deploy contracts" line) proves the tripwire fails the script.

**Phase 2 Milestone Review**
Context needed: `scripts/deploy-all.sh`, `plans/deployment/phase-1-summary.md`
Done when: a full dev deploy-all run succeeds once, log output is reviewed for any step masking a failure (exit code swallowed), and `plans/deployment/phase-2-summary.md` is written.

**Clarification checkpoint:** Before running `deploy-all.sh prod` for the first time — pause and confirm with David explicitly, since this touches every production service at once.

---

## Phase 3: dev-tests

**3.1 — Scaffold `dev-tests/`**
- What: New top-level `dev-tests/` folder with its own runner (`dev-tests/run.sh`), separate config for pointing at live dev press/wallet-service/relay URLs, Arbitrum Sepolia RPC, and live IPFS. Structure mirrors `integration_tests/` layout so porting is mechanical.
- Who: Claude
- Context needed: `integration_tests/` full structure (`ls -R` first), `integration_tests/run.sh`, `contracts/deployments/sepolia.json` (Sepolia registry contract address to test against)
- Done when: `dev-tests/run.sh` exists, runs zero tests successfully (empty scaffold), and its README explains how to point it at a given dev deployment.

**3.2 — Port each integration test**
- What: For every suite/harness under `integration_tests/`, create a `dev-tests/` counterpart that replaces mocked IPFS/chain/service calls with real ones, and replaces any source-tree SDK imports with the published npm package (installed at the `next`/dev dist-tag from Phase 1.4) — so these tests validate the actual artifact a real app would install, not the monorepo source.
- Who: Claude
- Context needed: each `integration_tests/` suite individually (read one at a time, not all at once, to keep context per-step scoped), `plans/integration-testing-implementation-plan.md` for the mocking rationale being replaced
- Done when: every `integration_tests/` suite has a corresponding `dev-tests/` file, each one runs green against a real dev deployment stood up via Phase 2's `deploy-all.sh dev`, and each uses the npm-installed SDK (verified by checking `dev-tests/package.json` has no `file:` refs into the monorepo).

**Phase 3 Milestone Review**
Context needed: `dev-tests/` full contents, `integration_tests/` full contents (for 1:1 coverage comparison), `plans/deployment/phase-2-summary.md`
Done when: every integration test has a confirmed dev-tests counterpart (no silent gaps), a full `dev-tests/run.sh` pass is green against a live dev deployment, and `plans/deployment/phase-3-summary.md` documents any tests that couldn't be meaningfully ported (e.g. pure unit tests with no live-infra equivalent) with justification.

**Clarification checkpoint:** If any integration test can't be sensibly ported to live infra (e.g. it tests an internal function with no external-facing equivalent), stop and confirm with David whether to skip it or restructure it, rather than silently dropping coverage.

---

## Phase 4: CI/CD pipeline

**4.1 — Pipeline workflow**
- What: New `.github/workflows/deploy-pipeline.yml`, triggered on push to `main`, with staged jobs: (a) `uses: ./.github/workflows/integration-tests.yml` (reuse existing gate), (b) `deploy-dev` running `scripts/deploy-all.sh dev` against the `dev` GitHub Environment, needs (a); (c) `dev-tests` running `dev-tests/run.sh` against the environment (b) just deployed, needs (b); (d) `deploy-prod` running `scripts/deploy-all.sh prod` against the `prod` GitHub Environment, needs (c).
- Who: Claude
- Context needed: `.github/workflows/integration-tests.yml` (reuse as-is via `workflow_call`), `scripts/deploy-all.sh` from Phase 2, `dev-tests/run.sh` from Phase 3, GitHub Environments `dev`/`prod` (create if missing — confirm secret names per package's `DEPLOYMENT.md`)
- Done when: a push to `main` (in a test branch renamed to simulate, or an actual controlled push) runs all four stages in order, a deliberate test-breaking commit halts the pipeline before `deploy-dev`, and a deliberate dev-tests-breaking commit halts it before `deploy-prod`.

**4.2 — Retire/reconcile old workflows**
- What: `relay-deploy.yml` (Cloudflare-targeted, already disabled) should be deleted or clearly archived now that relay deploys via the new pipeline to DigitalOcean. `wallet-service-ci.yml` and `client-sdk-ci.yml` keep their existing push/PR-triggered test-only jobs (still useful as fast per-package gates) but should not duplicate the deploy logic now owned by `deploy-pipeline.yml`.
- Who: Claude, David to confirm before deleting anything
- Context needed: `.github/workflows/relay-deploy.yml`, `.github/workflows/wallet-service-ci.yml`, `.github/workflows/client-sdk-ci.yml`
- Done when: no two workflows can both attempt to deploy the same package on the same trigger, and David has explicitly approved the removal of `relay-deploy.yml`.

**Phase 4 Milestone Review**
Context needed: `.github/workflows/deploy-pipeline.yml`, all Phase 1–3 summaries
Done when: a full end-to-end pipeline run (test → dev deploy → dev-tests → prod deploy) succeeds at least once against real infrastructure, and `plans/deployment/phase-4-summary.md` records the run.

**Clarification checkpoint:** Before merging `deploy-pipeline.yml` in a state where a push to `main` will actually auto-deploy to prod — do a final walkthrough with David of what triggers what, and confirm he wants prod deploys to be fully automatic (vs. requiring manual approval via a GitHub Environment protection rule) before this goes live.

---

## Cross-cutting clarification checkpoints (apply throughout)

- Before creating any GitHub Environments, DigitalOcean resources, or npm dist-tags that didn't exist before — confirm with David.
- Before deleting or overwriting any existing file (especially `.github/workflows/relay-deploy.yml` or anything in `contracts/`) — show the exact diff/list and get explicit confirmation.
- Before running any script against real `prod` infrastructure for the first time — always a manual, confirmed step, never automatic on first implementation.
- If any phase's Claude-time exceeds roughly 3 hours without reaching its Milestone Review, pause and check in with David rather than continuing to expand scope.
