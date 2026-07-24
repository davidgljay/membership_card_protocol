# Integration Tests

Deployment-faithful integration environment for the card protocol. A single
`docker compose up` brings up every core object — press and wallet-service
under workerd/wrangler (matching their Cloudflare deployment), relay and
Matrix (Synapse + policy module) as containers, IPFS, and a local
Stylus-capable chain — so cross-component integration failures surface here
instead of in production.

**Chain component:** the default stack runs against a local `nitro-devnode`
(`--dev` mode), redeployed fresh on every `docker compose up` via the
`deploy-contracts` one-shot service — not the Sepolia deployment. An earlier
investigation found every Stylus call reverting against the local devnode
and concluded it couldn't run deployed Stylus contracts at all; that turned
out to be a false negative (the sanity check itself used the wrong ABI
encoding — see `docker-compose.yml`'s own top-of-file note and
[`reports/phase-1-environment-notes.md`](reports/phase-1-environment-notes.md)
for the full history). Calling deployed contracts on the local devnode works
correctly once the ABI is encoded per Stylus SDK 0.8's actual convention
(camelCase dispatch, `uint8[]` for `Vec<u8>`).

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

All six implementation phases are complete — see `plans/milestones/
integration-phase-{1..6}.md` for each phase's own review. Every process spec
in `specs/process_specs/` and every object spec in `specs/object_specs/` has
either a dedicated suite or is covered as a real dependency of one (see
`suites/README.md`'s object-spec coverage map); `run.sh` is CI-gating every
deploy path (below).

## Running locally

```sh
cd integration_tests
./run.sh              # unit tests + full stack + integration suites + harnesses
./run.sh --unit-only          # every component's own unit tests only, no stack
./run.sh --integration-only   # skip unit tests, bring up the stack and run everything else
./run.sh --suite core/card_signing   # one suite file only (implies --integration-only)
```

`run.sh` installs its own dependencies at each step (`npm ci`/`pnpm
install`/`pip install`/`cargo`), so it works the same from a clean checkout
as on a dev machine with `node_modules`/`.venv`/`target` already present —
a clean checkout just costs more wall time. It always tears the stack down
(`docker compose down -v`) on exit, including on failure or interruption.

If you already have the stack running (e.g. via `docker compose up -d
--wait` yourself, for iterating on a suite) and don't want `run.sh` to bring
it down between runs, run suites directly instead:

```sh
cd integration_tests/suites
npm test                          # every suite
npx vitest run core/card_signing.spec.ts   # one file
```

## CI

[`../.github/workflows/integration-tests.yml`](../.github/workflows/integration-tests.yml)
runs `run.sh` on every pull request, and is invoked as a reusable workflow
(`workflow_call`) by the deploy-adjacent workflows so a red suite blocks the
deploy rather than just failing a check no one is required to look at:
[`relay-deploy.yml`](../.github/workflows/relay-deploy.yml),
[`wallet-service-ci.yml`](../.github/workflows/wallet-service-ci.yml),
[`client-sdk-ci.yml`](../.github/workflows/client-sdk-ci.yml), and
[`publish-verifier.yml`](../.github/workflows/publish-verifier.yml) each add
an `integration-tests` job that calls the reusable workflow, with their own
deploy/publish job listing it in `needs:`. See
[`plans/milestones/integration-phase-6.md`](../plans/milestones/integration-phase-6.md)
for how this was verified (a deliberately broken unit test and a
deliberately broken integration test were each confirmed to make `run.sh`
exit non-zero, then reverted).
