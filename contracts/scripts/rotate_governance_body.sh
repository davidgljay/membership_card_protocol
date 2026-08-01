#!/usr/bin/env bash
# rotate_governance_body.sh — Rotate one governance body's keyset on an
# already-deployed contract instance (e.g. the Sepolia dev deployment).
#
# Modeled directly on setup_dns.sh's tested RegisterPolicy/AuthorizePress/
# SetDnsGovernancePolicyAddress pattern (build payload -> sign with the
# CURRENT keyset -> confirm -> cast send), generalized to
# RotateGovernanceKeys for any body_id.
#
# Background: this repo's dev-tests suite needs narrower-scoped governance
# credentials than the shared bootstrap key (see
# plans/deployment/phase-3-summary.md's "governance-authority blocker").
# This script rotates ONE body (0 = RootPolicyBody, 2 = DnsGovernanceBody)
# away from the current keyset to a new one you provide -- it does not
# generate keys itself (see gen-dev-governance-keys.mjs, run that first,
# yourself, and keep the private keys out of any agent session).
#
# The contract enforces a floor: MIN_GOVERNANCE_KEYS = 3, and quorum must
# exceed key_count/2 (strict majority) -- see governance_ops.rs's
# rotate_governance_keys. You cannot rotate to fewer than 3 keys or to a
# quorum of half or less.
#
# Signing note: rotation is self-amending -- the transaction must be signed
# by a quorum of the body's CURRENT keyset, not the new one (see
# governance_ops.rs's own comment: "signatures are verified against the
# current keyset, not the new one"). On Sepolia today, both body 0 and
# body 2 are still 1-of-1 on the original deployer key (confirmed via a
# live getGovernanceKeyset read on 2026-07-30), so CURRENT_GOV_SECP256R1_PRIVKEY
# below is that deployer key for now -- one signature is sufficient.
#
# Usage:
#   source contracts/.env
#   export LOGIC_ADDRESS=0x...          # from deployments/sepolia.json
#   export PRIVATE_KEY=...              # Ethereum wallet paying gas
#   export ARBITRUM_SEPOLIA_RPC=...     # RPC endpoint
#   export CURRENT_GOV_SECP256R1_PRIVKEY=...   # current signer(s) for the body being rotated
#   ./contracts/scripts/rotate_governance_body.sh <body_id> <new_quorum> <pubkey1> <pubkey2> <pubkey3> [<pubkey4> ...]
#
# Example (rotate DNS governance body to 3 keys, quorum 2):
#   ./contracts/scripts/rotate_governance_body.sh 2 2 0xPUB1... 0xPUB2... 0xPUB3...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

BODY_ID="${1:?Usage: $0 <body_id> <new_quorum> <pubkey1> <pubkey2> <pubkey3> [...]}"
NEW_QUORUM="${2:?Usage: $0 <body_id> <new_quorum> <pubkey1> <pubkey2> <pubkey3> [...]}"
shift 2
NEW_PUBKEYS=("$@")

