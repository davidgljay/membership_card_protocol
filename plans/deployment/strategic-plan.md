# Deployment Strategy — Strategic Plan

## Goals

1. **Every deployable package has a self-contained, repeatable deployment path.** Anyone (or CI) can deploy any package without tribal knowledge, given the right secrets.
2. **Dev and prod are symmetric, configurable deployments of the same scripts** — not divergent one-off processes. The only difference between a dev and prod deploy is which environment/config is passed in.
3. **The contracts stay out of automated deployment.** Contract changes go through governance (redeploy_logic.sh + a governance proposal), never through the master script or CI pipeline. This is a hard boundary, not an oversight.
4. **Dev deployments are provably correct before prod ever sees them.** A new `dev-tests` suite exercises live dev infrastructure (real IPFS, Arbitrum Sepolia, deployed dev services) using the same npm-published SDKs a real app or wallet would use — not mocks, not local processes.
5. **Shipping to main is safe by default.** A push to `main` runs the full test pyramid, deploys to dev, proves dev works via dev-tests, and only then deploys to prod. A broken change never reaches production silently.

## Rationale

**Per-package deploy scripts + READMEs (Goal 1).** Right now deployment knowledge is scattered: `relay-deploy.yml` documents Cloudflare-era relay deploys that no longer apply (the workflow itself says so — relay moved to Docker/DigitalOcean and the old workflow is `workflow_dispatch`-only, disabled). `wallet-service-ci.yml` builds but doesn't deploy. `press` has no deploy workflow at all. Each package's actual deploy requirements (env vars, external services like Postgres/Redis/S3/KMS) live in scattered `OPERATOR.md`/`README.md`/CI-file knowledge. Consolidating this per-package removes the single point of failure where only one person remembers how to deploy a given service.

**Dev/prod symmetry (Goal 2).** The existing `wallet-service-ci.yml` already proves the pattern works well: same build script, `NITRO_PRESET` env var picks the target. Extending that same "one script, config-driven" approach to every package avoids maintaining two parallel deploy paths that silently drift apart — the classic way dev "works" and prod doesn't.

**Contracts excluded from automation (Goal 3).** `contracts/scripts/deploy.sh` and `redeploy_logic.sh` already exist and are explicitly split (initial deploy vs. logic-only redeploy), and `contracts/deployments/sepolia-2026-06-28-superseded.json` shows a redeploy already happened once. Contract changes affect a smart contract registry that every card, press, and wallet depends on — this is irreversible in ways application deploys aren't, and per protocol design should require a governance action, not a CI trigger. The master script must never touch it.

**Dev-tests against live infra (Goal 4).** `integration_tests/` today mocks out IPFS and the chain (per the integration-testing plan referenced in CI). That's correct for fast, deterministic CI gating of code correctness, but it can't catch "does the deployed dev environment, wired together with real network calls, real DNS, and a real Nitro/Cloudflare Worker cold start, actually work." Porting the tasked integration tests into dev-tests using the *published* app-sdk/wallet-sdk (not source imports) also validates the npm publish pipeline itself — a bug in the published package that isn't in the source tree would otherwise go undetected until a real developer hit it.

**Full pipeline gate before prod (Goal 5).** The existing `integration-tests.yml` is already wired as a reusable `workflow_call` gate in front of every other deploy workflow — this plan extends that same pattern (test → deploy dev → dev-test → deploy prod) rather than inventing a new convention.

## Key Objectives

**Goal 1 — Per-package deploy scripts + READMEs**
- Every deployable package (press, wallet-service, relay, and the four npm packages: app-sdk, wallet-sdk, sdk-providers-web, sdk-providers-rn, membership_card_verifier) has a `deploy.sh` (or `deploy.ts`) that takes an environment argument (`dev`/`prod`) and a package-level `DEPLOYMENT.md` documenting required external services and env vars. `client-sdk` is out of scope — it's the superseded predecessor of app-sdk/wallet-sdk and is not deployed or published.
- Running any package's deploy script with no config produces a clear, actionable error listing exactly what's missing (mirrors the existing `validate-secrets` job pattern in `relay-deploy.yml`).
- A fresh clone + the package README's setup instructions is sufficient to stand up a dev deployment of that package end to end, verified by actually doing it once.

**Goal 2 — Dev/prod configurability**
- Every deploy script and CI workflow reads environment from a single explicit input (CLI arg or workflow `environment:`), never from implicit branch-name or hostname sniffing.
- Config (contract addresses, RPC URLs, dist-tags, Cloudflare env, DO app/droplet ids) lives in versioned per-environment config files or documented secret names — not hardcoded in scripts.

