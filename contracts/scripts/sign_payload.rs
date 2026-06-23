//! sign_payload — Sign a JSON payload with a secp256r1 (P-256) private key.
//!
//! Computes keccak256 of the payload bytes, then signs with RFC 6979 deterministic ECDSA.
//! This matches the on-chain signature verification in the write gate (§6.1) and governance
//! quorum verifier (§6.2), both of which compute `keccak256(payload)` as the message hash.
//!
//! # Usage
//!
//! From PEM key file:
//!   cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload -- \
//!     --key contracts/.keys/test_press.key \
//!     --payload '{"op":"register_card","sequence":0}'
//!
//! From hex private key (e.g., SECP256R1_PRIVKEY from .env):
//!   cargo run --manifest-path contracts/scripts/Cargo.toml --bin sign_payload -- \
//!     --key-hex 0xa5c4a0065dbc299f3628c896941329431934172550fdcd7a1d12ffa3d4fe1a8e \
//!     --payload '{"governance_version":0,"nonce":"abc123","op":"register_policy"}'
//!
//! # Output
//!
//! Prints `0x<128 hex chars>` (64-byte r||s concatenation) to stdout, no trailing newline.
//! The caller should treat this as a raw 64-byte secp256r1 signature.
//!
//! # Key format
//!
//! PEM files must be SEC1 EC private keys (`-----BEGIN EC PRIVATE KEY-----`).
//! Hex keys must be 32-byte P-256 scalar, `0x`-prefixed or raw hex.

use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use tiny_keccak::{Hasher, Keccak};
use std::env;

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    hasher.update(data);
    let mut output = [0u8; 32];
    hasher.finalize(&mut output);
    output
}

fn pad32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let len = bytes.len().min(32);
    out[32 - len..].copy_from_slice(&bytes[..len]);
    out
}

/// Load a P-256 signing key from a SEC1 PEM file (-----BEGIN EC PRIVATE KEY-----).
///
/// Parses the DER manually: SEC1 structure is SEQUENCE { INTEGER 1, OCTET STRING <32 bytes>, ... }.
/// The 32-byte private scalar starts at DER offset 7 for standard P-256 SEC1 keys.
fn load_key_from_pem(path: &str) -> SigningKey {
    use base64::Engine;
    let content = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("Failed to read key file '{}': {}", path, e));

    let b64: String = content
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();

    let der = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .unwrap_or_else(|e| panic!("Failed to base64 decode PEM: {}", e));

    // SEC1 DER for P-256:
    //   30 <len>        SEQUENCE
    //   02 01 01        INTEGER version=1
    //   04 20           OCTET STRING, 32 bytes
    //   <32 bytes>      private key scalar
    //   ...             optional [0] OID, [1] BIT STRING (public key)
    //
    // The private scalar is always at bytes [7..39] for P-256 SEC1.
    assert!(
        der.len() >= 39,
        "SEC1 DER too short ({} bytes); expected at least 39",
        der.len()
    );
    assert_eq!(der[0], 0x30, "SEC1: expected SEQUENCE tag at byte 0");
    assert_eq!(der[2], 0x02, "SEC1: expected INTEGER tag at byte 2");
    assert_eq!(der[3], 0x01, "SEC1: expected INTEGER length 1 at byte 3");
    assert_eq!(der[4], 0x01, "SEC1: expected version=1 at byte 4");
    assert_eq!(der[5], 0x04, "SEC1: expected OCTET STRING tag at byte 5");
    assert_eq!(der[6], 0x20, "SEC1: expected OCTET STRING length 32 at byte 6");

    let scalar = &der[7..39];
    SigningKey::from_bytes(scalar.into())
        .unwrap_or_else(|e| panic!("Invalid P-256 private key: {}", e))
}

/// Load a P-256 signing key from a 32-byte hex string (0x-prefixed or raw).
fn load_key_from_hex(hex_str: &str) -> SigningKey {
    let hex_str = hex_str.trim().trim_start_matches("0x");
    let bytes = hex::decode(hex_str).unwrap_or_else(|e| panic!("Invalid hex key: {}", e));
    assert_eq!(bytes.len(), 32, "Hex key must be exactly 32 bytes (64 hex chars), got {}", bytes.len());
    SigningKey::from_bytes(bytes.as_slice().into())
        .unwrap_or_else(|e| panic!("Invalid P-256 private key: {}", e))
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut key_file: Option<String> = None;
    let mut key_hex: Option<String> = None;
    let mut payload: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--key" if i + 1 < args.len() => {
                i += 1;
                key_file = Some(args[i].clone());
            }
            "--key-hex" if i + 1 < args.len() => {
                i += 1;
                key_hex = Some(args[i].clone());
            }
            "--payload" if i + 1 < args.len() => {
                i += 1;
                payload = Some(args[i].clone());
            }
            _ => {}
        }
        i += 1;
    }

    let payload = payload.unwrap_or_else(|| panic!("--payload <json> is required"));
    let payload_bytes = payload.as_bytes();

    let signing_key = if let Some(path) = key_file {
        load_key_from_pem(&path)
    } else if let Some(hex) = key_hex {
        load_key_from_hex(&hex)
    } else {
        panic!("Either --key <pem-file> or --key-hex <hex> is required");
    };

    let hash = keccak256(payload_bytes);

    let sig: Signature = signing_key
        .sign_prehash(&hash)
        .expect("P-256 signing failed");
    let (r_bytes, s_bytes) = sig.split_bytes();

    let mut output = [0u8; 64];
    output[..32].copy_from_slice(&pad32(&r_bytes));
    output[32..].copy_from_slice(&pad32(&s_bytes));

    // Print 0x-prefixed hex, no trailing newline (vm.ffi compatibility).
    print!("0x{}", hex::encode(output));
}
