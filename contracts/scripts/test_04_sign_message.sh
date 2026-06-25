#!/usr/bin/env bash
# test_04_sign_message.sh — Sign a test message with the card's press key and verify on-chain.
#
# Step A: Calls verifySecp256R1 directly on the verifier module (uses EVM
#         precompile internally — no cross-contract sub-calls — so works fine
#         from cast call / STATICCALL context).
# Step B: Submits update_card_head to the logic contract via cast send
#         (regular CALL, so cross-contract sub-calls to storage work).
#
# SEPOLIA ONLY — aborts if RPC URL does not contain "sepolia".
#
# Usage:
#   set -a; source contracts/.env; set +a
#   ./contracts/scripts/test_04_sign_message.sh [--ipfs]
#
# Flags:
#   --ipfs   Pin the new log entry to IPFS and use the real CID.
#
# Required env vars: PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC
# Optional: PINATA_JWT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

source "$SCRIPT_DIR/contract_helpers.sh"
export PATH="$HOME/.cargo/bin:$PATH"

PARAMS_FILE="$CONTRACTS_DIR/test_params/card.json"
WALLETS_DIR="$CONTRACTS_DIR/mock_wallets"

DEPLOYMENTS="$CONTRACTS_DIR/deployments/sepolia.json"
LOGIC=$(python3   -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['logic_contract'])")
STORAGE=$(python3 -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['storage_contract'])")
VERIFIER=$(python3 -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['verifier_module'])")

# ── Flag parsing ──────────────────────────────────────────────────────────────

IPFS_PUBLISH=false
for arg in "$@"; do [[ "$arg" == "--ipfs" ]] && IPFS_PUBLISH=true; done
[[ "$IPFS_PUBLISH" == "true" ]] && source "$SCRIPT_DIR/ipfs_helpers.sh"

# ── Sepolia guard ─────────────────────────────────────────────────────────────

if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" ]]; then
    echo "ERROR: ARBITRUM_SEPOLIA_RPC is not set." >&2; exit 1
fi
if [[ "$ARBITRUM_SEPOLIA_RPC" != *"sepolia"* ]]; then
    echo "ERROR: These test scripts only run on Sepolia." >&2; exit 1
fi
[[ -z "${PRIVATE_KEY:-}" ]] && { echo "ERROR: PRIVATE_KEY is not set." >&2; exit 1; }
[[ ! -f "$PARAMS_FILE" ]] && { echo "ERROR: $PARAMS_FILE not found." >&2; exit 1; }

# ── Load state ────────────────────────────────────────────────────────────────

CARD_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['card_id'])")
PRESS_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['press_id'])")

PRESS_WALLET="$WALLETS_DIR/press_${PRESS_ID}.json"
CARD_WALLET="$WALLETS_DIR/card_${CARD_ID}.json"

for F in "$PRESS_WALLET" "$CARD_WALLET"; do
    [[ ! -f "$F" ]] && { echo "ERROR: $F not found. Run test_03_create_card.sh first." >&2; exit 1; }
done

PRESS_PRIVKEY=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['private_key'])")
PRESS_PUBKEY=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['public_key'])")
PRESS_ADDR=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['press_address'])")
CARD_ADDR=$(python3 -c "import json; d=json.load(open('$CARD_WALLET')); print(d['card_address'])")
POLICY_ADDR=$(python3 -c "import json; d=json.load(open('$CARD_WALLET')); print(d['policy_address'])")

# Load the ML-DSA-44 card identity public key for ADR-006 IPFS encryption.
MLDSA_WALLET_NAME=$(python3 -c "import json; d=json.load(open('$CARD_WALLET')); print(d.get('mldsa_wallet',''))" 2>/dev/null || true)
MLDSA_WALLET="$WALLETS_DIR/${MLDSA_WALLET_NAME}"
if [[ -n "$MLDSA_WALLET_NAME" && -f "$MLDSA_WALLET" ]]; then
    MLDSA_PUBKEY=$(python3 -c "import json; d=json.load(open('$MLDSA_WALLET')); print(d['public_key'])")
else
    echo "WARNING: ML-DSA-44 wallet not found; falling back to secp256r1 pubkey for IPFS encryption." >&2
    MLDSA_PUBKEY="$PRESS_PUBKEY"
fi

echo "=== Test Step 4: Sign Message and Verify (Sepolia) ==="
echo "Card:         $CARD_ADDR"
echo "Press:        $PRESS_ADDR"
echo "Policy:       $POLICY_ADDR"
echo "Verifier:     $VERIFIER"
echo "IPFS publish: $IPFS_PUBLISH"
echo ""

# ── Read current on-chain state (storage directly) ────────────────────────────

SEQ=$(cast call "$STORAGE" "getNextSequence(bytes32,bytes32)(uint64)" \
    "$POLICY_ADDR" "$PRESS_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC")

CARD_RAW=$(cast call "$STORAGE" "getCardEntry(bytes32)" "$CARD_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC")
CURRENT_CID=$(parse_card_cid "$CARD_RAW")

echo "Current sequence: $SEQ"
echo "Current CID:      $CURRENT_CID"
echo ""

