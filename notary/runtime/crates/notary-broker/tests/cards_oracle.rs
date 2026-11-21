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
    ipfs_fetches: usize,
}

impl HostIo for WorldHost {
    fn send(&mut self, _msg: Value) {}
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
        let (kind, arg) = what.split_once(':')?;
        let w = &self.world;
        match kind {
            "ipfs" => {
                self.ipfs_fetches += 1;
                b64u::decode(w["ipfs"][arg].as_str()?).ok()
            }
            "card_head" => {
                let c = w["cards"].get(arg)?;
                Some(serde_json::to_vec(&json!({ "head_cid": c["log_head_cid"], "events": c["events"] })).unwrap())
            }
            "subcard" => Some(serde_json::to_vec(w["subcards"].get(arg)?).unwrap()),
            "press_auth" => Some(serde_json::to_vec(w.get("press_auth")?.get(arg)?).unwrap()),
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
        list_cards: vec![],
        list_holder_key: vec![],
        list_press_key: vec![],
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
        let mut host = WorldHost { world: c["world"].clone(), ipfs_fetches: 0 };
        let got_a = verdict(a.contributor(&mut host, &c["input"], &notary, &c["parameters"], now));
        // (b) per-card fetches, no snapshot
        let mut b = SnapshotOracle::new(pins(&c["config"]));
        let mut host_b = WorldHost { world: c["world"].clone(), ipfs_fetches: 0 };
        let got_b = verdict(b.contributor(&mut host_b, &c["input"], &notary, &c["parameters"], now));
        // (c) documents only from the input's evidence
        let evidence = Value::Array(c["world"]["ipfs"].as_object().unwrap().iter().map(|(cid, b)| json!({ "cid": cid, "bytes": b })).collect());
        let input_c = with_evidence(&c["input"], evidence);
        let mut o_c = SnapshotOracle::new(pins(&c["config"]));
        let mut host_c = WorldHost { world: json!({ "cards": c["world"]["cards"], "subcards": c["world"]["subcards"], "ipfs": {} }), ipfs_fetches: 0 };
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
    let mut host = WorldHost { world: json!({ "cards": c["world"]["cards"], "subcards": c["world"]["subcards"], "ipfs": {} }), ipfs_fetches: 0 };
    assert_eq!(o.contributor(&mut host, &input, &json!({ "contributor_predicate": c["predicate"] }), &c["parameters"], now), Err("INPUT_SIGNER_INVALID"));
    // the same input with genuine evidence passes, so the refusal above is the forgery's doing
    let genuine = Value::Array(c["world"]["ipfs"].as_object().unwrap().iter().map(|(cid, b)| json!({ "cid": cid, "bytes": b })).collect());
    let mut o2 = SnapshotOracle::new(pins(&c["config"]));
    assert!(o2.contributor(&mut host, &with_evidence(&c["input"], genuine), &json!({ "contributor_predicate": c["predicate"] }), &c["parameters"], now).is_ok());
}

/// 5.7, Q9: verified IPFS objects are reused across inputs, and registry state (`card_head:`, `subcard:`) is never cached.
#[test]
fn verified_ipfs_objects_are_cached_between_inputs() {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/cards/cases.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let c = &file["cases"][0];
    let now = notary_types::formats::parse_timestamp(c["config"]["nowIso"].as_str().unwrap()).unwrap();
    let notary = json!({ "contributor_predicate": c["predicate"] });
    let mut o = SnapshotOracle::new(pins(&c["config"]));
    let mut host = WorldHost { world: c["world"].clone(), ipfs_fetches: 0 };
    assert!(o.contributor(&mut host, &c["input"], &notary, &c["parameters"], now).is_ok());
    let first = host.ipfs_fetches;
    assert!(first > 0 && o.cached_objects() > 0);
    assert!(o.contributor(&mut host, &c["input"], &notary, &c["parameters"], now).is_ok());
    assert_eq!(host.ipfs_fetches, first, "the second input fetched no IPFS object again");
    // registry state is read fresh: the same oracle, now holding cached objects, still sees a revocation
    let r = file["cases"].as_array().unwrap().iter().find(|x| x["id"] == "b7_master_revoked_8xx").unwrap();
    let mut host_r = WorldHost { world: r["world"].clone(), ipfs_fetches: 0 };
    let nr = notary_types::formats::parse_timestamp(r["config"]["nowIso"].as_str().unwrap()).unwrap();
    assert_eq!(o.contributor(&mut host_r, &r["input"], &json!({ "contributor_predicate": r["predicate"] }), &r["parameters"], nr), Err("INPUT_CARD_REVOKED"));
}

/// 6.0a: the oracle remembers which policy delivered each card, and the state each policy snapshot was built against.
#[test]
fn snapshots_record_their_policy_state_and_where_each_card_came_from() {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/cards/cases.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let c = &file["cases"][0];
    let mut o = SnapshotOracle::new(pins(&c["config"]));
    assert_eq!(o.contributor_policy_state("pol"), None, "nothing before a snapshot");
    let mut snap = snapshot_of(&c["world"]);
    snap["policy_head_cid"] = json!("bafkreipolicyhead");
    snap["at_block"] = json!(40);
    o.on_snapshot("pol", &snap);
    assert_eq!(o.contributor_policy_state("pol"), Some(("bafkreipolicyhead".to_string(), 40)));
    // an update raises the block, never lowers it
    let card = c["world"]["cards"].as_object().unwrap().keys().next().unwrap().clone();
    let head = c["world"]["cards"][&card]["log_head_cid"].as_str().unwrap().to_string();
    o.on_updates("pol", &json!({ "updates": [{ "card_address": card, "head_cid": head, "timestamp": "2026-01-01T00:00:00.000Z", "block": 45 }] }));
    assert_eq!(o.contributor_policy_state("pol").unwrap().1, 45);
    o.on_updates("pol", &json!({ "updates": [{ "card_address": card, "head_cid": head, "timestamp": "2026-01-01T00:00:00.000Z", "block": 3 }] }));
    assert_eq!(o.contributor_policy_state("pol").unwrap().1, 45);
    // a snapshot with no policy head is no state at all
    let mut headless = SnapshotOracle::new(pins(&c["config"]));
    headless.on_snapshot("headless", &snapshot_of(&c["world"]));
    assert_eq!(headless.contributor_policy_state("headless"), None);
    // which cards came from which policy's snapshot
    let sub = c["world"]["subcards"].as_object().unwrap().keys().next().unwrap().clone();
    assert!(o.contributor_from_snapshot(&card, &sub, &["pol".to_string()]));
    assert!(!o.contributor_from_snapshot(&card, &sub, &["other".to_string()]), "the snapshot belongs to another policy");
    assert!(!o.contributor_from_snapshot("00".repeat(32).as_str(), &sub, &["pol".to_string()]), "a card the host never snapshotted");
    assert!(!SnapshotOracle::new(pins(&c["config"])).contributor_from_snapshot(&card, &sub, &["pol".to_string()]), "no snapshot, only the per-card fallback");
}

/// E4 (step 6.5): a watched source policy's certified presses are read per policy, at most every `PRESS_REFRESH_MS`;
/// checking an entry reads nothing, so what the host is asked never depends on which source cards are linked.
#[test]
fn source_presses_are_read_per_policy_and_an_entry_check_reads_nothing() {
    use notary_broker::cards_oracle::PRESS_REFRESH_MS;
    use notary_crypto::MlDsaKey;
    use notary_types::formats;
    struct Counting {
        inner: WorldHost,
        reads: usize,
    }
    impl HostIo for Counting {
        fn send(&mut self, _msg: Value) {}
        fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
            self.reads += 1;
            self.inner.fetch(what)
        }
    }
    let (root, policy, press, forger) = (MlDsaKey::generate(), MlDsaKey::generate(), MlDsaKey::generate(), MlDsaKey::generate());
    let addr = |k: &MlDsaKey| formats::card_pointer(k.public_key());
    let mut ipfs = serde_json::Map::new();
    let mut put = |bytes: Vec<u8>| {
        let cid = formats::cid_of_bytes(&bytes);
        ipfs.insert(cid.clone(), json!(b64u::encode(&bytes)));
        cid
    };
    let policy_id = put(serde_json::to_vec(&json!({ "recipient_pubkey": b64u::encode(policy.public_key()) })).unwrap());
    let press_doc = put(serde_json::to_vec(&json!({ "recipient_pubkey": b64u::encode(press.public_key()), "ancestry_pubkeys": [b64u::encode(root.public_key())] })).unwrap());
    let policy_head = put(notary_cards::support::aes_gcm_encrypt(
        &notary_cards::support::content_key(policy.public_key()),
        &serde_json::to_vec(&json!({ "approved_presses": [press_doc] })).unwrap(),
    ));
    let card = |cid: &str| json!({ "log_head_cid": cid, "events": [{ "cid": cid, "timestamp": "2027-01-01T00:00:00Z" }] });
    let world = json!({ "cards": { addr(&policy): card(&policy_head), addr(&press): card(&press_doc) }, "subcards": {}, "ipfs": ipfs });
    let mut oracle = SnapshotOracle::new(CardPins {
        trusted_roots: vec![addr(&root)],
        app_certification_root: String::new(),
        login_service_root: String::new(),
        max_chain_depth: 8,
        list_cards: vec![],
        list_holder_key: vec![],
        list_press_key: vec![],
    });
    let mut host = Counting { inner: WorldHost { world, ipfs_fetches: 0 }, reads: 0 };
    let now = 1_800_000_000_000;
    let sign = |k: &MlDsaKey| {
        let mut e = json!({ "code": 901, "entry_type": "revocation", "card_state": {}, "version": 2 });
        e["press_signature"] = k.sign_object(&e, "press_signature").unwrap();
        e
    };
    assert_eq!(oracle.source_entry_certified(&policy_id, &sign(&press)), Err("PRESS_NOT_CERTIFIED"), "nothing read yet");
    oracle.refresh_source_presses(&mut host, &policy_id, now);
    let after_first = host.reads;
    assert!(after_first > 0);
    assert_eq!(oracle.source_entry_certified(&policy_id, &sign(&press)), Ok(()));
    assert_eq!(oracle.source_entry_certified(&policy_id, &sign(&forger)), Err("PRESS_NOT_CERTIFIED"));
    assert_eq!(host.reads, after_first, "an entry check reads nothing");
    oracle.refresh_source_presses(&mut host, &policy_id, now + PRESS_REFRESH_MS - 1);
    assert_eq!(host.reads, after_first, "not again before the refresh interval");
    oracle.refresh_source_presses(&mut host, &policy_id, now + PRESS_REFRESH_MS);
    assert!(host.reads > after_first, "read again after it");
}

