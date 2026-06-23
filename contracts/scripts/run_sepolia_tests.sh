#!/usr/bin/env bash
# run_sepolia_tests.sh — Run SepoliaIntegration fork tests against Arbitrum Sepolia.
#
# Fetches the current block number and pins the fork 100 blocks behind to avoid
# Arbitrum's "metadata not found" RPC error on the very latest blocks.
#
# Usage:
#   source contracts/.env
#   ./contracts/scripts/run_sepolia_tests.sh [forge test flags...]
#
# Examples:
#   ./contracts/scripts/run_sepolia_tests.sh -v
#   ./contracts/scripts/run_sepolia_tests.sh -vvv --match-test test_contracts_deployed

set -euo pipefail

# Add common tool locations to PATH if not already present.
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$(cd "$SCRIPT_DIR/../tests" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"

# Source .env if the variable isn't already in the environment.
if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" && -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" ]]; then
  echo "ERROR: ARBITRUM_SEPOLIA_RPC not set and $ENV_FILE not found." >&2
  exit 1
fi

LATEST=$(cast block-number --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
FORK_BLOCK=$((LATEST - 100))
echo "Chain tip: $LATEST  →  fork block: $FORK_BLOCK"

cd "$TESTS_DIR"
FOUNDRY_PROFILE=arbitrum_sepolia forge test \
  --fork-url "$ARBITRUM_SEPOLIA_RPC" \
  --fork-block-number "$FORK_BLOCK" \
  --match-contract SepoliaIntegrationTest \
  "$@"
