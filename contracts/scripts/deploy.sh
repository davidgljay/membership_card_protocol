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
# All deployed addresses, tx hashes, and gas costs are saved to deployments/<network>.json.
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

# ─── Helper: extract gas cost from a transaction receipt ─────────────────────
# Prints "gas_used:gas_price_wei:cost_eth" for a given tx hash.
tx_cost() {
  local tx="$1"
  local receipt
  receipt=$(cast receipt "$tx" --rpc-url "$RPC_URL" --json 2>/dev/null)
  local gas_hex price_hex gas price cost_wei cost_eth
  gas_hex=$(echo "$receipt" | grep -o '"gasUsed":"[^"]*"' | cut -d'"' -f4)
  price_hex=$(echo "$receipt" | grep -o '"effectiveGasPrice":"[^"]*"' | cut -d'"' -f4)
  gas=$(printf '%d' "$gas_hex")
  price=$(printf '%d' "$price_hex")
  cost_wei=$(echo "$gas * $price" | bc)
  cost_eth=$(echo "scale=7; $cost_wei / 1000000000000000000" | bc)
  echo "${gas}:${price}:${cost_eth}"
}

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
VERIFIER_DEPLOY_TX=$(echo "$VERIFIER_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '1p')
VERIFIER_ACTIVATE_TX=$(echo "$VERIFIER_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '2p')
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
STORAGE_DEPLOY_TX=$(echo "$STORAGE_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '1p')
STORAGE_ACTIVATE_TX=$(echo "$STORAGE_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '2p')
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
LOGIC_DEPLOY_TX=$(echo "$LOGIC_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '1p')
LOGIC_ACTIVATE_TX=$(echo "$LOGIC_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '2p')
echo "  logic-contract deployed at: $LOGIC_ADDRESS"

# ─── Wire contracts together ──────────────────────────────────────────────────
echo "[6/7] Wiring contracts..."

INIT_STORAGE_TX=""
INIT_LOGIC_TX=""

DEPLOYER_PUBKEY="${DEPLOYER_SECP256R1_PUBKEY:-}"
if [[ -z "$DEPLOYER_PUBKEY" ]]; then
  echo "  WARNING: DEPLOYER_SECP256R1_PUBKEY not set."
  echo "  You must call storage.initialize(logic_address, deployer_pubkey) manually."
  echo "  See deployments/README.md for the initialization procedure."
else
  # Stylus SDK 0.8 maps Vec<u8> to uint8[] (not bytes) in the ABI.
  # Convert the hex pubkey to a uint8[] literal that cast can encode.
  PUBKEY_HEX="${DEPLOYER_PUBKEY#0x}"
  PUBKEY_ARRAY="["
  for ((i=0; i<${#PUBKEY_HEX}; i+=2)); do
    byte=$((16#${PUBKEY_HEX:$i:2}))
    [[ $i -eq 0 ]] && PUBKEY_ARRAY+="$byte" || PUBKEY_ARRAY+=",$byte"
  done
  PUBKEY_ARRAY+="]"

  echo "  Calling storage.initialize($LOGIC_ADDRESS, <pubkey as uint8[]>)..."
  INIT_STORAGE_OUTPUT=$(cast send "$STORAGE_ADDRESS" \
    "initialize(address,uint8[])" \
    "$LOGIC_ADDRESS" \
    "$PUBKEY_ARRAY" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    --json \
    2>&1)
  echo "$INIT_STORAGE_OUTPUT"
  INIT_STORAGE_TX=$(echo "$INIT_STORAGE_OUTPUT" | grep -o '"transactionHash":"[^"]*"' | cut -d'"' -f4)

  echo "  Calling logic.initialize($STORAGE_ADDRESS, $VERIFIER_ADDRESS)..."
  INIT_LOGIC_OUTPUT=$(cast send "$LOGIC_ADDRESS" \
    "initialize(address,address)" \
    "$STORAGE_ADDRESS" \
    "$VERIFIER_ADDRESS" \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIV_KEY" \
    --json \
    2>&1)
  echo "$INIT_LOGIC_OUTPUT"
  INIT_LOGIC_TX=$(echo "$INIT_LOGIC_OUTPUT" | grep -o '"transactionHash":"[^"]*"' | cut -d'"' -f4)
fi

# ─── Collect gas costs ────────────────────────────────────────────────────────
echo "[7/7] Collecting gas costs and saving deployment record..."

total_cost_wei=0

cost_json_for() {
  local deploy_tx="$1" activate_tx="$2"
  local d_gas d_price d_eth a_gas a_price a_eth total_eth

  IFS=':' read -r d_gas d_price d_eth <<< "$(tx_cost "$deploy_tx")"
  IFS=':' read -r a_gas a_price a_eth <<< "$(tx_cost "$activate_tx")"
  total_eth=$(echo "scale=7; $d_eth + $a_eth" | bc)

  # Accumulate total
  local d_wei a_wei
  d_wei=$(echo "$d_gas * $d_price" | bc)
  a_wei=$(echo "$a_gas * $a_price" | bc)
  total_cost_wei=$(echo "$total_cost_wei + $d_wei + $a_wei" | bc)

  echo "\"deploy_gas\": $d_gas, \"deploy_cost_eth\": \"$d_eth\", \"activate_gas\": $a_gas, \"activate_cost_eth\": \"$a_eth\", \"total_cost_eth\": \"$total_eth\""
}

wire_cost_json_for() {
  local tx="$1" label="$2"
  local gas price eth cost_wei_tx
  IFS=':' read -r gas price eth <<< "$(tx_cost "$tx")"
  cost_wei_tx=$(echo "$gas * $price" | bc)
  total_cost_wei=$(echo "$total_cost_wei + $cost_wei_tx" | bc)
  echo "\"${label}_gas\": $gas, \"${label}_cost_eth\": \"$eth\""
}

VERIFIER_COSTS=$(cost_json_for "$VERIFIER_DEPLOY_TX" "$VERIFIER_ACTIVATE_TX")
STORAGE_COSTS=$(cost_json_for "$STORAGE_DEPLOY_TX" "$STORAGE_ACTIVATE_TX")
LOGIC_COSTS=$(cost_json_for "$LOGIC_DEPLOY_TX" "$LOGIC_ACTIVATE_TX")

WIRE_COSTS='"note": "wiring skipped (DEPLOYER_SECP256R1_PUBKEY not set)"'
if [[ -n "$INIT_STORAGE_TX" && -n "$INIT_LOGIC_TX" ]]; then
  STORAGE_WIRE=$(wire_cost_json_for "$INIT_STORAGE_TX" "init_storage")
  LOGIC_WIRE=$(wire_cost_json_for "$INIT_LOGIC_TX" "init_logic")
  WIRE_COSTS="$STORAGE_WIRE, $LOGIC_WIRE"
fi

GRAND_TOTAL_ETH=$(echo "scale=7; $total_cost_wei / 1000000000000000000" | bc)

# ─── Save deployment record ───────────────────────────────────────────────────
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
  "deployment_txs": {
    "verifier_module": "$VERIFIER_DEPLOY_TX",
    "storage_contract": "$STORAGE_DEPLOY_TX",
    "logic_contract": "$LOGIC_DEPLOY_TX"
  },
  "activation_txs": {
    "verifier_module": "$VERIFIER_ACTIVATE_TX",
    "storage_contract": "$STORAGE_ACTIVATE_TX",
    "logic_contract": "$LOGIC_ACTIVATE_TX"
  },
  "wiring_txs": {
    "init_storage": "$INIT_STORAGE_TX",
    "init_logic": "$INIT_LOGIC_TX"
  },
  "gas_costs": {
    "note": "gasUsed x effectiveGasPrice for each tx. 1 ETH = 1e18 wei.",
    "verifier_module": { $VERIFIER_COSTS },
    "storage_contract": { $STORAGE_COSTS },
    "logic_contract": { $LOGIC_COSTS },
    "wiring": { $WIRE_COSTS },
    "grand_total_eth": "$GRAND_TOTAL_ETH"
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
echo "Total gas cost:   $GRAND_TOTAL_ETH ETH"
echo ""
echo "NEXT STEPS:"
if [[ -z "${DEPLOYER_SECP256R1_PUBKEY:-}" ]]; then
  echo "1. Call storage.initialize($LOGIC_ADDRESS, <deployer_pubkey_as_uint8[]>) if not done."
  echo "   Note: Stylus SDK 0.8 maps Vec<u8> to uint8[], not bytes. Use the hex→array"
  echo "   conversion in this script, or see deployments/README.md."
  echo "2. Call logic.initialize($STORAGE_ADDRESS, $VERIFIER_ADDRESS) if not done."
  echo "3. Run bootstrap sequence: RegisterPolicy → AuthorizePress."
else
  echo "1. Run bootstrap sequence: RegisterPolicy → AuthorizePress."
fi
echo "$([ -n "${DEPLOYER_SECP256R1_PUBKEY:-}" ] && echo "2" || echo "4"). Call RotateGovernanceKeys to expand from 1-of-1 as soon as governance"
echo "   members are available. The 1-of-1 bootstrap is a single point of failure."
echo "$([ -n "${DEPLOYER_SECP256R1_PUBKEY:-}" ] && echo "3" || echo "5"). Transaction hashes saved to $DEPLOYMENT_FILE"
