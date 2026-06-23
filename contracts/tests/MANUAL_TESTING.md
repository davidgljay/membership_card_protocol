# Manual Testing Guide — Card Protocol on Arbitrum Sepolia

Self-contained reference for calling every protocol function against the live Sepolia deployment
using `cast` (Foundry), `openssl`, and the `sign_payload` / `build_governance_payload` Rust helpers.

---

## Prerequisites

```bash
# 1. Source the environment (private keys, RPC URL)
source contracts/.env

# 2. Verify toolchain
cast --version      # foundry ≥ 0.2
cargo --version     # rustup-managed, e.g. 1.78+
openssl version     # for key inspection

# 3. Build signing helpers once (subsequent runs are fast)
cargo build --manifest-path contracts/scripts/Cargo.toml --release --bins --quiet
```

---

## Contract Addresses

| Contract         | Address                                      |
|------------------|----------------------------------------------|
| Logic contract   | `0xc6bf998e1c8dd989b296405af9c5d07cc833f938` |
| Storage contract | `0x9272a5123a3a773d67d909f774fb88e4b260ce82` |
| Verifier module  | `0xdf4c20783a1c88f47363adbcf654a12f35d77d3e` |

```bash
LOGIC=0xc6bf998e1c8dd989b296405af9c5d07cc833f938
STORAGE=0x9272a5123a3a773d67d909f774fb88e4b260ce82
```

---

## ABI Encoding Notes

- All "card addresses" and "policy addresses" are **`bytes32`** (not EVM `address`). Pass as `0x`-prefixed 32-byte hex.
- `bytes` arguments: pass `0x`-prefixed hex. To hex-encode a JSON string:
  ```bash
  HEX="0x$(echo -n '{"op":"register_card","sequence":0}' | xxd -p | tr -d '\n')"
  ```
- `bytes[]` for governance sigs: `"[0x<sig1_hex>]"` (one element array, 64 bytes each).

---

## Read-Only Functions

All reads call the **logic contract** (which delegates to storage).

### get_governance_keyset

Returns: `(keys_flat bytes, key_count uint8, quorum uint8, version uint32, key_scheme uint8)`

```bash
# RootPolicyBody (body_id=0)
cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"

# PressRegistryBody (body_id=1)
cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 1 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### get_card_entry

Returns: `(log_head_cid bytes, policy_address bytes32, last_press_address bytes32, forward_to bytes32, exists bool)`

```bash
CARD_ADDR=0x0000000000000000000000000000000000000000000000000000000000000001
cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" $CARD_ADDR \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### card_exists

```bash
cast call $LOGIC "card_exists(bytes32)(bool)" $CARD_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### policy_exists

```bash
POLICY_ADDR=0x<32-byte-hex>
cast call $LOGIC "policy_exists(bytes32)(bool)" $POLICY_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### get_press_authorization

Returns: `(press_public_key bytes, mldsa44_key_hash bytes32, key_scheme uint8, active bool, next_sequence uint64, authorized_at uint64, revoked_at uint64)`

```bash
cast call $LOGIC "get_press_authorization(bytes32,bytes32)(bytes,bytes32,uint8,bool,uint64,uint64,uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### is_press_active

```bash
cast call $LOGIC "is_press_active(bytes32,bytes32)(bool)" $POLICY_ADDR $PRESS_ADDR \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### get_next_sequence

```bash
cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" $POLICY_ADDR $PRESS_ADDR \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### get_sub_card_entry

Returns: `(master_card_address bytes32, registration_log_head bytes, sub_card_doc_cid bytes, active bool, registered_at uint64, deregistered_at uint64)`

```bash
SUB_ADDR=0x<32-byte-hex>
cast call $LOGIC "get_sub_card_entry(bytes32)(bytes32,bytes,bytes,bool,uint64,uint64)" $SUB_ADDR \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### get_pending_logic_upgrade

Returns: `(proposed_address address, proposed_at uint64, governance_version uint32, nonce bytes32)`

