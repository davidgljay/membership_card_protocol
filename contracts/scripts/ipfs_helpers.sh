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

# ipfs_pin_encrypted <json_string> <press_pubkey_hex>
# Encrypts a JSON document for the press key, then pins it to IPFS.
# Uses ECIES (ephemeral ECDH P-256 + HKDF-SHA256 + AES-256-GCM).
# Only the holder of the press private key can decrypt the content.
# Prints 0x<hex CID bytes> to stdout.
ipfs_pin_encrypted() {
    local json_content="$1"
    local pubkey_hex="$2"
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local cargo_manifest="$script_dir/Cargo.toml"

    local encrypted
    encrypted=$(cargo run --manifest-path "$cargo_manifest" --bin encrypt_card --quiet -- \
        --pubkey "$pubkey_hex" --plaintext "$json_content" 2>/dev/null)

    if [[ -z "$encrypted" ]]; then
        echo "  [IPFS] Encryption failed." >&2
        return 1
    fi
    echo "  [IPFS] Content encrypted for press key." >&2
    ipfs_pin_json "$encrypted"
}

# ipfs_pin_json <json_string>
# Pins a JSON document to IPFS (unencrypted).
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
                _cid_to_hex "$cid_b58"
                return 0
            fi
        else
            echo "  [IPFS] ipfs binary found but daemon not running." >&2
        fi
    fi

    # ── Pinata ────────────────────────────────────────────────────────────────
    if [[ -n "${PINATA_JWT:-}" ]]; then
        # Build {"pinataContent": <obj>, "pinataMetadata": {...}} safely via argv.
        local pinata_body
        pinata_body=$(python3 -c "
import json, sys
content = json.loads(sys.argv[1])
body = {'pinataContent': content, 'pinataMetadata': {'name': 'card-log-entry'}}
print(json.dumps(body))
" "$json_content" 2>/dev/null)

        if [[ -z "$pinata_body" ]]; then
            echo "  [IPFS] Failed to build Pinata request body (JSON parse error?)" >&2
        else
            local tmp_resp http_code response cid_str
            tmp_resp=$(mktemp)

            # ── Try legacy Pinning API (pins to public IPFS) ──────────────────
            # Requires JWT with 'pinJSONToIPFS' scope enabled.
            http_code=$(curl -s -o "$tmp_resp" -w '%{http_code}' \
                -X POST "https://api.pinata.cloud/pinning/pinJSONToIPFS" \
                -H "Authorization: Bearer $PINATA_JWT" \
                -H "Content-Type: application/json" \
                -d "$pinata_body" 2>/dev/null)
            response=$(cat "$tmp_resp" 2>/dev/null); rm -f "$tmp_resp"

            cid_str=$(echo "$response" \
                | python3 -c "import json,sys; print(json.load(sys.stdin)['IpfsHash'])" 2>/dev/null || true)
            if [[ -n "$cid_str" ]]; then
                echo "  [IPFS] Pinned via Pinata (public IPFS): $cid_str" >&2
                _cid_to_hex "$cid_str"
                return 0
            fi

            if [[ "$http_code" == "403" ]]; then
                echo "  [IPFS] HTTP 403 — JWT needs 'pinJSONToIPFS' scope." >&2
                echo "  [IPFS] Pinata → API Keys → create key → enable pinFileToIPFS." >&2
                echo "  [IPFS] Falling back to Files API (accessible via Pinata gateway only)..." >&2
            else
                echo "  [IPFS] Pinning API HTTP $http_code: ${response:-<empty>}" >&2
            fi

            # ── Fallback: Files API v3 (Pinata gateway only, not public IPFS) ──
            local tmp_json
            tmp_json=$(mktemp --suffix=.json 2>/dev/null || mktemp)
            tmp_resp=$(mktemp)
            python3 -c "
import json, sys
content = json.loads(sys.argv[1])
print(json.dumps(content))
" "$json_content" > "$tmp_json" 2>/dev/null

            http_code=$(curl -s -o "$tmp_resp" -w '%{http_code}' \
                -X POST "https://uploads.pinata.cloud/v3/files" \
                -H "Authorization: Bearer $PINATA_JWT" \
                -F "file=@${tmp_json};type=application/json" \
                -F "name=card-log-entry" \
                2>/dev/null)
            response=$(cat "$tmp_resp" 2>/dev/null)
            rm -f "$tmp_json" "$tmp_resp"

            cid_str=$(echo "$response" \
                | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['cid'])" 2>/dev/null || true)
            if [[ -n "$cid_str" ]]; then
                echo "  [IPFS] Pinned via Pinata Files API (private gateway): $cid_str" >&2
                _cid_to_hex "$cid_str"
                return 0
            else
                echo "  [IPFS] Pinata Files API HTTP $http_code: ${response:-<empty>}" >&2
            fi
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

# _cid_to_hex <cid>
# Decodes an IPFS CID to 0x-prefixed hex bytes.
# Handles CIDv0 (base58, starts with "Qm") and CIDv1 (base32, starts with "b").
# Both fit within MAX_CID_LEN=64: CIDv0 = 34 bytes, CIDv1 (sha2-256) = 36 bytes.
_cid_to_hex() {
    python3 - "$1" <<'PYEOF'
import sys, base64

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

def b32decode_cid(s):
    # Multibase prefix 'b' = base32 lowercase (RFC 4648, no padding)
    body = s[1:] if s.startswith('b') else s
    body = body.upper()
    pad = (8 - len(body) % 8) % 8
    return base64.b32decode(body + '=' * pad)

cid = sys.argv[1]
if cid.startswith('Qm'):
    raw = b58decode(cid)
else:
    raw = b32decode_cid(cid)

print('0x' + raw.hex())
PYEOF
}
