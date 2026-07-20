# Integration Tests

Deployment-faithful integration environment for the card protocol. A single
`docker compose up` brings up every core object — press and wallet-service
under workerd/wrangler (matching their Cloudflare deployment), relay and
Matrix (Synapse + policy module) as containers, and web/RN SDK harnesses —
so cross-component integration failures surface here instead of in
production.

**Chain component:** the stack points at the existing Arbitrum Sepolia
deployment (`contracts/deployments/sepolia.json`), not a local devnode.
Deploying fresh contracts onto a local Nitro devnode works, but calling
deployed Stylus contracts on it doesn't yet (a genuine WASM-execution issue,
unrelated to the protocol contracts themselves) — see
[`reports/phase-1-environment-notes.md`](reports/phase-1-environment-notes.md).
That path is kept, not deleted, behind the `local-chain` Compose profile:
`docker compose --profile local-chain up nitro-devnode deploy-contracts`.

See the strategic and implementation plans for the full rationale and phased
rollout:

- [`plans/integration-testing-strategic-plan.md`](../plans/integration-testing-strategic-plan.md)
- [`plans/integration-testing-implementation-plan.md`](../plans/integration-testing-implementation-plan.md)

## Layout

```
integration_tests/
  docker-compose.yml   # the full stack
  stack-ready.sh        # polls an already-running stack's healthchecks until ready
  run.sh                # single entry point: unit tests + stack + integration suites
  env/                   # per-service Dockerfiles, wrangler configs, bootstrap scripts
  fixtures/               # shared keys, cards, test vectors (reused from existing suites)
  suites/
    core/                 # Wave 1: card lifecycle
    matrix-relay/         # Wave 2: matrix + relay flows
    extended/              # Wave 3: remaining process specs
    conformance/           # object-spec conformance checks
  harnesses/
    web/                    # Playwright container driving the web SDK
    rn/                      # jest + react-native preset container
  reports/                    # dated defect reports from each wave's first run
```

## Status

Environment (Phase 1) is under construction — see
`plans/milestones/integration-phase-1.md` once it exists for a status
summary. The default stack itself (`docker compose up --wait` — ipfs,
redis, relay, synapse, press, wallet-service and their Postgres/migration
containers) comes up healthy and repeatably from a clean state in ~30s; what's
still missing before this directory is runnable end-to-end is `run.sh` and
the `suites/`/`harnesses/` themselves (Phase 2).

## Running (once complete)

```sh
cd integration_tests
./run.sh              # unit tests + full stack + integration suites
./run.sh --unit-only
./run.sh --integration-only
./run.sh --suite core/card_signing
```
