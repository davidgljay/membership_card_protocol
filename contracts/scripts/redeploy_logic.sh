#!/usr/bin/env bash
# redeploy_logic.sh — Redeploy storage + logic contracts on Sepolia.
#
# Keeps the existing verifier module. Deploys a fresh storage contract
# and a new logic contract, wires them together, and updates
# deployments/sepolia.json.
#
# When to use this:
#   The logic contract must be redeployed when the sol_interface selectors
#   or ABI types change (e.g., snake_case → camelCase, bytes → uint8[]).
#   Because storage.setLogicContract is E-29 gated, and the broken logic
#   contract can't execute governance operations, a fresh storage contract
#   is required alongside the new logic contract.
#
# SEPOLIA ONLY — aborts if ARBITRUM_SEPOLIA_RPC does not contain "sepolia".
#
# Usage:
#   set -a; source contracts/.env; set +a
#   ./contracts/scripts/redeploy_logic.sh
#
# Required env vars: PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC,
#                    DEPLOYER_SECP256R1_PUBKEY, SECP256R1_PRIVKEY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

DEPLOYMENTS_FILE="$CONTRACTS_DIR/deployments/sepolia.json"

# ── Sepolia guard ─────────────────────────────────────────────────────────────

if [[ "$ARBITRUM_SEPOLIA_RPC" != *"sepolia"* ]]; then
    echo "ERROR: ARBITRUM_SEPOLIA_RPC must contain 'sepolia'. Got: $ARBITRUM_SEPOLIA_RPC" >&2
    exit 1
fi

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC DEPLOYER_SECP256R1_PUBKEY SECP256R1_PRIVKEY; do
    if [[ -z "${!VAR:-}" ]]; then
        echo "ERROR: $VAR is not set. Run: set -a; source contracts/.env; set +a" >&2
        exit 1
    fi
done

if ! command -v cargo-stylus &>/dev/null; then
    echo "ERROR: cargo-stylus not found. Install with: cargo install cargo-stylus" >&2
    exit 1
fi

# Keep the existing verifier module.
VERIFIER=$(python3 -c "import json; d=json.load(open('$DEPLOYMENTS_FILE')); print(d['contracts']['verifier_module'])")

