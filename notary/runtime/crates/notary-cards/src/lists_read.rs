//! Reading a governance list card's version history (notary_runtime.md §12 step 2, as amended 2026-11-12).
//!
//! The list card's address and public key are pinned in the image; its registry entry (`card_head:`) gives the head
//! events in order, and each version is an IPFS document (`ipfs:`) checked against its CID and decrypted with the pinned
//! key. Every read is a vsock `fetch`: no network connection. Checks per version:
//! - the genesis `CardDocument`'s `press_signature` (base64url) verifies under the pinned press key, over the document
//!   without `press_signature`;
//! - each `LogEntry`'s `press_signature` (SignatureEntry) is by the pinned press key, over the entry without it; its
//!   `prev_log_root` is the previous version's CID; its `intent_signature` signer is the pinned holder key. The intent
//!   payload can't be rebuilt from a LogEntry (it lacks `target_card`, `updater_card`, `timestamp`: erratum E33), so the
//!   intent signature itself isn't verified. The member signatures of algorithm L carry the list's trust.
//!
//! Returns `(list value, list_approval text)` per version, oldest first, for algorithm L.
use crate::support::{aes_gcm_decrypt, canonicalize, content_key, without};
use crate::world::CardSource;
use notary_types::b64u;
use serde_json::{Map, Value};

pub struct ListCardPins<'a> {
    pub address: &'a str,
    pub public_key: &'a [u8],
    /// `accepted_runtimes` or `program_allowlist`.
    pub field: &'a str,
    pub holder_key: &'a [u8],
    pub press_key: &'a [u8],
}

fn decrypt(src: &dyn CardSource, cid: &str, key: &[u8; 32]) -> Option<Map<String, Value>> {
    match serde_json::from_slice::<Value>(&aes_gcm_decrypt(key, &src.fetch(cid)?)?).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn press_entry_ok(entry: &Value, press_key: &[u8]) -> bool {
    let Some(sig) = entry.get("press_signature") else { return false };
    let (Some(pk), Some(s)) = (sig.get("public_key").and_then(Value::as_str), sig.get("signature").and_then(Value::as_str)) else { return false };
    let (Ok(pk), Ok(s)) = (b64u::decode(pk), b64u::decode(s)) else { return false };
    pk == press_key && canonicalize(&without(entry, &["press_signature"])).is_some_and(|m| notary_crypto::mldsa_verify(&pk, &m, &s))
}

pub fn read_list_history(src: &dyn CardSource, pins: &ListCardPins<'_>) -> Option<Vec<(Value, Option<String>)>> {
    if crate::support::address_of(pins.public_key) != pins.address {
        return None;
    }
    let key = content_key(pins.public_key);
    let entry = src.card(pins.address)?;
    let mut state = Map::new();
    let mut out = vec![];
    let mut prev_cid: Option<String> = None;
    for (i, ev) in entry.events.iter().enumerate() {
        let doc = decrypt(src, &ev.cid, &key)?;
        let v = Value::Object(doc.clone());
        if i == 0 {
            // genesis CardDocument
            let sig = doc.get("press_signature").and_then(Value::as_str).and_then(|s| b64u::decode(s).ok())?;
            let msg = canonicalize(&without(&v, &["press_signature"]))?;
            if !notary_crypto::mldsa_verify(pins.press_key, &msg, &sig) {
                return None;
            }
            state = doc;
        } else {
            if !press_entry_ok(&v, pins.press_key) {
                return None;
            }
            if doc.get("prev_log_root").and_then(Value::as_str) != prev_cid.as_deref() {
                return None;
            }
            let intent_pk = doc.get("intent_signature").and_then(|s| s.get("public_key")).and_then(Value::as_str).and_then(|k| b64u::decode(k).ok())?;
            if intent_pk != pins.holder_key {
                return None;
            }
            if let Some(Value::Object(cs)) = doc.get("card_state") {
                for (k, x) in cs {
                    state.insert(k.clone(), x.clone());
                }
            }
        }
        out.push((state.get(pins.field).cloned().unwrap_or(Value::Null), state.get("list_approval").and_then(Value::as_str).map(String::from)));
        prev_cid = Some(ev.cid.clone());
    }
    if entry.events.last().map(|e| e.cid.as_str()) != Some(entry.log_head_cid.as_str()) {
        return None;
    }
    Some(out)
}
