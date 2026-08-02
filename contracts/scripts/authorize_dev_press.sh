#!/usr/bin/env bash
# authorize_dev_press.sh — Submit AuthorizePress on-chain for the shared dev
# press, under the dev-tests policy registered by register_dev_policy.sh.
#
# Signs with a 2-of-3 quorum from dev-tests' own rotated Body 1
# (PressRegistryBody) keyset -- DEV_TESTS_PRESS_GOV_PRIVKEY_1/2 -- not the
# original deployer key. Body 1 was initially left un-rotated (see
# plans/deployment/phase-3-summary.md's "pending decision"), but this dev
# deployment's real use case turned out to be dev-tests itself, so it was
# rotated the same way as Body 0/2. This script predates that rotation and
# originally signed with the deployer's own key -- that now fails with
# InvalidGovernanceSignature (0xf21458ad) since Body 1 no longer trusts it,
# found live running this script after the rotation. Modeled on the same
# tested pattern as register_dev_policy.sh / rotate_governance_body.sh.
#
# The press's own secp256r1 and ML-DSA-44 public keys (from
# press/scripts/gen-press-keys.mjs) are public values, safe to pass as
# plain args -- only the corresponding private keys must stay out of any
# agent session.
#
# Usage:
#   source dev-tests/.env   # provides DEV_TESTS_PRESS_GOV_PRIVKEY_1/2/3
#   export PRIVATE_KEY=...              # Ethereum wallet paying gas
#   export ARBITRUM_SEPOLIA_RPC=...
#   export LOGIC_ADDRESS=0x...
#   ./contracts/scripts/authorize_dev_press.sh <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

POLICY_ADDRESS="${1:?Usage: $0 <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>}"
PRESS_PUBKEY="${2:?Usage: $0 <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>}"
PRESS_MLDSA_PUBKEY="${3:?Usage: $0 <policy_address> <press_secp256r1_pubkey> <press_mldsa44_pubkey>}"

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC LOGIC_ADDRESS DEV_TESTS_PRESS_GOV_PRIVKEY_1 DEV_TESTS_PRESS_GOV_PRIVKEY_2; do
  if [[ -z "${!VAR:-}" ]]; then
    echo "ERROR: $VAR is not set." >&2
    exit 1
  fi
done

LOGIC="${LOGIC_ADDRESS}"
RPC="${ARBITRUM_SEPOLIA_RPC}"
NETWORK="sepolia"

command -v cast >/dev/null || { echo "ERROR: cast not found. Install Foundry." >&2; exit 1; }
command -v cargo >/dev/null || { echo "ERROR: cargo not found." >&2; exit 1; }

source "$SCRIPT_DIR/contract_helpers.sh"

build_gov_payload() {
  cargo run --manifest-path "$CARGO_MANIFEST" --bin build_governance_payload --quiet -- "$@"
}
sign_with_key() {
  local key="$1" payload="$2"
  cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
    --key-hex "$key" --payload "$payload"
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
if [[ "$CURRENT_COUNT" != "3" ]]; then
  echo "WARNING: expected key_count=3 (the rotated dev-tests keyset) but got $CURRENT_COUNT." >&2
  echo "Confirm Body 1 was actually rotated before continuing." >&2
fi
echo ""

PAYLOAD=$(build_gov_payload --op authorize_press --version "$CURRENT_VERSION" \
  --policy "$POLICY_ADDRESS" --press "$PRESS_ADDR" --press-pubkey "$PRESS_PUBKEY")

# Quorum = 2: sign with DEV_TESTS_PRESS_GOV_PRIVKEY_1 and _2.
SIG1=$(sign_with_key "$DEV_TESTS_PRESS_GOV_PRIVKEY_1" "$PAYLOAD")
SIG2=$(sign_with_key "$DEV_TESTS_PRESS_GOV_PRIVKEY_2" "$PAYLOAD")

PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
SIG1_ARR=$(to_uint8_array "$SIG1")
SIG2_ARR=$(to_uint8_array "$SIG2")
PUBKEY_ARR=$(to_uint8_array "$PRESS_PUBKEY")

echo "  Payload: $PAYLOAD"
echo "  Sig 1:   $SIG1"
echo "  Sig 2:   $SIG2"
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
  "[${SIG1_ARR},${SIG2_ARR}]" \
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
