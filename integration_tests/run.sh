#!/usr/bin/env bash
# Single entry point for the integration-testing pyramid (Phase 6.1):
#   (a) every component's own unit tests
#   (b) bring the full stack up (docker compose --wait)
#   (c) every suite in suites/ + both harnesses (web/rn) smoke tests
#   (d) tear the stack down
# Exits non-zero if anything in (a) or (c) failed. Designed to run
# unattended from a clean checkout (CI) as well as interactively on a dev
# machine that already has node_modules/.venv/target present — every step
# installs its own dependencies first, so a clean checkout costs more wall
# time but not a different code path.
#
# Flags:
#   --unit-only         run (a) only, skip (b)-(d)
#   --integration-only   skip (a), run (b)-(d)
#   --suite <name>       run only one suite file within (c), e.g.
#                         `core/card_signing` or `extended/oblivious_transport`
#                         (path relative to suites/, .spec.ts optional).
#                         Implies --integration-only unless combined with
#                         no other flag alongside a full run.
#
# Known, currently-red steps NOT caused by this script: wallet-service's
# and client-sdk's own unit-test suites have pre-existing gaps unrelated
# to run.sh's own orchestration (see reports/2026-07-24-unit-test-gaps.md)
# -- expect those two steps to fail until that's separately fixed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTEGRATION_DIR="$ROOT/integration_tests"

RUN_UNIT=1
RUN_INTEGRATION=1
SUITE_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit-only)
      RUN_INTEGRATION=0
      shift
      ;;
    --integration-only)
      RUN_UNIT=0
      shift
      ;;
    --suite)
      SUITE_FILTER="${2:?--suite requires a suite name}"
      RUN_UNIT=0
      shift 2
      ;;
    *)
      echo "run.sh: unknown argument '$1'" >&2
      echo "usage: run.sh [--unit-only] [--integration-only] [--suite <name>]" >&2
      exit 2
      ;;
  esac
done

FAILURES=()

# Runs one unit-test step; records the label in FAILURES on non-zero exit
# instead of aborting immediately, so a single component's failure doesn't
# hide failures in every component after it in the same run.
step() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  if ! ( "$@" ); then
    echo "!!! FAILED: $label" >&2
    FAILURES+=("$label")
  fi
}