**Goal 3 — Master deployment script**
- One script at repo root (or `scripts/deploy-all.sh`) that deploys press, wallet-service, relay, and publishes the four npm packages (app-sdk, wallet-sdk, sdk-providers-web, sdk-providers-rn, membership_card_verifier), for a given environment, in dependency order (verifier before app-sdk/wallet-sdk, etc., mirroring the existing CI `file:` dependency chain). `client-sdk` is excluded — superseded by app-sdk/wallet-sdk, not published.
- The master script never references `contracts/` and this is enforced (e.g., a test or lint check that fails if `contracts` deploy logic gets added to it).

**Goal 4 — Dev-tests suite**
- A `dev-tests/` folder exists with its own runner, separate from `integration_tests/`.
- Every integration test explicitly tasked for porting (needs enumeration in Phase 1 — see Open Questions) has a dev-tests counterpart that installs `app-sdk`/`wallet-sdk` from the npm registry (dev dist-tag) and drives them against real deployed dev press/wallet-service/relay, real Arbitrum Sepolia, and real IPFS.
- `dev-tests` passing is a required, automated gate before any prod deploy — not a manual step.

**Goal 5 — CI/CD pipeline**
- One pipeline, triggered on push to `main`, runs: full unit + integration tests → deploy all (non-contract) packages to dev → dev-tests against the live dev deployment → deploy all (non-contract) packages to prod, each stage gating the next.
- A failure at any stage stops the pipeline before prod is touched, and is visible in the GitHub Actions UI per-stage (not one monolithic job).

## Open Questions

1. ~~Which integration tests are "tasked for porting"?~~ **Resolved: all of `integration_tests/`** is in scope for porting to `dev-tests/`.
2. ~~DigitalOcean target shape for relay.~~ **Resolved: DigitalOcean App Platform**, deploying the existing `relay/Dockerfile` directly (App Platform builds and runs Dockerfile-based services natively, including long-running processes and WebSockets — relay's `ws` dependency is supported). Chosen over a Droplet + docker-compose on cost/simplicity grounds: a small App Platform service (~$5/mo shared CPU) is priced comparably to the smallest usable Droplet (~$4–12/mo), but App Platform removes all host/OS management, patching, and manual SSH-deploy scripting — a real simplicity win at effectively no cost premium. [DigitalOcean App Platform pricing](https://www.digitalocean.com/pricing/app-platform), [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing). Managed Redis (DO Managed Databases for Redis) replaces a self-hosted Redis container to avoid re-introducing host management through the back door — priced separately, confirm in Phase 1.3.
   The relay deploy script is still built as a thin wrapper around the same `relay/Dockerfile` used today, with the actual platform call (`doctl apps create-deployment` vs. `ssh` + `docker-compose up`) isolated in one clearly-marked function/section — so a future service that's a worse App Platform fit (e.g. something needing a stateful local volume, multiple bound ports, or non-HTTP protocols App Platform doesn't support) can be pointed at a Droplet instead by swapping that one section, without touching the Dockerfile or the rest of the deploy pipeline.
3. **Where do env vars/secrets live?** For GitHub Actions: repository/environment secrets (`dev` and `prod` GitHub Environments), consistent with how `wallet-service-ci.yml`/`relay-deploy.yml` already use `secrets.*` and `environment: production`. For local dev/testing: per-package `.env.example` files (gitignored `.env` for the real values) — need to confirm this matches how `press`/`wallet-service` already do local dev (they already have `.env` patterns implied by `WEBCRYPTO_MASTER_KEY` etc. in CI). This plan assumes GitHub Environments named `dev` and `prod` should be created if they don't exist.
4. **npm dist-tags for dev vs prod.** Assumption: dev deploys publish under an npm dist-tag like `next` or `dev`, prod publishes to `latest`, mirroring `publish-verifier.yml`'s tag-triggered flow but adding a lower-stakes dev channel. Confirm this is acceptable before Phase 2 — publishing to the real npm registry from an automated dev pipeline (even under a dist-tag) is a step up in blast radius from what exists today (verifier publish is currently manual, tag-triggered).
5. **DigitalOcean secret storage mechanism.** `doctl` App Platform supports encrypted env vars set via its own API/UI or via the app spec — need to confirm whether GitHub Actions should push secrets into the DO app spec at deploy time (via `doctl`) or whether they should be configured once, out-of-band, directly in the DO dashboard and simply referenced. Recommend the latter for actual secrets (API keys, private keys) and the former only for non-secret config, to avoid secrets transiting CI logs — confirm before Phase 2.
