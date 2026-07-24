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

  step "contracts: cargo test --workspace" \
    bash -c "cd '$ROOT/contracts' && cargo test --workspace"

  step "press: npm test" \
    bash -c "cd '$ROOT/press' && npm ci && npm run typecheck && npm test"

  step "wallet-service: npm test" \
    bash -c "cd '$ROOT/wallet-service' && npm ci && npm run typecheck && npm test"

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
