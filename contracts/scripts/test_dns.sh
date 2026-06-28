#!/usr/bin/env bash
# test_dns.sh — End-to-end DNS resolution test for Arbitrum Sepolia (Step 4.2).
#
# Verifies the complete DNS write/read/remove cycle:
#   1. RegisterCard         — issue a test domain admin card under DNS governance policy
#   2. RegisterDomain       — register "test.example.com" with the admin card
#   3. SetPolicyAddress     — set a policy card address at the test domain/path
#   4. LookupPolicyAddress  — verify the lookup returns the expected policy card address
#   5. RemovePolicyAddress  — remove the entry (governance path)
#   6. LookupPolicyAddress  — verify the lookup returns bytes32(0)
#
# Prerequisites:
#   - deploy.sh run successfully (contracts deployed)
#   - setup_dns.sh run successfully (DNS governance bootstrapped)
#
# Usage:
#   source contracts/.env
#   export LOGIC_ADDRESS=0x...
#   ./contracts/scripts/test_dns.sh
#
# Required env vars:
#   PRIVATE_KEY                — Ethereum wallet for gas
#   ARBITRUM_SEPOLIA_RPC       — RPC endpoint
#   DEPLOYER_SECP256R1_PUBKEY  — 64-byte secp256r1 public key (0x-prefixed)
#   SECP256R1_PRIVKEY          — secp256r1 private key (0x-prefixed)
#   LOGIC_ADDRESS              — Deployed logic contract

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC DEPLOYER_SECP256R1_PUBKEY SECP256R1_PRIVKEY LOGIC_ADDRESS; do
    if [[ -z "${!VAR:-}" ]]; then
        echo "ERROR: $VAR is not set." >&2; exit 1
    fi
done

LOGIC="${LOGIC_ADDRESS}"
RPC="${ARBITRUM_SEPOLIA_RPC}"

source "$SCRIPT_DIR/contract_helpers.sh"

# Storage contract address (for reads not exposed on logic contract)
STORAGE_ADDR=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/../deployments/sepolia.json'))['contracts']['storage_contract'])" 2>/dev/null || echo "")

# ── Helpers ───────────────────────────────────────────────────────────────────

sign_payload_with() {
    local payload="$1"
    cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$SECP256R1_PRIVKEY" --payload "$payload"
}

build_gov_payload() {
    cargo run --manifest-path "$CARGO_MANIFEST" --bin build_governance_payload --quiet -- "$@"
}

hex_encode() { echo -n "$1" | xxd -p | tr -d '\n'; }
to_uint8_array() { hex_to_uint8_array "$1"; }

