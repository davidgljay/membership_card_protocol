//! Test vector generator for secp256r1 (P-256) signatures.
//!
//! Generates deterministic RFC 6979 test vectors compatible with:
//!   - The RIP-7212 precompile (address 0x...0100 on Arbitrum)
//!   - The verifier-module contract
//!   - The Foundry test suite (Verifier.t.sol)
//!
//! Output: JSON written to scripts/test_vectors.json
//!
//! Usage:
//!   cargo run --manifest-path contracts/scripts/Cargo.toml --bin gen_test_vectors
//!
//! The generated vectors can be pasted directly into Verifier.t.sol.
//!
//! # RIP-7212 Precompile Input Format
//!
//! The precompile expects exactly 160 bytes:
//!   [0..32]   message hash (bytes32)
//!   [32..64]  signature r  (bytes32)
//!   [64..96]  signature s  (bytes32)
//!   [96..128] public key x (bytes32)
//!   [128..160] public key y (bytes32)
//!
//! The precompile returns bytes32(1) for valid, bytes32(0) for invalid.

use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey, VerifyingKey},
    elliptic_curve::sec1::ToEncodedPoint,
};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::fs;

/// A single test vector for the RIP-7212 precompile.
#[derive(Serialize, Deserialize, Debug)]
struct TestVector {
    /// Human-readable label.
    label: String,
    /// Hex-encoded 32-byte message hash (the actual bytes passed to the precompile).
    msg_hash: String,
    /// Hex-encoded 32-byte signature r component.
    r: String,
    /// Hex-encoded 32-byte signature s component.
    s: String,
    /// Hex-encoded 32-byte public key x coordinate.
    x: String,
    /// Hex-encoded 32-byte public key y coordinate.
    y: String,
    /// Expected verification result.
    valid: bool,
    /// Notes for auditors.
    notes: String,
}

fn to_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn pad32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let start = 32usize.saturating_sub(bytes.len());
    out[start..].copy_from_slice(&bytes[..bytes.len().min(32)]);
    out
}

/// Generate a signing key from a deterministic seed (for reproducible vectors).
/// In production the key would come from a hardware wallet or secure key gen.
fn key_from_seed(seed: &[u8]) -> SigningKey {
    // Hash the seed to get 32 bytes, then use as scalar.
    // p256::SigningKey::from_bytes requires the scalar to be in [1, n-1].
    // We use SHA-256 to produce a 32-byte value and iterate if needed.
    let mut counter: u64 = 0;
    loop {
        let mut hasher = Sha256::new();
        hasher.update(seed);
        hasher.update(&counter.to_le_bytes());
        let hash = hasher.finalize();
        if let Ok(key) = SigningKey::from_bytes((&hash).into()) {
            return key;
        }
        counter += 1;
    }
}

/// Compute SHA-256 of a message (used as the preimage of the hash passed to the precompile).
/// The precompile receives the hash directly — we record both the preimage and the hash.
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Sign a 32-byte hash with a signing key and return (r, s).
/// Uses RFC 6979 deterministic k generation (built into the p256 crate).
fn sign_hash(key: &SigningKey, hash: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    // p256 ecdsa::SigningKey signs over the raw bytes (no additional hashing).
    // The prehash variant signs over already-hashed data.
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    let sig: Signature = key.sign_prehash(hash).expect("signing failed");
    let (r_bytes, s_bytes) = sig.split_bytes();
    (pad32(&r_bytes), pad32(&s_bytes))
}

/// Extract the (x, y) coordinates from a verifying key.
fn pubkey_xy(key: &VerifyingKey) -> ([u8; 32], [u8; 32]) {
    let point = key.to_encoded_point(false); // uncompressed: 0x04 || x || y
    let coords = point.as_bytes();
    // coords[0] == 0x04 (uncompressed prefix)
    let x = pad32(&coords[1..33]);
    let y = pad32(&coords[33..65]);
    (x, y)
}

