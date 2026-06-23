#!/usr/bin/env bash
# setup_dev.sh — Idempotent Sepolia dev environment setup.
#
# Configures the deployed Sepolia contract for local development by:
#   1. Registering a dev policy (if not already registered)
#   2. Authorizing the deployer key as a dev press (if not already authorized)
#   3. Writing contracts/.keys/dev-state.json with the resulting addresses
#
# Usage:
#   source contracts/.env
#   ./contracts/scripts/setup_dev.sh
#
# Required env vars (from contracts/.env):
#   PRIVATE_KEY              — Ethereum private key for gas payment
#   ARBITRUM_SEPOLIA_RPC     — RPC endpoint
#   DEPLOYER_SECP256R1_PUBKEY — 64-byte P-256 public key (x||y, 0x-prefixed)
#   SECP256R1_PRIVKEY        — 32-byte P-256 private key scalar (0x-prefixed)
#
# ⚠ Clarification Checkpoint: This script will PROMPT before submitting any transaction.
#   It does NOT auto-submit governance transactions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"
KEY_FILE="$CONTRACTS_DIR/.keys/test_press.key"
STATE_FILE="$CONTRACTS_DIR/.keys/dev-state.json"

LOGIC=0xc6bf998e1c8dd989b296405af9c5d07cc833f938
STORAGE=0x9272a5123a3a773d67d909f774fb88e4b260ce82

# Dev identifiers (deterministic for reproducibility)
DEV_POLICY_ADDR="0x$(printf '%064x' "$(echo -n 'dev_policy_v1' | xxd -p | tr -d '\n' | head -c 8)" 2>/dev/null || echo "6465765f706f6c6963795f763100000000000000000000000000000000000000")"
DEV_PRESS_ADDR="0x$(printf '%064x' "$(echo -n 'dev_press_v1' | xxd -p | tr -d '\n' | head -c 8)" 2>/dev/null || echo "6465765f70726573735f7631000000000000000000000000000000000000000000")"

# Use keccak256-derived deterministic addresses
DEV_POLICY_ADDR="0x$(cast keccak "dev_policy_v1" 2>/dev/null | cut -c1-66 || echo "0x6465765f706f6c69637900000000000000000000000000000000000000000000")"
DEV_PRESS_ADDR="0x$(cast keccak "dev_press_v1" 2>/dev/null | cut -c1-66 || echo "0x6465765f707265737300000000000000000000000000000000000000000000000")"

# Re-derive properly using openssl sha256 → bytes32
DEV_POLICY_ADDR="0x$(echo -n 'card_protocol_dev_policy_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
DEV_PRESS_ADDR="0x$(echo -n 'card_protocol_dev_press_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"

# ── Validation ───────────────────────────────────────────────────────────────

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC DEPLOYER_SECP256R1_PUBKEY SECP256R1_PRIVKEY; do
    if [[ -z "${!VAR:-}" ]]; then
        echo "ERROR: $VAR is not set. Run: source contracts/.env" >&2
        exit 1
    fi
done

if ! command -v cast &>/dev/null; then
    echo "ERROR: cast not found. Install Foundry: https://getfoundry.sh" >&2
    exit 1
fi

if ! command -v cargo &>/dev/null; then
    echo "ERROR: cargo not found. Install Rust: https://rustup.rs" >&2
    exit 1
fi

echo "=== Card Protocol Dev Setup ==="
echo "Network:          Arbitrum Sepolia"
echo "Logic contract:   $LOGIC"
echo "Dev policy addr:  $DEV_POLICY_ADDR"
echo "Dev press addr:   $DEV_PRESS_ADDR"
echo ""

# ── Helper: sign a governance payload ────────────────────────────────────────

sign_payload() {
    local payload="$1"
    cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$SECP256R1_PRIVKEY" \
        --payload "$payload"
}

hex_encode() {
    echo -n "$1" | xxd -p | tr -d '\n'
}

# ── Step 1: Read current governance state ────────────────────────────────────