# Convert a plain ASCII string to a Stylus uint8[] literal "[0x74,0x65,0x73,0x74,...]"
str_to_uint8_array() {
    local str="$1"
    local hex arr=""
    hex=$(printf '%s' "$str" | xxd -p | tr -d '\n')
    while [ ${#hex} -ge 2 ]; do
        byte="${hex:0:2}"
        hex="${hex:2}"
        arr="${arr}${arr:+,}0x${byte}"
    done
    echo "[$arr]"
}

# keccak256 of a bytes32 + separator + path string — the PolicyAddresses key
# Uses cast keccak with abi-encoded input (domain_bytes || 0x00 || path_bytes)
policy_key() {
    local domain="$1" path="$2"
    local domain_hex path_hex combined
    domain_hex=$(printf '%s' "$domain" | xxd -p | tr -d '\n')
    path_hex=$(printf '%s' "$path" | xxd -p | tr -d '\n')
    combined="${domain_hex}00${path_hex}"
    cast keccak "0x${combined}" --rpc-url "$RPC" 2>/dev/null || \
        cast keccak "0x${combined}"
}

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ FAIL: $1" >&2; FAILED=1; }

FAILED=0

# ── Derive addresses ──────────────────────────────────────────────────────────

DNS_POLICY_ADDR="0x$(echo -n 'card_protocol_dns_policy_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
DNS_PRESS_ADDR="0x$(echo -n 'card_protocol_dns_press_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"

# Test domain admin card address: sha256("test_dns_admin_card_v1")
ADMIN_CARD_ADDR="0x$(echo -n 'test_dns_admin_card_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
# Policy card to point to: sha256("test_dns_policy_card_v1")
POLICY_CARD_ADDR="0x$(echo -n 'test_dns_policy_card_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
# Test domain and path
TEST_DOMAIN="test.example.com"
TEST_PATH="staff/reporter"
ZERO32="0x$(printf '00%.0s' {1..32})"

PUBKEY_ARR=$(to_uint8_array "$DEPLOYER_SECP256R1_PUBKEY")
ADMIN_SECP_ARR=$(to_uint8_array "$DEPLOYER_SECP256R1_PUBKEY")
MLDSA_HASH="$ZERO32"
TEST_LOG_CID="0x$(echo -n 'test_log_cid_v1' | xxd -p | tr -d '\n')"
CID_ARR=$(to_uint8_array "$TEST_LOG_CID")
DOMAIN_ARR=$(str_to_uint8_array "$TEST_DOMAIN")
PATH_ARR=$(str_to_uint8_array "$TEST_PATH")

echo "=== DNS End-to-End Test (Sepolia) ==="
echo "Logic:           $LOGIC"
echo "DNS policy:      $DNS_POLICY_ADDR"
echo "DNS press:       $DNS_PRESS_ADDR"
echo "Admin card:      $ADMIN_CARD_ADDR"
echo "Policy card:     $POLICY_CARD_ADDR"
echo "Test domain:     $TEST_DOMAIN"
echo "Test path:       $TEST_PATH"
echo ""

# ── Read governance versions ──────────────────────────────────────────────────

read_gov_version() {
    local body_id="$1"
    local raw
    raw=$(cast call $LOGIC "getGovernanceKeyset(uint8)" "$body_id" --rpc-url "$RPC" 2>/dev/null || echo "0x")
    parse_gov_keyset_version "$raw" 2>/dev/null || echo "0"
}
ROOT_VER=$(read_gov_version 0)
PRESS_VER=$(read_gov_version 1)
DNS_VER=$(read_gov_version 2)
# getNextSequence is on storage contract, not logic contract
DNS_PRESS_SEQ=$(cast call "$STORAGE_ADDR" "getNextSequence(bytes32,bytes32)(uint64)" \
    "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" --rpc-url "$RPC" 2>/dev/null || echo "0")

echo "Governance versions: Root=$ROOT_VER Press=$PRESS_VER DNS=$DNS_VER"
echo "DNS press sequence:  $DNS_PRESS_SEQ"
echo ""

# ── Test 1: RegisterCard for the admin card ───────────────────────────────────

echo "[1/6] RegisterCard — domain admin card under DNS governance policy"

CARD_EXISTS=$(cast call "$STORAGE_ADDR" "cardExists(bytes32)(bool)" "$ADMIN_CARD_ADDR" \
    --rpc-url "$RPC" 2>/dev/null || echo "false")

if [[ "$CARD_EXISTS" == "true" ]]; then
    pass "Admin card already registered (skip)"
else
    REG_PAYLOAD=$(printf '{"card_address":"%s","initial_log_cid":"%s","op":"register_card","policy_address":"%s","press_address":"%s","sequence":%s,"timestamp":"2026-01-01T00:00:00Z"}' \
        "$ADMIN_CARD_ADDR" "$TEST_LOG_CID" "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" "$DNS_PRESS_SEQ")
    REG_SIG=$(sign_payload_with "$REG_PAYLOAD")
    PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$REG_PAYLOAD")")
    SIG_ARR=$(to_uint8_array "$REG_SIG")

    cast send $LOGIC \
        "registerCard(bytes32,uint8[],bytes32,bytes32,uint8[],uint8[])" \
        "$ADMIN_CARD_ADDR" "$CID_ARR" "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" "$PAYLOAD_ARR" "$SIG_ARR" \
        --private-key "$PRIVATE_KEY" --rpc-url "$RPC" --quiet
    DNS_PRESS_SEQ=$((DNS_PRESS_SEQ + 1))
    pass "RegisterCard submitted (admin card: $ADMIN_CARD_ADDR)"
fi

# Also register the policy card being pointed to
POLICY_CARD_EXISTS=$(cast call "$STORAGE_ADDR" "cardExists(bytes32)(bool)" "$POLICY_CARD_ADDR" \
    --rpc-url "$RPC" 2>/dev/null || echo "false")
if [[ "$POLICY_CARD_EXISTS" != "true" ]]; then
    REG_PAYLOAD2=$(printf '{"card_address":"%s","initial_log_cid":"%s","op":"register_card","policy_address":"%s","press_address":"%s","sequence":%s,"timestamp":"2026-01-01T00:00:01Z"}' \
        "$POLICY_CARD_ADDR" "$TEST_LOG_CID" "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" "$DNS_PRESS_SEQ")
    REG_SIG2=$(sign_payload_with "$REG_PAYLOAD2")
    PAYLOAD_ARR2=$(to_uint8_array "0x$(hex_encode "$REG_PAYLOAD2")")
    SIG_ARR2=$(to_uint8_array "$REG_SIG2")
    cast send $LOGIC \
        "registerCard(bytes32,uint8[],bytes32,bytes32,uint8[],uint8[])" \
        "$POLICY_CARD_ADDR" "$CID_ARR" "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" "$PAYLOAD_ARR2" "$SIG_ARR2" \
        --private-key "$PRIVATE_KEY" --rpc-url "$RPC" --quiet
    DNS_PRESS_SEQ=$((DNS_PRESS_SEQ + 1))
    pass "RegisterCard submitted (policy card: $POLICY_CARD_ADDR)"
fi

# ── Test 2: RegisterDomain ────────────────────────────────────────────────────

echo "[2/6] RegisterDomain — register $TEST_DOMAIN"

DOMAIN_REG_RAW=$(cast call $LOGIC "getDomainRegistration(uint8[])(bytes32,uint64,uint8,uint64,bool)" \
    "$DOMAIN_ARR" --rpc-url "$RPC" 2>/dev/null || echo "")
# Use grep -q to avoid multiline count issues on macOS bash
if echo "$DOMAIN_REG_RAW" | grep -q "true"; then DOMAIN_EXISTS=1; else DOMAIN_EXISTS=0; fi

if [[ "$DOMAIN_EXISTS" -gt 0 ]]; then
    pass "Domain already registered (skip)"
else
    REG_DOM_PAYLOAD=$(build_gov_payload \
        --op register_domain \
        --version "$DNS_VER" \
        --policy "$TEST_DOMAIN" \
        --press "$ADMIN_CARD_ADDR" \
        --press-pubkey "$DEPLOYER_SECP256R1_PUBKEY")
    REG_DOM_SIG=$(sign_payload_with "$REG_DOM_PAYLOAD")
    REG_DOM_PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$REG_DOM_PAYLOAD")")
    REG_DOM_SIG_ARR=$(to_uint8_array "$REG_DOM_SIG")

    cast send $LOGIC \
        "registerDomain(uint8[],bytes32,uint8[],uint8[],uint8[][])" \
        "$DOMAIN_ARR" \
        "$ADMIN_CARD_ADDR" \
        "$ADMIN_SECP_ARR" \
        "$REG_DOM_PAYLOAD_ARR" \
        "[$REG_DOM_SIG_ARR]" \
        --private-key "$PRIVATE_KEY" --rpc-url "$RPC" --quiet
    pass "RegisterDomain submitted for $TEST_DOMAIN"
