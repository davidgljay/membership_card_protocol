#!/usr/bin/env bash
# setup_dns.sh — Bootstrap the DNS Governance Authority on a freshly deployed contract.
#
# Performs the DNS-specific bootstrap sequence after deploy.sh has run:
#   1. RegisterPolicy — create the DNS governance policy (RootPolicyBody quorum)
#   2. AuthorizePress  — authorize the DNS governance press (PressRegistryBody quorum)
#   3. SetDnsGovernancePolicyAddress — wire the policy into storage (DnsGovernanceBody quorum)
#
# On Sepolia (1-of-1 bootstrap), all three steps use the same deployer secp256r1 key.
# On mainnet, each step requires the relevant quorum of board member signatures assembled
# out-of-band — this script handles the 1-of-1 test case only.
#
# Usage:
#   source contracts/.env
#   export LOGIC_ADDRESS=0x...      # from deployments/sepolia.json
#   export STORAGE_ADDRESS=0x...    # from deployments/sepolia.json
#   ./contracts/scripts/setup_dns.sh
#
# Required env vars:
#   PRIVATE_KEY                — Ethereum wallet for gas (not the signing key)
#   ARBITRUM_SEPOLIA_RPC       — RPC endpoint
#   DEPLOYER_SECP256R1_PUBKEY  — 64-byte secp256r1 public key (0x-prefixed)
#   SECP256R1_PRIVKEY          — secp256r1 private key for signing (0x-prefixed)
#   LOGIC_ADDRESS              — Deployed logic contract address
#   STORAGE_ADDRESS            — Deployed storage contract address

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

# ── Validation ────────────────────────────────────────────────────────────────

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC DEPLOYER_SECP256R1_PUBKEY SECP256R1_PRIVKEY LOGIC_ADDRESS; do
    if [[ -z "${!VAR:-}" ]]; then
        echo "ERROR: $VAR is not set." >&2
        exit 1
    fi
done

LOGIC="${LOGIC_ADDRESS}"
RPC="${ARBITRUM_SEPOLIA_RPC}"
NETWORK="sepolia"

if ! command -v cast &>/dev/null; then
    echo "ERROR: cast not found. Install Foundry." >&2; exit 1
fi
if ! command -v cargo &>/dev/null; then
    echo "ERROR: cargo not found. Install Rust." >&2; exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

source "$SCRIPT_DIR/contract_helpers.sh"

sign_gov_payload() {
    local payload="$1"
    cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$SECP256R1_PRIVKEY" \
        --payload "$payload"
}

build_gov_payload() {
    cargo run --manifest-path "$CARGO_MANIFEST" --bin build_governance_payload --quiet -- "$@"
}

hex_encode() { echo -n "$1" | xxd -p | tr -d '\n'; }

# Convert a 0x-prefixed hex string to a Stylus uint8[] array literal "[0x12,0x34,...]"
to_uint8_array() { hex_to_uint8_array "$1"; }

# base64url-encode a 0x-hex bytes32 value for inclusion in governance payload JSON
hex32_to_b64url() {
    local hex="${1#0x}"
    printf '%s' "$hex" | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='
}

# ── Derive deterministic DNS addresses from deployer key ─────────────────────

# DNS governance policy address: sha256("card_protocol_dns_policy_v1")
DNS_POLICY_ADDR="0x$(echo -n 'card_protocol_dns_policy_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"

# DNS governance press address: sha256("card_protocol_dns_press_v1")
DNS_PRESS_ADDR="0x$(echo -n 'card_protocol_dns_press_v1' | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"

# MLDSA44 key hash placeholder (all zeros — press is secp-only for Phase 1)
MLDSA_HASH="0x$(printf '00%.0s' {1..32})"

echo "=== DNS Governance Bootstrap ==="
echo "Logic:          $LOGIC"
echo "DNS policy:     $DNS_POLICY_ADDR"
echo "DNS press:      $DNS_PRESS_ADDR"
echo ""

