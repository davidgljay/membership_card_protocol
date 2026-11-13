//! Ports of the verifier's Stage 2, 3 and 4, in the same order of checks. Each failure carries the TypeScript error
//! code, for diagnostics; the contributor check maps them to B-step codes.
use crate::support::{address_of, b64_lenient, canonicalize, content_key, decrypt_card_head, without};
use crate::world::CardSource;
use serde_json::{Map, Value};

pub type Doc = Map<String, Value>;

#[derive(Debug, Clone)]
pub struct Stage2 {
    pub master_doc: Doc,
    pub master_pubkey: Vec<u8>,
    pub sub_doc: Doc,
}

pub struct Roots<'a> {
    pub trusted: &'a [String],
    pub app_certification: &'a str,
    pub login_service: &'a str,
    pub max_depth: usize,
}

fn str_field<'a>(d: &'a Doc, k: &str) -> Option<&'a str> {
    d.get(k).and_then(Value::as_str)
}

fn ancestry_first(d: &Doc) -> Result<Option<String>, ()> {
    // `currentDoc.ancestry_pubkeys.length` in TypeScript throws if the field is missing; treat as a failed walk.
    match d.get("ancestry_pubkeys") {
        Some(Value::Array(a)) if a.is_empty() => Ok(None),
        Some(Value::Array(a)) => Ok(Some(a[0].as_str().unwrap_or_default().to_string())),
        _ => Err(()),
    }
}

/// Stage 2 (sub-card), `verifyStage2` steps 2–16f.
pub fn stage2(src: &dyn CardSource, signer_pk: &[u8], roots: &Roots<'_>) -> Result<Stage2, &'static str> {
    let signer = address_of(signer_pk);
    // step 2: the document, via a CardEntry or the SubCardEntry
    let doc_cid = match src.card(&signer) {
        Some(c) => Some(c.log_head_cid),
        None => src.subcard(&signer).map(|s| s.sub_card_doc_cid).filter(|c| !c.is_empty()),
    }
    .ok_or("CARD_NOT_FOUND")?;
    // steps 3–4: encrypted under the leaf key, or plain
    let raw = src.fetch(&doc_cid).ok_or("DECRYPTION_FAILED")?;
    let text = crate::support::aes_gcm_decrypt(&content_key(signer_pk), &raw).unwrap_or(raw);
    let Ok(Value::Object(sub)) = serde_json::from_slice::<Value>(&text) else { return Err("DECRYPTION_FAILED") };
    match str_field(&sub, "recipient_pubkey") {
        Some(r) if address_of(&b64_lenient(r)) == signer => {}
        _ => return Err("ADDRESS_BINDING_MISMATCH"),
    }
    // steps 5–6
    let holder_pk = b64_lenient(str_field(&sub, "holder_primary_card_pubkey").ok_or("ADDRESS_BINDING_MISMATCH")?);
    let holder = address_of(&holder_pk);
    if Some(holder.as_str()) != str_field(&sub, "holder_primary_card") {
        return Err("ADDRESS_BINDING_MISMATCH");
    }
    let app_pk = b64_lenient(str_field(&sub, "app_card_pubkey").ok_or("ADDRESS_BINDING_MISMATCH")?);
    let app = address_of(&app_pk);
    if Some(app.as_str()) != str_field(&sub, "app_card") {
        return Err("ADDRESS_BINDING_MISMATCH");
    }
    // steps 7–8
    let master_entry = src.card(&holder).ok_or("CARD_NOT_FOUND")?;
    let master_doc = decrypt_card_head(src, &master_entry.log_head_cid, &content_key(&holder_pk)).ok_or("DECRYPTION_FAILED")?;
    // step 9
    let listed = master_doc
        .get("active_subcards")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().filter_map(Value::as_str).any(|k| address_of(&b64_lenient(k)) == signer));
    if !listed {
        return Err("SUB_CARD_NOT_IN_ACTIVE_DIRECTORY");
    }
    // step 10
    let reg = src.subcard(&signer).filter(|s| s.master_card_address == holder).ok_or("ADDRESS_BINDING_MISMATCH")?;
    // step 11: holder signature over the document without holder_signature
    let sub_v = Value::Object(sub.clone());
    let verify = |pk: &[u8], obj: &Value, sig: Option<&str>| -> bool {
        match (canonicalize(obj), sig) {
            (Some(msg), Some(s)) => notary_crypto::mldsa_verify(pk, &msg, &b64_lenient(s)),
            _ => false,
        }
    };
    if !verify(&holder_pk, &without(&sub_v, &["holder_signature"]), str_field(&sub, "holder_signature")) {
        return Err("INVALID_HOLDER_SIGNATURE");
    }
    // step 12
    if !reg.active {
        return Err("SUB_CARD_INACTIVE");
    }
    // step 13
    if !verify(&app_pk, &without(&sub_v, &["app_signature", "holder_signature"]), str_field(&sub, "app_signature")) {
        return Err("INVALID_APP_SIGNATURE");
    }
    // step 15: the app card chain reaches the app-certification root
    let app_entry = src.card(&app).ok_or("APP_CARD_CHAIN_NOT_TRUSTED")?;
    let mut current = decrypt_card_head(src, &app_entry.log_head_cid, &content_key(&app_pk)).ok_or("DECRYPTION_FAILED")?;
    let mut current_addr = app.clone();
    let mut visited = vec![app.clone()];
    let mut reached = current_addr == roots.app_certification;
    let mut depth = 0;
    while depth < roots.max_depth && !reached {
        let next = match ancestry_first(&current) {
            Err(()) => return Err("APP_CARD_CHAIN_NOT_TRUSTED"),
            Ok(None) => {
                reached = current_addr == roots.app_certification;
                break;
            }
            Ok(Some(n)) => n,
        };
        if next.is_empty() {
            break;
        }
        let next_pk = b64_lenient(&next);
        let next_addr = address_of(&next_pk);
        if next_addr == roots.app_certification {
            reached = true;
            break;
        }
        visited.push(next_addr.clone());
        let e = src.card(&next_addr).ok_or("APP_CARD_CHAIN_NOT_TRUSTED")?;
        current = decrypt_card_head(src, &e.log_head_cid, &content_key(&next_pk)).ok_or("DECRYPTION_FAILED")?;
        current_addr = next_addr;
        depth += 1;
    }
    if !reached {
        return Err("APP_CARD_CHAIN_NOT_TRUSTED");
    }
    // step 16f: login service scope and S1
    let is_login = visited.iter().any(|a| a == roots.login_service);
    let self_scoped = app == holder;
    if is_login && !self_scoped {
        return Err("LOGIN_SERVICE_SCOPE");
    }
    if str_field(&sub, "attestation_level") == Some("S1") && !(is_login && self_scoped) {
        return Err("ATTESTATION_LEVEL_INSUFFICIENT");
    }
    Ok(Stage2 { master_doc, master_pubkey: holder_pk, sub_doc: sub })
}

