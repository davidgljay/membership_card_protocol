#!/usr/bin/env bash
# test_03_create_card.sh — Generate a press keypair, authorize the press, and register a card.
#
# Reads go directly to the storage contract (STATICCALL restriction — see
# contract_helpers.sh). Writes go through the logic contract via cast send.
#
# SEPOLIA ONLY — aborts if RPC URL does not contain "sepolia".
#
# Usage:
#   set -a; source contracts/.env; set +a
#   ./contracts/scripts/test_03_create_card.sh [--ipfs]
#
# Flags:
#   --ipfs   Pin the initial card log entry to IPFS and use the real CID on-chain.
#            Requires a running local IPFS daemon OR PINATA_JWT env var.
#
# Required env vars: PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC, SECP256R1_PRIVKEY
# Optional: PINATA_JWT  (only needed with --ipfs if no local daemon)
#
# ⚠ Prompts before each transaction.
#
# Address derivation
# ──────────────────
# In Phase 1, the press's secp256r1 keypair serves as both the write-authorization
# key (used in registerCard / updateCardHead) and the card-holder signing identity
# (used in SignedMessageEnvelope). The on-chain addresses are therefore:
#
#   press_address = card_address = keccak256(press_secp256r1_public_key_bytes)
#
# This matches what the membership_card_verifier computes in stage 2:
#   signerCard = keccak256(publicKeyBytes)
#
# The previous scheme — SHA-256("card_protocol_<id>") — was a name-based shortcut
# that broke verifyEnvelope because the derived identity never matched the
# registered address.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CARGO_MANIFEST="$SCRIPT_DIR/Cargo.toml"

source "$SCRIPT_DIR/contract_helpers.sh"
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"

PARAMS_FILE="$CONTRACTS_DIR/test_params/card.json"
POLICY_STATE="$CONTRACTS_DIR/mock_wallets/policy.json"
WALLETS_DIR="$CONTRACTS_DIR/mock_wallets"

DEPLOYMENTS="$CONTRACTS_DIR/deployments/sepolia.json"
LOGIC=$(python3   -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['logic_contract'])")
STORAGE=$(python3 -c "import json; d=json.load(open('$DEPLOYMENTS')); print(d['contracts']['storage_contract'])")

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
for VAR in PRIVATE_KEY SECP256R1_PRIVKEY; do
    [[ -z "${!VAR:-}" ]] && { echo "ERROR: $VAR is not set." >&2; exit 1; }
done
for F in "$PARAMS_FILE" "$POLICY_STATE"; do
    if [[ ! -f "$F" ]]; then
        echo "ERROR: $F not found." >&2
        [[ "$F" == "$POLICY_STATE" ]] && echo "  Run test_02_create_policy.sh first." >&2
        exit 1
    fi
done

# ── Load params ───────────────────────────────────────────────────────────────

PARAMS_NETWORK=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d.get('network',''))")
[[ "$PARAMS_NETWORK" == "sepolia" ]] || { echo "ERROR: card.json must have \"network\": \"sepolia\"" >&2; exit 1; }

CARD_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['card_id'])")
PRESS_ID=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['press_id'])")
CID_LABEL=$(python3 -c "import json; d=json.load(open('$PARAMS_FILE')); print(d['initial_cid_label'])")
POLICY_ADDR=$(python3 -c "import json; d=json.load(open('$POLICY_STATE')); print(d['policy_address'])")

PRESS_WALLET="$WALLETS_DIR/press_${PRESS_ID}.json"
CARD_WALLET="$WALLETS_DIR/card_${CARD_ID}.json"

# ── Generate press keypair (or load existing) ─────────────────────────────────
# Address derivation must happen AFTER the keypair is known, because
# press_address = keccak256(press_secp256r1_public_key_bytes).

if [[ -f "$PRESS_WALLET" ]]; then
    echo "Loading existing press keypair: $PRESS_WALLET"
    PRESS_PRIVKEY=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['private_key'])")
    PRESS_PUBKEY=$(python3 -c "import json; d=json.load(open('$PRESS_WALLET')); print(d['public_key'])")
else
    echo "Generating new P-256 press keypair..."
    KEYPAIR_JSON=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin gen_keypair --quiet)
    PRESS_PRIVKEY=$(echo "$KEYPAIR_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['private_key'])")
    PRESS_PUBKEY=$(echo "$KEYPAIR_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['public_key'])")
fi

# ── ML-DSA-44 card holder identity keypair ────────────────────────────────────
# Per ADR-006, IPFS content is encrypted under HKDF-SHA3-256(recipient_pubkey)
# where recipient_pubkey is the ML-DSA-44 public key (1312 bytes), not secp256r1.
MLDSA_WALLET="$WALLETS_DIR/mldsa_${CARD_ID}.json"
if [[ -f "$MLDSA_WALLET" ]]; then
    echo "Loading existing ML-DSA-44 keypair: $MLDSA_WALLET"
    MLDSA_PUBKEY=$(python3 -c "import json; d=json.load(open('$MLDSA_WALLET')); print(d['public_key'])")