# ── Step 1: Read governance versions ─────────────────────────────────────────

echo "Reading governance versions..."
# Use raw hex output and parse with contract_helpers parse_gov_keyset_version.
# getGovernanceKeyset returns (bytes keys_flat, uint8 key_count, uint8 quorum, uint32 version, uint8 key_scheme).
# The bytes field shifts awk line offsets depending on ABI encoding; raw hex parsing is reliable.
read_gov_version() {
    local body_id="$1"
    local raw
    raw=$(cast call $LOGIC "getGovernanceKeyset(uint8)" "$body_id" --rpc-url "$RPC" 2>/dev/null || echo "0x")
    parse_gov_keyset_version "$raw" 2>/dev/null || echo "0"
}

ROOT_VER=$(read_gov_version 0)
echo "  RootPolicyBody version: $ROOT_VER"

PRESS_VER=$(read_gov_version 1)
echo "  PressRegistryBody version: $PRESS_VER"

DNS_VER=$(read_gov_version 2)
echo "  DnsGovernanceBody version: $DNS_VER"

# ── Step 2: Register DNS governance policy (RootPolicyBody quorum) ────────────

# policyExists and isPressActive are storage contract reads (not exposed on logic contract).
STORAGE_ADDR="${STORAGE_ADDRESS:-$(python3 -c "import json; print(json.load(open('$CONTRACTS_DIR/deployments/${NETWORK:-sepolia}.json'))['contracts']['storage_contract'])" 2>/dev/null || echo "")}"
POLICY_EXISTS=$(cast call "$STORAGE_ADDR" "policyExists(bytes32)(bool)" "$DNS_POLICY_ADDR" \
    --rpc-url "$RPC" 2>/dev/null || echo "false")

if [[ "$POLICY_EXISTS" == "true" ]]; then
    echo "✓ DNS governance policy already registered: $DNS_POLICY_ADDR"
