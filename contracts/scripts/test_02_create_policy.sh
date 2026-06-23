#!/usr/bin/env bash
# test_02_create_policy.sh — Register a test policy on Sepolia.
#
# Reads go directly to the storage contract (STATICCALL restriction — see
# contract_helpers.sh). Writes go through the logic contract via cast send
# (regular CALL, so cross-contract sub-calls work).
#
# SEPOLIA ONLY — aborts if RPC URL does not contain "sepolia".
#
# Usage:
#   set -a; source contracts/.env; set +a
#   ./contracts/scripts/test_02_create_policy.sh
#
# Required env vars: PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC, SECP256R1_PRIVKEY,
#                    DEPLOYER_SECP256R1_PUBKEY
#
# ⚠ Prompts before submitting any transaction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

source "$SCRIPT_DIR/contract_helpers.sh"
export PATH="$HOME/.cargo/bin:$PATH"

PARAMS_FILE="$CONTRACTS_DIR/test_params/policy.json"
ROOT_STATE="$CONTRACTS_DIR/mock_wallets/root_node.json"
WALLETS_DIR="$CONTRACTS_DIR/mock_wallets"
OUT_FILE="$WALLETS_DIR/policy.json"

LOGIC=0xc6bf998e1c8dd989b296405af9c5d07cc833f938
STORAGE=0x9272a5123a3a773d67d909f774fb88e4b260ce82

# ── Sepolia guard ─────────────────────────────────────────────────────────────

if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" ]]; then
    echo "ERROR: ARBITRUM_SEPOLIA_RPC is not set. Run: set -a; source contracts/.env; set +a" >&2
    exit 1
fi
if [[ "$ARBITRUM_SEPOLIA_RPC" != *"sepolia"* ]]; then
    echo "ERROR: These test scripts only run on Sepolia." >&2
    exit 1
fi
for VAR in PRIVATE_KEY SECP256R1_PRIVKEY DEPLOYER_SECP256R1_PUBKEY; do
    if [[ -z "${!VAR:-}" ]]; then
        echo "ERROR: $VAR is not set." >&2; exit 1
    fi
done
for F in "$PARAMS_FILE" "$ROOT_STATE"; do
    if [[ ! -f "$F" ]]; then
        echo "ERROR: $F not found." >&2
        [[ "$F" == "$ROOT_STATE" ]] && echo "  Run test_01_setup_root_node.sh first." >&2
        exit 1
    fi
done

# ── Load params ───────────────────────────────────────────────────────────────

PARAMS_NETWORK=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d.get('network',''))")
[[ "$PARAMS_NETWORK" == "sepolia" ]] || { echo "ERROR: policy.json must have \"network\": \"sepolia\"" >&2; exit 1; }

POLICY_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['policy_id'])")
ROOT_GOV_VER=$(python3 -c "import json; d=json.load(open('$ROOT_STATE')); print(d['root_policy_body']['version'])")

POLICY_ADDR="0x$(echo -n "card_protocol_${POLICY_ID}" | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"

echo "=== Test Step 2: Create Policy (Sepolia) ==="
echo "Policy ID:      $POLICY_ID"
echo "Policy address: $POLICY_ADDR"
echo "Gov version:    $ROOT_GOV_VER  (RootPolicyBody)"
echo ""

# ── Check if already registered (read from storage directly) ──────────────────

POLICY_EXISTS=$(cast call "$STORAGE" "policyExists(bytes32)(bool)" "$POLICY_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC")

if [[ "$POLICY_EXISTS" == "true" ]]; then
    echo "✓ Policy already registered — skipping."
else
    echo "Policy not yet registered. Building governance payload..."
    echo ""

    NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
    GOV_PAYLOAD="{\"governance_version\":${ROOT_GOV_VER},\"nonce\":\"${NONCE}\",\"op\":\"register_policy\"}"
    GOV_PAYLOAD_HEX="0x$(echo -n "$GOV_PAYLOAD" | xxd -p | tr -d '\n')"
    GOV_SIG=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$SECP256R1_PRIVKEY" --payload "$GOV_PAYLOAD")

    # Encode parameters as uint8[] for the Stylus ABI
    PUBKEY_ARR=$(hex_to_uint8_array "$DEPLOYER_SECP256R1_PUBKEY")
    PAYLOAD_ARR=$(hex_to_uint8_array "$GOV_PAYLOAD_HEX")
    SIG_ARR=$(hex_to_uint8_array "$GOV_SIG")

    echo "Payload: $GOV_PAYLOAD"
    echo ""
    read -r -p "Submit registerPolicy? (y/N) " CONFIRM
    [[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "Aborted."; exit 0; }

    # Write goes to LOGIC via cast send (regular CALL — cross-contract sub-calls work)
    cast send "$LOGIC" \
        "registerPolicy(bytes32,uint8[],uint8[],uint8[][])" \
        "$POLICY_ADDR" \
        "$PUBKEY_ARR" \
        "$PAYLOAD_ARR" \
        "[$SIG_ARR]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC"

    POLICY_EXISTS=$(cast call "$STORAGE" "policyExists(bytes32)(bool)" "$POLICY_ADDR" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC")
    if [[ "$POLICY_EXISTS" != "true" ]]; then
        echo "ERROR: policy not found after transaction. Check tx status." >&2; exit 1
    fi
    echo "✓ Policy confirmed on-chain."
fi

# ── Write output ──────────────────────────────────────────────────────────────

mkdir -p "$WALLETS_DIR"
cat > "$OUT_FILE" <<EOF
{
  "network": "sepolia",
  "policy_id": "$POLICY_ID",
  "policy_address": "$POLICY_ADDR",
  "authorizer_pubkey": "$DEPLOYER_SECP256R1_PUBKEY"
}
EOF

echo ""
echo "=== Policy Created ==="
echo "Policy: $POLICY_ADDR"
echo "Written: $OUT_FILE"
echo ""
echo "Next: run test_03_create_card.sh"
