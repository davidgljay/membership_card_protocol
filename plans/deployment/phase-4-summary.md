# Phase 4 Summary — CI/CD pipeline

Strategic plan: [strategic-plan.md](./strategic-plan.md) · Implementation plan: [implementation-plan.md](./implementation-plan.md) · Previous: [phase-3-summary.md](./phase-3-summary.md)

**Status: pipeline mechanics fully proven end-to-end against real
infrastructure.** `.github/workflows/deploy-pipeline.yml` runs `test` →
`deploy-dev` → `dev-tests` on every push to `main`, and `Deploy (dev)` has
gone green repeatedly and reliably — every package publish, every service
deploy (press, wallet-service, relay/Droplet), confirmed live. `dev-tests`
itself has climbed from every test failing (pure pipeline/config bugs) to
**191 of 242 tests passing**, with the remaining 3 failures currently
attributed to real Arbitrum Sepolia confirmation-latency variance under
this session's own unusually heavy same-day testnet load, not a code bug
— under active investigation (see "Open items" below). `deploy-prod`
remains deliberately gated behind the Phase 4 clarification checkpoint
(prod GitHub Environment doesn't exist yet; no real prod infrastructure
exists yet for wallet-service, relay, or contracts — see
`relay/DEPLOYMENT.md` and this doc's "What's deliberately not done" below).

This phase took far longer than Phases 1-3 combined, almost entirely
because it was the first phase to actually *run* the full chain against
real infrastructure end-to-end, over and over, rather than being verified
piecewise. Nearly every bug below was invisible until a real push actually
exercised it — the recurring lesson of this whole session, stated once
here rather than after each entry: **trust a real CI run over "should
work," every time.**

## What shipped

- **`.github/workflows/deploy-pipeline.yml`**: `test` (reuses
  `integration-tests.yml`) → `deploy-dev` (`environment: dev`, runs
  `scripts/deploy-all.sh dev`) → `dev-tests` (materializes
  `dev-tests/.env` from the `dev` GitHub Environment's secrets/vars, runs
  `dev-tests/run.sh`) → `deploy-prod` (wired identically to `deploy-dev`
  but targets a `prod` GitHub Environment that doesn't exist yet —
  fully built, deliberately not live).
- **`.github/workflows/relay-deploy.yml` deleted** — superseded, already
  disabled, targeted a defunct Cloudflare-based relay implementation.
- **`relay/scripts/deploy.sh` rewritten** for SSH-based Droplet deployment
  (`git pull && docker compose ... up -d --build`), replacing the old
  App Platform path (kept as a documented fallback via
  `RELAY_DEPLOY_TARGET=app_platform`).
- **`scripts/deploy-all.sh`**: service-scoping fix so press's and
  wallet-service's both-named-`REGISTRY_CONTRACT_ADDRESS`-but-different-
  contracts env var doesn't collide when both are deployed in the same
  process.
- **`scripts/publish-npm-package.sh`**: skip-if-unchanged for dev
  publishes — diffs each package's directory (and any `file:`-linked
  in-repo dependency) against the commit its last-published dev version
  was built from; skips test/version-bump/publish when nothing changed,
  but always still installs+builds so any in-repo `file:` consumer in the
  same run still resolves real `dist/` output (see "Bugs found and fixed"
  below — this one shipped with a same-day regression).
- **`wallet-service-ci.yml`** stopped double-running the full
  `integration-tests.yml` suite (it and `deploy-pipeline.yml` were both
  independently gating on it, once each, on every push touching
  `wallet-service/`) — now runs its own fast lint/typecheck/test/build
  directly with no redundant re-gate.
- **`dev-tests/reports/2026-08-10-ohttp-intermittent-key-length.md`**: a
  rare, not-yet-reproduced-in-isolation intermittent 500 on press's OHTTP
  gateway, logged with investigation notes and fix hypotheses for next
  time it recurs.

## Bugs found and fixed (all confirmed live against real CI, not local-only)

Roughly in the order they were found — each one only surfaced by an actual
push actually reaching that stage:

