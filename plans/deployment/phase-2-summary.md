# Phase 2 Summary — Master deployment script

Strategic plan: [strategic-plan.md](./strategic-plan.md) · Implementation plan: [implementation-plan.md](./implementation-plan.md) · Previous: [phase-1-summary.md](./phase-1-summary.md)

## What shipped

`scripts/deploy-all.sh <dev|prod> [--dry-run]` — calls, in order: `verifier`
→ `verifier-ipfs-provider` → `verifier-rpc-provider` → `app-sdk` →
`sdk-providers-web` → `sdk-providers-rn` → `wallet-sdk` (all publishes) →
`press` → `wallet-service` → `relay` (all deploys). Each step's failure
halts the script immediately (`run_step` checks the exit code explicitly
and `exit 1`s with the failing step's name; no partial-deploy-and-continue).

A contracts tripwire runs before any step: it locates the `STEP_LIST_START`/
`STEP_LIST_END` markers in the script itself and greps only that block (not
the explanatory comments around it) for the word "contracts", failing loudly
if found. Verified live: temporarily inserted a fake `run_step "deploy
contracts" ...` line inside the markers and confirmed the script refused to
run with a clear error before restoring the file.

`--dry-run` forwards to the seven npm publish steps only (press/wallet-service/
relay's `deploy.sh` scripts have no dry-run mode).

## Verification performed (no real infrastructure touched)

- Argument validation: no args, and an invalid environment name, both fail
  with the usage message.
- Tripwire: confirmed it blocks a deliberately-inserted fake contracts step
  (above), then confirmed the real script has no tripped state.
- Halt-on-first-failure: ran `deploy-all.sh dev` with no `NODE_AUTH_TOKEN`
  set — halted immediately at "publish verifier" with a clear error,
  touching nothing further.
- Halt-mid-sequence (not just at step 1): ran with `--dry-run` and a fake
  `NODE_AUTH_TOKEN`. The first three publish steps (verifier,
  verifier-ipfs-provider, verifier-rpc-provider) succeeded in dry-run mode;
  the fourth (`app-sdk`) correctly failed and halted, since dry-run doesn't
  actually publish anything to the real registry for the dependency-order
  check (`npm view @membership-card-protocol/verifier@next`) to resolve
  against — this is expected/correct behavior given no real publish
  happened, and confirms the halt logic fires correctly beyond just the
  first step.
- doctl failure propagation: ran `relay/scripts/deploy.sh dev` with an
  invalid `DIGITALOCEAN_ACCESS_TOKEN` — failed immediately via `set -e` at
  `doctl auth init`, before reaching the `doctl apps list | awk` pipeline
  that a swallowed exit code there could have masked.
- Log review for swallowed exit codes: checked every called script
  (`press`, `wallet-service`, `relay` `deploy.sh`; `publish-npm-package.sh`)
  for `|| true`-style patterns or unchecked pipelines. All `missing=()`
  arrays are always guarded by a length check (`${#missing[@]} -ne 0`)
  before expansion, so no bash-version-dependent empty-array issue there.

## Bug found and fixed during this work

**Empty-array expansion under `set -u` crashes on bash 3.2** (macOS's
default `/bin/bash`, still shipped as of this writing): the first draft of
`deploy-all.sh` built a `PUBLISH_EXTRA_ARGS=()` array and conditionally
populated it with `--dry-run`, then expanded it as
`"${PUBLISH_EXTRA_ARGS[@]}"` at each publish call site. Under `set -u`,
expanding an empty array this way throws `unbound variable` on bash 3.2 (a
long-standing, well-known bash quirk fixed only in bash 4.4+) — every
publish step failed with a shell error having nothing to do with the actual
deploy logic. Fixed by replacing the array with a `publish_step()` wrapper
function that appends `--dry-run` via an `if`/`else` branch instead of array
expansion, avoiding the construct entirely. Confirmed fixed by re-running
`deploy-all.sh dev` locally (bash 3.2) after the change.

## Outstanding items before Phase 3

- A full real `deploy-all.sh dev` run against live dev infrastructure still
  needs to happen at least once to satisfy Phase 2's literal "Done when"
  criteria — this phase only verified orchestration logic (ordering,
  halting, tripwire) without real credentials/infrastructure, per the
  standing clarification checkpoint.
- Everything flagged as outstanding in `phase-1-summary.md` (relay's SQLite
  persistence gap on App Platform in particular) still applies before a real
  prod `deploy-all.sh prod` run.