else
    echo "Generating new ML-DSA-44 card identity keypair..."
    MLDSA_JSON=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin gen_mldsa_keypair --quiet)
    MLDSA_PRIVKEY=$(echo "$MLDSA_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['private_key'])")
    MLDSA_PUBKEY=$(echo "$MLDSA_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['public_key'])")
    python3 - <<PYEOF
import json
wallet = {"network":"sepolia","card_id":"$CARD_ID",
          "private_key":"$MLDSA_PRIVKEY","public_key":"$MLDSA_PUBKEY",
          "note":"ML-DSA-44 (FIPS 204) card holder identity key. Used as recipient_pubkey for ADR-006 content encryption."}
with open("$MLDSA_WALLET","w") as f: json.dump(wallet, f, indent=2)
PYEOF
    echo "  ✓ ML-DSA-44 wallet written: $MLDSA_WALLET"
fi

# Derive press address = keccak256(press_pubkey_bytes).
# PRESS_PUBKEY is "0x<128 hex chars>" (64 bytes x||y). cast keccak treats 0x-prefixed
# input as hex bytes and outputs a 0x-prefixed 32-byte keccak256 hash.
PRESS_ADDR=$(cast keccak "$PRESS_PUBKEY")

# In Phase 1 the press key IS the card-holder signing identity, so the card address
# is the same cryptographic hash.  The verifier derives signerCard = keccak256(pubkey)
# in stage 2; registering the card at this address makes verifyEnvelope work end-to-end.
CARD_ADDR="$PRESS_ADDR"

# Write (or re-write) the press wallet with the derived address.
# Re-writing is safe here: address is always recomputed from the public key, so
# wallets generated by older versions of this script are silently corrected.
mkdir -p "$WALLETS_DIR"
python3 - <<PYEOF
import json
wallet = {"network":"sepolia","press_id":"$PRESS_ID","press_address":"$PRESS_ADDR",
          "policy_address":"$POLICY_ADDR","private_key":"$PRESS_PRIVKEY","public_key":"$PRESS_PUBKEY"}
with open("$PRESS_WALLET","w") as f: json.dump(wallet, f, indent=2)
PYEOF
echo "  ✓ Press wallet written: $PRESS_WALLET"

echo ""
echo "=== Test Step 3: Create Card (Sepolia) ==="
echo "Card ID:        $CARD_ID"
echo "Card address:   $CARD_ADDR  (keccak256(press_pubkey))"
echo "Press ID:       $PRESS_ID"
echo "Press address:  $PRESS_ADDR  (= card_address in Phase 1)"
echo "Policy:         $POLICY_ADDR"
echo "IPFS publish:   $IPFS_PUBLISH"
echo "Press pubkey:   $PRESS_PUBKEY"
echo ""

# ── Authorize press (if not already active) ───────────────────────────────────
# Read from storage directly; write through logic.

PRESS_ACTIVE=$(cast call "$STORAGE" "isPressActive(bytes32,bytes32)(bool)" \
    "$POLICY_ADDR" "$PRESS_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC")

if [[ "$PRESS_ACTIVE" == "true" ]]; then
    echo "✓ Press already active — skipping authorizePress."