fn main() {
    let mut vectors: Vec<TestVector> = Vec::new();

    // ── Vector 1: Valid signature over "hello world" ──────────────────────────
    {
        let key = key_from_seed(b"card_protocol_test_key_1");
        let vk = VerifyingKey::from(&key);
        let (x, y) = pubkey_xy(&vk);

        let msg = b"hello world";
        let hash = sha256(msg);
        let (r, s) = sign_hash(&key, &hash);

        vectors.push(TestVector {
            label: "valid_hello_world".to_string(),
            msg_hash: to_hex(&hash),
            r: to_hex(&r),
            s: to_hex(&s),
            x: to_hex(&x),
            y: to_hex(&y),
            valid: true,
            notes: "SHA-256(\"hello world\") signed with deterministic key 1".to_string(),
        });
    }

    // ── Vector 2: Valid signature over a 32-byte zero hash ────────────────────
    {
        let key = key_from_seed(b"card_protocol_test_key_2");
        let vk = VerifyingKey::from(&key);
        let (x, y) = pubkey_xy(&vk);

        let hash = [0u8; 32];
        let (r, s) = sign_hash(&key, &hash);

        vectors.push(TestVector {
            label: "valid_zero_hash".to_string(),
            msg_hash: to_hex(&hash),
            r: to_hex(&r),
            s: to_hex(&s),
            x: to_hex(&x),
            y: to_hex(&y),
            valid: true,
            notes: "All-zero hash signed with deterministic key 2".to_string(),
        });
    }

    // ── Vector 3: Valid signature over a realistic card payload hash ──────────
    {
        let key = key_from_seed(b"card_protocol_press_key_3");
        let vk = VerifyingKey::from(&key);
        let (x, y) = pubkey_xy(&vk);

        // Simulate a card registration payload hash.
        let payload = br#"{"op":"register_card","seq":0,"policy":"0xabc","press":"0xdef","cid":"Qm..."}"#;
        let hash = sha256(payload);
        let (r, s) = sign_hash(&key, &hash);

        vectors.push(TestVector {
            label: "valid_card_registration_payload".to_string(),
            msg_hash: to_hex(&hash),
            r: to_hex(&r),
            s: to_hex(&s),
            x: to_hex(&x),
            y: to_hex(&y),
            valid: true,
            notes: "SHA-256 of a card registration JSON payload".to_string(),
        });
    }

    // ── Vector 4: Invalid — wrong public key for this signature ───────────────
    {
        let signing_key = key_from_seed(b"card_protocol_test_key_4_signer");
        let wrong_key = key_from_seed(b"card_protocol_test_key_4_wrong");
        let wrong_vk = VerifyingKey::from(&wrong_key);
        let (x, y) = pubkey_xy(&wrong_vk);

        let msg = b"test message for wrong key";
        let hash = sha256(msg);
        let (r, s) = sign_hash(&signing_key, &hash);

        vectors.push(TestVector {
            label: "invalid_wrong_pubkey".to_string(),
            msg_hash: to_hex(&hash),
            r: to_hex(&r),
            s: to_hex(&s),
            x: to_hex(&x),
            y: to_hex(&y),
            valid: false,
            notes: "Signature from key 4 but public key is from a different key — must fail".to_string(),
        });
    }

    // ── Vector 5: Invalid — signature r is bit-flipped ────────────────────────
    {
        let key = key_from_seed(b"card_protocol_test_key_5");
        let vk = VerifyingKey::from(&key);
        let (x, y) = pubkey_xy(&vk);

        let hash = sha256(b"bit flip test");
        let (mut r, s) = sign_hash(&key, &hash);

        // Flip the least significant bit of r.
        r[31] ^= 0x01;

        vectors.push(TestVector {
            label: "invalid_bit_flip_r".to_string(),
            msg_hash: to_hex(&hash),
            r: to_hex(&r),
            s: to_hex(&s),
            x: to_hex(&x),
            y: to_hex(&y),
            valid: false,
            notes: "Valid signature with one bit flipped in r — must fail".to_string(),
        });
    }

    // ── Vector 6: Invalid — all zeros ────────────────────────────────────────
    {
        vectors.push(TestVector {
            label: "invalid_all_zeros".to_string(),
            msg_hash: to_hex(&[0u8; 32]),
            r: to_hex(&[0u8; 32]),
            s: to_hex(&[0u8; 32]),
            x: to_hex(&[0u8; 32]),
            y: to_hex(&[0u8; 32]),
            valid: false,
            notes: "All-zero input — must fail (not a valid point on the curve)".to_string(),
        });
    }

    // ── Vector 7: Valid — governance quorum simulation ────────────────────────
    {
        let key = key_from_seed(b"card_protocol_governance_key_root_1");
        let vk = VerifyingKey::from(&key);
        let (x, y) = pubkey_xy(&vk);

        // Governance payload: rotate governance keys operation.
        let payload = br#"{"op":"rotate_governance_keys","body":0,"version":1,"nonce":"abc123","keys":["..."],"quorum":2}"#;
        let hash = sha256(payload);
        let (r, s) = sign_hash(&key, &hash);

        vectors.push(TestVector {
            label: "valid_governance_rotation_payload".to_string(),
            msg_hash: to_hex(&hash),
            r: to_hex(&r),
            s: to_hex(&s),
            x: to_hex(&x),
            y: to_hex(&y),
            valid: true,
            notes: "SHA-256 of a governance key rotation payload signed by root body key 1".to_string(),
        });
    }

    // ── Print human-readable summary ─────────────────────────────────────────
    println!("Generated {} test vectors:", vectors.len());
    for v in &vectors {
        println!(
            "  [{:>5}] {} — {}",
            if v.valid { "VALID" } else { "INVAL" },
            v.label,
            v.notes
        );
    }

    // ── Write JSON output ─────────────────────────────────────────────────────
    let json = serde_json::to_string_pretty(&vectors).expect("serialization failed");
    let out_path = "scripts/test_vectors.json";
    fs::write(out_path, &json).expect("failed to write test_vectors.json");
    println!("\nWrote {} vectors to {}", vectors.len(), out_path);

    // ── Print Solidity snippet ────────────────────────────────────────────────
    println!("\n// ── Solidity snippet for Verifier.t.sol ──────────────────────────────────");
    println!("// Paste these into test_nist_p256_valid_signature() and test_bit_flip_invalidates_signature()");
    println!();

    for v in &vectors {
        let prefix = if v.valid { "" } else { "// INVALID: " };
        println!("// {} {}", v.label, v.notes);
        println!(
            "{}TestVector({{ msg_hash: {}, r: {}, s: {}, x: {}, y: {}, valid: {} }}),",
            prefix,
            v.msg_hash, v.r, v.s, v.x, v.y,
            v.valid
        );
        println!();
    }
}
