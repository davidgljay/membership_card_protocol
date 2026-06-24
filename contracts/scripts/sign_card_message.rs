//! sign_card_message — Sign and verify card messages with secp256r1/SHA-256.
//!
//! Card message signing per card_signing.md (Phase 1 secp256r1 approximation):
//!   hash      = SHA-256(canonical_payload_bytes)
//!   signature = secp256r1.sign_prehash(hash)
//!
//! In production the spec requires ML-DSA-44 over the raw bytes with no
//! pre-hash. SHA-256 is the standard pre-hash for secp256r1/P-256 and
//! is used here as the Phase 1 substitute.
//!
//! Usage:
//!
//!   Sign:
//!     cargo run --bin sign_card_message -- \
//!       --key-hex 0x<64-hex> --message '<canonical_json>'
//!     → prints 0x<128-hex r||s>
//!
//!   Verify:
//!     cargo run --bin sign_card_message -- \
//!       --pubkey 0x<128-hex x||y> \
//!       --message '<canonical_json>' \
//!       --signature 0x<128-hex r||s>
//!     → prints "true" or "false"

use p256::ecdsa::{
    signature::hazmat::{PrehashSigner, PrehashVerifier},
    Signature, SigningKey, VerifyingKey,
};
use sha2::{Digest, Sha256};
use std::env;

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn pad32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let len = bytes.len().min(32);
    out[32 - len..].copy_from_slice(&bytes[..len]);
    out
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut key_hex:   Option<String> = None;
    let mut pubkey_hex: Option<String> = None;
    let mut message:   Option<String> = None;
    let mut sig_hex:   Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--key-hex"   if i + 1 < args.len() => { i += 1; key_hex    = Some(args[i].clone()); }
            "--pubkey"    if i + 1 < args.len() => { i += 1; pubkey_hex = Some(args[i].clone()); }
            "--message"   if i + 1 < args.len() => { i += 1; message    = Some(args[i].clone()); }
            "--signature" if i + 1 < args.len() => { i += 1; sig_hex    = Some(args[i].clone()); }
            _ => {}
        }
        i += 1;
    }

    let msg = message.unwrap_or_else(|| panic!("--message <canonical_json> is required"));
    let hash = sha256(msg.as_bytes());

    if let Some(sig_str) = sig_hex {
        // ── Verify mode ───────────────────────────────────────────────────────
        let pub_str = pubkey_hex.unwrap_or_else(|| panic!("--pubkey required for verification"));
        let pub_hex = pub_str.trim().trim_start_matches("0x");
        let xy = hex::decode(pub_hex).unwrap_or_else(|e| panic!("Invalid pubkey hex: {}", e));
        assert_eq!(xy.len(), 64, "Pubkey must be 64 bytes (x||y, no 0x04 prefix)");
        let mut uncompressed = vec![0x04u8];
        uncompressed.extend_from_slice(&xy);

        let verifying_key = VerifyingKey::from_sec1_bytes(&uncompressed)
            .unwrap_or_else(|e| panic!("Invalid P-256 public key: {}", e));

        let sig_hex_str = sig_str.trim().trim_start_matches("0x");
        let sig_bytes = hex::decode(sig_hex_str)
            .unwrap_or_else(|e| panic!("Invalid signature hex: {}", e));
        assert_eq!(sig_bytes.len(), 64, "Signature must be 64 bytes (r||s)");

        let sig = Signature::from_bytes(sig_bytes.as_slice().into())
            .unwrap_or_else(|e| panic!("Invalid P-256 signature: {}", e));

        let valid = verifying_key.verify_prehash(&hash, &sig).is_ok();
        print!("{}", valid);
    } else {
        // ── Sign mode ─────────────────────────────────────────────────────────
        let priv_str = key_hex.unwrap_or_else(|| panic!("--key-hex required for signing"));
        let priv_hex = priv_str.trim().trim_start_matches("0x");
        let priv_bytes = hex::decode(priv_hex)
            .unwrap_or_else(|e| panic!("Invalid private key hex: {}", e));

        let signing_key = SigningKey::from_bytes(priv_bytes.as_slice().into())
            .unwrap_or_else(|e| panic!("Invalid P-256 private key: {}", e));

        let sig: Signature = signing_key
            .sign_prehash(&hash)
            .expect("P-256 signing failed");
        let (r, s) = sig.split_bytes();

        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&pad32(&r));
        out[32..].copy_from_slice(&pad32(&s));
        print!("0x{}", hex::encode(out));
    }
}