else
    echo ""
    echo "--- RegisterPolicy (DNS governance policy) ---"
    PAYLOAD=$(build_gov_payload --op register_policy --version "$ROOT_VER")
    SIG=$(sign_gov_payload "$PAYLOAD")
    PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
    SIG_ARR=$(to_uint8_array "$SIG")
    PUBKEY_ARR=$(to_uint8_array "$DEPLOYER_SECP256R1_PUBKEY")

    echo "  Payload: $PAYLOAD"
    echo "  Sig:     $SIG"
    read -r -p "Submit RegisterPolicy transaction? (y/N) " CONFIRM
    [[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

    cast send $LOGIC \
        "registerPolicy(bytes32,uint8[],uint8[],uint8[][])" \
        "$DNS_POLICY_ADDR" \
        "$PUBKEY_ARR" \
        "$PAYLOAD_ARR" \
        "[${SIG_ARR}]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$RPC"
    echo "✓ RegisterPolicy submitted"
fi

# ── Step 3: Authorize DNS governance press (PressRegistryBody quorum) ─────────

PRESS_ACTIVE=$(cast call "$STORAGE_ADDR" "isPressActive(bytes32,bytes32)(bool)" \
    "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" \
    --rpc-url "$RPC" 2>/dev/null || echo "false")

if [[ "$PRESS_ACTIVE" == "true" ]]; then
    echo "✓ DNS governance press already active: $DNS_PRESS_ADDR"
else
    echo ""
    echo "--- AuthorizePress (DNS governance press) ---"
    PAYLOAD=$(build_gov_payload --op authorize_press --version "$PRESS_VER")
    SIG=$(sign_gov_payload "$PAYLOAD")
    PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
    SIG_ARR=$(to_uint8_array "$SIG")
    PUBKEY_ARR=$(to_uint8_array "$DEPLOYER_SECP256R1_PUBKEY")

    echo "  Payload: $PAYLOAD"
    echo "  Sig:     $SIG"
    read -r -p "Submit AuthorizePress transaction? (y/N) " CONFIRM
    [[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

    cast send $LOGIC \
        "authorizePress(bytes32,bytes32,uint8[],bytes32,uint8[],uint8[][])" \
        "$DNS_POLICY_ADDR" \
        "$DNS_PRESS_ADDR" \
        "$PUBKEY_ARR" \
        "$MLDSA_HASH" \
        "$PAYLOAD_ARR" \
        "[${SIG_ARR}]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$RPC"
    echo "✓ AuthorizePress submitted"
fi

# ── Step 4: SetDnsGovernancePolicyAddress (DnsGovernanceBody quorum) ──────────

CURRENT_DNS_POLICY=$(cast call $LOGIC "getDnsGovernancePolicyAddress()(bytes32)" \
    --rpc-url "$RPC" 2>/dev/null || echo "0x$(printf '00%.0s' {1..32})")

if [[ "$(echo "$CURRENT_DNS_POLICY" | tr '[:upper:]' '[:lower:]')" == "$(echo "$DNS_POLICY_ADDR" | tr '[:upper:]' '[:lower:]')" ]]; then
    echo "✓ DnsGovernancePolicyAddress already set to: $DNS_POLICY_ADDR"
else
    echo ""
    echo "--- SetDnsGovernancePolicyAddress ---"
    POLICY_B64=$(hex32_to_b64url "$DNS_POLICY_ADDR")
    PAYLOAD=$(build_gov_payload --op set_dns_governance_policy_address \
        --version "$DNS_VER" \
        --address "$DNS_POLICY_ADDR")
    SIG=$(sign_gov_payload "$PAYLOAD")
    PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
    SIG_ARR=$(to_uint8_array "$SIG")

    echo "  New policy: $DNS_POLICY_ADDR"
    echo "  Payload: $PAYLOAD"
    echo "  Sig:     $SIG"
    read -r -p "Submit SetDnsGovernancePolicyAddress transaction? (y/N) " CONFIRM
    [[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

    cast send $LOGIC \
        "setDnsGovernancePolicyAddress(bytes32,uint8[],uint8[][])" \
        "$DNS_POLICY_ADDR" \
        "$PAYLOAD_ARR" \
        "[${SIG_ARR}]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$RPC"
    echo "✓ SetDnsGovernancePolicyAddress submitted"
fi

# ── Final state verification ──────────────────────────────────────────────────

echo ""
echo "=== Verifying DNS Bootstrap State ==="
POLICY_EXISTS_F=$(cast call "$STORAGE_ADDR" "policyExists(bytes32)(bool)" "$DNS_POLICY_ADDR" \
    --rpc-url "$RPC" 2>/dev/null || echo "false")
PRESS_ACTIVE_F=$(cast call "$STORAGE_ADDR" "isPressActive(bytes32,bytes32)(bool)" \
    "$DNS_POLICY_ADDR" "$DNS_PRESS_ADDR" \
    --rpc-url "$RPC" 2>/dev/null || echo "false")
DNS_POLICY_F=$(cast call $LOGIC "getDnsGovernancePolicyAddress()(bytes32)" \
    --rpc-url "$RPC" 2>/dev/null || echo "0x00")

echo "DNS policy registered: $POLICY_EXISTS_F"
echo "DNS press active:      $PRESS_ACTIVE_F"
echo "DnsGovernancePolicyAddress: $DNS_POLICY_F"

if [[ "$POLICY_EXISTS_F" != "true" || "$PRESS_ACTIVE_F" != "true" ]]; then
    echo "ERROR: Bootstrap state check failed." >&2; exit 1
fi

echo ""
echo "=== DNS Bootstrap Complete ==="
echo "DNS_POLICY_ADDR=$DNS_POLICY_ADDR"
echo "DNS_PRESS_ADDR=$DNS_PRESS_ADDR"
echo ""
echo "NEXT: Run test_dns.sh to verify end-to-end DNS resolution."
echo "      Then register a production domain via governance/scripts/txt-verification.ts"
