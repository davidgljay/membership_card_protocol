#!/usr/bin/env bash
# contract_helpers.sh — ABI parsing and encoding helpers for Stylus contracts.
#
# Source this file in test scripts.
#
# Background:
#   - `cast call` issues a STATICCALL. The logic contract's cross-contract
#     calls to storage use a non-static Call internally (Stylus SDK 0.8
#     deprecated-API bug), so they all revert with 0x inside a static context.
#   - Reads therefore go directly to the storage contract.
#   - Writes (cast send) are regular CALLs, so logic → storage works fine.
#
#   - Stylus SDK 0.8 encodes multi-value returns as a tuple with an outer
#     0x20 pointer word. Single-value returns (bool, uint64, address) have
#     no wrapper. Complex tuple returns must be parsed from raw hex.
#
#   - The contract ABI uses uint8[] for Vec<u8>, not bytes.
#     cast send arguments must be passed as "[0x12,0x20,...]" array literals.

# ── Encoding helpers ──────────────────────────────────────────────────────────

# hex_to_uint8_array <0x-hex-string>
# Converts a hex byte string to a uint8[] array literal for cast.
# Example: hex_to_uint8_array 0x1220ab → [0x12,0x20,0xab]
hex_to_uint8_array() {
    local hex="${1#0x}"
    local arr="" byte
    while [ ${#hex} -ge 2 ]; do
        byte="${hex:0:2}"
        hex="${hex:2}"
        arr="${arr}${arr:+,}0x${byte}"
    done
    echo "[$arr]"
}

# ── Tuple parsing helpers ─────────────────────────────────────────────────────
#
# Stylus multi-value returns have this layout in the raw hex:
#   Word 0: 0x20 (outer offset — points to the inner tuple at byte 32)
#   Word 1: offset to first dynamic element within the inner tuple
#   Words 2+: static elements (uint8, uint32, bool, bytes32, etc.)
#   Dynamic data follows after the head words.
#
# All word indices below are 0-based from the START of the raw hex data.

# parse_gov_keyset_version <raw-hex>
# Returns the governance version (uint32) from a getGovernanceKeyset raw return.
# Layout: [0x20][uint8[]-offset][key_count][quorum][version][key_scheme]...
#                  word1           word2     word3   word4    word5
parse_gov_keyset_version() {
    python3 - "$1" <<'PYEOF'
import sys
raw = sys.argv[1][2:]  # strip 0x
def word(n): return int(raw[n*64:(n+1)*64], 16)
print(word(4))  # version is the 4th word (0-indexed)
PYEOF
}

# parse_gov_keyset_count <raw-hex>
# Returns key_count from a getGovernanceKeyset raw return.
parse_gov_keyset_count() {
    python3 - "$1" <<'PYEOF'
import sys
raw = sys.argv[1][2:]
def word(n): return int(raw[n*64:(n+1)*64], 16)
print(word(2))
PYEOF
}

# parse_gov_keyset_quorum <raw-hex>
# Returns quorum from a getGovernanceKeyset raw return.
parse_gov_keyset_quorum() {
    python3 - "$1" <<'PYEOF'
import sys
raw = sys.argv[1][2:]
def word(n): return int(raw[n*64:(n+1)*64], 16)
print(word(3))
PYEOF
}

# parse_card_cid <raw-hex>
# Returns the CID (0x-hex) from a getCardEntry raw return.
# getCardEntry returns (uint8[] cid, bytes32 policy, bytes32 press, bytes32 fwd, bool exists)
# Layout: [0x20][uint8[]-offset=0xa0][policy][press][fwd][exists][cid_len][cid_bytes...]
#           w0       w1                  w2     w3    w4    w5      w6      w7..
parse_card_cid() {
    python3 - "$1" <<'PYEOF'
import sys
raw = sys.argv[1][2:]
def word(n): return raw[n*64:(n+1)*64]
def word_int(n): return int(word(n), 16)
cid_len = word_int(6)
# Each uint8 element is right-padded to 32 bytes; the byte value is the last byte.
cid = ''.join(word(7 + i)[-2:] for i in range(cid_len))
print('0x' + cid)
PYEOF
}

# parse_card_exists <raw-hex>
# Returns "true" or "false" from a getCardEntry raw return.
parse_card_exists() {
    python3 - "$1" <<'PYEOF'
import sys
raw = sys.argv[1][2:]
def word_int(n): return int(raw[n*64:(n+1)*64], 16)
print("true" if word_int(5) == 1 else "false")
PYEOF
}
