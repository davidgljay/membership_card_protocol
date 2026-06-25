//! gen_mldsa_keypair — Generate a random ML-DSA-44 (FIPS 204) keypair.
//!
//! ML-DSA-44 is the card holder identity key per the card protocol spec:
//!   - Public key (1312 bytes): recipient_pubkey in the CardDocument
//!     → on-chain address: keccak256(recipient_pubkey)
//!     → ADR-006 content key: HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")
//!   - Private key stored as the 32-byte seed (sufficient to reconstruct the full signing key)
//!
//! Output JSON (stdout, no trailing newline):
//!   {"private_key":"0x<64-hex seed>","public_key":"0x<2624-hex, 1312 bytes>"}
//!
//! Usage:
//!   cargo run --bin gen_mldsa_keypair

use ml_dsa::{Generate, MlDsa44, SigningKey, signature::Keypair};

fn main() {
    let sk = SigningKey::<MlDsa44>::generate();
    let vk = sk.verifying_key();

    // Public key: 1312 bytes (encode() returns Array<u8, 1312>)
    let pk_hex = hex::encode(vk.encode().as_slice());

    // Private key: stored as the 32-byte seed for compactness.
    // Reconstruct with: SigningKey::<MlDsa44>::from_seed(seed)
    let seed_hex = hex::encode(sk.as_seed().as_slice());

    print!(r#"{{"private_key":"0x{}","public_key":"0x{}"}}"#, seed_hex, pk_hex);
}