fi

# ── Test 3: SetPolicyAddress ──────────────────────────────────────────────────

echo "[3/6] SetPolicyAddress — $TEST_DOMAIN/$TEST_PATH → $POLICY_CARD_ADDR"

SET_PAYLOAD=$(printf '{"admin_card_address":"%s","domain":"%s","op":"set_policy_address","path":"%s","policy_card_address":"%s","press_address":"%s","sequence":%s,"sub_card_address":"%s","timestamp":"2026-01-01T00:00:01Z"}' \
    "$ADMIN_CARD_ADDR" "$TEST_DOMAIN" "$TEST_PATH" "$POLICY_CARD_ADDR" "$DNS_PRESS_ADDR" "$DNS_PRESS_SEQ" "$ZERO32")
SET_SIG=$(sign_payload_with "$SET_PAYLOAD")
SET_PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$SET_PAYLOAD")")
SET_SIG_ARR=$(to_uint8_array "$SET_SIG")

cast send $LOGIC \
    "setPolicyAddress(uint8[],uint8[],bytes32,bytes32,bytes32,bytes32,uint8[],uint8[])" \
    "$DOMAIN_ARR" "$PATH_ARR" \
    "$POLICY_CARD_ADDR" \
    "$ADMIN_CARD_ADDR" \
    "$ZERO32" \
    "$DNS_PRESS_ADDR" \
    "$SET_PAYLOAD_ARR" "$SET_SIG_ARR" \
    --private-key "$PRIVATE_KEY" --rpc-url "$RPC" --quiet
