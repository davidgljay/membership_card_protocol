#!/usr/bin/env bash
# Single entry point for dev-tests -- runs every suite (or one, via
# --suite) against whatever live dev deployment dev-tests/.env points at.
#
# Unlike integration_tests/run.sh, this script does not bring up or tear
# down any infrastructure -- there is no local stack. It assumes
# scripts/deploy-all.sh dev has already deployed the environment .env
# points at, and that dev governance has already been provisioned
# out-of-band (see README.md).
#
# Flags:
#   --suite <name>   run only one suite file, e.g. `core/card_signing` or
#                    `extended/oblivious_transport` (path relative to
#                    suites/, .spec.ts optional).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

SUITE_FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --suite)
      SUITE_FILTER="${2:?--suite requires a suite name}"
      shift 2
      ;;
    *)
      echo "run.sh: unknown argument '$1'" >&2
      echo "usage: run.sh [--suite <name>]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "::error::dev-tests/.env not found. Copy .env.example to .env and fill in every value first (see README.md)." >&2
  exit 1
fi

set -a
source .env
set +a

REQUIRED_VARS=(
  DEV_PRESS_URL
  DEV_WALLET_SERVICE_URL
  DEV_RELAY_URL
  DEV_ARBITRUM_RPC_URL
  DEV_REGISTRY_CONTRACT_ADDRESS
  DEV_TESTS_POLICY_ID
  DEV_TESTS_POLICY_ADDRESS
)
missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done
if [[ ${#missing[@]} -ne 0 ]]; then
  echo "::error::Missing required var(s) in dev-tests/.env:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  echo "See README.md and .env.example." >&2
  exit 1
fi

npm install

if [[ -n "$SUITE_FILTER" ]]; then
  suite_path="suites/$SUITE_FILTER"
  [[ "$suite_path" == *.spec.ts ]] || suite_path="${suite_path}.spec.ts"
  npx vitest run "$suite_path"
else
  npm test
fi
