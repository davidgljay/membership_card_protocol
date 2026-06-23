#!/usr/bin/env bash
# publish_cards.sh — Publish test cards to the Sepolia dev environment.
#
# Reads contracts/.keys/dev-state.json (written by setup_dev.sh) and registers
# a set of test cards, updating dev-state.json with the resulting addresses and CIDs.
#
# What it publishes:
#   - CARDS_TO_PUBLISH cards via register_card (default: 3)
#   - An update_card_head for card[0] (tests the update path)
#   - A register_sub_card under card[0] (tests the sub-card path)
#
# Usage:
#   source contracts/.env
#   ./contracts/scripts/publish_cards.sh
#   CARDS_TO_PUBLISH=5 ./contracts/scripts/publish_cards.sh  # custom count
#
# Required env vars (from contracts/.env):
#   PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC, SECP256R1_PRIVKEY
#
# ⚠ Clarification Checkpoint: This script prompts before the first transaction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"
STATE_FILE="$CONTRACTS_DIR/.keys/dev-state.json"

LOGIC=0xc6bf998e1c8dd989b296405af9c5d07cc833f938
CARDS_TO_PUBLISH="${CARDS_TO_PUBLISH:-3}"

# ── Validation ───────────────────────────────────────────────────────────────

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC SECP256R1_PRIVKEY; do
    if [[ -z "${!VAR:-}" ]]; then
        echo "ERROR: $VAR is not set. Run: source contracts/.env" >&2
        exit 1
    fi
done

if [[ ! -f "$STATE_FILE" ]]; then
    echo "ERROR: $STATE_FILE not found. Run setup_dev.sh first." >&2
    exit 1
fi

if ! command -v cast &>/dev/null; then
    echo "ERROR: cast not found." >&2
    exit 1
fi

# ── Load state ───────────────────────────────────────────────────────────────

POLICY_ADDR=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d['policy_address'])")
PRESS_ADDR=$(python3 -c "import json,sys; d=json.load(open('$STATE_FILE')); print(d['press_address'])")

echo "=== Card Protocol Publish Cards ==="
echo "Policy: $POLICY_ADDR"
echo "Press:  $PRESS_ADDR"
echo "Cards to publish: $CARDS_TO_PUBLISH"

# ── Helper: sign a press payload ─────────────────────────────────────────────

sign_press() {
    local payload="$1"
    cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$SECP256R1_PRIVKEY" \
        --payload "$payload"
}

hex_encode() {
    echo -n "$1" | xxd -p | tr -d '\n'
}