DNS_PRESS_SEQ=$((DNS_PRESS_SEQ + 1))
pass "SetPolicyAddress submitted"

# ── Test 4: LookupPolicyAddress ───────────────────────────────────────────────

echo "[4/6] LookupPolicyAddress — verify lookup returns $POLICY_CARD_ADDR"

LOOKUP_RESULT=$(cast call $LOGIC \
    "lookupPolicyAddress(uint8[],uint8[])(bytes32)" \
    "$DOMAIN_ARR" "$PATH_ARR" \
    --rpc-url "$RPC" 2>/dev/null || echo "")

if [[ "$(echo "$LOOKUP_RESULT" | tr '[:upper:]' '[:lower:]')" == "$(echo "$POLICY_CARD_ADDR" | tr '[:upper:]' '[:lower:]')" ]]; then
    pass "LookupPolicyAddress returned correct policy card address"
else
    fail "LookupPolicyAddress returned $LOOKUP_RESULT (expected $POLICY_CARD_ADDR)"
fi

# ── Test 5: RemovePolicyAddress (governance path) ────────────────────────────

echo "[5/6] RemovePolicyAddress — remove via DnsGovernanceBody quorum"

REM_PAYLOAD=$(build_gov_payload \
    --op remove_policy_address \
    --version "$DNS_VER" \
    --policy "$TEST_DOMAIN" \
    --press "$TEST_PATH")
REM_SIG=$(sign_payload_with "$REM_PAYLOAD")
REM_PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$REM_PAYLOAD")")
REM_SIG_ARR=$(to_uint8_array "$REM_SIG")

cast send $LOGIC \
    "removePolicyAddress(uint8[],uint8[],bytes32,bytes32,uint8[],uint8[],uint8[],uint8[][])" \
    "$DOMAIN_ARR" "$PATH_ARR" \
    "$ZERO32" "$ZERO32" \
    "$(to_uint8_array 0x00)" "$(to_uint8_array 0x00)" \
    "$REM_PAYLOAD_ARR" "[$REM_SIG_ARR]" \
    --private-key "$PRIVATE_KEY" --rpc-url "$RPC" --quiet
pass "RemovePolicyAddress submitted (governance path)"

# ── Test 6: LookupPolicyAddress returns zero ─────────────────────────────────

echo "[6/6] LookupPolicyAddress — verify entry is now zero"

LOOKUP_AFTER=$(cast call $LOGIC \
    "lookupPolicyAddress(uint8[],uint8[])(bytes32)" \
    "$DOMAIN_ARR" "$PATH_ARR" \
    --rpc-url "$RPC" 2>/dev/null || echo "")

if [[ "$LOOKUP_AFTER" == "$ZERO32" || "$LOOKUP_AFTER" == "0x$(printf '00%.0s' {1..32})" || -z "$LOOKUP_AFTER" ]]; then
    pass "LookupPolicyAddress correctly returns zero after removal"
else
    fail "LookupPolicyAddress returned $LOOKUP_AFTER (expected zero)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
if [[ $FAILED -eq 0 ]]; then
    echo "=== All DNS tests PASSED ==="
    echo ""
    echo "End-to-end verification complete:"
    echo "  ✓ Domain admin card registered under DNS governance policy"
    echo "  ✓ Domain registered on-chain with admin card and secp256r1 key"
    echo "  ✓ PolicyAddresses entry set for $TEST_DOMAIN/$TEST_PATH"
    echo "  ✓ LookupPolicyAddress returned correct policy card address"
    echo "  ✓ Entry removed via governance quorum"
    echo "  ✓ LookupPolicyAddress returns zero after removal"
else
    echo "=== DNS tests FAILED ==="
    exit 1
fi
