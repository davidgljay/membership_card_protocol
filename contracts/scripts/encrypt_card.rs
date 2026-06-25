//! encrypt_card — Encrypt/decrypt card content per ADR-006.
//!
//! ADR-006 content encryption:
//!   content_key = HKDF-SHA3-256(ikm=recipient_pubkey, info="card-content-v1")
//!   ciphertext  = AES-256-GCM.Encrypt(content_key, card_document_bytes, nonce)
//!
//! The public key is the single credential needed to both derive the content key
//! and decrypt the document. Anyone who has the public key can decrypt. The
//! on-chain address (keccak256(pubkey)) does not reveal the pubkey, so observers
//! cannot derive the content key from the address alone.
//!
//! Output JSON (stdout, no trailing newline):
//!   { "v":1, "scheme":"adr006-hkdf-sha3-256-aesgcm256",
//!     "nonce":"<base64url 12 bytes>", "ct":"<base64url ciphertext+tag>" }
//!
//! Usage:
//!   # Encrypt
//!   cargo run --bin encrypt_card -- \
//!     --pubkey 0x<128-hex x||y> --plaintext '{"op":"register_card",...}'
//!
//!   # Decrypt with public key (anyone holding the pubkey can decrypt)
//!   cargo run --bin encrypt_card -- \
//!     --pubkey 0x<128-hex x||y> \
//!     --decrypt '{"v":1,"scheme":"...","nonce":"...","ct":"..."}'
//!
//!   # Decrypt with private key (derives pubkey automatically)
//!   cargo run --bin encrypt_card -- \
//!     --privkey 0x<64-hex> \
//!     --decrypt '{"v":1,"scheme":"...","nonce":"...","ct":"..."}'

use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use p256::{
    ecdsa::SigningKey,
    elliptic_curve::sec1::ToEncodedPoint,
};
use rand_core::{OsRng, RngCore};
use sha3::Sha3_256;
use std::env;

const INFO: &[u8] = b"card-content-v1";

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut pubkey_hex:    Option<String> = None;
    let mut privkey_hex:   Option<String> = None;
    let mut plaintext:     Option<String> = None;
    let mut decrypt_input: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--pubkey"    if i + 1 < args.len() => { i += 1; pubkey_hex    = Some(args[i].clone()); }
            "--privkey"   if i + 1 < args.len() => { i += 1; privkey_hex   = Some(args[i].clone()); }
            "--plaintext" if i + 1 < args.len() => { i += 1; plaintext     = Some(args[i].clone()); }
            "--decrypt"   if i + 1 < args.len() => { i += 1; decrypt_input = Some(args[i].clone()); }
            _ => {}
        }
        i += 1;
    }

    // Resolve pubkey bytes (from either --pubkey or --privkey).
    let pubkey_bytes: Vec<u8> = if let Some(hex) = pubkey_hex {
        parse_pubkey_hex(&hex)
    } else if let Some(hex) = privkey_hex.as_deref() {
        derive_pubkey_from_privkey(hex)
    } else {
        panic!("--pubkey <hex> or --privkey <hex> is required");
    };

    if let Some(enc_json) = decrypt_input {
        print!("{}", decrypt(&enc_json, &pubkey_bytes));
    } else {
        let plain = plaintext.unwrap_or_else(|| panic!("--plaintext <json> required for encryption"));
        print!("{}", encrypt(&plain, &pubkey_bytes));
    }
}

// ── Key helpers ───────────────────────────────────────────────────────────────

fn parse_pubkey_hex(hex_str: &str) -> Vec<u8> {
    let hex_str = hex_str.trim().trim_start_matches("0x");
    let bytes = hex::decode(hex_str)
        .unwrap_or_else(|e| panic!("Invalid pubkey hex: {}", e));
    // Accept any size: 64 bytes (secp256r1, Phase 1 fallback) or 1312 bytes (ML-DSA-44, spec-correct).
    assert!(
        bytes.len() == 64 || bytes.len() == 1312,
        "Pubkey must be 64 bytes (secp256r1) or 1312 bytes (ML-DSA-44), got {}",
        bytes.len()
    );
    bytes
}

fn derive_pubkey_from_privkey(hex_str: &str) -> Vec<u8> {
    let hex_str = hex_str.trim().trim_start_matches("0x");
    let bytes = hex::decode(hex_str).unwrap_or_else(|e| panic!("Invalid privkey hex: {}", e));
    let signing_key = SigningKey::from_bytes(bytes.as_slice().into())
        .unwrap_or_else(|e| panic!("Invalid P-256 private key: {}", e));
    let point = signing_key.verifying_key().to_encoded_point(false); // 0x04 || x || y
    let coords = point.as_bytes();
    coords[1..65].to_vec()
}

/// ADR-006: content_key = HKDF-SHA3-256(ikm=recipient_pubkey, info="card-content-v1")
/// recipient_pubkey is ML-DSA-44 (1312 bytes) per spec; secp256r1 (64 bytes) for Phase 1 fallback.
fn derive_content_key(pubkey_bytes: &[u8]) -> [u8; 32] {
    let hkdf = Hkdf::<Sha3_256>::new(None, pubkey_bytes);
    let mut key = [0u8; 32];
    hkdf.expand(INFO, &mut key).expect("HKDF expand");
    key
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

fn encrypt(plaintext: &str, pubkey_bytes: &[u8]) -> String {
    let content_key = derive_content_key(pubkey_bytes);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);

    let ct = Aes256Gcm::new(content_key.as_slice().into())
        .encrypt(aes_gcm::Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .expect("AES-GCM encrypt");

    serde_json::json!({
        "v": 1,
        "scheme": "adr006-hkdf-sha3-256-aesgcm256",
        "nonce": URL_SAFE_NO_PAD.encode(nonce_bytes),
        "ct":    URL_SAFE_NO_PAD.encode(&ct),
    }).to_string()
}

fn decrypt(enc_json: &str, pubkey_bytes: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_str(enc_json)
        .unwrap_or_else(|e| panic!("Invalid encrypted JSON: {}", e));

    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(v["nonce"].as_str().expect("missing nonce"))
        .expect("nonce base64");
    let ct_bytes = URL_SAFE_NO_PAD
        .decode(v["ct"].as_str().expect("missing ct"))
        .expect("ct base64");

    let content_key = derive_content_key(pubkey_bytes);

    let plaintext = Aes256Gcm::new(content_key.as_slice().into())
        .decrypt(aes_gcm::Nonce::from_slice(&nonce_bytes), ct_bytes.as_slice())
        .expect("AES-GCM decrypt failed (wrong key or corrupted ciphertext)");

    String::from_utf8(plaintext).expect("UTF-8")
}
