#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Card Protocol Registry — Deployment Script
#
# Deploys all three contracts in order:
#   1. verifier-module (pure computation, no state)
#   2. storage-contract (immutable-address, all state)
#   3. logic-contract (upgradeable write operations)
#
# Then wires them together via initialize() calls.
#
# Usage:
#   export ARBITRUM_SEPOLIA_RPC=https://...
#   export PRIVATE_KEY=0x...    # or use --ledger flag
#   ./scripts/deploy.sh sepolia
#   ./scripts/deploy.sh mainnet
#
# Prerequisites:
#   cargo install cargo-stylus
#   forge installed (for cast send wiring calls)
#
# Deployment approach (resolves chicken-and-egg address dependency):
#   The storage contract needs the logic contract's address in its constructor,
#   but the logic contract needs the storage contract's address. We resolve this
#   with a two-step approach:
#   1. Deploy storage with a placeholder address (deployer EOA).
#   2. Deploy logic with the real storage address.
#   3. Call storage.initialize(logic_address, deployer_pubkey) to wire them up.
#   4. Call logic.initialize(storage_address, verifier_address) to complete wiring.
#
# All deployed addresses are saved to deployments/<network>.json.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

NETWORK=${1:-sepolia}
CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENTS_DIR="$CONTRACTS_DIR/deployments"

case "$NETWORK" in
  sepolia)
    RPC_URL="${ARBITRUM_SEPOLIA_RPC:-}"
    if [[ -z "$RPC_URL" ]]; then
      echo "ERROR: ARBITRUM_SEPOLIA_RPC not set"
      exit 1
    fi
    ;;
  mainnet)
    RPC_URL="${ARBITRUM_MAINNET_RPC:-}"
    if [[ -z "$RPC_URL" ]]; then
      echo "ERROR: ARBITRUM_MAINNET_RPC not set"
      exit 1
    fi
    echo "WARNING: Deploying to MAINNET. Are you sure? (Ctrl+C to abort, Enter to continue)"
    read -r
    ;;
  *)
    echo "ERROR: Unknown network '$NETWORK'. Use 'sepolia' or 'mainnet'."
    exit 1
    ;;
esac

# Require private key
PRIV_KEY="${PRIVATE_KEY:-}"
if [[ -z "$PRIV_KEY" ]]; then
  echo "ERROR: PRIVATE_KEY not set. Export it before running this script."
  exit 1
fi

echo "=== Card Protocol Registry Deployment ==="
echo "Network: $NETWORK"
echo "RPC:     $RPC_URL"
echo ""

# ─── Build all WASM contracts (release profile) ───────────────────────────────
echo "[1/7] Building contracts..."
cd "$CONTRACTS_DIR"
cargo build --release --target wasm32-unknown-unknown
echo "  Build complete."

# ─── Check contracts with cargo stylus ────────────────────────────────────────
echo "[2/7] Checking contracts with cargo-stylus..."

(cd "$CONTRACTS_DIR/verifier-module" && cargo stylus check --endpoint "$RPC_URL")
echo "  verifier-module: OK"

(cd "$CONTRACTS_DIR/storage-contract" && cargo stylus check --endpoint "$RPC_URL")
echo "  storage-contract: OK"

(cd "$CONTRACTS_DIR/logic-contract" && cargo stylus check --endpoint "$RPC_URL")
echo "  logic-contract: OK"

# ─── Deploy verifier module ───────────────────────────────────────────────────
echo "[3/7] Deploying verifier-module..."