run_unit_tests() {
  echo ""
  echo "########## Unit tests ##########"

  # Scoped to protocol-types only, not `cargo test --workspace`: the other
  # three crates (verifier-module, storage-contract, logic-contract) depend
  # on stylus-sdk, whose host functions (account_balance, storage_load_bytes32,
  # etc.) are provided by the Stylus/WASM VM at runtime and have no native
  # implementation -- linking a native test binary for them fails with
  # "undefined symbols for architecture arm64" (confirmed live). protocol-types
  # is the only crate with no Stylus dependency and can compile+link natively
  # (0 tests exist today, but this is the correct scope for any that get
  # added). The Stylus crates are verified via the deployed-contract
  # integration suites instead, not native cargo test -- see
  # reports/phase-1-environment-notes.md.
  step "contracts: cargo test -p protocol-types" \
    bash -c "cd '$ROOT/contracts' && cargo test -p protocol-types"

  # press/wallet-service use pnpm (pnpm-lock.yaml only, no package-lock.json)
  # -- `npm ci` here would fail with EUSAGE (confirmed live).
  step "press: pnpm test" \
    bash -c "cd '$ROOT/press' && pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test"

  # wallet-service's own test suite needs a real Postgres, migrations run
  # first, and a batch of env vars (webcrypto secrets backend, WebAuthn
  # RP/origin, a dummy wallet-service signing identity, etc.) -- confirmed
  # empirically: 83 of 231 tests fail without them. Mirrors
  # .github/workflows/wallet-service-ci.yml's own job env/steps exactly
  # (values there are already committed, non-secret CI fixtures, not real
  # credentials) rather than inventing a second copy of this setup. Values
  # live in env/wallet-service/unit-test.env, not inlined here, so this
  # script doesn't carry a long secret-shaped string directly in a shell
  # command.
  step "wallet-service: pnpm test" \
    bash -c "cd '$ROOT/wallet-service' && \
      docker rm -f run-sh-wallet-service-pg >/dev/null 2>&1 || true; \
      docker run -d --rm -p 5433:5432 --name run-sh-wallet-service-pg \
        -e POSTGRES_USER=wallet_service -e POSTGRES_PASSWORD=wallet_service -e POSTGRES_DB=wallet_service \
        postgres:16 >/dev/null && \
      trap 'docker rm -f run-sh-wallet-service-pg >/dev/null 2>&1' EXIT && \
      until docker exec run-sh-wallet-service-pg pg_isready -U wallet_service >/dev/null 2>&1; do sleep 1; done && \
      set -a && source '$INTEGRATION_DIR/env/wallet-service/unit-test.env' && set +a && \
      export DATABASE_URL=postgres://wallet_service:wallet_service@localhost:5433/wallet_service && \
      pnpm install --frozen-lockfile && \
      pnpm run typecheck && \
      pnpm exec node-pg-migrate --migrations-dir server/db/migrations up --database-url-var DATABASE_URL && \
      pnpm test"

  # relay has no "typecheck" script of its own (unlike press/wallet-service)
  # -- npx tsc --noEmit here does the same check `build` (tsc) would as a
  # side effect, without writing dist/. Its own README documents that
  # `npm test` needs a real Redis reachable at REDIS_URL (default
  # localhost:6379) -- confirmed empirically (6 of 7 test files fail with
  # ECONNREFUSED/MaxRetriesPerRequestError without one) -- so a throwaway
  # container is started/stopped around just this step, independent of the
  # integration stack's own `redis` service.
  step "relay: npm test" \
    bash -c "cd '$ROOT/relay' && npm ci && npx tsc --noEmit && \
      docker rm -f run-sh-relay-redis >/dev/null 2>&1 || true; \
      docker run -d --rm -p 6379:6379 --name run-sh-relay-redis redis:7-alpine >/dev/null && \
      trap 'docker rm -f run-sh-relay-redis >/dev/null 2>&1' EXIT && \
      REDIS_URL=redis://localhost:6379 npm test"

  # --no-cache-dir on the -e install: pip's wheel cache keys on the file:
  # dependency's path, not its contents, so a stale cached wheel of
  # membership_card_verifier's `file:./../../membership_card_verifier/
  # packages/verifier-py` dependency silently shadows real local edits to
  # that package (confirmed empirically -- ImportError for a symbol added
  # after the first cached build, resolved only by --no-cache-dir).
  step "matrix-policy-module: pytest" \
    bash -c "cd '$ROOT/wallet-service/matrix-policy-module' && \
      python3 -m venv .venv >/dev/null 2>&1 || true; \
      source .venv/bin/activate && \
      pip install --quiet --upgrade pip && \
      pip install --quiet --no-cache-dir -e '.[dev]' && \
      pytest"

  # SDK workspaces share file: dependencies across separate top-level pnpm
  # workspaces (not a single pnpm-workspace), so each must be installed
  # *and built* before the next one's install can resolve real dist/
  # output — same ordering client-sdk-ci.yml already establishes for
  # membership_card_verifier -> client-sdk. Extended here to the full
  # chain: membership_card_verifier -> app-sdk -> {sdk-providers-rn,
  # sdk-providers-web} -> wallet-sdk, and membership_card_verifier ->
  # client-sdk independently.
  step "membership_card_verifier: pnpm -r test" \
    bash -c "cd '$ROOT/membership_card_verifier' && pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run test"

  step "app-sdk: pnpm -r test" \
    bash -c "cd '$ROOT/app-sdk' && pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run test"

  step "sdk-providers-web: pnpm -r test" \
    bash -c "cd '$ROOT/sdk-providers-web' && pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run test"

  step "sdk-providers-rn: pnpm -r test" \
    bash -c "cd '$ROOT/sdk-providers-rn' && pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run test"

  step "wallet-sdk: pnpm -r test" \
    bash -c "cd '$ROOT/wallet-sdk' && pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run test"

  step "client-sdk: pnpm -r test" \
    bash -c "cd '$ROOT/client-sdk' && pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run test"
}

run_integration() {
  echo ""
  echo "########## Integration stack ##########"

  cd "$INTEGRATION_DIR"

  # No --build: `up` already builds any image that doesn't exist yet (the
  # clean-checkout/CI case), and forcing a rebuild of every service on
  # every run reproduces a known Docker Desktop flake (deploy-contracts'
  # rust:1.96.0-bookworm base image intermittently hits `DeadlineExceeded`
  # under a full-stack `--build`, unrelated to this repo -- see
  # reports/phase-1-environment-notes.md). If a Dockerfile/context genuinely
  # changed, run `docker compose build <service>` yourself first.
  echo "--- docker compose up --wait ---"
  docker compose up -d --wait

  # Always torn down, even if a suite below fails or this script is
  # interrupted, so a failed CI run doesn't leave orphaned containers
  # occupying the runner's ports for the next job.
  trap 'echo "--- docker compose down ---"; docker compose down -v' EXIT

  step "stack-ready.sh" ./stack-ready.sh

  cd "$INTEGRATION_DIR/suites"
  step "suites: npm ci" npm ci
  step "suites: typecheck" npm run typecheck

  if [[ -n "$SUITE_FILTER" ]]; then
    local suite_path="$SUITE_FILTER"
    [[ "$suite_path" == *.spec.ts ]] || suite_path="${suite_path}.spec.ts"
    step "suite: $SUITE_FILTER" npx vitest run "$suite_path"
  else
    step "suites: npm test (all)" npm test

    cd "$INTEGRATION_DIR/harnesses/web"
    step "harness: web (playwright)" bash -c "npm ci && npm test"

    cd "$INTEGRATION_DIR/harnesses/rn"
    step "harness: rn (jest)" bash -c "npm ci && npm test"
  fi
}

if [[ "$RUN_UNIT" -eq 1 ]]; then
  run_unit_tests
fi

if [[ "$RUN_INTEGRATION" -eq 1 ]]; then
  run_integration
fi

echo ""
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "########## FAILED (${#FAILURES[@]}) ##########"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

echo "########## All green ##########"
exit 0
