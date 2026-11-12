//! CP9 checkpoint 1 (notary_runtime.md §17): X-Wing draft-06 HPKE interop between
//! `@hpke/hybridkem-x-wing` 0.7.1 (TypeScript) and `hpke` 0.15.1 `mlkem` + `x-wing` 0.1.1 (Rust).
//!
//! 1. `rust_reproduces_js_vectors`: from the JS-generated vectors (fixed seeds and a fixed 64-byte
//!    encapsulation randomness), Rust derives the same public key, produces the same `enc`, `ct`
//!    and exported secret bit for bit (sender direction), and opens the JS ciphertext (receiver direction).
//! 2. `write_rust_vectors` (run with NOTARY_WRITE_VECTORS=1): Rust seals fresh vectors that the
//!    TypeScript test (notary/vectors-tools/test/xwing.test.ts) must open (Rust → JS).
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::XWing, Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable,
    setup_receiver, setup_sender_with_rng,
};
use notary_types::b64u;
use rand_core::{TryCryptoRng, TryRng};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::path::PathBuf;

type Kem = XWing;
type Aead = ChaCha20Poly1305;
type Kdf = HkdfSha256;

/// Yields the given bytes once, then panics: pins the 64 bytes of encapsulation randomness.
struct FixedBytes(Vec<u8>);
impl TryRng for FixedBytes {
    type Error = Infallible;
    fn try_next_u32(&mut self) -> Result<u32, Infallible> { unimplemented!() }
    fn try_next_u64(&mut self) -> Result<u64, Infallible> { unimplemented!() }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        assert_eq!(dst.len(), self.0.len(), "X-Wing must draw exactly the 64 pinned bytes in one call");
        dst.copy_from_slice(&self.0);
        self.0.clear();
        Ok(())
    }
}
impl TryCryptoRng for FixedBytes {}

fn vec_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors").join(rel)
}
fn d(c: &Value, k: &str) -> Vec<u8> {
    b64u::decode(c[k].as_str().unwrap_or_else(|| panic!("missing {k}"))).unwrap()
}

#[test]
fn rust_reproduces_js_vectors() {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(vec_path("xwing/js_vectors.json")).unwrap()).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 3);
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let (sk, pk) = (d(c, "sk_b64u"), d(c, "pk_b64u"));
        assert_eq!(sk.len(), 32, "{id}: private key is the 32-byte seed");
        assert_eq!(pk.len(), 1216, "{id}: public key size");
        let (info, aad, pt) = (d(c, "info_b64u"), d(c, "aad_b64u"), d(c, "pt_b64u"));

        // NOTE (observation, not a failure): `DeriveKeyPair(ikm)` differs between the two libraries
        // (hpke 0.15.1 follows draft-ietf-hpke-pq-03; hpke-js 0.7.1 follows X-Wing draft-06 expansion).
        // The protocol never uses DeriveKeyPair: job keys are 32-byte secrets generated in the broker and
        // exchanged as raw bytes, which is what this test uses.
        let sk_p = <Kem as KemTrait>::PrivateKey::from_bytes(&sk).unwrap();
        assert_eq!(Kem::sk_to_pk(&sk_p).to_bytes().as_slice(), &pk[..], "{id}: sk_to_pk");

        // Sender direction: identical enc, ct and exported secret from identical randomness.
        let pk_p = <Kem as KemTrait>::PublicKey::from_bytes(&pk).unwrap();
        let mut rng = FixedBytes(d(c, "ekm_b64u"));
        let (enc, mut sctx) = setup_sender_with_rng::<Aead, Kdf, Kem>(&OpModeS::Base, &pk_p, &info, &mut rng).unwrap();
        assert_eq!(enc.to_bytes().len(), 1120);
        assert_eq!(b64u::encode(&enc.to_bytes()), c["enc_b64u"], "{id}: enc");
        let ct = sctx.seal(&pt, &aad).unwrap();
        assert_eq!(b64u::encode(&ct), c["ct_b64u"], "{id}: ct");
        let mut ex = [0u8; 32];
        sctx.export(c["export_context"].as_str().unwrap().as_bytes(), &mut ex).unwrap();
        assert_eq!(b64u::encode(&ex), c["exported_b64u"], "{id}: exported secret");

        // Receiver direction: Rust opens the JS ciphertext.
        let enc_js = <Kem as KemTrait>::EncappedKey::from_bytes(&d(c, "enc_b64u")).unwrap();
        let mut rctx = setup_receiver::<Aead, Kdf, Kem>(&OpModeR::Base, &sk_p, &enc_js, &info).unwrap();
        let ct_js = d(c, "ct_b64u");
        let plain = rctx.open(&ct_js, &aad).unwrap();
        assert_eq!(plain, pt, "{id}: plaintext");
        let mut ex2 = [0u8; 32];
        rctx.export(c["export_context"].as_str().unwrap().as_bytes(), &mut ex2).unwrap();
        assert_eq!(b64u::encode(&ex2), c["exported_b64u"], "{id}: receiver exported secret");

        // A modified aad must not open (the aad binds epoch, job and type).
        let mut rctx2 = setup_receiver::<Aead, Kdf, Kem>(&OpModeR::Base, &sk_p, &enc_js, &info).unwrap();
        assert!(rctx2.open(&ct_js, b"wrong").is_err(), "{id}: wrong aad must fail");
    }
}

