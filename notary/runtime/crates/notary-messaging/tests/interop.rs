//! Cross-language check with the App SDK (code-plan §7.2, `notary/vectors/messaging/`):
//! - `ts_blob.json`: a message fanned out by the App SDK's `fanOutMessageToSubCards`; Rust opens it.
//! - `rust_blob.json`: a message sealed here; `vectors-tools` opens it with the App SDK's `decryptRoutingEnvelope` and
//!   verifies the `K_id` signature. Written with `NOTARY_WRITE_VECTORS=1` (randomised encryption, so a static vector).
use notary_crypto::MlDsaKey;
use notary_messaging::*;
use notary_types::b64u;
use serde_json::{json, Value};
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/messaging")
}

fn seed_of(v: &Value) -> [u8; KEM_SEED_LEN] {
    b64u::decode(v["kem_seed"].as_str().unwrap()).unwrap().try_into().unwrap()
}

#[test]
fn rust_opens_what_the_app_sdk_fanned_out() {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dir().join("ts_blob.json")).unwrap()).unwrap();
    let seed = seed_of(&v);
    assert_eq!(public_key_from_seed(&seed), b64u::decode(v["kem_public_key"].as_str().unwrap()).unwrap(), "the same key from the same seed in both libraries");
    let blob = b64u::decode(v["routing"]["payload"].as_str().unwrap()).unwrap();
    let plain = open_blob(&blob, &seed).expect("opens");
    let envelope: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(envelope, v["envelope"]);
}

#[test]
fn a_message_sealed_here_round_trips_and_only_its_key_opens_it() {
    let seed: [u8; 64] = core::array::from_fn(|i| (i * 7 + 3) as u8);
    let pk = public_key_from_seed(&seed);
    assert_eq!(pk.len(), KEM_PUBLIC_KEY_LEN);
    let blob = seal_to_subcard(b"hello", &pk).unwrap();
    assert_eq!(open_blob(&blob, &seed).unwrap(), b"hello");
    let other: [u8; 64] = core::array::from_fn(|i| (i * 11 + 5) as u8);
    assert_eq!(open_blob(&blob, &other), Err(MessagingError::Decrypt), "implicit rejection: another key gets a different secret, so the AEAD fails");
    let mut bad = blob.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(open_blob(&bad, &seed), Err(MessagingError::Decrypt));
    assert_eq!(open_blob(&blob[..3], &seed), Err(MessagingError::BadBlob));
    assert_eq!(seal_to_subcard(b"x", &pk[..100]), Err(MessagingError::BadKemKey));
}

#[test]
fn rust_blob_for_the_app_sdk() {
    let seed: [u8; 64] = core::array::from_fn(|i| (i * 7 + 3) as u8);
    let k_id = MlDsaKey::from_seed(notary_crypto::SecretBytes::from_vec(notary_crypto::sha256(b"notary-messaging-vector-K_id").to_vec())).unwrap();
    let payload = output_payload("jh", "bafkreinotarization", &json!({ "count": 12, "sum": 345 }), "oh", &["r".repeat(64)], &"s".repeat(64), "2026-11-14T10:00:00.000Z");
    let envelope = sign_envelope(payload, &k_id).unwrap();
    let routing = routing_envelopes(&envelope, &"r".repeat(64), &[("sub".repeat(21) + "x", public_key_from_seed(&seed))]).unwrap();
    // opens with the seed, and the envelope inside is the signed one
    let opened = open_blob(&b64u::decode(routing[0]["payload"].as_str().unwrap()).unwrap(), &seed).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&opened).unwrap(), envelope);
    let out = json!({
        "about": "A notary_output message sealed by notary-messaging to the ML-KEM-768 key of the seed, signed by the K_id below. vectors-tools opens it with the App SDK's decryptRoutingEnvelope and verifies the signature. Static: encryption is randomised.",
        "kem_seed": b64u::encode(&seed), "k_id_public_key": b64u::encode(k_id.public_key()), "envelope": envelope, "routing": routing[0],
    });
    let path = dir().join("rust_blob.json");
    if std::env::var("NOTARY_WRITE_VECTORS").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    }
    assert!(path.exists(), "run with NOTARY_WRITE_VECTORS=1 to write {}", path.display());
}
