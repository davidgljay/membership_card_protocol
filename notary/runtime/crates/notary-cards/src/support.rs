//! Helpers mirroring the verifier's own (`verifier/src/crypto.ts`, `canonicalize.ts`, `head.ts`) byte for byte.
use crate::world::CardSource;
use serde_json::{Map, Value};

/// `keccak256(bytes)` as lowercase hex (the card address form).
pub fn address_of(pubkey: &[u8]) -> String {
    notary_types::formats::card_pointer(pubkey)
}

/// Twin of `base64UrlToBytes`: lenient. `-`/`_` map to `+`/`/`; characters outside the standard alphabet (including
/// `=`) are skipped; trailing bits are dropped.
pub fn b64_lenient(s: &str) -> Vec<u8> {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut buf, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in s.bytes() {
        let c = match c {
            b'-' => b'+',
            b'_' => b'/',
            x => x,
        };
        let Some(v) = ALPHA.iter().position(|a| *a == c) else { continue };
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
        buf &= (1 << bits) - 1;
    }
    out
}

/// `HKDF-SHA3-256(pubkey, info = "card-content-v1")`, no salt (ADR-006; `hkdfSha3256`).
pub fn content_key(pubkey: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf::SimpleHkdf::<sha3_12::Sha3_256>::new(None, pubkey).expand(b"card-content-v1", &mut out).expect("32 bytes");
    out
}

/// AES-256-GCM, `nonce(12) || ciphertext || tag(16)` (`aes256gcmDecrypt`).
pub fn aes_gcm_decrypt(key: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm};
    if data.len() < 28 {
        return None;
    }
    let nonce: [u8; 12] = data[..12].try_into().ok()?;
    Aes256Gcm::new_from_slice(key).ok()?.decrypt(&nonce.into(), &data[12..]).ok()
}

/// Twin of the verifier's `canonicalize` (sorted keys, no whitespace, `null` kept). Numbers must be integers: a
/// fractional number gives `None` (JavaScript would format it; no signed card object carries one).
pub fn canonicalize(v: &Value) -> Option<Vec<u8>> {
    fn s(x: &str, out: &mut String) {
        out.push('"');
        for c in x.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{08}' => out.push_str("\\b"),
                '\u{09}' => out.push_str("\\t"),
                '\u{0a}' => out.push_str("\\n"),
                '\u{0c}' => out.push_str("\\f"),
                '\u{0d}' => out.push_str("\\r"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }
    fn w(v: &Value, out: &mut String) -> Option<()> {
        match v {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => {
                if n.is_f64() {
                    return None;
                }
                out.push_str(&n.to_string());
            }
            Value::String(x) => s(x, out),
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    w(x, out)?;
                }
                out.push(']');
            }
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    s(k, out);
                    out.push(':');
                    w(&m[*k], out)?;
                }
                out.push('}');
            }
        }
        Some(())
    }
    let mut out = String::new();
    w(v, &mut out)?;
    Some(out.into_bytes())
}

pub fn without(v: &Value, names: &[&str]) -> Value {
    notary_types::jcs::without_fields(v, names)
}

fn decrypt_json(src: &dyn CardSource, cid: &str, key: &[u8; 32]) -> Option<Map<String, Value>> {
    let plain = aes_gcm_decrypt(key, &src.fetch(cid)?)?;
    match serde_json::from_slice::<Value>(&plain).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// Twin of `decryptCardHead`: a `LogEntry` head is the genesis document (`history[0]`) overlaid with `card_state`, with
/// the entry's own `entry_type`, `code`, `revocation`, `history`, `version` and `prev_log_root` kept on top.
pub fn decrypt_card_head(src: &dyn CardSource, cid: &str, key: &[u8; 32]) -> Option<Map<String, Value>> {
    let head = decrypt_json(src, cid, key)?;
    let is_log = matches!(head.get("entry_type").and_then(Value::as_str), Some("field_update") | Some("revocation"));
    if !is_log {
        return Some(head);
    }
    let genesis_cid = head.get("history").and_then(Value::as_array).and_then(|h| h.first()).and_then(Value::as_str);
    let mut doc = match genesis_cid {
        Some(g) => decrypt_json(src, g, key)?,
        None => Map::new(),
    };
    if let Some(Value::Object(state)) = head.get("card_state") {
        for (k, v) in state {
            doc.insert(k.clone(), v.clone());
        }
    }
    for k in ["entry_type", "code", "revocation", "history", "version", "prev_log_root"] {
        if let Some(v) = head.get(k) {
            doc.insert(k.into(), v.clone());
        }
    }
    Some(doc)
}
