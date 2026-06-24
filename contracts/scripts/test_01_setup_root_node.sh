#!/usr/bin/env bash
# test_01_setup_root_node.sh — Verify and record root governance state for Sepolia testing.
#
# Reads the storage contract directly (not through logic) because cast call
# issues STATICCALL and the logic contract's cross-contract sub-calls fail
# in that context. Writes mock_wallets/root_node.json.
#
# SEPOLIA ONLY — aborts if RPC URL does not contain "sepolia".
#
# Usage:
#   set -a; source contracts/.env; set +a
#   ./contracts/scripts/test_01_setup_root_node.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$SCRIPT_DIR/contract_helpers.sh"

PARAMS_FILE="$CONTRACTS_DIR/test_params/root_node.json"
WALLETS_DIR="$CONTRACTS_DIR/mock_wallets"
OUT_FILE="$WALLETS_DIR/root_node.json"

DEPLOYMENTS="$CONTRACTS_DIR/deployments/sepolia.json"
LOGIC=$(python3   -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['logic_contract'])")
STORAGE=$(python3 -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['storage_contract'])")

# ── Sepolia guard ─────────────────────────────────────────────────────────────

if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" ]]; then
    echo "ERROR: ARBITRUM_SEPOLIA_RPC is not set. Run: set -a; source contracts/.env; set +a" >&2
    exit 1
fi
if [[ "$ARBITRUM_SEPOLIA_RPC" != *"sepolia"* ]]; then
    echo "ERROR: These test scripts only run on Sepolia." >&2
    exit 1
fi
if ! command -v cast &>/dev/null; then
    echo "ERROR: cast not found. Install Foundry: https://getfoundry.sh" >&2
    exit 1
fi
if [[ ! -f "$PARAMS_FILE" ]]; then
    echo "ERROR: $PARAMS_FILE not found." >&2
    exit 1
fi

PARAMS_NETWORK=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d.get('network',''))")
if [[ "$PARAMS_NETWORK" != "sepolia" ]]; then
    echo "ERROR: test_params/root_node.json must have \"network\": \"sepolia\"" >&2
    exit 1
fi

# ── Query governance state directly from storage ──────────────────────────────
# Reads go to STORAGE, not LOGIC. See contract_helpers.sh for explanation.

echo "=== Test Step 1: Setup Root Node (Sepolia) ==="
echo "Logic:   $LOGIC"
echo "Storage: $STORAGE"
echo ""

echo "Querying RootPolicyBody (body_id=0)..."
ROOT_RAW=$(cast call "$STORAGE" "getGovernanceKeyset(uint8)" 0 \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC")
ROOT_KEY_COUNT=$(parse_gov_keyset_count  "$ROOT_RAW")
ROOT_QUORUM=$(parse_gov_keyset_quorum    "$ROOT_RAW")
ROOT_VERSION=$(parse_gov_keyset_version  "$ROOT_RAW")
echo "  key_count: $ROOT_KEY_COUNT"
echo "  quorum:    $ROOT_QUORUM"
echo "  version:   $ROOT_VERSION"
echo ""

echo "Querying PressRegistryBody (body_id=1)..."
PRESS_RAW=$(cast call "$STORAGE" "getGovernanceKeyset(uint8)" 1 \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC")
PRESS_KEY_COUNT=$(parse_gov_keyset_count  "$PRESS_RAW")
PRESS_QUORUM=$(parse_gov_keyset_quorum    "$PRESS_RAW")
PRESS_VERSION=$(parse_gov_keyset_version  "$PRESS_RAW")
echo "  key_count: $PRESS_KEY_COUNT"
echo "  quorum:    $PRESS_QUORUM"
echo "  version:   $PRESS_VERSION"
echo ""

if [[ "$ROOT_KEY_COUNT" -eq 0 ]]; then
    echo "ERROR: RootPolicyBody has no keys. Contract not properly initialized." >&2
    exit 1
fi

# ── Write output ──────────────────────────────────────────────────────────────

mkdir -p "$WALLETS_DIR"
cat > "$OUT_FILE" <<EOF
{
  "network": "sepolia",
  "logic_contract": "$LOGIC",
  "storage_contract": "$STORAGE",
  "root_policy_body": {
    "body_id": 0,
    "key_count": $ROOT_KEY_COUNT,
    "quorum": $ROOT_QUORUM,
    "version": $ROOT_VERSION
  },
  "press_registry_body": {
    "body_id": 1,
    "key_count": $PRESS_KEY_COUNT,
    "quorum": $PRESS_QUORUM,
    "version": $PRESS_VERSION
  }
}
EOF

echo "=== Root Node Verified ==="
echo "RootPolicyBody:    version=$ROOT_VERSION  ${ROOT_QUORUM}-of-${ROOT_KEY_COUNT}"
echo "PressRegistryBody: version=$PRESS_VERSION  ${PRESS_QUORUM}-of-${PRESS_KEY_COUNT}"
echo "Written: $OUT_FILE"
echo ""
echo "Next: run test_02_create_policy.sh"
