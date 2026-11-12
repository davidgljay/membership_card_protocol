//! RFC 8785 canonical JSON for notary objects, integers only (Q6).
//!
//! Keys sort by UTF-16 code units, as RFC 8785 requires. `null`, non-integer numbers and integers
//! outside ±(2^53 − 1) are rejected, in serialization and in parsing.
use crate::{b64u, error::{NotaryError, Result}};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub fn assert_notary_json(v: &Value) -> Result<()> {
    match v {
        Value::Null => Err(NotaryError::new("JSON_NULL", "null is not allowed")),
        Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(n) => {
            let i = n.as_i64().or_else(|| n.as_u64().and_then(|u| i64::try_from(u).ok()));
            match i {
                None if n.is_f64() => Err(NotaryError::new("JSON_NON_INTEGER", "non-integer number")),
                None => Err(NotaryError::new("JSON_INTEGER_RANGE", "integer out of range")),
                Some(x) if x.abs() > MAX_SAFE => Err(NotaryError::new("JSON_INTEGER_RANGE", "integer out of range")),
                Some(_) => Ok(()),
            }
        }
        Value::Array(a) => a.iter().try_for_each(assert_notary_json),
        Value::Object(m) => m.values().try_for_each(assert_notary_json),
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
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

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, out);
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
                write_string(k, out);
                out.push(':');
                write_value(&m[*k], out);
            }
            out.push('}');
        }
    }
}

/// Canonical bytes of a notary object.
pub fn canonical(v: &Value) -> Result<Vec<u8>> {
    assert_notary_json(v)?;
    let mut s = String::new();
    write_value(v, &mut s);
    Ok(s.into_bytes())
}

/// Canonical bytes of any serializable typed object.
pub fn canonical_of<T: Serialize>(t: &T) -> Result<Vec<u8>> {
    let v = serde_json::to_value(t).map_err(|e| NotaryError::new("JSON_SERIALIZE", e.to_string()))?;
    canonical(&v)
}

/// Parse received bytes; reject anything that is not already canonical, so hashes and signatures
/// are always taken over the raw received bytes. Duplicate keys collapse on parse and so fail the
/// re-serialization comparison.
pub fn parse_canonical(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).map_err(|_| NotaryError::new("JSON_NOT_CANONICAL", "invalid UTF-8"))?;
    let v: Value = serde_json::from_str(text).map_err(|e| NotaryError::new("JSON_NOT_CANONICAL", e.to_string()))?;
    if canonical(&v)? != bytes {
        return Err(NotaryError::new("JSON_NOT_CANONICAL", "bytes are not RFC 8785 canonical"));
    }
    Ok(v)
}

pub fn h_bytes(v: &Value) -> Result<[u8; 32]> {
    Ok(Sha256::digest(canonical(v)?).into())
}

/// H(x) = SHA-256(JCS(x)), base64url.
pub fn h(v: &Value) -> Result<String> {
    Ok(b64u::encode(&h_bytes(v)?))
}

/// The object without the named fields (signing form).
pub fn without_fields(v: &Value, names: &[&str]) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(k, _)| !names.contains(&k.as_str())).map(|(k, x)| (k.clone(), x.clone())).collect()),
        other => other.clone(),
    }
}