echo "=== Redeploy: Storage + Logic (Sepolia) ==="
echo "Verifier (unchanged): $VERIFIER"
echo "RPC: $ARBITRUM_SEPOLIA_RPC"
echo ""
read -r -p "This will deploy fresh storage + logic contracts. Proceed? (y/N) " CONFIRM
[[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "Aborted."; exit 0; }
echo ""

# ── Build ─────────────────────────────────────────────────────────────────────

echo "[1/5] Building contracts (WASM)..."
cd "$CONTRACTS_DIR"
cargo build --release --target wasm32-unknown-unknown -p storage-contract -p logic-contract 2>&1 | tail -5
echo "  Build complete."
echo ""

# ── Deploy storage contract ───────────────────────────────────────────────────

echo "[2/5] Deploying storage-contract..."
STORAGE_OUT=$(cd "$CONTRACTS_DIR/storage-contract" && cargo stylus deploy \
    --endpoint "$ARBITRUM_SEPOLIA_RPC" \
    --private-key "$PRIVATE_KEY" \
    --no-verify \
    2>&1)
echo "$STORAGE_OUT"
STORAGE=$(echo "$STORAGE_OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
STORAGE_DEPLOY_TX=$(echo "$STORAGE_OUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '1p')
STORAGE_ACTIVATE_TX=$(echo "$STORAGE_OUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '2p')
echo ""
echo "  storage-contract: $STORAGE"
echo ""

# ── Deploy logic contract ─────────────────────────────────────────────────────

echo "[3/5] Deploying logic-contract..."
LOGIC_OUT=$(cd "$CONTRACTS_DIR/logic-contract" && cargo stylus deploy \
    --endpoint "$ARBITRUM_SEPOLIA_RPC" \
    --private-key "$PRIVATE_KEY" \
    --no-verify \
    2>&1)
echo "$LOGIC_OUT"
LOGIC=$(echo "$LOGIC_OUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
LOGIC_DEPLOY_TX=$(echo "$LOGIC_OUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '1p')
LOGIC_ACTIVATE_TX=$(echo "$LOGIC_OUT" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '2p')
echo ""
echo "  logic-contract: $LOGIC"
echo ""

# ── Wire: storage.initialize(logic, deployer_pubkey) ─────────────────────────

echo "[4/5] Wiring contracts..."

# Convert hex pubkey to uint8[] decimal array for cast
PUBKEY_HEX="${DEPLOYER_SECP256R1_PUBKEY#0x}"
PUBKEY_ARRAY="["
for ((i=0; i<${#PUBKEY_HEX}; i+=2)); do
    byte=$((16#${PUBKEY_HEX:$i:2}))
    [[ $i -eq 0 ]] && PUBKEY_ARRAY+="$byte" || PUBKEY_ARRAY+=",$byte"
done
PUBKEY_ARRAY+="]"

echo "  storage.initialize($LOGIC, <pubkey>)..."
INIT_STORAGE_OUT=$(cast send "$STORAGE" \
    "initialize(address,uint8[])" \
    "$LOGIC" \
    "$PUBKEY_ARRAY" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" \
    --json 2>&1)
INIT_STORAGE_TX=$(echo "$INIT_STORAGE_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null || echo "")
echo "  TX: ${INIT_STORAGE_TX:-submitted}"

echo "  logic.initialize($STORAGE, $VERIFIER)..."
INIT_LOGIC_OUT=$(cast send "$LOGIC" \
    "initialize(address,address)" \
    "$STORAGE" \
    "$VERIFIER" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" \
    --json 2>&1)
INIT_LOGIC_TX=$(echo "$INIT_LOGIC_OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null || echo "")
echo "  TX: ${INIT_LOGIC_TX:-submitted}"
echo ""

# ── Verify wiring ─────────────────────────────────────────────────────────────

echo "Verifying..."
STORED_LOGIC=$(cast call "$STORAGE" "getLogicContract()(address)" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
STORED_STORAGE=$(cast call "$LOGIC" "getStorageContract()(address)" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
STORED_VERIFIER=$(cast call "$LOGIC" "getVerifierModule()(address)" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

echo "  storage.getLogicContract()  = $STORED_LOGIC"
echo "  logic.getStorageContract()  = $STORED_STORAGE"
echo "  logic.getVerifierModule()   = $STORED_VERIFIER"

# Case-insensitive address compare
normalize() { echo "${1,,}"; }
if [[ "$(normalize "$STORED_LOGIC")" != "$(normalize "$LOGIC")" ]] || \
   [[ "$(normalize "$STORED_STORAGE")" != "$(normalize "$STORAGE")" ]] || \
   [[ "$(normalize "$STORED_VERIFIER")" != "$(normalize "$VERIFIER")" ]]; then
    echo "" >&2
    echo "ERROR: wiring verification failed — addresses don't match expected values." >&2
    exit 1
fi
echo "  ✓ All addresses match."
echo ""

# ── Update deployments/sepolia.json ──────────────────────────────────────────

echo "[5/5] Updating deployments/sepolia.json..."
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
python3 - <<PYEOF
import json, sys

with open("$DEPLOYMENTS_FILE") as f:
    d = json.load(f)

d["deployed_at"] = "$TIMESTAMP"
d["contracts"]["storage_contract"] = "$STORAGE"
d["contracts"]["logic_contract"] = "$LOGIC"
d["deployment_txs"] = {
    "storage_contract_deploy": "$STORAGE_DEPLOY_TX",
    "storage_contract_activate": "$STORAGE_ACTIVATE_TX",
    "logic_contract_deploy": "$LOGIC_DEPLOY_TX",
    "logic_contract_activate": "$LOGIC_ACTIVATE_TX",
    "storage_initialize": "$INIT_STORAGE_TX",
    "logic_initialize": "$INIT_LOGIC_TX",
}
d["notes"] = "storage_contract is the stable protocol identifier — never redeployed. (Sepolia exception: redeployed alongside logic contract fix.)"

with open("$DEPLOYMENTS_FILE", "w") as f:
    json.dump(d, f, indent=2)

print("  Written:", "$DEPLOYMENTS_FILE")
PYEOF

echo ""
echo "=== Redeploy Complete ==="
echo "verifier-module:  $VERIFIER  (unchanged)"
echo "storage-contract: $STORAGE   ← NEW"
echo "logic-contract:   $LOGIC     ← NEW"
echo ""
echo "Next: re-run the test scripts from step 1."
