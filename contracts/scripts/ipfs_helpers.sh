#!/usr/bin/env bash
# ipfs_helpers.sh — IPFS pinning helpers for test scripts.
#
# Source this file, then call ipfs_pin_json() to pin a JSON document.
# Tries a local IPFS daemon first, then Pinata if PINATA_JWT is set.
#
# Usage in a script:
#   source "$SCRIPT_DIR/ipfs_helpers.sh"
#   CID_HEX=$(ipfs_pin_json "$json_string")
#
# Returns:
#   stdout — 0x-prefixed hex CID bytes (34 bytes for CIDv0 / sha2-256)
#   stderr — status messages
#   exit 1 — if neither backend is available

# ipfs_pin_json <json_string>
# Pins a JSON document to IPFS.
# Prints 0x<hex CID bytes> to stdout.
ipfs_pin_json() {
    local json_content="$1"
    local cid_b58

    # ── Local IPFS daemon ─────────────────────────────────────────────────────
    if command -v ipfs &>/dev/null; then
        if ipfs swarm peers &>/dev/null 2>&1; then
            local tmp
            tmp=$(mktemp)
            printf '%s' "$json_content" > "$tmp"
            cid_b58=$(ipfs add -Q --cid-version 0 "$tmp" 2>/dev/null || true)
            rm -f "$tmp"
            if [[ -n "$cid_b58" ]]; then
                echo "  [IPFS] Pinned via local daemon: $cid_b58" >&2
                _cid_b58_to_hex "$cid_b58"
                return 0
            fi
        else
            echo "  [IPFS] ipfs binary found but daemon not running." >&2
        fi
    fi

    # ── Pinata ────────────────────────────────────────────────────────────────
    if [[ -n "${PINATA_JWT:-}" ]]; then
        # Pinata's pinJSONToIPFS expects {"pinataContent": <obj>, "pinataMetadata": {...}}
        local pinata_body
        pinata_body=$(python3 - <<PYEOF
import json, sys
content = json.loads('''$json_content''')
body = {"pinataContent": content, "pinataMetadata": {"name": "card-log-entry"}}
print(json.dumps(body))
PYEOF
        )
        local response
        response=$(curl -sf -X POST "https://api.pinata.cloud/pinning/pinJSONToIPFS" \
            -H "Authorization: Bearer $PINATA_JWT" \
            -H "Content-Type: application/json" \
            -d "$pinata_body" 2>/dev/null || true)
        cid_b58=$(echo "$response" \
            | python3 -c "import json,sys; print(json.load(sys.stdin)['IpfsHash'])" 2>/dev/null || true)
        if [[ -n "$cid_b58" ]]; then
            echo "  [IPFS] Pinned via Pinata: $cid_b58" >&2
            _cid_b58_to_hex "$cid_b58"
            return 0
        else
            echo "  [IPFS] Pinata request failed. Response: ${response:-<empty>}" >&2
        fi
    fi

    echo "" >&2
    echo "ERROR: --ipfs flag is set but no IPFS backend is available." >&2
    echo "  Option A: install and start a local IPFS node (kubo):" >&2
    echo "              https://docs.ipfs.tech/install/command-line/" >&2
    echo "              ipfs init && ipfs daemon" >&2
    echo "  Option B: set PINATA_JWT=<your_jwt> in contracts/.env" >&2
    echo "              (free API key at https://pinata.cloud)" >&2
    return 1
}

# _cid_b58_to_hex <base58_cidv0>
# Decodes a CIDv0 (base58-encoded 34-byte multihash) to 0x-prefixed hex.
# CIDv0 wire format: 0x12 (sha2-256 fn code) || 0x20 (32-byte digest length) || <32 bytes>
_cid_b58_to_hex() {
    python3 - "$1" <<'PYEOF'
import sys

def b58decode(s):
    ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    n = 0
    for c in s:
        n = n * 58 + ALPHA.index(c)
    out = []
    while n > 0:
        out.append(n & 0xFF)
        n >>= 8
    out += [0] * (len(s) - len(s.lstrip('1')))
    return bytes(reversed(out))

raw = b58decode(sys.argv[1])
# Sanity check: CIDv0 is always 34 bytes (0x1220 prefix + 32-byte hash)
if len(raw) != 34 or raw[0] != 0x12 or raw[1] != 0x20:
    print(f"WARNING: unexpected CID bytes: {raw.hex()}", file=sys.stderr)
print('0x' + raw.hex())
PYEOF
}
