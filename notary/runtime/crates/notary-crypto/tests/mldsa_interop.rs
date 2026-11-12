//! ML-DSA-44 interop (FIPS 204 pure mode, empty context) between `@noble/post-quantum` (TypeScript)
//! and the RustCrypto `ml-dsa` 0.1.2 crate (decision Q8, notary_runtime.md §4).
//!
//! * key generation from a seed gives the same public key;
//! * deterministic signing gives byte-identical signatures;
//! * every signature on the committed object vectors verifies in Rust (TS → Rust);
//! * Rust-made signatures (NOTARY_WRITE_VECTORS=1 writes them) verify in TypeScript (Rust → TS).
use ml_dsa::{Keypair, MlDsa44, Signature, SigningKey, VerifyingKey};
use notary_types::b64u;
use serde_json::{json, Value};
use std::path::PathBuf;

fn vec_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors").join(rel)
}
fn load(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(vec_path(rel)).unwrap()).unwrap()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}"))
}

fn verify(pk: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let Ok(pk) = pk.try_into() else { return false };
    let vk = VerifyingKey::<MlDsa44>::decode(&pk);
    let Ok(sig) = sig.try_into() else { return false };
    let Some(sig) = Signature::<MlDsa44>::decode(&sig) else { return false };
    vk.verify_with_context(msg, b"", &sig)
}

#[test]
fn rust_matches_noble_on_keys_and_deterministic_signatures() {
    let v = load("signatures.json");
    for c in v["cases"].as_array().unwrap() {
        let seed: [u8; 32] = b64u::decode_len(s(c, "seed_b64u"), 32).unwrap().try_into().unwrap();
        let sk = SigningKey::<MlDsa44>::from_seed(&seed.into());
        let pk = sk.verifying_key().encode();
        assert_eq!(b64u::encode(pk.as_slice()), s(c, "public_key_b64u"), "{}: public key from seed", s(c, "id"));
        let msg = b64u::decode(s(c, "message_b64u")).unwrap();
        let sig_noble = b64u::decode(s(c, "signature_b64u")).unwrap();
        assert_eq!(sig_noble.len(), 2420);
        assert!(verify(pk.as_slice(), &msg, &sig_noble), "{}: noble signature verifies in Rust", s(c, "id"));
        let sig_rust = sk.expanded_key().sign_deterministic(&msg, b"").unwrap().encode();
        assert_eq!(b64u::encode(sig_rust.as_slice()), s(c, "signature_b64u"), "{}: deterministic signatures are identical", s(c, "id"));
        // negative: wrong message, flipped bit
        assert!(!verify(pk.as_slice(), b"other message", &sig_noble));
        let mut bad = sig_noble.clone();
        bad[100] ^= 1;
        assert!(!verify(pk.as_slice(), &msg, &bad));
        // a non-empty context must not verify (domain separation is by `type`, not by context)
        let vk = VerifyingKey::<MlDsa44>::decode(&pk);
        let sig = Signature::<MlDsa44>::decode(&sig_noble.as_slice().try_into().unwrap()).unwrap();
        assert!(!vk.verify_with_context(&msg, b"ctx", &sig));
    }
}

#[test]
fn rust_verifies_every_signature_on_the_object_vectors() {
    let mut n = 0;
    for name in ["job", "announcement", "input", "host_receipt", "validation_receipt", "validation_receipt_rejected", "notarization",
                 "job_log", "identity_log", "handoff", "heartbeat", "state_blob"] {
        let f = load(&format!("objects/{name}.json"));
        for c in f["cases"].as_array().unwrap() {
            let msg = b64u::decode(s(c, "signing_bytes_b64u")).unwrap();
            for chk in c["signature_checks"].as_array().unwrap() {
                let entry = &c["input"][s(chk, "field")];
                let pk = b64u::decode(s(entry, "public_key")).unwrap();
                assert_eq!(s(chk, "signer_public_key"), s(entry, "public_key"));
                assert!(verify(&pk, &msg, &b64u::decode(s(entry, "signature")).unwrap()), "{name}.{}", s(chk, "field"));
                n += 1;
            }
        }
    }
    assert!(n >= 14, "verified {n} object signatures");
}

#[test]
fn write_rust_signatures() {
    if std::env::var("NOTARY_WRITE_VECTORS").is_err() {
        return;
    }
    use sha2::{Digest, Sha256};
    let mut cases = vec![];
    for (i, m) in ["", "rust-signed", "{\"type\":\"notary.job.v1\"}"].iter().enumerate() {
        let seed: [u8; 32] = Sha256::digest(format!("card-notary-rust-sig-key-{i}")).into();
        let sk = SigningKey::<MlDsa44>::from_seed(&seed.into());
        let sig = sk.expanded_key().sign_deterministic(m.as_bytes(), b"").unwrap().encode();
        cases.push(json!({
            "id": format!("RSIG-{i}"), "public_key_b64u": b64u::encode(sk.verifying_key().encode().as_slice()),
            "message_b64u": b64u::encode(m.as_bytes()), "signature_b64u": b64u::encode(sig.as_slice()),
        }));
    }
    let out = json!({ "scheme": "ML-DSA-44 (FIPS 204, pure mode, empty context)", "signer": "ml-dsa 0.1.2, deterministic", "cases": cases });
    std::fs::write(vec_path("signatures_rust.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
}
