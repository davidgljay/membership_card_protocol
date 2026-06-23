#!/usr/bin/env bash
# read_dev_state.sh — Query on-chain state for the dev environment.
#
# Reads contracts/.keys/dev-state.json and queries the Sepolia contract
# for the current on-chain state of each entity. Prints a human-readable status table.
#
# Usage:
#   source contracts/.env
#   ./contracts/scripts/read_dev_state.sh
#
# Required env vars (from contracts/.env):
#   ARBITRUM_SEPOLIA_RPC

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_FILE="$CONTRACTS_DIR/.keys/dev-state.json"
LOGIC=0xc6bf998e1c8dd989b296405af9c5d07cc833f938

# ── Validation ───────────────────────────────────────────────────────────────

if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" ]]; then
    echo "ERROR: ARBITRUM_SEPOLIA_RPC is not set. Run: source contracts/.env" >&2
    exit 1
fi

if [[ ! -f "$STATE_FILE" ]]; then
    echo "ERROR: $STATE_FILE not found. Run setup_dev.sh first." >&2
    exit 1
fi

if ! command -v cast &>/dev/null; then
    echo "ERROR: cast not found." >&2
    exit 1
fi

# ── Load state ───────────────────────────────────────────────────────────────

POLICY_ADDR=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d['policy_address'])")
PRESS_ADDR=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d['press_address'])")
CARD_COUNT=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(len(d.get('cards', [])))")
SUB_ADDR=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('sub_card_address', ''))" 2>/dev/null || echo "")

echo "=== Card Protocol Dev State — Arbitrum Sepolia ==="
echo ""

# ── Policy ───────────────────────────────────────────────────────────────────

POLICY_EXISTS=$(cast call $LOGIC "policy_exists(bytes32)(bool)" "$POLICY_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
STATUS="NOT FOUND"
[[ "$POLICY_EXISTS" == "true" ]] && STATUS="EXISTS"
printf "Policy:    %-66s → %s\n" "$POLICY_ADDR" "$STATUS"

# ── Press ────────────────────────────────────────────────────────────────────

PRESS_ACTIVE=$(cast call $LOGIC "is_press_active(bytes32,bytes32)(bool)" \
    "$POLICY_ADDR" "$PRESS_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
    "$POLICY_ADDR" "$PRESS_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
PRESS_STATUS="NOT ACTIVE"
[[ "$PRESS_ACTIVE" == "true" ]] && PRESS_STATUS="ACTIVE (seq=$SEQ)"
printf "Press:     %-66s → %s\n" "$PRESS_ADDR" "$PRESS_STATUS"

# ── Cards ────────────────────────────────────────────────────────────────────

if [[ "$CARD_COUNT" -gt 0 ]]; then
    echo ""
    for i in $(seq 0 $((CARD_COUNT - 1))); do
        CARD_ADDR=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d['cards'][$i]['card_address'])")
        EXPECTED_CID=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d['cards'][$i]['cid'])")

        CARD_EXISTS=$(cast call $LOGIC "card_exists(bytes32)(bool)" "$CARD_ADDR" \
            --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)

        if [[ "$CARD_EXISTS" == "true" ]]; then
            ENTRY=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" \
                "$CARD_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
            ON_CHAIN_CID=$(echo "$ENTRY" | awk 'NR==1{print $1}')
            FWD=$(echo "$ENTRY" | awk 'NR==4{print $1}')
            FWD_STR="fwd=none"
            if [[ "$FWD" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]]; then
                FWD_STR="fwd=$FWD"
            fi
            CID_SHORT="${ON_CHAIN_CID:0:18}..."
            printf "Card %-2s:   %-66s → EXISTS  CID=%s  %s\n" "$i" "$CARD_ADDR" "$CID_SHORT" "$FWD_STR"
        else
            printf "Card %-2s:   %-66s → NOT FOUND\n" "$i" "$CARD_ADDR"
        fi
    done
fi

# ── Sub-card ─────────────────────────────────────────────────────────────────

if [[ -n "$SUB_ADDR" ]]; then
    echo ""
    SUB_ENTRY=$(cast call $LOGIC "get_sub_card_entry(bytes32)(bytes32,bytes,bytes,bool,uint64,uint64)" \
        "$SUB_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
    SUB_ACTIVE=$(echo "$SUB_ENTRY" | awk 'NR==4{print $1}')
    SUB_STATUS="NOT FOUND"
    [[ "$SUB_ACTIVE" == "true" ]] && SUB_STATUS="ACTIVE"
    [[ "$SUB_ACTIVE" == "false" ]] && SUB_STATUS="DEREGISTERED"
    printf "Sub-card:  %-66s → %s\n" "$SUB_ADDR" "$SUB_STATUS"
fi

# ── Governance health ─────────────────────────────────────────────────────────

echo ""
GOV_RESULT=$(cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
GOV_VER=$(echo "$GOV_RESULT" | awk 'NR==4{print $1}')
GOV_QUORUM=$(echo "$GOV_RESULT" | awk 'NR==3{print $1}')
GOV_KEY_COUNT=$(echo "$GOV_RESULT" | awk 'NR==2{print $1}')
printf "Governance (body=0): version=%s  quorum=%s  key_count=%s\n" "$GOV_VER" "$GOV_QUORUM" "$GOV_KEY_COUNT"

# Check if there's a pending upgrade
PENDING_LOGIC=$(cast call $LOGIC "get_pending_logic_upgrade()(address,uint64,uint32,bytes32)" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null | awk 'NR==1{print $1}')
if [[ "$PENDING_LOGIC" != "0x0000000000000000000000000000000000000000" ]]; then
    echo "⚠ Pending logic upgrade: $PENDING_LOGIC"
fi

echo ""
echo "State file: $STATE_FILE"
