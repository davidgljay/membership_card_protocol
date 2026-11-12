//! Card pointers, timestamps, durations, CIDs (Q7).
use crate::error::{NotaryError, Result};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

/// keccak256(public key) as 64 lowercase hex characters, no `0x`.
pub fn card_pointer(public_key: &[u8]) -> String {
    Keccak256::digest(public_key).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn assert_card_pointer(s: &str) -> Result<()> {
    if s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        Ok(())
    } else {
        Err(NotaryError::new("CARD_POINTER_INVALID", s))
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Strict UTC `YYYY-MM-DDTHH:MM:SS(.fff)?Z`; returns milliseconds since the Unix epoch.
pub fn parse_timestamp(s: &str) -> Result<i64> {
    let bad = || NotaryError::new("TIMESTAMP_INVALID", s);
    let b = s.as_bytes();
    if b.len() < 20 || !s.is_ascii() || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last().unwrap() != b'Z' {
        return Err(bad());
    }
    let num = |r: std::ops::Range<usize>| -> Result<i64> {
        let t = &s[r];
        if t.bytes().all(|c| c.is_ascii_digit()) { t.parse().map_err(|_| bad()) } else { Err(bad()) }
    };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = match &s[19..s.len() - 1] {
        "" => 0,
        frac if frac.starts_with('.') && (2..=4).contains(&frac.len()) => {
            let digits = &frac[1..];
            if !digits.bytes().all(|c| c.is_ascii_digit()) {
                return Err(bad());
            }
            format!("{digits:0<3}").parse::<i64>().map_err(|_| bad())?
        }
        _ => return Err(bad()),
    };
    let dim = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&mo) || d < 1 || d > dim[(mo - 1) as usize] || h > 23 || mi > 59 || se > 59 {
        return Err(bad());
    }
    Ok(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

/// ISO 8601 duration without years or months (`PnW`, `PnD`, `PTnH`, `PTnM`, `PTnS` and combinations); milliseconds.
pub fn parse_duration(s: &str) -> Result<i64> {
    let bad = || NotaryError::new("DURATION_INVALID", s);
    let rest = s.strip_prefix('P').ok_or_else(bad)?;
    if rest.is_empty() || rest.ends_with('T') {
        return Err(bad());
    }
    let (date, time) = match rest.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (rest, None),
    };
    let mut total = 0i64;
    let mut take = |part: &str, units: &[(char, i64)]| -> Result<()> {
        let mut last = usize::MAX;
        let mut num = String::new();
        for c in part.chars() {
            if c.is_ascii_digit() {
                num.push(c);
            } else {
                let idx = units.iter().position(|(u, _)| *u == c).ok_or_else(bad)?;
                if num.is_empty() || (last != usize::MAX && idx <= last) {
                    return Err(bad());
                }
                total += num.parse::<i64>().map_err(|_| bad())? * units[idx].1;
                num.clear();
                last = idx;
            }
        }
        if num.is_empty() { Ok(()) } else { Err(bad()) }
    };
    take(date, &[('W', 7 * 86_400_000), ('D', 86_400_000)])?;
    if let Some(t) = time {
        take(t, &[('H', 3_600_000), ('M', 60_000), ('S', 1000)])?;
    }
    Ok(total)
}

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// CIDv1 (raw codec, sha2-256) string, multibase base32 lower.
pub fn cid_from_digest(digest: &[u8; 32]) -> String {
    let mut bytes = vec![0x01, 0x55, 0x12, 0x20];
    bytes.extend_from_slice(digest);
    let (mut bits, mut acc, mut out) = (0u32, 0u32, String::from("b"));
    for b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(B32[((acc >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn digest_from_cid(cid: &str) -> Result<[u8; 32]> {
    let bad = |m: &str| NotaryError::new("CID_INVALID", m.to_string());
    let rest = cid.strip_prefix('b').ok_or_else(|| bad("multibase must be base32 lower"))?;
    let (mut bits, mut acc, mut out) = (0u32, 0u32, Vec::<u8>::new());
    for c in rest.bytes() {
        let v = B32.iter().position(|&a| a == c).ok_or_else(|| bad("bad base32 character"))? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push(((acc >> (bits - 8)) & 255) as u8);
            bits -= 8;
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 || out.len() != 36 {
        return Err(bad("wrong length or trailing bits"));
    }
    if out[..4] != [0x01, 0x55, 0x12, 0x20] {
        return Err(bad("must be CIDv1, raw codec, sha2-256"));
    }
    Ok(out[4..].try_into().unwrap())
}

pub fn cid_of_bytes(bytes: &[u8]) -> String {
    cid_from_digest(&Sha256::digest(bytes).into())
}
