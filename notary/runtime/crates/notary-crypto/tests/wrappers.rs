//! The production wrappers (runtime §4, §15) against the cross-language vectors and their own properties.
use notary_crypto::*;
use notary_types::b64u;
use serde_json::{json, Value};

fn load(rel: &str) -> Value {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors").join(rel);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}
fn d(c: &Value, k: &str) -> Vec<u8> {
    b64u::decode(c[k].as_str().unwrap()).unwrap()
}

#[test]
fn mldsa_wrapper_matches_noble_vectors() {
    for c in load("signatures.json")["cases"].as_array().unwrap() {
        let k = MlDsaKey::from_seed(SecretBytes::from_vec(d(c, "seed_b64u"))).unwrap();
        assert_eq!(k.public_key(), d(c, "public_key_b64u").as_slice());
        assert_eq!(k.sign(&d(c, "message_b64u")), d(c, "signature_b64u"), "deterministic signature");
        assert!(mldsa_verify(k.public_key(), &d(c, "message_b64u"), &d(c, "signature_b64u")));
    }
}

#[test]
fn signature_entries_round_trip_and_bind_the_key() {
    let k = MlDsaKey::generate();
    let mut obj = json!({ "type": "notary.validation_receipt.v1", "acks": 2, "status": "accepted" });
    obj["notary_signature"] = k.sign_object(&obj, "notary_signature").unwrap();
    assert!(verify_object(&obj, "notary_signature", k.public_key()));
    assert!(!verify_object(&obj, "notary_signature", MlDsaKey::generate().public_key()), "wrong expected key");
    obj["acks"] = json!(3);
    assert!(!verify_object(&obj, "notary_signature", k.public_key()), "tampered body");
}

#[test]
fn xwing_wrapper_opens_wallet_vectors_and_exports_the_receipt_key() {
    for c in load("xwing/js_vectors.json")["cases"].as_array().unwrap() {
        let key = XWingKey::from_secret(SecretBytes::from_vec(d(c, "sk_b64u"))).unwrap();
        assert_eq!(key.public_key(), d(c, "pk_b64u").as_slice());
        let job_hash: [u8; 32] = d(c, "job_hash_b64u").try_into().unwrap();
        let (info, aad) = sealed_input_info_aad(&job_hash, c["epoch"].as_u64().unwrap());
        assert_eq!(info, d(c, "info_b64u"), "info is built exactly as the wallet builds it");
        assert_eq!(aad, d(c, "aad_b64u"), "aad is built exactly as the wallet builds it");
        let opened = key.open(&d(c, "enc_b64u"), &d(c, "ct_b64u"), &info, &aad).unwrap();
        assert_eq!(opened.plaintext.expose(), d(c, "pt_b64u").as_slice());
        assert_eq!(opened.receipt_key.expose(), d(c, "exported_b64u").as_slice());
        assert!(key.open(&d(c, "enc_b64u"), &d(c, "ct_b64u"), &info, b"other aad").is_err());
    }
}

#[test]
fn xwing_seal_open_and_receipts() {
    let key = XWingKey::generate();
    assert_eq!(key.public_key().len(), XWING_PUBLIC_KEY_LEN);
    let (info, aad) = sealed_input_info_aad(&[7u8; 32], 3);
    let s = xwing_seal(key.public_key(), &info, &aad, b"hello").unwrap();
    assert_eq!(s.enc.len(), XWING_ENC_LEN);
    let o = key.open(&s.enc, &s.ct, &info, &aad).unwrap();
    assert_eq!(o.plaintext.expose(), b"hello");
    assert_eq!(o.receipt_key.expose(), s.receipt_key.expose(), "both sides export the same receipt key");

    let sealed = seal_receipt(&o.receipt_key, "IH", "JH", b"{\"r\":1}").unwrap();
    assert_eq!(open_receipt(&s.receipt_key, "IH", "JH", &sealed).unwrap(), b"{\"r\":1}");
    assert!(open_receipt(&s.receipt_key, "IH2", "JH", &sealed).is_err(), "aad binds input_hash");
    assert!(XWingKey::generate().open(&s.enc, &s.ct, &info, &aad).is_err(), "another key can't open");
}

#[test]
fn chain_key_signs_digests_as_the_message_hash() {
    let k = ChainKey::generate();
    let digest = sha256(b"payload");
    let sig = k.sign_digest(&digest).unwrap();
    assert_eq!(sig.len(), 64);
    assert!(p256_verify_digest(&k.public_key_xy(), &digest, &sig));
    assert!(!p256_verify_digest(&k.public_key_xy(), &sha256(b"other"), &sig));
    let k2 = ChainKey::from_secret(&k.secret()).unwrap();
    assert_eq!(k2.public_key_xy(), k.public_key_xy(), "handoff of the scalar reproduces the key");
}

#[test]
fn secrets_are_zeroized_and_hashes_are_standard() {
    let s = SecretBytes::from_vec(vec![1, 2, 3]);
    assert_eq!(s.expose(), &[1, 2, 3]);
    assert_eq!(format!("{s:?}"), "SecretBytes(3 bytes, redacted)");
    // Known answers: keccak256("") = c5d24601…, SHA3-256("") = a7ffc6f8…434a.
    assert_eq!(b64u::encode(&keccak256(b"")), "xdJGAYb3IzySfn2y3McDwOUAtlPKgic7e_rYBF2FpHA");
    assert_eq!(b64u::encode(&sha3_256(b"")), "p__G-L8e12ZRwUdWoGHWYvWA_03kO0n6gtgKS4D4Q0o");
    let mut out = [0u8; 42];
    // RFC 5869 test case 1
    let ikm = [0x0bu8; 22];
    let salt: Vec<u8> = (0u8..=0x0c).collect();
    let info: Vec<u8> = (0xf0u8..=0xf9).collect();
    hkdf_sha256(&ikm, &salt, &info, &mut out).unwrap();
    assert_eq!(out[..4], [0x3c, 0xb2, 0x5f, 0x25]);
}