```bash
cast call $LOGIC "get_pending_logic_upgrade()(address,uint64,uint32,bytes32)" \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### get_logic_contract / get_verifier_module / get_key_scheme_phase / get_policy_delete_disabled

```bash
cast call $LOGIC "get_logic_contract()(address)"       --rpc-url "$ARBITRUM_SEPOLIA_RPC"
cast call $LOGIC "get_verifier_module()(address)"      --rpc-url "$ARBITRUM_SEPOLIA_RPC"
cast call $LOGIC "get_key_scheme_phase()(uint8)"       --rpc-url "$ARBITRUM_SEPOLIA_RPC"
cast call $LOGIC "get_policy_delete_disabled()(bool)"  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

---

## Signing Payloads

The `sign_payload` binary computes `keccak256(payload_bytes)` and signs with P-256 RFC 6979.

```bash
# From PEM key file
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key \
  --payload '{"op":"register_card","sequence":0}')
echo $SIG   # 0x<128 hex chars>

# From hex private key (SECP256R1_PRIVKEY from .env)
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key-hex "$SECP256R1_PRIVKEY" \
  --payload '{"op":"register_card","sequence":0}')
```

### Generate a unique nonce

```bash
NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
```

### Build governance payloads

```bash
# Read current governance version first
GOV_VER=$(cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==4{print $1}')

NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')

PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op register_policy --version $GOV_VER --nonce $NONCE)
echo $PAYLOAD
```

---

## Governance Write Functions

All governance operations require:
1. A JSON payload with `"governance_version"` and `"nonce"` fields
2. A secp256r1 signature from the current governance keyset (quorum-many sigs)
3. `cast send` with `--private-key $PRIVATE_KEY` (Ethereum key for gas)

### §4.6 RegisterPolicy

```bash
# 1. Choose a unique policy address (bytes32)
POLICY_ADDR=0x$(xxd -p -l 32 /dev/urandom | tr -d '\n')

# 2. Read current governance version
GOV_VER=$(cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==4{print $1}')

# 3. Build payload
NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op register_policy --version $GOV_VER --nonce $NONCE)

# 4. Sign
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")

# 5. ABI-encode payload and sig
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

# 6. Send (confirm before submitting)
echo "Payload: $PAYLOAD"
echo "Sig: $SIG"
read -p "Submit register_policy? (y/N) " CONFIRM
[[ "$CONFIRM" == "y" ]] || exit 0

cast send $LOGIC \
  "register_policy(bytes32,bytes,bytes,bytes[])" \
  $POLICY_ADDR \
  "$DEPLOYER_SECP256R1_PUBKEY" \
  "$PAYLOAD_HEX" \
  "[$SIG]" \
  --private-key $PRIVATE_KEY \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"

# 7. Verify
cast call $LOGIC "policy_exists(bytes32)(bool)" $POLICY_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.7 AuthorizePress

Uses **PressRegistryBody** (body_id=1) governance keyset.

```bash
PRESS_ADDR=0x$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PRESS_PUBKEY="$DEPLOYER_SECP256R1_PUBKEY"  # 64-byte x||y

# Read PressRegistryBody version (body_id=1)
GOV_VER=$(cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 1 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==4{print $1}')

NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op authorize_press --version $GOV_VER --nonce $NONCE)
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "authorize_press(bytes32,bytes32,bytes,bytes32,bytes,bytes[])" \
  $POLICY_ADDR $PRESS_ADDR \
  "$PRESS_PUBKEY" \
  "0x0000000000000000000000000000000000000000000000000000000000000000" \
  "$PAYLOAD_HEX" \
  "[$SIG]" \
  --private-key $PRIVATE_KEY \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.8 RevokePress

```bash
NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op revoke_press --version $GOV_VER --nonce $NONCE)
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "revoke_press(bytes32,bytes32,bytes,bytes[])" \
  $POLICY_ADDR $PRESS_ADDR \
  "$PAYLOAD_HEX" "[$SIG]" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.9 RotateAuthorizerKey

```bash
NEW_KEY=0x$(python3 -c "import secrets; print(secrets.token_hex(64))")
NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op rotate_authorizer_key --version $GOV_VER --nonce $NONCE)
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "rotate_authorizer_key(bytes32,bytes,bytes,bytes[])" \
  $POLICY_ADDR "$NEW_KEY" \
  "$PAYLOAD_HEX" "[$SIG]" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.10 RotateGovernanceKeys

