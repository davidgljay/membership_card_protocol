//! gen_keypair — Generate a random secp256r1 (P-256) keypair for testing.
//!
//! Outputs a single line of JSON to stdout (no trailing newline):
//!   {"private_key":"0x<64hex>","public_key":"0x<128hex>"}
//!
//! public_key is the uncompressed point minus the 0x04 prefix: x||y (64 bytes).
//! This is the format expected by authorize_press and the verifier module.
//!
//! Usage:
//!   cargo run --manifest-path contracts/scripts/Cargo.toml --bin gen_keypair

use p256::ecdsa::SigningKey;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

fn random_signing_key() -> SigningKey {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    loop {
        let mut hasher = Sha256::new();
        hasher.update(&seed);
        seed = hasher.finalize().into();
        if let Ok(key) = SigningKey::from_bytes(seed.as_ref().into()) {
            return key;
        }
    }
}

fn main() {
    let signing_key = random_signing_key();
    let verifying_key = p256::ecdsa::VerifyingKey::from(&signing_key);

    let private_key_hex = format!("0x{}", hex::encode(signing_key.to_bytes()));

    // Uncompressed point: 0x04 || x (32 bytes) || y (32 bytes)
    // We strip the 0x04 prefix and return x||y (64 bytes).
    let point = verifying_key.to_encoded_point(false);
    let coords = point.as_bytes();
    assert_eq!(coords[0], 0x04, "expected uncompressed point");
    let pubkey_xy_hex = format!("0x{}", hex::encode(&coords[1..65]));

    // No trailing newline — consistent with sign_payload output for pipe compat.
    print!(
        r#"{{"private_key":"{}","public_key":"{}"}}"#,
        private_key_hex, pubkey_xy_hex
    );
}