/// Rust → JS: fresh seeds and randomness chosen on the Rust side, sealed here, opened by TypeScript.
#[test]
fn write_rust_vectors() {
    if std::env::var("NOTARY_WRITE_VECTORS").is_err() {
        return;
    }
    use sha2::{Digest, Sha256};
    let h = |s: &str| -> Vec<u8> { Sha256::digest(s.as_bytes()).to_vec() };
    let mut cases = vec![];
    for n in 0..3u64 {
        let seed = h(&format!("card-notary-xwing-rust-seed-{n}"));
        let ekm = [h(&format!("rust-ekm-a-{n}")), h(&format!("rust-ekm-b-{n}"))].concat();
        let job_hash = h(&format!("rust-job-{n}"));
        let epoch = n + 7;
        let mut info = b"card-notary-input-v1".to_vec();
        info.push(0);
        info.extend_from_slice(&job_hash);
        info.extend_from_slice(&epoch.to_be_bytes());
        info.extend_from_slice(b"x-wing-draft-06");
        let aad = notary_types::jcs::canonical(&json!({
            "epoch": epoch, "job_hash": b64u::encode(&job_hash), "kem": "x-wing-draft-06", "type": "notary.sealed_input.v1"
        })).unwrap();
        let pt = notary_types::jcs::canonical(&json!({"type": "notary.input.v1", "from": "rust", "n": n})).unwrap();
        let (sk, pk) = Kem::derive_keypair(&seed);
        let mut rng = FixedBytes(ekm.clone());
        let (enc, mut sctx) = setup_sender_with_rng::<Aead, Kdf, Kem>(&OpModeS::Base, &pk, &info, &mut rng).unwrap();
        let ct = sctx.seal(&pt, &aad).unwrap();
        let mut ex = [0u8; 32];
        sctx.export(b"card-notary-receipt-v1", &mut ex).unwrap();
        cases.push(json!({
            "id": format!("RX-{n}"), "seed_b64u": b64u::encode(&seed), "sk_b64u": b64u::encode(&sk.to_bytes()), "pk_b64u": b64u::encode(&pk.to_bytes()),
            "ekm_b64u": b64u::encode(&ekm), "info_b64u": b64u::encode(&info), "aad_b64u": b64u::encode(&aad), "pt_b64u": b64u::encode(&pt),
            "enc_b64u": b64u::encode(&enc.to_bytes()), "ct_b64u": b64u::encode(&ct), "export_context": "card-notary-receipt-v1", "exported_b64u": b64u::encode(&ex),
        }));
    }
    let out = json!({
        "suite": { "kem": "X-Wing draft-06 (0x647a)", "kdf": "HKDF-SHA256", "aead": "ChaCha20-Poly1305", "mode": "base" },
        "producer": "hpke 0.15.1 (mlkem) + x-wing 0.1.1", "cases": cases,
    });
    std::fs::write(vec_path("xwing/rust_vectors.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
}
