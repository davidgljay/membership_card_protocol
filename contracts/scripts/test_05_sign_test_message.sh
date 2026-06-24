#!/usr/bin/env bash
# test_05_sign_test_message.sh — Sign a test message using the card's press key.
#
# Builds a SignedMessageEnvelope per specs/process_specs/card_signing.md:
#   - payload: type, content, senders, recipients, timestamp
#   - RFC 8785 canonical serialization (lexicographic key order, compact)
#   - SHA-256(canonical_bytes) signed with secp256r1 (Phase 1 approximation;
#     spec requires ML-DSA-44 over raw bytes in production)
#   - Verification is done locally — no network call needed
#
# Output:
#   mock_wallets/signed_message_<card_id>.json  — the full SignedMessageEnvelope
#
# SEPOLIA ONLY — only reads on-chain state; no transactions are submitted.
#
# Usage:
#   set -a; source contracts/.env; set +a
#   ./contracts/scripts/test_05_sign_test_message.sh [--message "your text here"]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"
export PATH="$HOME/.cargo/bin:$PATH"

PARAMS_FILE="$CONTRACTS_DIR/test_params/card.json"
WALLETS_DIR="$CONTRACTS_DIR/mock_wallets"
DEPLOYMENTS="$CONTRACTS_DIR/deployments/sepolia.json"

# ── Flag parsing ──────────────────────────────────────────────────────────────

MESSAGE="test message"
i=1
while [[ $i -le $# ]]; do
    if [[ "${!i}" == "--message" ]]; then
        i=$((i+1)); MESSAGE="${!i}"
    fi
    i=$((i+1))
done

# ── Sepolia guard ─────────────────────────────────────────────────────────────

if [[ -z "${ARBITRUM_SEPOLIA_RPC:-}" ]]; then
    echo "ERROR: ARBITRUM_SEPOLIA_RPC is not set." >&2; exit 1
fi
if [[ "$ARBITRUM_SEPOLIA_RPC" != *"sepolia"* ]]; then
    echo "ERROR: These test scripts only run on Sepolia." >&2; exit 1
fi
[[ ! -f "$PARAMS_FILE" ]] && { echo "ERROR: $PARAMS_FILE not found." >&2; exit 1; }

# ── Load wallet state ─────────────────────────────────────────────────────────

CARD_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['card_id'])")
PRESS_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['press_id'])")

PRESS_WALLET="$WALLETS_DIR/press_${PRESS_ID}.json"
CARD_WALLET="$WALLETS_DIR/card_${CARD_ID}.json"

for F in "$PRESS_WALLET" "$CARD_WALLET"; do
    [[ ! -f "$F" ]] && { echo "ERROR: $F not found. Run test_03 first." >&2; exit 1; }
done

PRESS_PRIVKEY=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['private_key'])")
PRESS_PUBKEY=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['public_key'])")
CARD_ADDR=$(python3 -c "import json; d=json.load(open('$CARD_WALLET')); print(d['card_address'])")

OUT_FILE="$WALLETS_DIR/signed_message_${CARD_ID}.json"

echo "=== Test Step 5: Sign Test Message ==="
echo "Card:    $CARD_ADDR"
echo "Message: \"$MESSAGE\""
echo ""

# ── Phase 1: Assemble payload (card_signing.md §Steps §Phase 1) ───────────────
# senders / recipients use the card's on-chain address as the mutable pointer.
# Both are self-addressed for this test.

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

PAYLOAD=$(python3 -c "
import json
payload = {
    'content':    '$MESSAGE',
    'recipients': ['$CARD_ADDR'],
    'senders':    ['$CARD_ADDR'],
    'timestamp':  '$TIMESTAMP',
    'type':       'text',
}
# Phase 2: RFC 8785 canonical serialization.
# RFC 8785 requires lexicographic key order and specific number/unicode rules.
# sort_keys=True with compact separators is the correct form for ASCII payloads.
print(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True))
")

echo "Canonical payload (RFC 8785):"
echo "  $PAYLOAD"
echo ""

# ── Phase 3: Sign canonical payload bytes ─────────────────────────────────────
# sign_card_message computes SHA-256(canonical_bytes) and signs with secp256r1.
# This is the Phase 1 approximation of the spec's ML-DSA-44 over raw bytes.

SIG=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_card_message --quiet -- \
    --key-hex "$PRESS_PRIVKEY" \
    --message "$PAYLOAD")

echo "Signature: $SIG"
echo ""

# ── Local signature verification ─────────────────────────────────────────────
# Signed messages are off-chain: the envelope is sent directly between parties
# along with the signer's public key. The recipient verifies by:
#   1. Deriving the on-chain address: keccak256(public_key)
#   2. Looking up the CID in the registry and decrypting the card from IPFS
#   3. Verifying the signature using the public key from the card document
#
# Step 3 — the cryptographic check — is what we test here. Steps 1-2 resolve
# the signer's card identity (chain of trust) and are a separate concern.

VERIFY=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_card_message --quiet -- \
    --pubkey "$PRESS_PUBKEY" \
    --message "$PAYLOAD" \
    --signature "$SIG")

if [[ "$VERIFY" == "true" ]]; then
    echo "✓ Signature verified locally (SHA-256 + secp256r1)"
else
    echo "✗ Local verification FAILED" >&2; exit 1
fi
echo ""

# ── Assemble SignedMessageEnvelope (card_signing.md §Phase 3 step 6) ──────────

PUBKEY_B64=$(python3 -c "
import base64, sys
b = bytes.fromhex(sys.argv[1].lstrip('0x'))
print(base64.urlsafe_b64encode(b).decode().rstrip('='))
" "$PRESS_PUBKEY")

SIG_B64=$(python3 -c "
import base64, sys
b = bytes.fromhex(sys.argv[1].lstrip('0x'))
print(base64.urlsafe_b64encode(b).decode().rstrip('='))
" "$SIG")

python3 - <<PYEOF
import json

payload = json.loads('$PAYLOAD')

envelope = {
    "payload": payload,
    "signatures": [
        {
            # Phase 1: secp256r1 + SHA-256. Production: ML-DSA-44 over raw bytes.
            "key_scheme":  "secp256r1_phase1",
            "public_key":  "$PUBKEY_B64",
            "signature":   "$SIG_B64"
        }
    ]
}

with open("$OUT_FILE", "w") as f:
    json.dump(envelope, f, indent=2)

print(json.dumps(envelope, indent=2))
PYEOF

echo ""
echo "=== Signed Message Complete ==="
echo "Written: $OUT_FILE"