if [[ ${#NEW_PUBKEYS[@]} -lt 3 ]]; then
  echo "ERROR: need at least 3 new public keys (contract minimum: MIN_GOVERNANCE_KEYS=3)." >&2
  exit 1
fi
NEW_KEY_COUNT=${#NEW_PUBKEYS[@]}
if (( NEW_QUORUM * 2 <= NEW_KEY_COUNT )); then
  echo "ERROR: new_quorum ($NEW_QUORUM) must exceed key_count/2 ($NEW_KEY_COUNT/2) -- strict majority required." >&2
  exit 1
fi

for VAR in PRIVATE_KEY ARBITRUM_SEPOLIA_RPC CURRENT_GOV_SECP256R1_PRIVKEY LOGIC_ADDRESS; do
  if [[ -z "${!VAR:-}" ]]; then
    echo "ERROR: $VAR is not set." >&2
    exit 1
  fi
done

LOGIC="${LOGIC_ADDRESS}"
RPC="${ARBITRUM_SEPOLIA_RPC}"

command -v cast >/dev/null || { echo "ERROR: cast not found. Install Foundry." >&2; exit 1; }
command -v cargo >/dev/null || { echo "ERROR: cargo not found. Install Rust." >&2; exit 1; }

source "$SCRIPT_DIR/contract_helpers.sh"

build_gov_payload() {
  cargo run --manifest-path "$CARGO_MANIFEST" --bin build_governance_payload --quiet -- "$@"
}
sign_gov_payload() {
  local payload="$1"
  cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
    --key-hex "$CURRENT_GOV_SECP256R1_PRIVKEY" \
    --payload "$payload"
}
hex_encode() { echo -n "$1" | xxd -p | tr -d '\n'; }
to_uint8_array() { hex_to_uint8_array "$1"; }

echo "=== Rotate Governance Body $BODY_ID ==="
echo "Logic:       $LOGIC"
echo "New key_count: $NEW_KEY_COUNT, new quorum: $NEW_QUORUM"
echo ""

echo "Reading current governance version for body $BODY_ID..."
RAW=$(cast call "$LOGIC" "getGovernanceKeyset(uint8)" "$BODY_ID" --rpc-url "$RPC")
CURRENT_VERSION=$(parse_gov_keyset_version "$RAW")
CURRENT_COUNT=$(parse_gov_keyset_count "$RAW")
CURRENT_QUORUM=$(parse_gov_keyset_quorum "$RAW")
echo "  Current: key_count=$CURRENT_COUNT quorum=$CURRENT_QUORUM version=$CURRENT_VERSION"
echo ""

# Concatenate new pubkeys into a single flat hex string (64 bytes each, no
# 0x between them) for the actual on-chain uint8[] argument.
NEW_KEYS_FLAT_HEX="0x"
for PK in "${NEW_PUBKEYS[@]}"; do
  STRIPPED="${PK#0x}"
  if [[ ${#STRIPPED} -ne 128 ]]; then
    echo "ERROR: public key '$PK' is not 64 raw bytes (128 hex chars)." >&2
    exit 1
  fi
  NEW_KEYS_FLAT_HEX="${NEW_KEYS_FLAT_HEX}${STRIPPED}"
done

PAYLOAD=$(build_gov_payload --op rotate_governance_keys --body "$BODY_ID" --version "$CURRENT_VERSION" \
  --new-key-count "$NEW_KEY_COUNT" --new-quorum "$NEW_QUORUM" --new-keys-hex "$NEW_KEYS_FLAT_HEX")
SIG=$(sign_gov_payload "$PAYLOAD")
PAYLOAD_ARR=$(to_uint8_array "0x$(hex_encode "$PAYLOAD")")
SIG_ARR=$(to_uint8_array "$SIG")
NEW_KEYS_ARR=$(to_uint8_array "$NEW_KEYS_FLAT_HEX")

echo "  Payload: $PAYLOAD"
echo "  Sig:     $SIG"
echo ""
echo "This will permanently replace body $BODY_ID's governance keyset on $RPC."
echo "The current keyset (version $CURRENT_VERSION) will no longer be able to"
echo "authorize actions for this body after this transaction confirms."
read -r -p "Submit RotateGovernanceKeys transaction for body $BODY_ID? (y/N) " CONFIRM
[[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Aborted."; exit 0; }

cast send "$LOGIC" \
  "rotateGovernanceKeys(uint8,uint8[],uint8,uint8,uint8[],uint8[][])" \
  "$BODY_ID" \
  "$NEW_KEYS_ARR" \
  "$NEW_KEY_COUNT" \
  "$NEW_QUORUM" \
  "$PAYLOAD_ARR" \
  "[${SIG_ARR}]" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$RPC"

echo "✓ RotateGovernanceKeys submitted for body $BODY_ID."
echo ""
echo "Verifying new state..."
RAW_AFTER=$(cast call "$LOGIC" "getGovernanceKeyset(uint8)" "$BODY_ID" --rpc-url "$RPC")
echo "  New: key_count=$(parse_gov_keyset_count "$RAW_AFTER") quorum=$(parse_gov_keyset_quorum "$RAW_AFTER") version=$(parse_gov_keyset_version "$RAW_AFTER")"