⚠️ This is a self-amending operation. The new keyset must satisfy `quorum > key_count / 2` and `key_count >= 3`.

```bash
# Generate 3 new test keys (run cargo keygen or use openssl)
# For testing, use deterministic placeholders (not real signing keys)
KEY0=0x$(xxd -p -l 64 /dev/urandom | tr -d '\n')
KEY1=0x$(xxd -p -l 64 /dev/urandom | tr -d '\n')
KEY2=0x$(xxd -p -l 64 /dev/urandom | tr -d '\n')

NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op rotate_governance_keys --body 0 --version $GOV_VER --nonce $NONCE \
  --new-key-count 3 --new-quorum 2 \
  --new-keys-hex "$(echo -n ${KEY0:2}${KEY1:2}${KEY2:2})")
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")

NEW_KEYS_FLAT="0x${KEY0:2}${KEY1:2}${KEY2:2}"
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "rotate_governance_keys(uint8,bytes,uint8,uint8,bytes,bytes[])" \
  0 "$NEW_KEYS_FLAT" 3 2 \
  "$PAYLOAD_HEX" "[$SIG]" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.14 ProposeLogicUpgrade / CancelLogicUpgrade

```bash
NEW_LOGIC_ADDR=0xdeadbeef00000000000000000000000000000001

NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op propose_logic_upgrade --version $GOV_VER --nonce $NONCE --address $NEW_LOGIC_ADDR)
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "propose_logic_upgrade(address,bytes,bytes[])" \
  $NEW_LOGIC_ADDR "$PAYLOAD_HEX" "[$SIG]" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"

# Confirm pending
cast call $LOGIC "get_pending_logic_upgrade()(address,uint64,uint32,bytes32)" \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"

# Cancel (fresh nonce)
NONCE2=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD2=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op cancel_logic_upgrade --version $GOV_VER --nonce $NONCE2 --address $NEW_LOGIC_ADDR)
SIG2=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD2")
PAYLOAD2_HEX="0x$(echo -n "$PAYLOAD2" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "cancel_logic_upgrade(bytes,bytes[])" \
  "$PAYLOAD2_HEX" "[$SIG2]" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.16 DisablePolicyDeletePermanently

⚠️ **Irreversible.** This permanently prevents `deregister_policy` from working.

```bash
NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
PAYLOAD=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin build_governance_payload --quiet -- \
  --op disable_policy_delete_permanently --version $GOV_VER --nonce $NONCE)
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD" | xxd -p | tr -d '\n')"

echo "WARNING: This is irreversible. Current status:"
cast call $LOGIC "get_policy_delete_disabled()(bool)" --rpc-url "$ARBITRUM_SEPOLIA_RPC"
read -p "Confirm disable_policy_delete_permanently? (y/N) " CONFIRM
[[ "$CONFIRM" == "y" ]] || exit 0

cast send $LOGIC \
  "disable_policy_delete_permanently(bytes,bytes[])" \
  "$PAYLOAD_HEX" "[$SIG]" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

---

## Card Write Functions

Card writes use the **press write gate** (§6.1):
- Payload must contain `"op"` and `"sequence"` fields
- Signature is over `keccak256(press_payload_json)`
- Sequence must match `get_next_sequence(policy, press)` on-chain

### §4.1 RegisterCard

```bash
CARD_ADDR=0x$(xxd -p -l 32 /dev/urandom | tr -d '\n')
CID="0x1220$(xxd -p -l 32 /dev/urandom | tr -d '\n')"  # 34 bytes: IPFS multihash prefix + sha256

# Read current sequence
SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC")

# Build and sign press payload
PAYLOAD_STR="{\"op\":\"register_card\",\"sequence\":$SEQ}"
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD_STR")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD_STR" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "register_card(bytes32,bytes,bytes32,bytes32,bytes,bytes)" \
  $CARD_ADDR "$CID" $POLICY_ADDR $PRESS_ADDR \
  "$PAYLOAD_HEX" "$SIG" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"

