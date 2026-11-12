//! Strict unpadded base64url (Q7): canonical trailing bits, no padding, no foreign characters.
use crate::error::{NotaryError, Result};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | (*chunk.get(2).unwrap_or(&0) as u32);
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub fn decode(s: &str) -> Result<Vec<u8>> {
    if s.len() % 4 == 1 {
        return Err(NotaryError::new("BASE64URL_INVALID", "bad length"));
    }
    let mut vals = Vec::with_capacity(s.len());
    for c in s.bytes() {
        let v = ALPHABET
            .iter()
            .position(|&a| a == c)
            .ok_or_else(|| NotaryError::new("BASE64URL_INVALID", "bad character"))?;
        vals.push(v as u32);
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for q in vals.chunks(4) {
        let n = q[0] << 18 | q.get(1).map_or(0, |v| v << 12) | q.get(2).map_or(0, |v| v << 6) | q.get(3).copied().unwrap_or(0);
        out.push((n >> 16) as u8);
        if q.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if q.len() > 3 {
            out.push(n as u8);
        }
    }
    if encode(&out) != s {
        return Err(NotaryError::new("BASE64URL_INVALID", "non-canonical trailing bits"));
    }
    Ok(out)
}

pub fn decode_len(s: &str, len: usize) -> Result<Vec<u8>> {
    let b = decode(s)?;
    if b.len() != len {
        return Err(NotaryError::new("BASE64URL_LENGTH", format!("expected {len} bytes, got {}", b.len())));
    }
    Ok(b)
}
