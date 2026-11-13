//! Algorithm R (notary_lifecycle.md Appendix A.7): the policy at `policy_state_cid` and the job requester — twin of
//! `verifier/src/notary/policy.ts`, judged against `notary/vectors/cards/policy_cases.json`.
//!
//! In the enclave every read is a vsock `fetch` through the `CardSource`; there is no network connection. Content is
//! checked against its CID (the `CardSource` returns only CID-checked bytes); trust comes from the pinned roots.
use crate::predicates::{self, Context};
use crate::stages::{stage3, stage4, Doc, Roots};
use crate::support::{address_of, aes_gcm_decrypt, content_key};
use crate::world::CardSource;
use notary_types::b64u;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct PolicyRead {
    pub policy_address: String,
    pub notary: Value,
    pub approved_notaries: Vec<String>,
}

fn parse_object(bytes: &[u8]) -> Option<Doc> {
    match serde_json::from_slice::<Value>(bytes).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// R1: a document that is AES-256-GCM under `key`, or plain JSON.
fn read_doc(src: &dyn CardSource, cid: &str, key: &[u8; 32]) -> Option<Doc> {
    let bytes = src.fetch(cid)?;
    if let Some(p) = aes_gcm_decrypt(key, &bytes).and_then(|p| parse_object(&p)) {
        return Some(p);
    }
    parse_object(&bytes)
}

/// A head: a document, or a LogEntry overlaid on its genesis (`decryptCardHead`'s rule), each plain or encrypted.
fn read_head(src: &dyn CardSource, cid: &str, key: &[u8; 32]) -> Option<Doc> {
    let head = read_doc(src, cid, key)?;
    if !matches!(head.get("entry_type").and_then(Value::as_str), Some("field_update") | Some("revocation")) {
        return Some(head);
    }
    let genesis_cid = head.get("history").and_then(Value::as_array).and_then(|h| h.first()).and_then(Value::as_str);
    let mut doc = match genesis_cid {
        Some(g) => read_doc(src, g, key)?,
        None => Map::new(),
    };
    if let Some(Value::Object(state)) = head.get("card_state") {
        for (k, v) in state {
            doc.insert(k.clone(), v.clone());
        }
    }
    for k in ["entry_type", "code", "revocation", "history", "version", "prev_log_root"] {
        if let Some(v) = head.get(k) {
            doc.insert(k.into(), v.clone());
        }
    }
    Some(doc)
}

pub struct ChainOk {
    pub chain: Vec<(String, Doc)>,
    pub addresses: Vec<String>,
}

fn chain_ok(src: &dyn CardSource, doc: Doc, address: &str, roots: &Roots<'_>, now_ms: i64) -> Option<ChainOk> {
    let s3 = stage3(src, doc, address, roots).ok()?;
    let s4 = stage4(src, &s3.chain, now_ms);
    if s4.history_mismatch {
        return None;
    }
    if let Some(eff) = &s4.earliest {
        if notary_types::formats::parse_timestamp(eff).is_ok_and(|t| t <= now_ms) {
            return None;
        }
    }
    Some(ChainOk { chain: s3.chain.into_iter().map(|l| (l.address, l.content)).collect(), addresses: s3.addresses })
}

/// R1–R4.
pub fn read_policy(src: &dyn CardSource, policy_id: &str, state_cid: &str, replica_cards: &[String], roots: &Roots<'_>, now_ms: i64) -> Result<PolicyRead, &'static str> {
    // R1: the policy_id document is plain JSON and gives the policy key and address
    let genesis = src.fetch(policy_id).and_then(|b| parse_object(&b)).ok_or("JOB_POLICY_UNTRUSTED")?;
    let pubkey = genesis
        .get("recipient_pubkey")
        .and_then(Value::as_str)
        .and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok())
        .ok_or("JOB_POLICY_UNTRUSTED")?;
    let key = content_key(&pubkey);
    let address = address_of(&pubkey);
    let state = read_head(src, state_cid, &key).ok_or("JOB_POLICY_UNTRUSTED")?;
    // R2
    let entry = src.card(&address).ok_or("JOB_POLICY_UNTRUSTED")?;
    if !entry.events.iter().any(|e| e.cid == state_cid) {
        return Err("JOB_POLICY_CHANGED");
    }
    let head = read_head(src, &entry.log_head_cid, &key).ok_or("JOB_POLICY_UNTRUSTED")?;
    if head.get("notary") != state.get("notary") || head.get("approved_notaries") != state.get("approved_notaries") {
        return Err("JOB_POLICY_CHANGED");
    }
    // R3
    chain_ok(src, head.clone(), &address, roots, now_ms).ok_or("JOB_POLICY_UNTRUSTED")?;
    // R4
    let approved: Vec<String> = head.get("approved_notaries").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
    if !replica_cards.iter().all(|r| approved.contains(r)) {
        return Err("JOB_NOTARY_NOT_APPROVED");
    }
    Ok(PolicyRead { policy_address: address, notary: head.get("notary").cloned().unwrap_or(Value::Null), approved_notaries: approved })
}

/// R5: the requester's chain satisfies `predicate`; `is_holder` iff the requester holds the policy card.
pub fn requester_allowed(src: &dyn CardSource, job: &Value, predicate: &Value, policy_address: &str, roots: &Roots<'_>, now_ms: i64) -> bool {
    let Some(pubkey) = job.get("requester_pubkey").and_then(Value::as_str).and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok()) else {
        return false;
    };
    let Some(card) = job.get("requester_card").and_then(Value::as_str) else { return false };
    if address_of(&pubkey) != card {
        return false;
    }
    let Some(entry) = src.card(card) else { return false };
    let Some(head) = read_head(src, &entry.log_head_cid, &content_key(&pubkey)) else { return false };
    let Some(c) = chain_ok(src, head, card, roots, now_ms) else { return false };
    let empty = Map::new();
    let params = job.get("parameters").and_then(Value::as_object).unwrap_or(&empty);
    let chain: Vec<(String, &Doc)> = c.chain.iter().map(|(a, d)| (a.clone(), d)).collect();
    let ctx = Context { chain: &chain, addresses: &c.addresses, parameters: Some(params), is_holder: card == policy_address, is_issuer: false };
    predicates::evaluate(predicate, &ctx)
}