# Verify
cast call $LOGIC "card_exists(bytes32)(bool)" $CARD_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.2 UpdateCardHead

```bash
# Read current head CID
CURRENT_CID=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" \
  $CARD_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==1{print $1}')
NEW_CID="0x1220$(xxd -p -l 32 /dev/urandom | tr -d '\n')"

SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC")

PAYLOAD_STR="{\"op\":\"update_card_head\",\"sequence\":$SEQ}"
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD_STR")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD_STR" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "update_card_head(bytes32,bytes,bytes,bytes32,bytes,bytes)" \
  $CARD_ADDR "$NEW_CID" "$CURRENT_CID" $PRESS_ADDR \
  "$PAYLOAD_HEX" "$SIG" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.5 ClaimOpenOffer

```bash
OFFER_ID=0x$(xxd -p -l 32 /dev/urandom | tr -d '\n')
NEW_CARD=0x$(xxd -p -l 32 /dev/urandom | tr -d '\n')
CID="0x1220$(xxd -p -l 32 /dev/urandom | tr -d '\n')"
MAX_ACCEPTS=18446744073709551615  # type(uint64).max = unconstrained
EXPIRES_AT=0                      # 0 = no expiry

SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC")

PAYLOAD_STR="{\"op\":\"claim_open_offer\",\"sequence\":$SEQ}"
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD_STR")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD_STR" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "claim_open_offer(bytes32,uint64,uint64,bytes32,bytes,bytes32,bytes32,bytes,bytes)" \
  $OFFER_ID $MAX_ACCEPTS $EXPIRES_AT \
  $NEW_CARD "$CID" $POLICY_ADDR $PRESS_ADDR \
  "$PAYLOAD_HEX" "$SIG" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.13 RegisterAddressForward

The press signs `keccak256(holder_sig_payload)`. The holder's ML-DSA-44 sig is accepted in calldata for auditability but not verified on-chain.

```bash
# holder_sig_payload must contain op="register_address_forward"
HOLDER_PAYLOAD="{\"new_address\":\"$NEW_CARD_ADDR\",\"old_address\":\"$OLD_CARD_ADDR\",\"op\":\"register_address_forward\"}"
HOLDER_PAYLOAD_HEX="0x$(echo -n "$HOLDER_PAYLOAD" | xxd -p | tr -d '\n')"

# Press signs keccak256(holder_sig_payload)
PRESS_SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$HOLDER_PAYLOAD")

# Holder ML-DSA-44 sig (empty for Phase 1 testing; field accepted but not verified on-chain)
HOLDER_SIG="0x"

cast send $LOGIC \
  "register_address_forward(bytes32,bytes32,bytes32,bytes,bytes,bytes)" \
  $OLD_CARD_ADDR $NEW_CARD_ADDR $PRESS_ADDR \
  "$HOLDER_PAYLOAD_HEX" "$HOLDER_SIG" "$PRESS_SIG" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.15 BatchUpdateCardHeads

```bash
# Example: 2 cards
CARD1=0x<first-card-bytes32>
CARD2=0x<second-card-bytes32>
PREV_CID1=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" $CARD1 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==1{print $1}')
PREV_CID2=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" $CARD2 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==1{print $1}')
NEW_CID1="0x1220$(xxd -p -l 32 /dev/urandom | tr -d '\n')"
NEW_CID2="0x1220$(xxd -p -l 32 /dev/urandom | tr -d '\n')"

SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC")

PAYLOAD_STR="{\"op\":\"batch_update_card_heads\",\"sequence\":$SEQ}"
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD_STR")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD_STR" | xxd -p | tr -d '\n')"

# Note: arrays in cast use "[]" notation
cast send $LOGIC \
  "batch_update_card_heads(bytes32,bytes32,bytes32[],bytes[],bytes[],bytes,bytes)" \
  $POLICY_ADDR $PRESS_ADDR \
  "[$CARD1,$CARD2]" \
  "[$PREV_CID1,$PREV_CID2]" \
  "[$NEW_CID1,$NEW_CID2]" \
  "$PAYLOAD_HEX" "$SIG" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.3 RegisterSubCard

