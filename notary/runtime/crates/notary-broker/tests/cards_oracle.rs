//! The enclave card oracle (step 5.3a) reproduces the TypeScript verifier's verdict on every conformance case, with the
//! card world delivered the ways the enclave receives it: (a) whole-policy snapshots plus IPFS fetches; (b) per-card
//! fetches (the fallback for cards outside snapshotted policies); (c) per-card registry fetches with every document in
//! the input's signed `evidence` and none available from the host. Inputs in (c) are re-signed with the conformance
//! sub-card key, which the vectors derive from a published seed.
use notary_broker::cards_oracle::{CardPins, SnapshotOracle};
use notary_broker::env::{CardOracle, HostIo};
use notary_types::b64u;
use serde_json::{json, Value};

struct WorldHost {
    world: Value,
}

impl HostIo for WorldHost {
    fn send(&mut self, _msg: Value) {}
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
        let (kind, arg) = what.split_once(':')?;
        let w = &self.world;
        match kind {
            "ipfs" => b64u::decode(w["ipfs"][arg].as_str()?).ok(),
            "card_head" => {
                let c = w["cards"].get(arg)?;
                Some(serde_json::to_vec(&json!({ "head_cid": c["log_head_cid"], "events": c["events"] })).unwrap())
            }
            "subcard" => Some(serde_json::to_vec(w["subcards"].get(arg)?).unwrap()),
            _ => None,
        }
    }
}

fn pins(cfg: &Value) -> CardPins {
    CardPins {
        trusted_roots: cfg["trustedRoots"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().into()).collect(),
        app_certification_root: cfg["appCertificationRoot"].as_str().unwrap().into(),
        login_service_root: cfg["loginServiceCertificationRoot"].as_str().unwrap().into(),
        max_chain_depth: cfg.get("maxChainDepth").and_then(Value::as_u64).unwrap_or(64) as usize,
    }
}

fn snapshot_of(world: &Value) -> Value {
    let entries: Vec<Value> = world["cards"].as_object().unwrap().iter().map(|(a, c)| json!({ "address": a, "head_cid": c["log_head_cid"], "events": c["events"] })).collect();
    let subcards: Vec<Value> = world["subcards"].as_object().unwrap().iter()
        .map(|(s, e)| json!({ "master_card": e["master_card_address"], "sub_card": s, "sub_card_doc_cid": e["sub_card_doc_cid"], "active": e["active"] })).collect();
    json!({ "kind": "policy_snapshot", "policy_address": "p", "entries": entries, "subcards": subcards, "heads": [] })
}

/// The input with `evidence` replaced and re-signed by the conformance sub-card key (seeded as the generator seeds it),
/// when the case was signed by that key; otherwise unchanged (those cases fail before the signature matters).
fn with_evidence(input: &Value, evidence: Value) -> Value {
    let seed = notary_crypto::sha256(b"card-notary-conformance-key-S");
    let k = notary_crypto::MlDsaKey::from_seed(notary_crypto::SecretBytes::from_vec(seed.to_vec())).unwrap();
    let mut i = input.clone();
    if i["contributor_signature"]["public_key"].as_str() != Some(&b64u::encode(k.public_key())) {
        return i;
    }
    let original_ok = notary_crypto::verify_object(input, "contributor_signature", k.public_key());
    i["evidence"] = evidence;
    if original_ok {
        let bytes = notary_types::jcs::canonical(&notary_types::jcs::without_fields(&i, &["contributor_signature"])).unwrap();
        i["contributor_signature"]["signature"] = json!(b64u::encode(&k.sign(&bytes)));
    }
    i
}

fn verdict(r: Result<[u8; 32], &'static str>) -> Value {
    match r {
        Ok(h) => json!({ "ok": true, "root_key_hash": b64u::encode(&h) }),
        Err(c) => json!({ "ok": false, "code": c }),
    }
}

#[test]
fn oracle_matches_typescript_via_snapshots_and_via_fetches() {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/cards/cases.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let mut bad = vec![];
    for c in file["cases"].as_array().unwrap() {
        let mut expect = c["expect"].clone();
        if let Some(o) = expect.as_object_mut() {
            o.remove("chain_addresses");
        }
        let now = notary_types::formats::parse_timestamp(c["config"]["nowIso"].as_str().unwrap()).unwrap();
        let notary = json!({ "contributor_predicate": c["predicate"] });
        // (a) snapshots
        let mut a = SnapshotOracle::new(pins(&c["config"]));
        a.on_snapshot("p", &snapshot_of(&c["world"]));
        let mut host = WorldHost { world: c["world"].clone() };
        let got_a = verdict(a.contributor(&mut host, &c["input"], &notary, &c["parameters"], now));
        // (b) per-card fetches, no snapshot
        let mut b = SnapshotOracle::new(pins(&c["config"]));
        let mut host_b = WorldHost { world: c["world"].clone() };
        let got_b = verdict(b.contributor(&mut host_b, &c["input"], &notary, &c["parameters"], now));
        // (c) documents only from the input's evidence
        let evidence = Value::Array(c["world"]["ipfs"].as_object().unwrap().iter().map(|(cid, b)| json!({ "cid": cid, "bytes": b })).collect());
        let input_c = with_evidence(&c["input"], evidence);
        let mut o_c = SnapshotOracle::new(pins(&c["config"]));
        let mut host_c = WorldHost { world: json!({ "cards": c["world"]["cards"], "subcards": c["world"]["subcards"], "ipfs": {} }) };
        let got_c = verdict(o_c.contributor(&mut host_c, &input_c, &notary, &c["parameters"], now));
        if got_a != expect || got_b != expect || got_c != expect {
            bad.push(format!("{}: expect {expect} / snapshots {got_a} / fetches {got_b} / evidence {got_c}", c["id"]));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn forged_evidence_is_ignored() {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/cards/cases.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let c = &file["cases"][0];
    assert_eq!(c["id"], "ok");
    let now = notary_types::formats::parse_timestamp(c["config"]["nowIso"].as_str().unwrap()).unwrap();
    // validly signed input, but every evidence item's bytes don't hash to its CID, and the host serves no documents
    let forged = Value::Array(c["world"]["ipfs"].as_object().unwrap().keys().map(|cid| json!({ "cid": cid, "bytes": b64u::encode(b"forged") })).collect());
    let input = with_evidence(&c["input"], forged);
    let mut o = SnapshotOracle::new(pins(&c["config"]));
    let mut host = WorldHost { world: json!({ "cards": c["world"]["cards"], "subcards": c["world"]["subcards"], "ipfs": {} }) };
    assert_eq!(o.contributor(&mut host, &input, &json!({ "contributor_predicate": c["predicate"] }), &c["parameters"], now), Err("INPUT_SIGNER_INVALID"));
    // the same input with genuine evidence passes, so the refusal above is the forgery's doing
    let genuine = Value::Array(c["world"]["ipfs"].as_object().unwrap().iter().map(|(cid, b)| json!({ "cid": cid, "bytes": b })).collect());
    let mut o2 = SnapshotOracle::new(pins(&c["config"]));
    assert!(o2.contributor(&mut host, &with_evidence(&c["input"], genuine), &json!({ "contributor_predicate": c["predicate"] }), &c["parameters"], now).is_ok());
}