else
    echo "Authorizing press (PressRegistryBody quorum)..."

    PRESS_KEYSET_RAW=$(cast call "$STORAGE" "getGovernanceKeyset(uint8)" 1 \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC")
    PRESS_GOV_VER=$(parse_gov_keyset_version "$PRESS_KEYSET_RAW")

    NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
    GOV_PAYLOAD="{\"governance_version\":${PRESS_GOV_VER},\"nonce\":\"${NONCE}\",\"op\":\"authorize_press\"}"
    GOV_PAYLOAD_HEX="0x$(echo -n "$GOV_PAYLOAD" | xxd -p | tr -d '\n')"
    GOV_SIG=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$SECP256R1_PRIVKEY" --payload "$GOV_PAYLOAD")
    MLDSA_HASH="0x0000000000000000000000000000000000000000000000000000000000000000"

    PUBKEY_ARR=$(hex_to_uint8_array "$PRESS_PUBKEY")
    PAYLOAD_ARR=$(hex_to_uint8_array "$GOV_PAYLOAD_HEX")
    SIG_ARR=$(hex_to_uint8_array "$GOV_SIG")

    echo "Gov payload: $GOV_PAYLOAD"
    echo ""
    read -r -p "Submit authorizePress? (y/N) " CONFIRM
    [[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "Aborted."; exit 0; }

    cast send "$LOGIC" \
        "authorizePress(bytes32,bytes32,uint8[],bytes32,uint8[],uint8[][])" \
        "$POLICY_ADDR" "$PRESS_ADDR" "$PUBKEY_ARR" "$MLDSA_HASH" "$PAYLOAD_ARR" "[$SIG_ARR]" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC"

    PRESS_ACTIVE=$(cast call "$STORAGE" "isPressActive(bytes32,bytes32)(bool)" \
        "$POLICY_ADDR" "$PRESS_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC")
    [[ "$PRESS_ACTIVE" == "true" ]] || { echo "ERROR: press still not active after transaction." >&2; exit 1; }
    echo "✓ Press authorized."
fi
echo ""

# ── Register card (if not already exists) ─────────────────────────────────────

CARD_EXISTS=$(cast call "$STORAGE" "cardExists(bytes32)(bool)" "$CARD_ADDR" \
    --rpc-url "$ARBITRUM_SEPOLIA_RPC")

if [[ "$CARD_EXISTS" == "true" ]]; then
    echo "✓ Card already registered — skipping registerCard."
    [[ "$IPFS_PUBLISH" == "true" ]] && echo "  (card exists; skipping IPFS pin)"
    CARD_RAW=$(cast call "$STORAGE" "getCardEntry(bytes32)" "$CARD_ADDR" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC")
    INITIAL_CID=$(parse_card_cid "$CARD_RAW")
else
    SEQ=$(cast call "$STORAGE" "getNextSequence(bytes32,bytes32)(uint64)" \
        "$POLICY_ADDR" "$PRESS_ADDR" --rpc-url "$ARBITRUM_SEPOLIA_RPC")

    # Resolve CID
    if [[ "$IPFS_PUBLISH" == "true" ]]; then
        echo "Pinning initial card log entry to IPFS..."
        TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        IPFS_DOC=$(python3 - <<PYEOF
import json
doc = {"type":"card_log_entry","op":"register_card","card_id":"$CARD_ID",
       "card_address":"$CARD_ADDR","policy_address":"$POLICY_ADDR",
       "press_address":"$PRESS_ADDR","sequence":0,"timestamp":"$TIMESTAMP","label":"$CID_LABEL"}
print(json.dumps(doc, separators=(',',':')))
PYEOF
        )
        INITIAL_CID=$(ipfs_pin_encrypted "$IPFS_DOC" "$MLDSA_PUBKEY")
        echo "  CID (hex): $INITIAL_CID"
    else
        INITIAL_CID="0x1220$(echo -n "$CID_LABEL" | openssl dgst -sha256 -binary | xxd -p | tr -d '\n')"
        echo "  CID (synthetic): $INITIAL_CID"
    fi
    echo ""

    PRESS_PAYLOAD="{\"op\":\"register_card\",\"sequence\":${SEQ}}"
    PRESS_PAYLOAD_HEX="0x$(echo -n "$PRESS_PAYLOAD" | xxd -p | tr -d '\n')"
    PRESS_SIG=$(cargo run --manifest-path "$CARGO_MANIFEST" --bin sign_payload --quiet -- \
        --key-hex "$PRESS_PRIVKEY" --payload "$PRESS_PAYLOAD")

    CID_ARR=$(hex_to_uint8_array "$INITIAL_CID")
    PRESS_PAYLOAD_ARR=$(hex_to_uint8_array "$PRESS_PAYLOAD_HEX")
    PRESS_SIG_ARR=$(hex_to_uint8_array "$PRESS_SIG")

    echo "Press payload: $PRESS_PAYLOAD"
    echo ""
    read -r -p "Submit registerCard? (y/N) " CONFIRM
    [[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "Aborted."; exit 0; }

    cast send "$LOGIC" \
        "registerCard(bytes32,uint8[],bytes32,bytes32,uint8[],uint8[])" \
        "$CARD_ADDR" "$CID_ARR" "$POLICY_ADDR" "$PRESS_ADDR" "$PRESS_PAYLOAD_ARR" "$PRESS_SIG_ARR" \
        --private-key "$PRIVATE_KEY" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC"

    CARD_EXISTS=$(cast call "$STORAGE" "cardExists(bytes32)(bool)" "$CARD_ADDR" \
        --rpc-url "$ARBITRUM_SEPOLIA_RPC")
    [[ "$CARD_EXISTS" == "true" ]] || { echo "ERROR: card not found after transaction." >&2; exit 1; }
    echo "✓ Card registered."
fi

# ── Write card wallet ─────────────────────────────────────────────────────────

python3 - <<PYEOF
import json
wallet = {"network":"sepolia","card_id":"$CARD_ID","card_address":"$CARD_ADDR",
          "policy_address":"$POLICY_ADDR","press_id":"$PRESS_ID",
          "press_address":"$PRESS_ADDR","current_cid":"$INITIAL_CID",
          "mldsa_wallet":"mldsa_$CARD_ID.json",
          "ipfs_pinned":$([[ "$IPFS_PUBLISH" == "true" ]] && echo "True" || echo "False")}
with open("$CARD_WALLET","w") as f: json.dump(wallet, f, indent=2)
PYEOF

echo ""
echo "=== Card Created ==="
echo "Press wallet: $PRESS_WALLET"
echo "Card wallet:  $CARD_WALLET"
echo ""
echo "Next: run test_04_sign_message.sh"