#[derive(Debug, Clone)]
pub struct Link {
    pub address: String,
    pub content: Doc,
}

#[derive(Debug, Clone)]
pub struct Stage3 {
    pub chain: Vec<Link>,
    pub addresses: Vec<String>,
}

/// Stage 3, `verifyStage3`: walk `ancestry_pubkeys[0]` to a pinned trusted root.
pub fn stage3(src: &dyn CardSource, start: Doc, start_addr: &str, roots: &Roots<'_>) -> Result<Stage3, &'static str> {
    let trusted = |a: &str| roots.trusted.iter().any(|t| t == a);
    let mut out = Stage3 { chain: vec![Link { address: start_addr.into(), content: start }], addresses: vec![start_addr.into()] };
    if trusted(start_addr) {
        return Ok(out);
    }
    for _ in 0..roots.max_depth {
        let current = &out.chain.last().expect("non-empty").content;
        let current_addr = out.chain.last().expect("non-empty").address.clone();
        let next = match ancestry_first(current) {
            Err(()) => return Err("CHAIN_NOT_TRUSTED"),
            Ok(None) => return if trusted(&current_addr) { Ok(out) } else { Err("CHAIN_NOT_TRUSTED") },
            Ok(Some(n)) => n,
        };
        if next.is_empty() {
            break;
        }
        let next_pk = b64_lenient(&next);
        let next_addr = address_of(&next_pk);
        if trusted(&next_addr) {
            out.addresses.push(next_addr);
            return Ok(out);
        }
        let e = src.card(&next_addr).ok_or("CARD_NOT_FOUND")?;
        let doc = decrypt_card_head(src, &e.log_head_cid, &content_key(&next_pk)).ok_or("DECRYPTION_FAILED")?;
        out.addresses.push(next_addr.clone());
        out.chain.push(Link { address: next_addr, content: doc });
    }
    Err("CHAIN_DEPTH_EXCEEDED")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stage4 {
    pub history_mismatch: bool,
    /// The earliest revocation or lapse: `(effective date as written, is_expiry)`.
    pub earliest: Option<String>,
}

/// Stage 4, `verifyStage4`: revocations and `expires_at` from head content, dated by the on-chain event replay.
/// `now_ms` is chain time (the TypeScript verifier uses its wall clock for `expires_at`).
pub fn stage4(src: &dyn CardSource, chain: &[Link], now_ms: i64) -> Stage4 {
    let mut out = Stage4 { history_mismatch: false, earliest: None };
    let consider = |date: String, out: &mut Stage4| {
        if out.earliest.as_ref().is_none_or(|e| date < *e) {
            out.earliest = Some(date);
        }
    };
    for link in chain {
        let entry = src.card(&link.address);
        let head_cid = entry.as_ref().map(|e| e.log_head_cid.clone());
        let events = entry.map(|e| e.events).unwrap_or_default();
        let c = &link.content;
        let entry_type = c.get("entry_type").and_then(Value::as_str);
        let is_log = matches!(entry_type, Some("field_update") | Some("revocation"));
        if is_log {
            if let (Some(Value::Array(history)), Some(head)) = (c.get("history"), head_cid.as_ref()) {
                let mut claimed: Vec<String> = history.iter().map(|h| h.as_str().map(String::from).unwrap_or_else(|| h.to_string())).collect();
                claimed.push(head.clone());
                let actual: Vec<String> = events.iter().map(|e| e.cid.clone()).collect();
                if claimed != actual {
                    out.history_mismatch = true;
                }
            }
        }
        let head_event = head_cid.as_ref().and_then(|h| events.iter().find(|e| &e.cid == h));
        if entry_type == Some("revocation") {
            let reported = c.get("revocation").and_then(|r| r.get("effective_date")).and_then(Value::as_str).map(String::from);
            if let Some(d) = head_event.map(|e| e.timestamp.clone()).or(reported) {
                consider(d, &mut out);
            }
        }
        if let Some(exp) = c.get("expires_at").and_then(Value::as_str).and_then(|s| notary_types::formats::parse_timestamp(s).ok()) {
            if exp <= now_ms {
                consider(notary_types::formats::format_timestamp(exp), &mut out);
            }
        }
    }
    out
}