```bash
SUB_ADDR=0x$(xxd -p -l 32 /dev/urandom | tr -d '\n')
SUB_DOC_CID="0x1220$(xxd -p -l 32 /dev/urandom | tr -d '\n')"

# Get master card's current head CID (registration_log_head must match current head)
MASTER_CID=$(cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" \
  $MASTER_CARD --rpc-url "$ARBITRUM_SEPOLIA_RPC" | awk 'NR==1{print $1}')

SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC")

PAYLOAD_STR="{\"op\":\"register_sub_card\",\"sequence\":$SEQ}"
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD_STR")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD_STR" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "register_sub_card(bytes32,bytes32,bytes,bytes,bytes32,bytes,bytes,bytes,bytes)" \
  $SUB_ADDR $MASTER_CARD "$MASTER_CID" "$SUB_DOC_CID" $PRESS_ADDR \
  "$PAYLOAD_HEX" "$SIG" \
  "0x" "0x" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

### §4.4 DeregisterSubCard

```bash
SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" \
  $POLICY_ADDR $PRESS_ADDR --rpc-url "$ARBITRUM_SEPOLIA_RPC")

PAYLOAD_STR="{\"op\":\"deregister_sub_card\",\"sequence\":$SEQ}"
SIG=$(cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload --quiet -- \
  --key contracts/.keys/test_press.key --payload "$PAYLOAD_STR")
PAYLOAD_HEX="0x$(echo -n "$PAYLOAD_STR" | xxd -p | tr -d '\n')"

cast send $LOGIC \
  "deregister_sub_card(bytes32,bytes32,bytes,bytes,bytes,bytes)" \
  $SUB_ADDR $PRESS_ADDR \
  "$PAYLOAD_HEX" "$SIG" \
  "0x" "0x" \
  --private-key $PRIVATE_KEY --rpc-url "$ARBITRUM_SEPOLIA_RPC"
```

---

## Troubleshooting

### `InvalidPressSignature`

1. Verify the payload JSON is exactly what you signed (no extra whitespace):
   ```bash
   echo -n "$PAYLOAD_STR" | wc -c
   ```
2. Verify the `"op"` field matches the function you're calling:
   - `register_card`, `update_card_head`, `claim_open_offer`, `batch_update_card_heads`
   - `register_sub_card`, `deregister_sub_card`
   - `register_address_forward` (in holder_sig_payload)
3. Verify the press is active: `cast call $LOGIC "is_press_active(bytes32,bytes32)(bool)" ...`
4. For `register_address_forward`: confirm you're signing `holder_sig_payload`, not a sequence-based payload.

### `SequenceMismatch`

Read current sequence before signing:
```bash
SEQ=$(cast call $LOGIC "get_next_sequence(bytes32,bytes32)(uint64)" $POLICY_ADDR $PRESS_ADDR \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC")
```
The sequence in the signed payload must equal this value exactly.

### `GovernanceVersionMismatch`

Read current governance version before building governance payloads:
```bash
# RootPolicyBody (body_id=0)
cast call $LOGIC "get_governance_keyset(uint8)(bytes,uint8,uint8,uint32,uint8)" 0 \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
# Column 4 (0-indexed) is the version
```

### `NonceReused`

The nonce in a governance payload is stored as `keccak256(nonce_bytes)` and must never repeat.
Always generate a fresh random nonce:
```bash
NONCE=$(xxd -p -l 32 /dev/urandom | tr -d '\n')
```

### `StalePrevCid`

Read the current head before `update_card_head`:
```bash
cast call $LOGIC "get_card_entry(bytes32)(bytes,bytes32,bytes32,bytes32,bool)" $CARD_ADDR \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC"
# First return value is the current log_head_cid
```

### ABI encoding failures with `cast send`

- `bytes32` must be `0x`-prefixed 32-byte hex (64 hex chars + `0x`)
- `bytes` must be `0x`-prefixed hex
- `bytes[]` uses bracket notation: `"[0xhex1,0xhex2]"`
- If the array encoding causes issues, try wrapping in quotes: `'"[0xhex1]"'`
