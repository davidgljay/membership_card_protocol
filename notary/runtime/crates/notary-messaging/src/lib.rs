//! `notary_output` messages (messaging_protocol.md §24; process_specs/message_routing.md "Sender-Side Fan-out").
//!
//! The construction is the App SDK's (`app-sdk/src/messaging/fanout.ts`), and cross-language vectors check it
//! (`notary/vectors/messaging/`): a fresh ML-KEM-768 encapsulation to the sub-card's key, a content key
//! `HKDF-SHA3-256(shared secret, no salt, info = "card-protocol-message-fanout-v1")`, AES-256-GCM with a random 12-byte
//! nonce and no associated data, and the blob `u32be(len(kem ciphertext)) ‖ kem ciphertext ‖ nonce ‖ AEAD ciphertext`.
//! The plaintext is the signed message envelope `{ payload, signatures }`, JSON.
//!
//! The enclave builds the envelope and signs it with `K_id` over the canonical payload; the host only relays the
//! per-sub-card blobs (`deliver`).
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm};
use ml_kem::{kem::{Decapsulate, Encapsulate, FromSeed, KeyExport}, EncapsulationKey, MlKem768};
use notary_types::{b64u, jcs};
use serde_json::{json, Value};

pub const CONTENT_KEY_INFO: &[u8] = b"card-protocol-message-fanout-v1";
pub const KEM_PUBLIC_KEY_LEN: usize = 1184;
pub const KEM_SEED_LEN: usize = 64;
pub const PROTOCOL_VERSION: &str = "0.1";

#[derive(Debug, PartialEq, Eq)]
pub enum MessagingError {
    BadKemKey,
    BadBlob,
    Decrypt,
    Random,
}

fn content_key(shared: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf::SimpleHkdf::<sha3_12::Sha3_256>::new(None, shared).expand(CONTENT_KEY_INFO, &mut out).expect("32 bytes");
    out
}

/// Encrypts `plaintext` to one sub-card's ML-KEM-768 public key. Returns the blob (before base64url).
pub fn seal_to_subcard(plaintext: &[u8], kem_public_key: &[u8]) -> Result<Vec<u8>, MessagingError> {
    let key: &[u8; KEM_PUBLIC_KEY_LEN] = kem_public_key.try_into().map_err(|_| MessagingError::BadKemKey)?;
    let ek = EncapsulationKey::<ml_kem::MlKem768>::new(&(*key).into()).map_err(|_| MessagingError::BadKemKey)?;
    let (ct, shared) = ek.encapsulate();
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).map_err(|_| MessagingError::Random)?;
    let aead = Aes256Gcm::new_from_slice(&content_key(shared.as_slice())).expect("32 bytes")
        .encrypt(&nonce.into(), plaintext).map_err(|_| MessagingError::Decrypt)?;
    let mut blob = Vec::with_capacity(4 + ct.len() + 12 + aead.len());
    blob.extend_from_slice(&(ct.len() as u32).to_be_bytes());
    blob.extend_from_slice(ct.as_slice());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&aead);
    Ok(blob)
}

/// The recipient side, from the 64-byte ML-KEM seed `d ‖ z` (used by tests and vectors; wallets use the App SDK).
pub fn open_blob(blob: &[u8], kem_seed: &[u8; KEM_SEED_LEN]) -> Result<Vec<u8>, MessagingError> {
    if blob.len() < 4 {
        return Err(MessagingError::BadBlob);
    }
    let ct_len = u32::from_be_bytes(blob[..4].try_into().expect("4")) as usize;
    let (ct_end, nonce_end) = (4usize.checked_add(ct_len).ok_or(MessagingError::BadBlob)?, 4 + ct_len + 12);
    if blob.len() < nonce_end {
        return Err(MessagingError::BadBlob);
    }
    let (dk, _) = MlKem768::from_seed(&(*kem_seed).into());
    let ct = blob[4..ct_end].try_into().map_err(|_| MessagingError::BadBlob)?;
    let shared = dk.decapsulate(&ct);
    let nonce: [u8; 12] = blob[ct_end..nonce_end].try_into().expect("12");
    Aes256Gcm::new_from_slice(&content_key(shared.as_slice())).expect("32 bytes").decrypt(&nonce.into(), &blob[nonce_end..]).map_err(|_| MessagingError::Decrypt)
}

/// The ML-KEM-768 public key for a 64-byte seed (tests and vectors).
pub fn public_key_from_seed(kem_seed: &[u8; KEM_SEED_LEN]) -> Vec<u8> {
    let (_, ek) = MlKem768::from_seed(&(*kem_seed).into());
    ek.to_bytes().to_vec()
}

/// The `notary_output` payload (messaging_protocol.md §24). `recipients` are card pointers, `sender` is the notary card.
pub fn output_payload(job_hash: &str, notarization_cid: &str, output: &Value, output_hash: &str, recipients: &[String], sender: &str, timestamp: &str) -> Value {
    json!({
        "type": "notary_output",
        "content": { "job_hash": job_hash, "notarization": notarization_cid, "output": output, "output_hash": output_hash },
        "recipients": recipients, "senders": [sender], "protocol_version": PROTOCOL_VERSION, "timestamp": timestamp,
    })
}

/// Signs a payload: `{ payload, signatures: [{ public_key, signature }] }`, the signature (ML-DSA-44) over the canonical
/// payload (`signMessageEnvelope`).
pub fn sign_envelope(payload: Value, signer: &notary_crypto::MlDsaKey) -> Result<Value, notary_types::NotaryError> {
    let canonical = jcs::canonical(&payload)?;
    Ok(json!({ "payload": payload, "signatures": [{ "public_key": b64u::encode(signer.public_key()), "signature": b64u::encode(&signer.sign(&canonical)) }] }))
}

/// One routing envelope per sub-card: `{ to, subcard_hash, payload }` with the base64url blob (`RoutingEnvelope`).
pub fn routing_envelopes(envelope: &Value, recipient_card: &str, subcards: &[(String, Vec<u8>)]) -> Result<Vec<Value>, MessagingError> {
    let plaintext = serde_json::to_vec(envelope).map_err(|_| MessagingError::BadBlob)?;
    subcards.iter().map(|(hash, kem_key)| Ok(json!({ "to": recipient_card, "subcard_hash": hash, "payload": b64u::encode(&seal_to_subcard(&plaintext, kem_key)?) }))).collect()
}
