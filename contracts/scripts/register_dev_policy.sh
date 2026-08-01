#!/usr/bin/env bash
# register_dev_policy.sh — Submit RegisterPolicy on-chain for the shared
# dev-tests permissive policy (see press/scripts/pin-dev-policy.mjs and
# dev-tests/README.md's "Dev governance prerequisite").
#
# Signs with a 2-of-3 quorum from dev-tests' own rotated Body 0
# (RootPolicyBody) keyset -- DEV_TESTS_POLICY_GOV_PRIVKEY_1/2 -- not the
# original deployer key. Modeled on the same tested pattern as
# rotate_governance_body.sh / setup_dns.sh (read current state, build+sign
# payload, print for review, interactive confirmation, then cast send).
#
# The policy_authorizer_pubkey argument (a required, 64-byte secp256r1
# x||y key registered alongside the policy -- governance_ops.rs's
# register_policy) is derived automatically from
# DEV_TESTS_POLICY_GOV_PRIVKEY_1, so this policy's authorizer key is one
# dev-tests already controls.
#
# Usage:
#   source dev-tests/.env   # provides DEV_TESTS_POLICY_GOV_PRIVKEY_1/2/3
#   export LOGIC_ADDRESS=0x...
#   export PRIVATE_KEY=...              # Ethereum wallet paying gas
#   export ARBITRUM_SEPOLIA_RPC=...
#   ./contracts/scripts/register_dev_policy.sh <policy_address>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

POLICY_ADDRESS="${1:?Usage: $0 <policy_address>}"

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC LOGIC_ADDRESS DEV_TESTS_POLICY_GOV_PRIVKEY_1 DEV_TESTS_POLICY_GOV_PRIVKEY_2; do
  if [[ -z "${!VAR:-}" ]]; then
    echo "ERROR: $VAR is not set." >&2
    exit 1
  fi
done

LOGIC="${LOGIC_ADDRESS}"
RPC="${ARBITRUM_SEPOLIA_RPC}"

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

# Derive DEV_TESTS_POLICY_GOV_PRIVKEY_1's public key (x||y, 64 bytes) to use
# as this policy's authorizer key -- run from press/ where @noble/curves is
# already installed.
AUTHORIZER_PUBKEY=$(cd "$REPO_ROOT/press" && node -e "
  const { p256 } = require('@noble/curves/p256');
  const priv = Buffer.from(process.argv[1].replace(/^0x/, ''), 'hex');
  const pub = p256.getPublicKey(priv, false).slice(1);
  console.log('0x' + Buffer.from(pub).toString('hex'));
" "$DEV_TESTS_POLICY_GOV_PRIVKEY_1")

echo "=== Register dev-tests policy ==="
echo "Logic:            $LOGIC"
echo "Policy address:   $POLICY_ADDRESS"
echo "Authorizer pubkey: $AUTHORIZER_PUBKEY (derived from DEV_TESTS_POLICY_GOV_PRIVKEY_1)"
echo ""

echo "Reading current RootPolicyBody (Body 0) governance version..."
RAW=$(cast call "$LOGIC" "getGovernanceKeyset(uint8)" 0 --rpc-url "$RPC")
CURRENT_VERSION=$(parse_gov_keyset_version "$RAW")
CURRENT_COUNT=$(parse_gov_keyset_count "$RAW")
CURRENT_QUORUM=$(parse_gov_keyset_quorum "$RAW")
echo "  Current: key_count=$CURRENT_COUNT quorum=$CURRENT_QUORUM version=$CURRENT_VERSION"
if [[ "$CURRENT_COUNT" != "3" ]]; then
  echo "WARNING: expected key_count=3 (the rotated dev-tests keyset) but got $CURRENT_COUNT." >&2
  echo "Confirm Body 0 was actually rotated before continuing." >&2
fi
echo ""

PAYLOAD=$(build_gov_payload --op register_policy --version "$CURRENT_VERSION")

# Quorum = 2: sign with DEV_TESTS_POLICY_GOV_PRIVKEY_1 and _2.
SIG1=$(sign_with_key "$DEV_TESTS_POLICY_GOV_PRIVKEY_1" "$PAYLOAD")
SIG2=$(sign_with_key "$DEV_TESTS_POLICY_GOV_PRIVKEY_2" "$PAYLOAD")

PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
SIG1_ARR=$(to_uint8_array "$SIG1")
SIG2_ARR=$(to_uint8_array "$SIG2")
AUTHORIZER_ARR=$(to_uint8_array "$AUTHORIZER_PUBKEY")

echo "  Payload: $PAYLOAD"
echo "  Sig 1:   $SIG1"
echo "  Sig 2:   $SIG2"
echo ""
read -r -p "Submit RegisterPolicy transaction for $POLICY_ADDRESS? (y/N) " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

cast send "$LOGIC" \
  "registerPolicy(bytes32,uint8[],uint8[],uint8[][])" \
  "$POLICY_ADDRESS" \
  "$AUTHORIZER_ARR" \
  "$PAYLOAD_ARR" \
  "[${SIG1_ARR},${SIG2_ARR}]" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$RPC"

echo "✓ RegisterPolicy submitted."
echo ""
echo "Verifying..."
EXISTS=$(cast call "$(python3 -c "import json; print(json.load(open('$REPO_ROOT/contracts/deployments/sepolia.json'))['contracts']['storage_contract'])")" \
  "policyExists(bytes32)(bool)" "$POLICY_ADDRESS" --rpc-url "$RPC")
echo "policyExists($POLICY_ADDRESS) = $EXISTS"