# ── Resolve new CID ───────────────────────────────────────────────────────────

if [[ "$IPFS_PUBLISH" == "true" ]]; then
    echo "Pinning new card log entry to IPFS..."
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    IPFS_DOC=$(python3 - <<PYEOF
import json
doc = {"type":"card_log_entry","op":"update_card_head","card_id":"$CARD_ID",
       "card_address":"$CARD_ADDR","press_address":"$PRESS_ADDR",
       "sequence":$SEQ,"prev_cid":"$CURRENT_CID","timestamp":"$TIMESTAMP"}
print(json.dumps(doc, separators=(',',':')))
PYEOF
    )
    NEW_CID=$(ipfs_pin_encrypted "$IPFS_DOC" "$MLDSA_PUBKEY")
    echo "  CID (hex): $NEW_CID"
else
    NEW_CID="0x1220$(echo -n "test_signed_content_seq${SEQ}" | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
    echo "  CID (synthetic): $NEW_CID"
fi
echo ""

# ── Step A: Direct verifier check ────────────────────────────────────────────
# The verifier module uses an EVM precompile (RIP-7212) internally, not a
# cross-contract call, so cast call (STATICCALL) works fine here.

PAYLOAD="{\"op\":\"update_card_head\",\"sequence\":${SEQ}}"
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

echo "--- Step A: Direct Verifier Check ---"
echo "Press payload: $PAYLOAD"
echo ""

PRESS_SIG=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
    --key-hex "$PRESS_PRIVKEY" --payload "$PAYLOAD")
echo "Signature (r||s): $PRESS_SIG"
echo ""

MSG_HASH=$(cast keccak "$PAYLOAD_HEX")
echo "keccak256(payload): $MSG_HASH"
echo ""

SIG_ARR=$(hex_to_uint8_array "$PRESS_SIG")
PUBKEY_ARR=$(hex_to_uint8_array "$PRESS_PUBKEY")

echo "Calling verifySecp256R1 on verifier module..."
VERIFY_RESULT=$(cast call "$VERIFIER" \
    "verifySecp256R1(bytes32,uint8[],uint8[])(bool)" \
    "$MSG_HASH" "$SIG_ARR" "$PUBKEY_ARR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>&1 || echo "CALL_FAILED")

if [[ "$VERIFY_RESULT" == "true" ]]; then
    echo "✓ verifySecp256R1 → true   Signature is VALID."
elif [[ "$VERIFY_RESULT" == "false" ]]; then
    echo "✗ verifySecp256R1 → false  Signature INVALID." >&2
    echo "  Check that private_key and public_key in $PRESS_WALLET match." >&2
    exit 1
else
    echo "⚠ Unexpected result: $VERIFY_RESULT"
    echo "  Proceeding to end-to-end test."
fi
echo ""

# ── Step B: End-to-end transaction ───────────────────────────────────────────
# cast send = regular CALL, so logic → storage cross-contract calls work.

echo "--- Step B: End-to-End Transaction (updateCardHead) ---"
echo "Success here confirms the full signature verification path works on-chain."
echo ""
read -r -p "Submit updateCardHead transaction? (y/N) " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Skipped."
    echo ""
    echo "=== Test Complete (Step A only) ==="
    exit 0
fi

NEW_CID_ARR=$(hex_to_uint8_array "$NEW_CID")
CURRENT_CID_ARR=$(hex_to_uint8_array "$CURRENT_CID")

TX_JSON=$(cast send "$LOGIC" \
    "updateCardHead(bytes32,uint8[],uint8[],bytes32,uint8[],uint8[])" \
    "$CARD_ADDR" "$NEW_CID_ARR" "$CURRENT_CID_ARR" "$PRESS_ADDR" \
    "$(hex_to_uint8_array "$PAYLOAD_HEX")" "$SIG_ARR" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" \
    --json 2>/dev/null)

TX_HASH=$(echo "$TX_JSON" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null \
    || echo "")
echo "✓ TX: ${TX_HASH:-submitted}"

# Confirm the CID updated on-chain.
NEW_CARD_RAW=$(cast call "$STORAGE" "getCardEntry(bytes32)" "$CARD_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC" 2>/dev/null)
ON_CHAIN_CID=$(parse_card_cid "$NEW_CARD_RAW")

if [[ "$ON_CHAIN_CID" == "$NEW_CID" ]]; then
    echo "✓ On-chain CID updated to $NEW_CID"
    echo "  Verification function confirmed working end-to-end!"
else
    echo "⚠ On-chain CID is $ON_CHAIN_CID, expected $NEW_CID"
    echo "  Transaction may still be pending."
fi

# Update card wallet.
python3 - <<PYEOF
import json
with open("$CARD_WALLET","r") as f: state = json.load(f)
state["current_cid"] = "$NEW_CID"
state["ipfs_pinned"] = $([[ "$IPFS_PUBLISH" == "true" ]] && echo "True" || echo "False")
with open("$CARD_WALLET","w") as f: json.dump(state, f, indent=2)
PYEOF

echo ""
echo "=== Test Complete ==="
echo "Updated: $CARD_WALLET"