1. **npm Trusted Publishing, three-part chain**: missing `registry-url` on
   `actions/setup-node` → missing `id-token: write` permission → npm CLI
   10.9.8 (the `node:22` runner image's bundled version) doesn't know how
   to request an OIDC token at all, silently publishing unauthenticated
   and getting a misleading `E404` instead of a clear auth error. Fixed
   by adding `npm install -g npm@latest` before every publish step
   (Trusted Publishing needs npm ≥ 11.5.1).
2. **`press`/`wallet-service` deploy scripts never installed dependencies**
   before `npx nitro build` — `nitro.config.ts` imports `nitropack`
   directly, and without a local install `npx` silently substitutes an
   unrelated public `nitro` package instead, which fails on that import.
3. **Skip-if-unchanged's own regression**: the first version skipped the
   *entire* publish cycle — including the build — for unchanged packages,
   but other packages in the same run resolve `file:` dependencies
   straight to that package's own `dist/` on disk in the same checkout.
   Fixed to always install+build; only test/version-bump/publish are
   skipped.
4. **`DATABASE_URL` secret contained literal wrapping quotes** (and
   possibly a `DATABASE_URL=` prefix) — `pg-connection-string`'s non-URL
   DSN fallback parser mangled it into host `"base"`, reproduced exactly
   locally. Re-saved as a bare connection string.
5. **7 GitHub Environment variables had the same wrapping-quotes bug**
   (`ARBITRUM_RPC_URL`, `DEV_RELAY_URL`, `DEV_WALLET_SERVICE_URL`,
   `PRESS_CARD_CID`, `PRESS_POLICY_CIDS`,
   `REGISTRY_CONTRACT_ADDRESS_LOGIC`, `REGISTRY_CONTRACT_ADDRESS_STORAGE`)
   — `ARBITRUM_RPC_URL`'s specifically left press permanently returning
   503 "Press is initializing" (viem rejected the quoted URL). Fixed via
   `gh api` (these are plain variables, not secrets, so values were
   already readable).
6. **`DATABASE_URL` pointed at Neon's pooled (`-pooler`) endpoint** —
   `node-pg-migrate`'s session-level advisory lock and multi-statement DDL
   don't survive PgBouncer transaction-mode pooling, the same class of bug
   already documented for Synapse in Phase 3. Switched to the direct
   endpoint (pooled remains correct for the deployed Worker's own runtime
   `pg.Pool`, a separate concern).
7. **Droplet's git/TLS trust store broken** — `deploy relay`'s `git pull`
   step failed with `server certificate verification failed: CAfile: none`.
   Infrastructure-level (broken CA bundle or bad system clock on the
   Droplet), not code; fixed by David directly on the Droplet (reboot +
   cert refresh), confirmed via a manual `git pull` + full `docker compose
   up --build` before retriggering CI.
8. **`wallet-service-ci.yml`'s typecheck had been broken on every single
   run since at least 2026-07-18** (confirmed via run history) — masked
   from attention the whole time by always running behind the (since
   removed) redundant `integration-tests` gate. Two gaps: `wallet-service`
   depends on `verifier` via a `file:` link that was never built in this
   job, and `npx nitro prepare` (generates the `.nitro/types/` tsconfig
   `wallet-service`'s own `tsconfig.json` extends) was never run before
   typecheck — the same fix Phase 3 already applied to
   `integration_tests/run.sh`, never ported to this separate workflow.
9. **Filebase (press's IPFS pinning backend) returning `403`** on
   uploads — its free-tier pin-count limit, exhausted by this session's
   own cumulative same-day testing volume across dozens of CI/local runs.
   Not a code bug; resolved by upgrading to a paid Filebase plan.
10. **Nine distinct missing-or-insufficient test timeout gaps**, all the
    same underlying shape: an `it()`/`beforeAll()` doing a real on-chain
    write, IPFS operation, or subprocess spawn with no explicit timeout
    (defaulting to vitest's 5000ms) or one too tight for the operation's
    own internal timeout (e.g. `submitGovernanceTx`'s 120s
    `waitForTransactionReceipt`). Found and fixed one at a time as each
    became the next real CI failure, across `dns_governance_verifier.spec.ts`,
    `card_offering_and_acceptance.spec.ts`, `subcard_creation_policy.spec.ts`,
    every `mintLiveCard`-calling `beforeAll` across five more `dev-tests`
    files, `card_migration.spec.ts`'s two "Step 5" tests, and finally
    `integration_tests/suites/conformance/matrix_encryption.spec.ts`'s
    three Python-cross-parity tests (a `child_process.execSync` subprocess
    spawn, not on-chain at all, but the identical missing-timeout shape —
    this one failed `test / integration` itself, before `Deploy (dev)`
    could even start).

## Open items

- ~~5 `dev-tests` failures~~ **Resolved 2026-08-11.** Root cause wasn't
  chain-confirmation flakiness — it was `press/src/chain/registry.ts`'s
  `getCardEventLog`, which does an unbounded `eth_getLogs({fromBlock: 0n,
  toBlock: 'latest'})` scan. `ee406334`'s switch of `ARBITRUM_RPC_URL` to
  an Alchemy-backed endpoint (fixing a real, different problem — see that
  commit) introduced a regression here: Alchemy's free tier hard-caps
  `eth_getLogs` to a 10-block range and rejects the call outright, which
  surfaced as an unhandled 500 from press wherever `ctx.verifier.verifyCard()`
  runs a chain walk (`subcard_creation_policy.spec.ts`'s Mechanisms 1/2,
  and `card_validation.spec.ts`'s `beforeAll`, whose 120s hook timeout was
  actually eaten by retries against this broken call, not the double
  mint). Chunking to fit the 10-block cap isn't viable here — the registry
  contract is ~1M+ blocks of Arbitrum Sepolia history a few days after
  deploy (~0.25s block time), so a full scan would be 100k+ chunked calls.
  Fixed by giving `getCardEventLog` its own `publicClient` on viem's
  built-in public Sepolia RPC (`http()` with no URL override — confirmed
  live to have no range cap), leaving `ARBITRUM_RPC_URL`/Alchemy in place
  for the write/confirmation traffic it was actually meant to fix. Verified
  live against `press-dev` after redeploy. Separately, `card_updates.spec.ts`
  and `card_validation.spec.ts`'s double-mint `beforeAll` hooks were still
  at the single-mint 120s convention (bumped to 180s, matching
  `card_signing.spec.ts`/`card_offering_and_acceptance.spec.ts`), and
  `log_auditing.spec.ts`'s four tests — each running a full
  `registerAndAuthorizeDevPolicy` (up to two on-chain governance txs, each
  internally capped at 120s) plus a full issue/finalize — were bumped from
  120s to 300s. Full suite now passes 23/23 files, 194/242 tests (48
  `it.todo`), in 446s (down from 1112s — the broken chain-walk retries were
  adding real overhead across the whole run, not just the failing tests).
- **Rare intermittent OHTTP gateway 500** ("Invalid length of the key"),
  observed once, not reproducible in isolation — logged with hypotheses in
  `dev-tests/reports/2026-08-10-ohttp-intermittent-key-length.md`.
- **`dns.relay.membershipcard.io` Droplet split**: discussed splitting dev
  and prod onto separate Droplets (would also allow downsizing the dev
  Droplet from 2GB to 1GB — confirmed safe via 6 hours of real observed
  peak usage never exceeding 33% memory / 45% CPU). Turned out to already
  be most of the way there: no `prod` GitHub Environment exists yet, so
  there's no live prod Droplet to migrate away from at all. Remaining
  action (David, DigitalOcean dashboard access required): resize the
  current Droplet to 1GB now; provision a genuinely separate Droplet + the
  `prod` GitHub Environment only when prod actually launches.

## What's deliberately not done

Per this phase's own clarification checkpoint and Phase 4's plan
entry: `deploy-prod` is fully wired (identical structure to `deploy-dev`,
targeting a `prod` GitHub Environment) but not live — that environment
doesn't exist yet, and per `deploy-pipeline.yml`'s own header comment,
wallet-service's prod deployment is explicitly blocked pending CP-3's
independent security review, with no mainnet contracts and no prod
Droplet tier brought up either. This is expected, not a bug — per the
checkpoint, going live with prod auto-deploy needs an explicit walkthrough
and decision on required-reviewers gating before it's turned on for real.
