//! B5–B8 and the contributor's root key — twin of `verifier/src/notary/contributor.ts`.
use crate::predicates::{self, Context};
use crate::stages::{stage2, stage3, stage4, Roots};
use crate::world::CardSource;
use notary_types::{b64u, jcs};
use serde_json::{Map, Value};

pub struct ContributorConfig<'a> {
    pub trusted_roots: &'a [String],
    pub app_certification_root: &'a str,
    pub login_service_root: &'a str,
    /// Chain time, milliseconds.
    pub now_ms: i64,
    pub max_chain_depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContributorResult {
    Ok { root_key_hash: [u8; 32], chain_addresses: Vec<String> },
    Err { code: &'static str, detail: String },
}

fn fail(code: &'static str, detail: impl Into<String>) -> ContributorResult {
    ContributorResult::Err { code, detail: detail.into() }
}

pub fn check_contributor(src: &dyn CardSource, input: &Value, predicate: &Value, parameters: &Map<String, Value>, cfg: &ContributorConfig<'_>) -> ContributorResult {
    let roots = Roots { trusted: cfg.trusted_roots, app_certification: cfg.app_certification_root, login_service: cfg.login_service_root, max_depth: cfg.max_chain_depth };
    let sig = input.get("contributor_signature");
    let Some(signer_pk) = sig.and_then(|s| s.get("public_key")).and_then(Value::as_str).and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok()) else {
        return fail("INPUT_SIGNER_INVALID", "contributor_signature.public_key");
    };

    // B5
    let s2 = match stage2(src, &signer_pk, &roots) {
        Ok(s) => s,
        Err(c) => return fail("INPUT_SIGNER_INVALID", c),
    };
    let sub = &s2.sub_doc;
    if !sub.get("capabilities").and_then(Value::as_array).is_some_and(|c| c.iter().any(|x| x.as_str() == Some("notary_input"))) {
        return fail("INPUT_SIGNER_INVALID", "capability");
    }
    if let Some(v) = sub.get("valid_until") {
        let ok = v.as_str().and_then(|s| notary_types::formats::parse_timestamp(s).ok()).is_some_and(|t| t > cfg.now_ms);
        if !ok {
            return fail("INPUT_SIGNER_INVALID", "valid_until");
        }
    }
    if sub.get("attestation_level").and_then(Value::as_str) != Some("T2") {
        return fail("INPUT_SIGNER_INVALID", "attestation_level");
    }
    let sig_ok = match (jcs::canonical(&jcs::without_fields(input, &["contributor_signature"])), sig.and_then(|s| s.get("signature")).and_then(Value::as_str)) {
        (Ok(msg), Some(s)) => b64u::decode_len(s, notary_crypto::MLDSA44_SIGNATURE_LEN).is_ok_and(|s| notary_crypto::mldsa_verify(&signer_pk, &msg, &s)),
        _ => false,
    };
    if !sig_ok {
        return fail("INPUT_SIGNER_INVALID", "contributor_signature");
    }

    // B6
    let Some(cpk) = input.get("contributor_card_pubkey").and_then(Value::as_str).and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok()) else {
        return fail("INPUT_BINDING_MISMATCH", "contributor_card_pubkey");
    };
    let card = input.get("contributor_card").and_then(Value::as_str);
    let holder = sub.get("holder_primary_card").and_then(Value::as_str);
    if card != Some(crate::support::address_of(&cpk).as_str()) || card != holder {
        return fail("INPUT_BINDING_MISMATCH", "binding");
    }
    let master = holder.expect("checked").to_string();

    // B7
    let s3 = match stage3(src, s2.master_doc.clone(), &master, &roots) {
        Ok(s) => s,
        Err(c) => return fail("INPUT_CARD_UNTRUSTED", c),
    };
    let s4 = stage4(src, &s3.chain, cfg.now_ms);
    if s4.history_mismatch {
        return fail("INPUT_CARD_UNTRUSTED", "HISTORY_MISMATCH");
    }
    if let Some(eff) = &s4.earliest {
        if notary_types::formats::parse_timestamp(eff).is_ok_and(|t| t <= cfg.now_ms) {
            return fail("INPUT_CARD_REVOKED", eff.clone());
        }
    }

    // B8
    let chain: Vec<(String, &Map<String, Value>)> = s3.chain.iter().map(|l| (l.address.clone(), &l.content)).collect();
    let ctx = Context { chain: &chain, addresses: &s3.addresses, parameters: Some(parameters), is_holder: false, is_issuer: false };
    if !predicates::evaluate(predicate, &ctx) {
        return fail("INPUT_NOT_ELIGIBLE", "contributor_predicate");
    }

    // root key: past_keys[0].pubkey, else recipient_pubkey
    let m = &s2.master_doc;
    let root = m
        .get("past_keys")
        .and_then(Value::as_array)
        .and_then(|p| p.first())
        .and_then(|p| p.get("pubkey"))
        .and_then(Value::as_str)
        .or_else(|| m.get("recipient_pubkey").and_then(Value::as_str));
    let Some(root) = root.and_then(|r| b64u::decode(r).ok()) else { return fail("INPUT_CARD_UNTRUSTED", "root key") };
    ContributorResult::Ok { root_key_hash: notary_crypto::sha256(&root), chain_addresses: s3.addresses }
}
