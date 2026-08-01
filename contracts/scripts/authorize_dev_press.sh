#!/usr/bin/env bash
# authorize_dev_press.sh — Submit AuthorizePress on-chain for the shared dev
# press, under the dev-tests policy registered by register_dev_policy.sh.
#
# PressRegistryBody (Body 1) was never rotated (see
# plans/deployment/dev-governance-rotation-runbook.md — only Body 0 and
# Body 2 were rotated to dev-tests-owned keys). Body 1 therefore still holds
# its original 1-of-1 deployer keyset, set at deploy time via
# storage.initialize(logic_address, deployer_pubkey) (see deploy.sh). So
# this script signs with the original deployer's SECP256R1_PRIVKEY, not any
# dev-tests key — modeled directly on setup_dns.sh's tested AuthorizePress
# step.
#
# The press's own secp256r1 and ML-DSA-44 public keys (from
# press/scripts/gen-press-keys.mjs) are public values, safe to pass as
# plain args -- only the corresponding private keys must stay out of any
# agent session.
#
# Usage:
#   export PRIVATE_KEY=...              # Ethereum wallet paying gas
#   export ARBITRUM_SEPOLIA_RPC=...
#   export LOGIC_ADDRESS=0x...
#   export DEPLOYER_SECP256R1_PUBKEY=... # original 1-of-1 deploy-time key
#   # Signing key: either
#   export SECP256R1_PRIVKEY=...          # 32-byte hex, OR
#   export SECP256R1_KEY_PEM=/path/to/key.pem   # SEC1 PEM file (-----BEGIN EC PRIVATE KEY-----)
#   ./contracts/scripts/authorize_dev_press.sh <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

POLICY_ADDRESS="${1:?Usage: $0 <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>}"
PRESS_PUBKEY="${2:?Usage: $0 <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>}"
PRESS_MLDSA_PUBKEY="${3:?Usage: $0 <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>}"

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC LOGIC_ADDRESS DEPLOYER_SECP256R1_PUBKEY; do
  if [[ -z "${!VAR:-}" ]]; then
    echo "ERROR: $VAR is not set." >&2
    exit 1
  fi
done

if [[ -z "${SECP256R1_PRIVKEY:-}" && -z "${SECP256R1_KEY_PEM:-}" ]]; then
  echo "ERROR: set either SECP256R1_PRIVKEY (32-byte hex) or SECP256R1_KEY_PEM (path to a PEM file)." >&2
  exit 1
fi

LOGIC="${LOGIC_ADDRESS}"
RPC="${ARBITRUM_SEPOLIA_RPC}"
NETWORK="sepolia"

command -v cast >/dev/null || { echo "ERROR: cast not found. Install Foundry." >&2; exit 1; }
command -v cargo >/dev/null || { echo "ERROR: cargo not found." >&2; exit 1; }

source "$SCRIPT_DIR/contract_helpers.sh"

build_gov_payload() {
  cargo run --manifest-path "$CARGO_MANIFEST" --bin build_governance_payload --quiet -- "$@"
}
sign_gov_payload() {
  if [[ -n "${SECP256R1_KEY_PEM:-}" ]]; then
    cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
      --key "$SECP256R1_KEY_PEM" --payload "$1"
  else
    cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
      --key-hex "$SECP256R1_PRIVKEY" --payload "$1"
  fi
}
hex_encode() { echo -n "$1" | xxd -p | tr -d '\n'; }
to_uint8_array() { hex_to_uint8_array "$1"; }

STORAGE_ADDR="${STORAGE_ADDRESS:-$(python3 -c "import json; print(json.load(open('$CONTRACTS_DIR/deployments/${NETWORK}.json'))['contracts']['storage_contract'])")}"

# Press's on-chain identity: keccak256(secp256r1 pubkey), same derivation
# test_03_create_card.sh and setup_dns.sh use.
PRESS_ADDR=$(cast keccak "$PRESS_PUBKEY")
MLDSA_HASH=$(cast keccak "$PRESS_MLDSA_PUBKEY")

echo "=== Authorize dev press ==="
echo "Logic:            $LOGIC"
echo "Policy address:   $POLICY_ADDRESS"
echo "Press pubkey:      $PRESS_PUBKEY"
echo "Press address:     $PRESS_ADDR (= keccak256(press pubkey))"
echo "ML-DSA-44 hash:    $MLDSA_HASH (= keccak256(press mldsa44 pubkey))"
echo ""

PRESS_ACTIVE=$(cast call "$STORAGE_ADDR" "isPressActive(bytes32,bytes32)(bool)" \
  "$POLICY_ADDRESS" "$PRESS_ADDR" --rpc-url "$RPC")
if [[ "$PRESS_ACTIVE" == "true" ]]; then
  echo "✓ Press already active under this policy — nothing to do."
  exit 0
fi

echo "Reading current PressRegistryBody (Body 1) governance version..."
RAW=$(cast call "$LOGIC" "getGovernanceKeyset(uint8)" 1 --rpc-url "$RPC")
CURRENT_VERSION=$(parse_gov_keyset_version "$RAW")
CURRENT_COUNT=$(parse_gov_keyset_count "$RAW")
CURRENT_QUORUM=$(parse_gov_keyset_quorum "$RAW")
echo "  Current: key_count=$CURRENT_COUNT quorum=$CURRENT_QUORUM version=$CURRENT_VERSION"
if [[ "$CURRENT_COUNT" != "1" ]]; then
  echo "WARNING: expected key_count=1 (Body 1 was never rotated) but got $CURRENT_COUNT." >&2
  echo "Confirm SECP256R1_PRIVKEY still matches Body 1's current keyset before continuing." >&2
fi
echo ""

PAYLOAD=$(build_gov_payload --op authorize_press --version "$CURRENT_VERSION")
SIG=$(sign_gov_payload "$PAYLOAD")

PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
SIG_ARR=$(to_uint8_array "$SIG")
PUBKEY_ARR=$(to_uint8_array "$PRESS_PUBKEY")
DEPLOYER_PUBKEY_ARR=$(to_uint8_array "$DEPLOYER_SECP256R1_PUBKEY")

echo "  Payload: $PAYLOAD"
echo "  Sig:     $SIG"
echo ""
read -r -p "Submit AuthorizePress transaction for $PRESS_ADDR? (y/N) " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

cast send "$LOGIC" \
  "authorizePress(bytes32,bytes32,uint8[],bytes32,uint8[],uint8[][])" \
  "$POLICY_ADDRESS" \
  "$PRESS_ADDR" \
  "$PUBKEY_ARR" \
  "$MLDSA_HASH" \
  "$PAYLOAD_ARR" \
  "[${SIG_ARR}]" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$RPC"

echo "✓ AuthorizePress submitted."
echo ""
echo "Verifying..."
PRESS_ACTIVE_F=$(cast call "$STORAGE_ADDR" "isPressActive(bytes32,bytes32)(bool)" \
  "$POLICY_ADDRESS" "$PRESS_ADDR" --rpc-url "$RPC")
echo "isPressActive($POLICY_ADDRESS, $PRESS_ADDR) = $PRESS_ACTIVE_F"
[[ "$PRESS_ACTIVE_F" == "true" ]] || { echo "ERROR: press still not active after transaction." >&2; exit 1; }

echo ""
echo "PRESS_ADDRESS=$PRESS_ADDR"
