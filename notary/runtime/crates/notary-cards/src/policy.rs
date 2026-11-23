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
    /// The policy card's ML-DSA-44 public key (from the plain `policy_id` document). A derived card's `ancestry_pubkeys`
    /// ends with it (step 6.4).
    pub policy_pubkey: Vec<u8>,
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
    Ok(PolicyRead { policy_address: address, notary: head.get("notary").cloned().unwrap_or(Value::Null), approved_notaries: approved, policy_pubkey: pubkey })
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

/// Step 6.5, E4 (decided by David, 2026-11-19): the ML-DSA-44 keys of the source policy's **certified presses**. A linked
/// source card's new head counts only if one of them signed it (`entry_press_signed`); any of them will do
/// (`derived_card_revocation_propagation.md` §6 step 2).
///
/// A `LogEntry` doesn't carry the `UpdateIntentPayload`'s `target_card`, `updater_card` or `timestamp`, so its
/// `intent_signature` can't be checked by any reader; the press checked `revocation_permissions` at submission. What can be
/// checked is the press. A key is certified when:
/// 1. its press card is in the source policy's current `approved_presses`, named by the press card document's CID (as
///    the press writes it, `press/src/functions/issuance.ts`) or by the card pointer (`keccak256` of the key,
///    protocol-objects §2). The press card document is published readable (press.md, "Press card"), so the key is read
///    from its `recipient_pubkey`; for a pointer, `keccak256` of that key must be the pointer;
/// 2. the press card is registered, and its current head chains to a pinned trusted root and isn't revoked (Stages 3
///    and 4).
///
/// 6.5a (C): the names of the source policy's fields with `derivable: false` at its **current head** (default `true`;
/// `card_protocol_spec.md §1`). Same reads as `certified_press_keys`: the genesis, then the registry head, whose chain must
/// reach a trusted root. Through the host, so unverified against a lying host (L4).
pub fn non_derivable_fields(src: &dyn CardSource, policy_id: &str, roots: &Roots<'_>, now_ms: i64) -> Result<Vec<String>, &'static str> {
    let genesis = src.fetch(policy_id).and_then(|b| parse_object(&b)).ok_or("SOURCE_POLICY_UNREADABLE")?;
    let policy_pk = genesis
        .get("recipient_pubkey")
        .and_then(Value::as_str)
        .and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok())
        .ok_or("SOURCE_POLICY_UNREADABLE")?;
    let addr = address_of(&policy_pk);
    let entry = src.card(&addr).ok_or("SOURCE_POLICY_UNREADABLE")?;
    let head = read_head(src, &entry.log_head_cid, &content_key(&policy_pk)).ok_or("SOURCE_POLICY_UNREADABLE")?;
    let names = non_derivable_in(&head);
    chain_ok(src, head, &addr, roots, now_ms).ok_or("SOURCE_POLICY_UNREADABLE")?;
    Ok(names)
}

/// The `derivable: false` field names in a policy document's `field_definitions` (an array of definitions).
pub fn non_derivable_in(policy: &Doc) -> Vec<String> {
    policy
        .get("field_definitions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|d| d.get("derivable").and_then(Value::as_bool) == Some(false))
        .filter_map(|d| d.get("name").and_then(Value::as_str).map(String::from))
        .collect()
}

/// Every read here is per policy, never per update: what the enclave asks the host for must not depend on which cards are
/// linked (§6 step 2). A forger needs a governance-certified press key, not just the source card's public key (from which
/// its content key is derived). The policy head and the registry reads come through the host (L4).
pub fn certified_press_keys(src: &dyn CardSource, policy_id: &str, roots: &Roots<'_>, now_ms: i64) -> Result<Vec<Vec<u8>>, &'static str> {
    let genesis = src.fetch(policy_id).and_then(|b| parse_object(&b)).ok_or("SOURCE_POLICY_UNREADABLE")?;
    let policy_pk = genesis
        .get("recipient_pubkey")
        .and_then(Value::as_str)
        .and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok())
        .ok_or("SOURCE_POLICY_UNREADABLE")?;
    let policy_entry = src.card(&address_of(&policy_pk)).ok_or("SOURCE_POLICY_UNREADABLE")?;
    let policy = read_head(src, &policy_entry.log_head_cid, &content_key(&policy_pk)).ok_or("SOURCE_POLICY_UNREADABLE")?;
    let mut keys: Vec<Vec<u8>> = vec![];
    for a in policy.get("approved_presses").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let by_pointer = src.card(a);
        // a pointer names a registered card: its genesis (first event) is the published press card document
        let doc_cid = match &by_pointer {
            Some(e) => match e.events.first() {
                Some(g) => g.cid.as_str(),
                None => return Err("PRESS_UNREADABLE"),
            },
            None => a,
        };
        let Some(pk) = src
            .fetch(doc_cid)
            .and_then(|b| parse_object(&b))
            .and_then(|d| d.get("recipient_pubkey").and_then(Value::as_str).map(crate::support::b64_lenient))
            .filter(|k| k.len() == notary_crypto::MLDSA44_PUBLIC_KEY_LEN)
        else {
            // F8.6: a registered card whose first event isn't a readable press document (registry heads are encrypted,
            // so a pointer only works if the genesis was published plain) would certify nobody: say so, don't skip it.
            // A name that resolves to nothing at all stays a skip (a press not yet registered is not an error).
            if by_pointer.is_some() {
                return Err("PRESS_UNREADABLE");
            }
            continue;
        };
        let addr = address_of(&pk);
        if by_pointer.is_some() && addr != a {
            continue;
        }
        let key = content_key(&pk);
        let binds = |d: &Doc| d.get("recipient_pubkey").and_then(Value::as_str).is_some_and(|r| crate::support::b64_lenient(r) == pk);
        let Some(head) = src.card(&addr).and_then(|e| read_head(src, &e.log_head_cid, &key)).filter(binds) else { continue };
        if chain_ok(src, head, &addr, roots, now_ms).is_some() && !keys.contains(&pk) {
            keys.push(pk);
        }
    }
    Ok(keys)
}