/// D9 (decided by David 2026-11-21: the spec check plus `AuthorizePress`): template-scope P3 passes only when the notary
/// card checks pass (notary-cards `template_notary`) **and** `AuthorizePress(T, card)` is active with the card's
/// `chain_pubkey`. Each refusal is checked against an otherwise passing world.
#[test]
fn template_handoff_needs_the_card_checks_and_an_active_authorize_press_with_the_cards_chain_key() {
    use notary_crypto::MlDsaKey;
    use notary_types::formats;
    let (root, template, notary) = (MlDsaKey::generate(), MlDsaKey::generate(), MlDsaKey::generate());
    let addr = |k: &MlDsaKey| formats::card_pointer(k.public_key());
    let chain_key = [0x5au8; 64];
    let mut ipfs = serde_json::Map::new();
    let mut put = |bytes: Vec<u8>| {
        let cid = formats::cid_of_bytes(&bytes);
        ipfs.insert(cid.clone(), json!(b64u::encode(&bytes)));
        cid
    };
    let seal = |k: &MlDsaKey, v: &Value| notary_cards::support::aes_gcm_encrypt(&notary_cards::support::content_key(k.public_key()), &serde_json::to_vec(v).unwrap());
    let template_id = put(serde_json::to_vec(&json!({ "recipient_pubkey": b64u::encode(template.public_key()) })).unwrap());
    let template_head = put(seal(&template, &json!({ "approved_notaries": [addr(&notary)] })));
    let notary_head = put(seal(&notary, &json!({
        "recipient_pubkey": b64u::encode(notary.public_key()),
        "ancestry_pubkeys": [b64u::encode(root.public_key())],
        "issuer_card": addr(&template),
        "chain_pubkey": b64u::encode(&chain_key[..]),
    })));
    let card = |cid: &str| json!({ "log_head_cid": cid, "events": [{ "cid": cid, "timestamp": "2027-01-01T00:00:00Z" }] });
    let auth_key = format!("{},{}", addr(&template), addr(&notary));
    let world = |auth: Value| {
        json!({
            "cards": { addr(&template): card(&template_head), addr(&notary): card(&notary_head) },
            "subcards": {},
            "ipfs": ipfs.clone(),
            "press_auth": { auth_key.clone(): auth },
        })
    };
    let pins = CardPins {
        trusted_roots: vec![addr(&root)],
        app_certification_root: String::new(),
        login_service_root: String::new(),
        max_chain_depth: 8,
        list_cards: vec![],
        list_holder_key: vec![],
        list_press_key: vec![],
    };
    let now = 1_800_000_000_000;
    let serves = |auth: Value, who: &MlDsaKey| {
        let mut oracle = SnapshotOracle::new(pins.clone());
        let mut host = WorldHost { world: world(auth), ipfs_fetches: 0 };
        oracle.serves_template(&mut host, who.public_key(), &template_id, now)
    };
    let good = json!({ "active": true, "next_sequence": 0, "press_public_key": b64u::encode(&chain_key[..]) });
    assert!(serves(good.clone(), &notary), "listed, issued for T, and authorized with its chain key");
    assert!(!serves(json!({ "active": false, "next_sequence": 0, "press_public_key": b64u::encode(&chain_key[..]) }), &notary), "AuthorizePress revoked");
    assert!(!serves(json!({ "active": true, "next_sequence": 0, "press_public_key": b64u::encode(&[0x11u8; 64][..]) }), &notary), "authorized with another key");
    assert!(!serves(Value::Null, &notary), "no AuthorizePress entry");
    assert!(!serves(good, &MlDsaKey::generate()), "a peer whose K_id has no notary card");
}