echo "Reading on-chain governance state..."
KEYSET_RESULT=$(cast call $LOGIC \
    "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

# Extract version (4th return value)
GOV_VER=$(echo "$KEYSET_RESULT" | awk 'NR==4{print $1}')
echo "RootPolicyBody: version=$GOV_VER"

PRESS_KEYSET=$(cast call $LOGIC \
    "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 1 \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
PRESS_GOV_VER=$(echo "$PRESS_KEYSET" | awk 'NR==4{print $1}')
echo "PressRegistryBody: version=$PRESS_GOV_VER"

# ── Step 2: Register policy (if not exists) ───────────────────────────────────

POLICY_EXISTS=$(cast call $LOGIC "policy_exists(bytes32)(bool)" "$DEV_POLICY_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

if [[ "$POLICY_EXISTS" == "true" ]]; then
    echo "✓ Dev policy already exists: $DEV_POLICY_ADDR"
else
    echo ""
    echo "--- RegisterPolicy ---"
    NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
    PAYLOAD="{\"governance_version\":$GOV_VER,\"nonce\":\"$NONCE\",\"op\":\"register_policy\"}"
    SIG=$(sign_payload "$PAYLOAD")
    PAYLOAD_HEX="0x$(hex_encode "$PAYLOAD")"

    echo "Payload: $PAYLOAD"
    echo "Sig:     $SIG"
    echo ""
    read -r -p "Submit register_policy transaction? (y/N) " CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
        echo "Aborted by user."
        exit 0
    fi

    cast send $LOGIC \
        "register_policy(bytes32,bytes,bytes,bytes[])" \
        "$DEV_POLICY_ADDR" \
        "$DEPLOYER_SECP256R1_PUBKEY" \
        "$PAYLOAD_HEX" \
        "[$SIG]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC"

    echo "✓ RegisterPolicy submitted"
fi

# ── Step 3: Authorize press (if not active) ───────────────────────────────────

PRESS_ACTIVE=$(cast call $LOGIC "is_press_active(bytes32,bytes32)(bool)" \
    "$DEV_POLICY_ADDR" "$DEV_PRESS_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

if [[ "$PRESS_ACTIVE" == "true" ]]; then
    echo "✓ Dev press already active: $DEV_PRESS_ADDR"
else
    echo ""
    echo "--- AuthorizePress ---"
    NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
    PAYLOAD="{\"governance_version\":$PRESS_GOV_VER,\"nonce\":\"$NONCE\",\"op\":\"authorize_press\"}"
    SIG=$(sign_payload "$PAYLOAD")
    PAYLOAD_HEX="0x$(hex_encode "$PAYLOAD")"
    MLDSA_HASH="0x0000000000000000000000000000000000000000000000000000000000000000"

    echo "Payload: $PAYLOAD"
    echo "Sig:     $SIG"
    echo ""
    read -r -p "Submit authorize_press transaction? (y/N) " CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
        echo "Aborted by user."
        exit 0
    fi

    cast send $LOGIC \
        "authorize_press(bytes32,bytes32,bytes,bytes32,bytes,bytes[])" \
        "$DEV_POLICY_ADDR" \
        "$DEV_PRESS_ADDR" \
        "$DEPLOYER_SECP256R1_PUBKEY" \
        "$MLDSA_HASH" \
        "$PAYLOAD_HEX" \
        "[$SIG]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC"

    echo "✓ AuthorizePress submitted"
fi

# ── Step 4: Verify final state ────────────────────────────────────────────────

POLICY_EXISTS_FINAL=$(cast call $LOGIC "policy_exists(bytes32)(bool)" "$DEV_POLICY_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
PRESS_ACTIVE_FINAL=$(cast call $LOGIC "is_press_active(bytes32,bytes32)(bool)" \
    "$DEV_POLICY_ADDR" "$DEV_PRESS_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
NEXT_SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
    "$DEV_POLICY_ADDR" "$DEV_PRESS_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

if [[ "$POLICY_EXISTS_FINAL" != "true" || "$PRESS_ACTIVE_FINAL" != "true" ]]; then
    echo "ERROR: Final state check failed. policy_exists=$POLICY_EXISTS_FINAL press_active=$PRESS_ACTIVE_FINAL" >&2
    exit 1
fi

# ── Step 5: Write dev-state.json ──────────────────────────────────────────────

mkdir -p "$(dirname "$STATE_FILE")"
cat > "$STATE_FILE" <<EOF
{
  "network": "arbitrum-sepolia",
  "logic_contract": "$LOGIC",
  "storage_contract": "$STORAGE",
  "policy_address": "$DEV_POLICY_ADDR",
  "press_address": "$DEV_PRESS_ADDR",
  "press_pubkey": "$DEPLOYER_SECP256R1_PUBKEY",
  "governance_version": $GOV_VER,
  "cards": []
}
EOF

echo ""
echo "=== Setup Complete ==="
echo "Policy:  $DEV_POLICY_ADDR → EXISTS"
echo "Press:   $DEV_PRESS_ADDR → ACTIVE (next_seq=$NEXT_SEQ)"
echo "Written: $STATE_FILE"