VERIFIER_DEPLOY_OUTPUT=$(
  cd "$CONTRACTS_DIR/verifier-module" && cargo stylus deploy \
    --endpoint "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    --no-verify \
    --max-fee-per-gas-gwei 0.1 \
    2>&1
)
echo "$VERIFIER_DEPLOY_OUTPUT"
VERIFIER_ADDRESS=$(echo "$VERIFIER_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
echo "  verifier-module deployed at: $VERIFIER_ADDRESS"

# ─── Deploy storage contract ──────────────────────────────────────────────────
echo "[4/7] Deploying storage-contract..."

STORAGE_DEPLOY_OUTPUT=$(
  cd "$CONTRACTS_DIR/storage-contract" && cargo stylus deploy \
    --endpoint "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    --no-verify \
    --max-fee-per-gas-gwei 0.1 \
    2>&1
)
echo "$STORAGE_DEPLOY_OUTPUT"
STORAGE_ADDRESS=$(echo "$STORAGE_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
echo "  storage-contract deployed at: $STORAGE_ADDRESS"

# ─── Deploy logic contract ────────────────────────────────────────────────────
echo "[5/7] Deploying logic-contract..."

LOGIC_DEPLOY_OUTPUT=$(
  cd "$CONTRACTS_DIR/logic-contract" && cargo stylus deploy \
    --endpoint "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    --no-verify \
    --max-fee-per-gas-gwei 0.1 \
    2>&1
)
echo "$LOGIC_DEPLOY_OUTPUT"
LOGIC_ADDRESS=$(echo "$LOGIC_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
echo "  logic-contract deployed at: $LOGIC_ADDRESS"

# ─── Wire contracts together ──────────────────────────────────────────────────
echo "[6/7] Wiring contracts..."

# The deployer public key must be 64 bytes (x||y secp256r1).
DEPLOYER_PUBKEY="${DEPLOYER_SECP256R1_PUBKEY:-}"
if [[ -z "$DEPLOYER_PUBKEY" ]]; then
  echo "  WARNING: DEPLOYER_SECP256R1_PUBKEY not set."
  echo "  You must call storage.initialize(logic_address, deployer_pubkey) manually."
  echo "  See deployments/README.md for the initialization procedure."
else
  echo "  Calling storage.initialize($LOGIC_ADDRESS, $DEPLOYER_PUBKEY)..."
  cast send "$STORAGE_ADDRESS" \
    "initialize(address,bytes)" \
    "$LOGIC_ADDRESS" \
    "$DEPLOYER_PUBKEY" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    2>&1

  echo "  Calling logic.initialize($STORAGE_ADDRESS, $VERIFIER_ADDRESS)..."
  cast send "$LOGIC_ADDRESS" \
    "initialize(address,address)" \
    "$STORAGE_ADDRESS" \
    "$VERIFIER_ADDRESS" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    2>&1
fi

# ─── Save deployment record ───────────────────────────────────────────────────
echo "[7/7] Saving deployment record..."

mkdir -p "$DEPLOYMENTS_DIR"
DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/${NETWORK}.json"

cat > "$DEPLOYMENT_FILE" <<EOF
{
  "network": "$NETWORK",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "rpc_url": "$RPC_URL",
  "contracts": {
    "verifier_module": "$VERIFIER_ADDRESS",
    "storage_contract": "$STORAGE_ADDRESS",
    "logic_contract": "$LOGIC_ADDRESS"
  },
  "notes": "storage_contract is the stable protocol identifier — never redeployed."
}
EOF

echo "  Saved to $DEPLOYMENT_FILE"

echo ""
echo "=== Deployment Complete ==="
echo "verifier-module:  $VERIFIER_ADDRESS"
echo "storage-contract: $STORAGE_ADDRESS  ← stable protocol identifier"
echo "logic-contract:   $LOGIC_ADDRESS"
echo ""
echo "NEXT STEPS:"
echo "1. Call storage.initialize($LOGIC_ADDRESS, <deployer_pubkey>) if not done."
echo "2. Call logic.initialize($STORAGE_ADDRESS, $VERIFIER_ADDRESS) if not done."
echo "3. Run bootstrap sequence: RegisterPolicy → AuthorizePress."
echo "4. Call RotateGovernanceKeys to expand from 1-of-1 as soon as governance"
echo "   members are available. The 1-of-1 bootstrap is a single point of failure."
echo "5. Record all transaction hashes in deployments/${NETWORK}-bootstrap.md."
