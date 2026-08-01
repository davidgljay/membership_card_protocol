#!/usr/bin/env bash
# Master deployment script -- publishes every in-scope npm package and
# deploys every in-scope service, in dependency order, for a given
# environment. Each step's failure halts the script immediately; there is
# no partial-deploy-and-continue.
#
# Usage: scripts/deploy-all.sh <dev|prod> [--dry-run]
#
# --dry-run is forwarded only to the npm publish steps (press/wallet-service/
# relay's deploy.sh scripts have no dry-run mode of their own).
#
# NEVER add a contracts/ step here. Contract changes go through governance
# (contracts/scripts/deploy.sh + a governance proposal), never through this
# script -- see strategic-plan.md Goal 3. This is a hard boundary enforced
# below by a tripwire, not just a convention: it greps this script's own
# step list (the block between the STEP_LIST_START/END markers, not this
# explanatory comment) for the word "contracts" and refuses to run if found,
# so an accidental future addition fails loudly instead of silently
# deploying contracts from CI.
set -euo pipefail

ENVIRONMENT="${1:-}"
if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <dev|prod> [--dry-run]" >&2
  exit 1
fi

DRY_RUN_FLAG="${2:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Contracts tripwire (checked before any step runs) ---------------------
START_LINE="$(grep -n '^# STEP_LIST_START$' "$REPO_ROOT/scripts/deploy-all.sh" | head -1 | cut -d: -f1)"
END_LINE="$(grep -n '^# STEP_LIST_END$' "$REPO_ROOT/scripts/deploy-all.sh" | head -1 | cut -d: -f1)"
if [[ -z "$START_LINE" || -z "$END_LINE" ]]; then
  echo "::error::Could not locate STEP_LIST_START/END markers in scripts/deploy-all.sh -- the contracts tripwire cannot run, refusing to proceed." >&2
  exit 1
fi
if sed -n "${START_LINE},${END_LINE}p" "$REPO_ROOT/scripts/deploy-all.sh" | grep -qi "contracts"; then
  echo "::error::Tripwire tripped: the deploy-all.sh step list mentions 'contracts'." >&2
  echo "Contract changes go through governance (contracts/scripts/deploy.sh + a" >&2
  echo "governance proposal), never through this script. Refusing to run." >&2
  exit 1
fi
# ----------------------------------------------------------------------------

run_step() {
  local name="$1"
  shift
  echo ""
  echo "=== [$ENVIRONMENT] $name ==="
  if ! "$@"; then
    echo "" >&2
    echo "::error::Step '$name' failed. Halting deploy-all.sh -- no partial deploy-and-continue." >&2
    exit 1
  fi
}

# Thin wrapper over run_step for the npm publish scripts specifically, so
# --dry-run is appended only when requested. Deliberately not a
# conditionally-populated array (`arr=(); ... "${arr[@]}"`) -- that construct
# throws "unbound variable" under `set -u` on bash 3.2 (macOS's default
# /bin/bash) when the array is empty, a real failure hit live while testing
# this script locally.
publish_step() {
  local name="$1"
  local script_path="$2"
  shift 2
  if [[ "$DRY_RUN_FLAG" == "--dry-run" ]]; then
    run_step "$name" "$script_path" "$@" --dry-run
  else
    run_step "$name" "$script_path" "$@"
  fi
}

# STEP_LIST_START
# npm publishes, in dependency order (see app-sdk/DEPLOYMENT.md for the full
# rationale) -- verifier and verifier-ipfs-provider before app-sdk, app-sdk
# before its three dependents.
publish_step "publish verifier" \
  "$REPO_ROOT/membership_card_verifier/scripts/publish.sh" verifier "$ENVIRONMENT"
publish_step "publish verifier-ipfs-provider" \
  "$REPO_ROOT/membership_card_verifier/scripts/publish.sh" verifier-ipfs-provider "$ENVIRONMENT"
publish_step "publish verifier-rpc-provider" \
  "$REPO_ROOT/membership_card_verifier/scripts/publish.sh" verifier-rpc-provider "$ENVIRONMENT"
publish_step "publish app-sdk" \
  "$REPO_ROOT/app-sdk/scripts/publish.sh" "$ENVIRONMENT"
publish_step "publish sdk-providers-web" \
  "$REPO_ROOT/sdk-providers-web/scripts/publish.sh" "$ENVIRONMENT"
publish_step "publish sdk-providers-rn" \
  "$REPO_ROOT/sdk-providers-rn/scripts/publish.sh" "$ENVIRONMENT"
publish_step "publish wallet-sdk" \
  "$REPO_ROOT/wallet-sdk/scripts/publish.sh" "$ENVIRONMENT"

# Service deploys. No dependency between these three, order kept stable for
# readable logs.
run_step "deploy press" \
  "$REPO_ROOT/press/scripts/deploy.sh" "$ENVIRONMENT"
run_step "deploy wallet-service" \
  "$REPO_ROOT/wallet-service/scripts/deploy.sh" "$ENVIRONMENT"
run_step "deploy relay" \
  "$REPO_ROOT/relay/scripts/deploy.sh" "$ENVIRONMENT"
# STEP_LIST_END

echo ""
echo "deploy-all.sh completed successfully for $ENVIRONMENT."