/// Step 6.5, E4: `entry`'s `press_signature` verifies, under the key it names, over the entry without it, and that key is
/// one of `certified` (`certified_press_keys`). No reads.
pub fn entry_press_signed(entry: &Value, certified: &[Vec<u8>]) -> Result<(), &'static str> {
    let sig = entry.get("press_signature").ok_or("PRESS_SIGNATURE_INVALID")?;
    let pk = sig
        .get("public_key")
        .and_then(Value::as_str)
        .and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok())
        .ok_or("PRESS_SIGNATURE_INVALID")?;
    let s = sig.get("signature").and_then(Value::as_str).and_then(|x| b64u::decode(x).ok()).ok_or("PRESS_SIGNATURE_INVALID")?;
    let msg = crate::support::canonicalize(&crate::support::without(entry, &["press_signature"])).ok_or("PRESS_SIGNATURE_INVALID")?;
    if !notary_crypto::mldsa_verify(&pk, &msg, &s) {
        return Err("PRESS_SIGNATURE_INVALID");
    }
    if certified.contains(&pk) { Ok(()) } else { Err("PRESS_NOT_CERTIFIED") }
}

/// What a template-scope handoff needs to finish P3 (`notary_replication_and_recovery.md` §3) after the card checks:
/// the registry entry to read is `PressAuthorizations[template_address][card_address]`, and it must bind `chain_pubkey`.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateNotary {
    pub template_address: String,
    pub card_address: String,
    pub chain_pubkey: Vec<u8>,
}

/// D9 (decided by David 2026-11-21: the spec check plus `AuthorizePress`): the card checks of template-scope P3. The peer
/// proved it holds `id_pubkey` (`K_id`); its notary card (address `keccak256(K_id)`) must be registered, bind that key,
/// name the template `template_id` as its `issuer_card`, be listed in `approved_notaries` at the template's **current**
/// head, and verify (chain to a trusted root, not revoked). The caller then also requires an active
/// `AuthorizePress(T, card)` whose key is the returned `chain_pubkey`, so withdrawing either authorization stops the
/// template key from moving further.
pub fn template_notary(src: &dyn CardSource, id_pubkey: &[u8], template_id: &str, roots: &Roots<'_>, now_ms: i64) -> Result<TemplateNotary, &'static str> {
    const DENIED: &str = "HANDOFF_SCOPE_DENIED";
    let template_pk = src
        .fetch(template_id)
        .and_then(|b| parse_object(&b))
        .and_then(|g| g.get("recipient_pubkey").and_then(Value::as_str).and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok()))
        .ok_or(DENIED)?;
    let template_address = address_of(&template_pk);
    let card_address = address_of(id_pubkey);
    let template = src
        .card(&template_address)
        .and_then(|e| read_head(src, &e.log_head_cid, &content_key(&template_pk)))
        .ok_or(DENIED)?;
    let listed = template.get("approved_notaries").and_then(Value::as_array).into_iter().flatten().any(|a| a.as_str() == Some(card_address.as_str()));
    if !listed {
        return Err(DENIED);
    }
    let entry = src.card(&card_address).ok_or(DENIED)?;
    let head = read_head(src, &entry.log_head_cid, &content_key(id_pubkey)).ok_or(DENIED)?;
    let binds = head.get("recipient_pubkey").and_then(Value::as_str).is_some_and(|r| crate::support::b64_lenient(r) == id_pubkey);
    if !binds || head.get("issuer_card").and_then(Value::as_str) != Some(template_address.as_str()) {
        return Err(DENIED);
    }
    let chain_pubkey = head.get("chain_pubkey").and_then(Value::as_str).map(crate::support::b64_lenient).filter(|k| k.len() == 64).ok_or(DENIED)?;
    chain_ok(src, head, &card_address, roots, now_ms).ok_or(DENIED)?;
    Ok(TemplateNotary { template_address, card_address, chain_pubkey })
}

#[cfg(test)]
mod field_control_tests {
    use super::*;

    #[test]
    fn only_an_explicit_false_blocks_a_field() {
        let doc: Doc = serde_json::from_value(serde_json::json!({ "field_definitions": [
            { "name": "a", "type": "text" },
            { "name": "b", "type": "text", "derivable": true },
            { "name": "c", "type": "text", "derivable": false },
            { "name": "d", "type": "text", "derivable": "no" },
        ] })).unwrap();
        assert_eq!(non_derivable_in(&doc), vec!["c".to_string()], "absent, true and junk values leave a field derivable");
        assert!(non_derivable_in(&Doc::new()).is_empty(), "a policy with no field_definitions blocks nothing");
    }

    /// The shared vectors (`notary/vectors/field_control/cases.json`).
    #[test]
    fn the_shared_vectors_hold() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/field_control/cases.json");
        let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for c in cases {
            let doc: Doc = serde_json::from_value(c["policy"].clone()).unwrap();
            let want: Vec<String> = c["non_derivable"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            assert_eq!(non_derivable_in(&doc), want, "{}", c["name"]);
        }
    }
}