# Make a test CID: 0x1220 (IPFS multihash sha2-256 prefix) + sha256 of a label
make_cid() {
    local label="$1"
    local hash
    hash=$(echo -n "$label" | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')
    echo "0x1220${hash}"
}

# Make a deterministic card address from an index
make_card_addr() {
    local idx="$1"
    echo -n "dev_card_v1_${idx}" | openssl dgst -sha256 -binary | xxd -p | tr -d '\n' | awk '{print "0x"$1}'
}

# ── Read current sequence ────────────────────────────────────────────────────

CURRENT_SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
    "$POLICY_ADDR" "$PRESS_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

echo "Current sequence: $CURRENT_SEQ"
echo ""

# ── Confirmation before first tx ─────────────────────────────────────────────

SENDER_ADDR=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)
SENDER_BALANCE=$(cast balance "$SENDER_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null || echo "unknown")
echo "Sender: $SENDER_ADDR"
echo "Balance: $SENDER_BALANCE wei"
echo ""

TOTAL_TXS=$((CARDS_TO_PUBLISH + 2))  # cards + update + sub-card
echo "Will submit $TOTAL_TXS transactions (${CARDS_TO_PUBLISH} register_card + 1 update_card_head + 1 register_sub_card)"
read -r -p "Proceed? (y/N) " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Aborted by user."
    exit 0
fi

# ── Publish cards ─────────────────────────────────────────────────────────────

SEQ=$CURRENT_SEQ
CARD_ENTRIES="[]"
FIRST_CARD_ADDR=""
FIRST_CARD_CID=""

for i in $(seq 0 $((CARDS_TO_PUBLISH - 1))); do
    CARD_ADDR=$(make_card_addr "$i")
    CID=$(make_cid "dev_card_content_${i}")

    echo "Registering card $i: $CARD_ADDR (seq=$SEQ)"

    # Check if already registered (idempotency)
    CARD_EXISTS=$(cast call $LOGIC "card_exists(bytes32)(bool)" "$CARD_ADDR" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

    if [[ "$CARD_EXISTS" == "true" ]]; then
        echo "  ↳ Already exists, skipping"
        # Still need to track CID for later use
        STORED_CID=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" \
            "$CARD_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null | awk 'NR==1{print $1}')
        CID="${STORED_CID:-$CID}"
    else
        PAYLOAD="{\"op\":\"register_card\",\"sequence\":$SEQ}"
        SIG=$(sign_press "$PAYLOAD")
        PAYLOAD_HEX="0x$(hex_encode "$PAYLOAD")"

        TX=$(cast send $LOGIC \
            "register_card(bytes32,bytes,bytes32,bytes32,bytes,bytes)" \
            "$CARD_ADDR" "$CID" "$POLICY_ADDR" "$PRESS_ADDR" \
            "$PAYLOAD_HEX" "$SIG" \
            --private-key "$PRIVATE_KEY" \
            --rpc-url "$ARBITRUM_SEPOLIA_RPC" \
            --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null || echo "submitted")
        echo "  ✓ TX: $TX"
        SEQ=$((SEQ + 1))
    fi

    if [[ $i -eq 0 ]]; then
        FIRST_CARD_ADDR="$CARD_ADDR"
        FIRST_CARD_CID="$CID"
    fi

    # Build JSON entry (append to array)
    ENTRY="{\"card_address\":\"$CARD_ADDR\",\"cid\":\"$CID\",\"sequence\":$((SEQ - 1))}"
    if [[ "$CARD_ENTRIES" == "[]" ]]; then
        CARD_ENTRIES="[$ENTRY"
    else
        CARD_ENTRIES="${CARD_ENTRIES},$ENTRY"
    fi
done
CARD_ENTRIES="${CARD_ENTRIES}]"

# ── Update head of card[0] ───────────────────────────────────────────────────

echo ""
echo "Updating head of card[0]: $FIRST_CARD_ADDR (seq=$SEQ)"

NEW_CID=$(make_cid "dev_card_content_0_v2")
PAYLOAD="{\"op\":\"update_card_head\",\"sequence\":$SEQ}"
SIG=$(sign_press "$PAYLOAD")
PAYLOAD_HEX="0x$(hex_encode "$PAYLOAD")"

TX=$(cast send $LOGIC \
    "update_card_head(bytes32,bytes,bytes,bytes32,bytes,bytes)" \
    "$FIRST_CARD_ADDR" "$NEW_CID" "$FIRST_CARD_CID" "$PRESS_ADDR" \
    "$PAYLOAD_HEX" "$SIG" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" \
    --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null || echo "submitted")
echo "  ✓ TX: $TX (updated CID to $NEW_CID)"
SEQ=$((SEQ + 1))

# Update the first card's CID in the entries
CARD_ENTRIES=$(echo "$CARD_ENTRIES" | python3 -c "
import json, sys
entries = json.load(sys.stdin)
if entries:
    entries[0]['cid'] = '$NEW_CID'
    entries[0]['head_updated'] = True
print(json.dumps(entries))
" 2>/dev/null || echo "$CARD_ENTRIES")

# ── Register sub-card under card[0] ──────────────────────────────────────────

echo ""
echo "Registering sub-card under card[0] (seq=$SEQ)"

SUB_ADDR="0x$(echo -n 'dev_sub_card_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
SUB_DOC_CID=$(make_cid "dev_sub_card_doc_v1")

# Get current head of card[0] (after the update)
MASTER_CID=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" \
    "$FIRST_CARD_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null | awk 'NR==1{print $1}')

PAYLOAD="{\"op\":\"register_sub_card\",\"sequence\":$SEQ}"
SIG=$(sign_press "$PAYLOAD")
PAYLOAD_HEX="0x$(hex_encode "$PAYLOAD")"

TX=$(cast send $LOGIC \
    "register_sub_card(bytes32,bytes32,bytes,bytes,bytes32,bytes,bytes,bytes,bytes)" \
    "$SUB_ADDR" "$FIRST_CARD_ADDR" "${MASTER_CID:-$NEW_CID}" "$SUB_DOC_CID" "$PRESS_ADDR" \
    "$PAYLOAD_HEX" "$SIG" \
    "0x" "0x" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" \
    --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null || echo "submitted")
echo "  ✓ TX: $TX"

# ── Update dev-state.json ────────────────────────────────────────────────────

python3 - <<PYEOF
import json

with open('$STATE_FILE', 'r') as f:
    state = json.load(f)

state['cards'] = $CARD_ENTRIES
state['sub_card_address'] = '$SUB_ADDR'
state['sub_card_master'] = '$FIRST_CARD_ADDR'

with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)
PYEOF

echo ""
echo "=== Publish Complete ==="
echo "Cards registered: $CARDS_TO_PUBLISH"
echo "Sub-card:         $SUB_ADDR (under $FIRST_CARD_ADDR)"
echo "Written:          $STATE_FILE"
echo ""
echo "Run ./contracts/scripts/read_dev_state.sh to verify on-chain state."
