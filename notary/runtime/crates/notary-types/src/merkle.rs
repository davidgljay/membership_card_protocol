//! input_commitment (§27): Merkle root over sorted `input_hash` values.
//! Leaf = SHA-256(0x00 ‖ input_hash); node = SHA-256(0x01 ‖ left ‖ right); an odd node is promoted
//! unchanged. The empty list's root is SHA-256("") (erratum E1, agreed 2026-11-12).
use crate::error::{NotaryError, Result};
use sha2::{Digest, Sha256};

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

pub fn input_commitment(input_hashes: &[[u8; 32]]) -> Result<[u8; 32]> {
    if input_hashes.windows(2).any(|w| w[0] >= w[1]) {
        return Err(NotaryError::new("MERKLE_UNSORTED", "inputs must be strictly increasing"));
    }
    if input_hashes.is_empty() {
        return Ok(sha(&[]));
    }
    let mut level: Vec<[u8; 32]> = input_hashes.iter().map(|h| sha(&[&[0], h])).collect();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|c| if c.len() == 2 { sha(&[&[1], &c[0], &c[1]]) } else { c[0] })
            .collect();
    }
    Ok(level[0])
}
