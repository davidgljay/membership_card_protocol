//! The broker end to end under the simulator (step 5.3): real attestations (fake enclave service, test root), the
//! real worker engine, real X-Wing / ML-DSA / receipts. Only card-chain verification is a test oracle here (B5–B8 and
//! the policy read are `notary-cards`, step 5.3a).
//!
//! Covers: hello; genesis and countersign (G2); create_job checks and admission before any key; the anchor-gated
//! announcement; sealed submissions with sealed receipts; B1–B4, B9–B11; close gated on chain time AND attested time;
//! the notarization (cosignature over H(body), commitment, dropped_after_acceptance); key isolation between jobs;
//! key erasure after the `notarized` anchor; abort.
use notary_attest::{
    sim::SimulatorBackend,
    verify::{verify_attestation, Config, Context, Expected},
};
use notary_broker::{
    chain::encode_test_header,
    env::{CardOracle, HostIo, InProcessWorkers, Platform, PolicyView},
    lists::{approval_digest, Keyset, ListVersion, Pins},
    Broker,
};
use notary_crypto::{mldsa_verify, open_receipt, sealed_input_info_aad, sha256, verify_object, xwing_seal, ChainKey, MlDsaKey};
use notary_sim::{EnclaveConfig, FakeEnclave};
use notary_types::{b64u, formats, jcs, merkle, user_data::UserData};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

const T0: i64 = 1_800_000_000_000; // 2027-01-15
const OPENS: i64 = T0 + 60_000;
const CLOSES: i64 = T0 + 3_600_000;

// ---------------------------------------------------------------------------------------------------------------
// Test host and oracle

#[derive(Default)]
struct Host {
    out: Vec<Value>,
}
impl HostIo for Host {
    fn send(&mut self, msg: Value) {
        self.out.push(msg);
    }
    fn fetch(&mut self, _what: &str) -> Option<Vec<u8>> {
        None
    }
}
impl Host {
    fn take(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.out)
    }
}
fn find<'a>(msgs: &'a [Value], kind: &str) -> Option<&'a Value> {
    msgs.iter().find(|m| m["kind"] == kind)
}

#[derive(Clone)]
struct Oracle {
    policy: Value,
    approved: Vec<String>,
    revoked: Arc<Mutex<BTreeSet<String>>>,
    lists: (Vec<ListVersion>, Vec<ListVersion>),
}
impl CardOracle for Oracle {
    fn policy(&mut self, _: &mut dyn HostIo, _: &str, _: &str, _: i64) -> Result<PolicyView, &'static str> {
        Ok(PolicyView { notary: self.policy.clone(), approved_notaries: self.approved.clone() })
    }
    fn requester_allowed(&mut self, _: &mut dyn HostIo, _: &Value, _: &Value, _: i64) -> bool {
        true
    }
    fn contributor(&mut self, _: &mut dyn HostIo, input: &Value, _: &Value, _: &Value, _: i64) -> Result<[u8; 32], &'static str> {
        let card = input["contributor_card"].as_str().unwrap();
        if self.revoked.lock().unwrap().contains(card) {
            return Err("INPUT_CARD_REVOKED");
        }
        Ok(sha256(card.as_bytes()))
    }
    fn list_history(&mut self, _: &mut dyn HostIo, card: &str) -> Option<Vec<ListVersion>> {
        Some(if card == "runtimes" { self.lists.0.clone() } else { self.lists.1.clone() })
    }
    fn on_snapshot(&mut self, _: &str, _: &Value) {}
    fn on_updates(&mut self, _: &str, _: &Value) {}
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

/// A tally program: counts inputs whose payload is `{"choice":"yes"}` and outputs `{"no":N,"yes":Y}`.
fn tally_program(schema: &Value) -> Vec<u8> {
    let schema_text = String::from_utf8(jcs::canonical(schema).unwrap()).unwrap().replace('"', "\\\"");
    let src = format!(
        r#"(module
          (import "notary_v1" "input_count" (func $count (result i32)))
          (import "notary_v1" "input_len" (func $len (param i32) (result i32)))
          (import "notary_v1" "input_read" (func $read (param i32 i32 i32) (result i32)))
          (import "notary_v1" "output_write" (func $out (param i32 i32) (result i32)))
          (memory (export "memory") 1 1)
          (func $digits (param $v i32) (param $at i32) (result i32) (local $n i32)
            (if (i32.ge_u (local.get $v) (i32.const 10)) (then (local.set $n (call $digits (i32.div_u (local.get $v) (i32.const 10)) (local.get $at)))))
            (i32.store8 (i32.add (local.get $at) (local.get $n)) (i32.add (i32.const 48) (i32.rem_u (local.get $v) (i32.const 10))))
            (i32.add (local.get $n) (i32.const 1)))
          (func (export "run") (result i32) (local $i i32) (local $yes i32) (local $n i32) (local $p i32)
            (local.set $n (call $count))
            (loop $l (if (i32.lt_u (local.get $i) (local.get $n)) (then
              (drop (call $read (local.get $i) (i32.const 1024) (call $len (local.get $i))))
              ;; payload is {{"choice":"yes"}} or {{"choice":"no"}}: byte 11 is 'y' or 'n'
              (if (i32.eq (i32.load8_u (i32.const 1035)) (i32.const 121)) (then (local.set $yes (i32.add (local.get $yes) (i32.const 1)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))
            ;; {{"no":N,"yes":Y}}
            (i32.store (i32.const 0) (i32.const 0x226f6e22)) ;; "{{\"no" little-endian trick avoided below
            (local.set $p (i32.const 0))
            (i32.store8 (i32.const 0) (i32.const 123)) (i32.store8 (i32.const 1) (i32.const 34)) (i32.store8 (i32.const 2) (i32.const 110))
            (i32.store8 (i32.const 3) (i32.const 111)) (i32.store8 (i32.const 4) (i32.const 34)) (i32.store8 (i32.const 5) (i32.const 58))
            (local.set $p (i32.add (i32.const 6) (call $digits (i32.sub (local.get $n) (local.get $yes)) (i32.const 6))))
            (i32.store8 (local.get $p) (i32.const 44)) (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 34))
            (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 121)) (i32.store8 (i32.add (local.get $p) (i32.const 3)) (i32.const 101))
            (i32.store8 (i32.add (local.get $p) (i32.const 4)) (i32.const 115)) (i32.store8 (i32.add (local.get $p) (i32.const 5)) (i32.const 34))
            (i32.store8 (i32.add (local.get $p) (i32.const 6)) (i32.const 58))
            (local.set $p (i32.add (i32.add (local.get $p) (i32.const 7)) (call $digits (local.get $yes) (i32.add (local.get $p) (i32.const 7)))))
            (i32.store8 (local.get $p) (i32.const 125))
            (drop (call $out (i32.const 0) (i32.add (local.get $p) (i32.const 1))))
            (i32.const 0))
          (@custom "notary.abi" "notary_v1")
          (@custom "notary.output_schema" "{schema_text}"))"#
    );
    wat::parse_str(src).unwrap()
}

fn output_schema() -> Value {
    json!([{ "name": "no", "type": "integer", "required": true, "clamp": [0, 1000000] },
           { "name": "yes", "type": "integer", "required": true, "clamp": [0, 1000000] }])
}

fn signed_lists(pcr0: &[u8], program_cid: &str, refuse_single_operator: bool) -> (Vec<ListVersion>, Vec<ListVersion>, Keyset) {
    let members: Vec<ChainKey> = (0..5).map(|_| ChainKey::generate()).collect();
    let keyset = Keyset { keys: members.iter().map(|k| k.public_key_xy()).collect(), quorum: 4, version: 1, key_scheme: 0 };
    let sign = |list: &str, card: &str, value: &Value| -> String {
        let mut a = json!({ "governance_version": 1, "kind": "standard", "list": list, "list_card": card, "list_hash": jcs::h(value).unwrap(),
            "list_version": 1, "signatures": [], "type": "notary_list_approval" });
        if list == "program_allowlist" && refuse_single_operator {
            a["single_operator_quorums"] = json!("refused");
        }
        let d = approval_digest(&a).unwrap();
        a["signatures"] = json!((0..4).map(|i| json!({ "key_index": i, "signature": b64u::encode(&members[i].sign_digest(&d).unwrap()) })).collect::<Vec<_>>());
        String::from_utf8(jcs::canonical(&a).unwrap()).unwrap()
    };
    let rt = json!([{ "accepted_from": "2026-01-01T00:00:00Z", "build_recipe_cid": "bafkreirecipe", "close_compat": "c1", "pcr0": b64u::encode(pcr0),
        "platform": "simulator", "source_commit": "abc", "version": "1" }]);
    let progs = json!([{ "accepted_from": "2026-01-01T00:00:00Z", "audit_report_cid": "bafkreiaudit", "name": "tally", "program_cid": program_cid,
        "source_commit": "abc", "toolchain": "rust", "version": "1" }]);
    (
        vec![ListVersion { approval_text: Some(sign("accepted_runtimes", "runtimes", &rt)), value: rt }],
        vec![ListVersion { approval_text: Some(sign("program_allowlist", "programs", &progs)), value: progs }],
        keyset,
    )
}

struct World {
    broker: Broker,
    host: Host,
    enclave: FakeEnclave,
    revoked: Arc<Mutex<BTreeSet<String>>>,
    program: Vec<u8>,
    headers: Vec<[u8; 32]>,
    card: String,
    isolation: u8,
}

fn backend(addr: &notary_attest::sim::SimAddr) -> SimulatorBackend {
    SimulatorBackend::new(addr.clone())
}

fn world(isolation: &str, replacement: &str, k_min: u64) -> World {
    world_ext(isolation, replacement, k_min, false)
}

fn world_ext(isolation: &str, replacement: &str, k_min: u64, refuse_single_operator: bool) -> World {
    let enclave = FakeEnclave::start_tcp("127.0.0.1:0", EnclaveConfig { pcr0_seed: 0x42, debug: false, clock_ms: Some(T0 as u64) }).unwrap();
    let program = tally_program(&output_schema());
    let program_cid = formats::cid_of_bytes(&program);
    let (rt, progs, keyset) = signed_lists(&notary_sim::pcr0_of(0x42), &program_cid, refuse_single_operator);
    let policy = json!({
        "contributor_predicate": { "issued_under_template": "bafkreisource" }, "input_replacement": replacement,
        "input_schema": [{ "name": "choice", "type": "text", "required": true, "enum": ["yes", "no"] }],
        "isolation": isolation, "mode": "aggregate", "output_action": "statement",
        "output_recipients": { "cards": [], "job_requester": false, "public": true }, "output_schema": output_schema(),
        "platform": "simulator", "privacy": { "k_min": k_min }, "program_cid": program_cid, "retention": "none",
    });
    let revoked = Arc::new(Mutex::new(BTreeSet::new()));
    let oracle = Oracle { policy, approved: vec![], revoked: revoked.clone(), lists: (rt, progs) };
    let addr = enclave.addr.clone();
    let clock_backend = backend(&addr);
    let platform = Platform {
        attest: Box::new(backend(&addr)),
        attested_time_ms: Box::new(move || clock_backend.attested_time_ms().map_err(|e| e.to_string())),
        pcr0: notary_sim::pcr0_of(0x42),
    };
    let pins = Pins { accepted_runtimes_card: "runtimes".into(), program_allowlist_card: "programs".into(), keyset, accepted_runtimes_floor: 1, program_allowlist_floor: 1 };
    let mut w = World { broker: Broker::new(pins, Box::new(oracle.clone()), Box::new(InProcessWorkers::default()), platform), host: Host::default(), enclave, revoked, program, headers: vec![], card: String::new(), isolation: if isolation == "shared" { 0x01 } else { 0x02 } };
    // genesis gives this enclave its notary card; the oracle then approves it
    let card = genesis(&mut w);
    let mut o = oracle;
    o.approved = vec![card.clone()];
    w.broker = rebuild(w.broker, o);
    w.card = card;
    w
}

/// Swaps the oracle while keeping the broker's keys: re-run genesis on the new broker is not possible (keys are
/// enclave-only), so the test oracle is shared through a field update instead.
fn rebuild(b: Broker, o: Oracle) -> Broker {
    let mut b = b;
    b.set_oracle_for_tests(Box::new(o));
    b
}

fn genesis(w: &mut World) -> String {
    let req = json!({ "chain_pubkey": "HOST_SUPPLIED", "id_pubkey": "HOST_SUPPLIED", "nonce": b64u::encode(&[7u8; 16]), "operator_card": "a".repeat(64),
        "operator_host_pubkey": b64u::encode(MlDsaKey::generate().public_key()), "platform": "simulator", "policy_id": "bafkreipolicy",
        "requested_at": "2027-01-15T00:00:00.000Z", "type": "notary.genesis_request.v1" });
    w.broker.handle(&mut w.host, &json!({ "kind": "genesis", "req_id": "g1", "request": req }));
    let out = w.host.take();
    let ready = find(&out, "genesis_ready").expect("genesis_ready").clone();
    let card = ready["notary_card"].as_str().unwrap().to_string();
    // step 6 and step 9 (E26): countersign writes identity-log seq 0, and jobs wait for its anchor
    let att_cid = formats::cid_of_bytes(&b64u::decode(ready["attestation"].as_str().unwrap()).unwrap());
    let offer = json!({ "chain_pubkey": ready["chain_pubkey"], "genesis_attestation": att_cid, "issuer_card": "c".repeat(64), "operator_card": "a".repeat(64),
        "platform": "simulator", "policy_id": "bafkreinotarycardpolicy", "recipient_pubkey": ready["id_pubkey"], "issuer_signature": "sig" });
    w.broker.handle(&mut w.host, &json!({ "kind": "countersign_notary_card", "req_id": "c", "offer": offer }));
    let out = w.host.take();
    assert!(find(&out, "countersigned").is_some());
    let anchor = out.iter().find(|m| m["kind"] == "eas_anchor").expect("seq 0 is anchored").clone();
    assert_eq!((anchor["scope_id"].as_str(), anchor["seq"].as_u64()), (Some(card.as_str()), Some(0)));
    w.broker.handle(&mut w.host, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": card, "seq": 0, "tx_receipt": "0x0" }));
    w.host.take();
    card
}

fn push_header(w: &mut World, ts_ms: i64) -> ([u8; 32], u64) {
    let parent = w.headers.last().copied().unwrap_or([0u8; 32]);
    let number = w.headers.len() as u64 + 100;
    let rlp = encode_test_header(parent, number, (ts_ms / 1000) as u64);
    let h = notary_crypto::keccak256(&rlp);
    w.headers.push(h);
    w.broker.handle(&mut w.host, &json!({ "kind": "chain_headers", "req_id": "h", "headers": [{ "number": number, "header_rlp": b64u::encode(&rlp) }] }));
    let ack = w.host.take();
    assert_eq!(find(&ack, "chain_ack").unwrap()["newest"], number);
    (h, number)
}

fn job_for(w: &World, requester: &MlDsaKey, nonce: u8) -> Value {
    let mut job = json!({ "closes_at": formats::format_timestamp(CLOSES), "created_at": formats::format_timestamp(T0), "kem": "x-wing-draft-06",
        "min_live": 1, "nonce": b64u::encode(&[nonce; 16]), "opens_at": formats::format_timestamp(OPENS), "parameters": {},
        "policy_id": "bafkreipolicy", "policy_state_cid": "bafkreistate", "replica_set": [{ "instances": 1, "notary_card": w.card }],
        "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1" });
    job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
    job
}

struct Opened {
    job_hash: [u8; 32],
    job_pk: Vec<u8>,
}

fn create_and_open(w: &mut World, job: &Value) -> Opened {
    w.broker.handle(&mut w.host, &json!({ "kind": "create_job", "req_id": "c1", "job": job, "program": b64u::encode(&w.program),
        "transport": { "key_config_url": "https://h/ohttp/key-config", "relay_target_id": "t" } }));
    let out = w.host.take();
    let keyed = find(&out, "job_keyed").unwrap_or_else(|| panic!("no job_keyed: {out:?}")).clone();
    assert!(find(&out, "announce").is_none(), "no announcement before the `opened` record is anchored");
    let anchor = find(&out, "eas_anchor").expect("opened record anchored").clone();
    assert_eq!(anchor["seq"], 0);
    let job_hash: [u8; 32] = jcs::h_bytes(job).unwrap();
    // the attestation binds the job, program, key and epoch, and verifies under algorithm V
    let doc = b64u::decode(keyed["attestation"].as_str().unwrap()).unwrap();
    let job_pk = b64u::decode(keyed["job_public_key"].as_str().unwrap()).unwrap();
    let rt = notary_attest::verify::AcceptedRuntime { pcr0: notary_sim::pcr0_of(0x42), platform: "simulator".into(), accepted_from_ms: 0, retired_at_ms: None, retire_reason: None };
    let cfg = Config { roots: [("simulator".to_string(), notary_sim::test_root_der())].into(), allow_simulator: true };
    let ud = UserData { purpose: 0x02, id_key_hash: notary_crypto::keccak256(&id_pubkey_of(w)), inst_key_hash: inst_hash_of(w), program_hash: sha256(&w.program),
        job_hash, epoch: 0, isolation: w.isolation, ..Default::default() };
    let expected = Expected { user_data: ud, nonce: Some(job_hash.to_vec()), public_key: Some(sha256(&job_pk).to_vec()) };
    verify_attestation(&doc, &cfg, &expected, &Context { t_eval_ms: T0, now_ms: T0, max_age_ms: Some(60_000), accepted_runtimes: &[rt], platform: "simulator" })
        .expect("job attestation passes algorithm V");
    // anchor arrives → the announcement
    w.broker.handle(&mut w.host, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": b64u::encode(&job_hash), "seq": 0, "tx_receipt": "0x1" }));
    let out = w.host.take();
    let ann = find(&out, "announce").expect("announcement after the anchor")["announcement"].clone();
    assert!(verify_object(&ann, "notary_signature", &id_pubkey_of(w)), "announcement signed by K_id");
    assert_eq!(ann["job_public_key"], keyed["job_public_key"]);
    Opened { job_hash, job_pk }
}

fn id_pubkey_of(w: &World) -> Vec<u8> {
    w.broker.identity_pubkey_for_tests(&w.card).unwrap()
}
fn inst_hash_of(w: &World) -> [u8; 32] {
    b64u::decode_len(&w.broker.instance_id(), 32).unwrap().try_into().unwrap()
}

struct Submission {
    sealed: Value,
    input_hash: String,
    receipt_key: notary_crypto::SecretBytes,
}

fn seal_input(o: &Opened, epoch: u64, card: &str, choice: &str, revision: u64, chain_ref: ([u8; 32], u64)) -> Submission {
    let input = json!({ "chain_ref": { "block_hash": b64u::encode(&chain_ref.0), "block_number": chain_ref.1 }, "contributor_card": card,
        "contributor_card_pubkey": "AA", "contributor_signature": { "public_key": "AA", "signature": "AA" }, "evidence": [],
        "job_hash": b64u::encode(&o.job_hash), "payload": { "choice": choice }, "revision": revision, "signed_at": "2027-01-15T00:10:00.000Z", "type": "notary.input.v1" });
    let (info, aad) = sealed_input_info_aad(&o.job_hash, epoch);
    let s = xwing_seal(&o.job_pk, &info, &aad, &jcs::canonical(&input).unwrap()).unwrap();
    let sealed = json!({ "ct": b64u::encode(&s.ct), "enc": b64u::encode(&s.enc), "epoch": epoch, "job_hash": b64u::encode(&o.job_hash), "kem": "x-wing-draft-06", "type": "notary.sealed_input.v1" });
    Submission { input_hash: jcs::h(&sealed).unwrap(), sealed, receipt_key: s.receipt_key }
}

/// Submits and opens the sealed validation receipt the way a wallet does.
fn submit(w: &mut World, s: &Submission) -> Result<Value, String> {
    w.broker.handle(&mut w.host, &json!({ "kind": "submit_input", "req_id": "s", "job_hash": s.sealed["job_hash"], "sealed_input": s.sealed }));
    let out = w.host.take();
    if let Some(e) = find(&out, "error") {
        return Err(e["code"].as_str().unwrap().to_string());
    }
    let r = find(&out, "input_result").unwrap();
    assert_eq!(r["input_hash"], s.input_hash.as_str());
    let opened = open_receipt(&s.receipt_key, &s.input_hash, s.sealed["job_hash"].as_str().unwrap(), &b64u::decode(r["receipt_sealed"].as_str().unwrap()).unwrap())
        .expect("the wallet opens its receipt");
    let receipt: Value = serde_json::from_slice(&opened).unwrap();
    assert!(verify_object(&receipt, "notary_signature", &id_pubkey_of(w)), "receipt signed by K_id");
    Ok(receipt)
}

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn hello_attests_the_instance_key() {
    let mut w = world("dedicated", "latest_wins", 2);
    w.broker.handle(&mut w.host, &json!({ "kind": "hello", "req_id": "h1", "challenge": b64u::encode(&[9u8; 32]) }));
    let ack = find(&w.host.take(), "hello_ack").unwrap().clone();
    let inst = b64u::decode(ack["inst_pubkey"].as_str().unwrap()).unwrap();
    assert_eq!(b64u::encode(&sha256(&inst)), w.broker.instance_id());
    let doc = b64u::decode(ack["attestation"].as_str().unwrap()).unwrap();
    let env = notary_attest::aws::verify_envelope(&doc, &notary_sim::test_root_der()).unwrap();
    let ud = UserData::decode(&env.user_data).unwrap();
    assert_eq!((ud.purpose, ud.inst_key_hash), (0x03, sha256(&inst)));
    assert_eq!(env.nonce, Some(vec![9u8; 32]));
    assert_eq!(env.public_key, None);
}

#[test]
fn genesis_ignores_host_keys_and_countersign_checks_g2() {
    let mut w = world("dedicated", "latest_wins", 2);
    let req = json!({ "chain_pubkey": "x", "id_pubkey": "x", "nonce": b64u::encode(&[1u8; 16]), "operator_card": "b".repeat(64),
        "operator_host_pubkey": b64u::encode(MlDsaKey::generate().public_key()), "platform": "simulator", "policy_id": "bafkreipolicy",
        "requested_at": "2027-01-15T00:00:00.000Z", "type": "notary.genesis_request.v1" });
    w.broker.handle(&mut w.host, &json!({ "kind": "genesis", "req_id": "g", "request": req }));
    let out = w.host.take();
    let ready = find(&out, "genesis_ready").unwrap().clone();
    assert_ne!(ready["id_pubkey"], "x", "host-supplied key fields are replaced (I2)");
    let request = &ready["request"];
    let doc = b64u::decode(ready["attestation"].as_str().unwrap()).unwrap();
    let env = notary_attest::aws::verify_envelope(&doc, &notary_sim::test_root_der()).unwrap();
    assert_eq!(env.nonce.unwrap(), jcs::h_bytes(request).unwrap().to_vec(), "nonce = H(complete genesis request)");
    let id_pub = b64u::decode(ready["id_pubkey"].as_str().unwrap()).unwrap();
    assert_eq!(UserData::decode(&env.user_data).unwrap().id_key_hash, notary_crypto::keccak256(&id_pub));
    assert!(out.iter().filter(|m| m["kind"] == "publish").count() >= 2, "attestation and completed request are published (E17)");
    let att_cid = formats::cid_of_bytes(&doc);
    let offer = json!({ "chain_pubkey": ready["chain_pubkey"], "genesis_attestation": att_cid, "issuer_card": "c".repeat(64), "operator_card": "b".repeat(64),
        "platform": "simulator", "policy_id": "bafkreinotarycardpolicy", "recipient_pubkey": ready["id_pubkey"], "issuer_signature": "sig" });
    w.broker.handle(&mut w.host, &json!({ "kind": "countersign_notary_card", "req_id": "c", "offer": offer }));
    let out = w.host.take();
    let signed = find(&out, "countersigned").unwrap()["offer"].clone();
    let sig = b64u::decode(signed["holder_signature"].as_str().unwrap()).unwrap();
    assert!(mldsa_verify(&id_pub, &jcs::canonical(&jcs::without_fields(&signed, &["holder_signature"])).unwrap(), &sig));
    // E26: identity-log seq 0 is `opened`, names the genesis attestation, is signed by K_id, and is anchored
    let card = ready["notary_card"].as_str().unwrap().to_string();
    let anchor = out.iter().find(|m| m["kind"] == "eas_anchor").expect("seq 0 anchor requested").clone();
    assert_eq!((anchor["scope_id"].as_str(), anchor["seq"].as_u64()), (Some(card.as_str()), Some(0)));
    let rec_bytes = out.iter().filter(|m| m["kind"] == "publish").map(|m| b64u::decode(m["object"].as_str().unwrap()).unwrap())
        .find(|b| formats::cid_of_bytes(b) == anchor["record_cid"].as_str().unwrap()).expect("record published");
    let rec: Value = serde_json::from_slice(&rec_bytes).unwrap();
    assert_eq!((rec["type"].as_str(), rec["kind"].as_str(), rec["seq"].as_u64(), rec["job_hash"].as_str()), (Some("notary.identity_log.v1"), Some("opened"), Some(0), Some(card.as_str())));
    assert_eq!(rec["body"], json!({ "attestations": [att_cid] }));
    let unsigned = jcs::canonical(&jcs::without_fields(&rec, &["notary_signature", "instance_signature"])).unwrap();
    assert!(mldsa_verify(&id_pub, &unsigned, &b64u::decode(rec["notary_signature"]["signature"].as_str().unwrap()).unwrap()), "signed by K_id");
    // a second countersign doesn't write another seq 0
    w.broker.handle(&mut w.host, &json!({ "kind": "countersign_notary_card", "req_id": "c", "offer": offer }));
    assert!(w.host.take().iter().all(|m| m["kind"] != "eas_anchor"));
    // no job for this card until seq 0 is anchored
    push_header(&mut w, T0);
    w.card = card.clone();
    let requester = MlDsaKey::generate();
    let job = job_for(&w, &requester, 9);
    w.broker.handle(&mut w.host, &json!({ "kind": "create_job", "req_id": "j", "job": job, "program": b64u::encode(&w.program) }));
    assert_eq!(find(&w.host.take(), "error").expect("refused")["code"], "IDENTITY_LOG_PENDING");
    w.broker.handle(&mut w.host, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": card, "seq": 0, "tx_receipt": "0x0" }));
    w.host.take();
    w.broker.handle(&mut w.host, &json!({ "kind": "create_job", "req_id": "j", "job": job, "program": b64u::encode(&w.program) }));
    assert!(w.host.take().iter().all(|m| m["code"] != "IDENTITY_LOG_PENDING"), "after the anchor the identity-log gate passes");
    let mut wrong = offer.clone();
    wrong["recipient_pubkey"] = json!(b64u::encode(MlDsaKey::generate().public_key()));
    w.broker.handle(&mut w.host, &json!({ "kind": "countersign_notary_card", "req_id": "c", "offer": wrong }));
    assert_eq!(find(&w.host.take(), "error").unwrap()["code"], "NOT_GENESIS_MISMATCH");
}

#[test]
fn create_job_refuses_before_any_key_exists() {
    let mut w = world("dedicated", "latest_wins", 2);
    push_header(&mut w, T0);
    let requester = MlDsaKey::generate();
    // bad signature
    let mut job = job_for(&w, &requester, 1);
    job["min_live"] = json!(1);
    job["nonce"] = json!(b64u::encode(&[2u8; 16]));
    w.broker.handle(&mut w.host, &json!({ "kind": "create_job", "req_id": "c", "job": job, "program": b64u::encode(&w.program) }));
    assert_eq!(find(&w.host.take(), "job_rejected").unwrap()["code"], "JOB_SIGNATURE_INVALID");
    // program bytes that don't match program_cid: A1, and no key, attestation or log record is produced
    let job = job_for(&w, &requester, 3);
    w.broker.handle(&mut w.host, &json!({ "kind": "create_job", "req_id": "c", "job": job, "program": b64u::encode(b"\0asm") }));
    let out = w.host.take();
    assert_eq!(find(&out, "job_rejected").unwrap()["code"], "ADM_HASH_MISMATCH");
    assert!(find(&out, "publish").is_none() && find(&out, "eas_anchor").is_none(), "nothing attested or logged");
    assert!(w.broker.job_epochs_for_tests(&jcs::h_bytes(&job).unwrap()).is_empty(), "no job key exists");
}

#[test]
fn shared_isolation_needs_the_verified_allowlist() {
    let mut w = world("shared", "latest_wins", 2);
    push_header(&mut w, T0);
    let job = job_for(&w, &MlDsaKey::generate(), 1);
    create_and_open(&mut w, &job); // allowlisted: admitted shared
}

#[test]
fn inputs_receipts_and_checks() {
    let mut w = world("dedicated", "latest_wins", 2);
    push_header(&mut w, T0);
    let job = job_for(&w, &MlDsaKey::generate(), 1);
    let o = create_and_open(&mut w, &job);
    let early = push_header(&mut w, OPENS - 1000);
    let r = push_header(&mut w, OPENS + 1000);

    // B4: chain_ref before opens_at
    let s = seal_input(&o, 0, &"1".repeat(64), "yes", 0, early);
    assert_eq!(submit(&mut w, &s).unwrap()["reject_reason"], "INPUT_TOO_EARLY");
    // B3: unknown block
    let s = seal_input(&o, 0, &"1".repeat(64), "yes", 0, ([5u8; 32], 7));
    assert_eq!(submit(&mut w, &s).unwrap()["reject_reason"], "INPUT_CHAIN_REF_UNKNOWN");
    // accepted, acks ≥ q (1)
    let a0 = seal_input(&o, 0, &"1".repeat(64), "no", 0, r);
    let rec = submit(&mut w, &a0).unwrap();
    assert_eq!((rec["status"].as_str(), rec["acks"].as_u64()), (Some("accepted"), Some(1)));
    // a replay of the same sealed input is idempotent
    assert_eq!(submit(&mut w, &a0).unwrap()["status"], "accepted");
    // latest_wins: higher revision supersedes; lower is superseded; same revision different content conflicts
    let a1 = seal_input(&o, 0, &"1".repeat(64), "yes", 1, r);
    assert_eq!(submit(&mut w, &a1).unwrap()["status"], "accepted");
    assert_eq!(submit(&mut w, &seal_input(&o, 0, &"1".repeat(64), "no", 0, r)).unwrap()["status"], "superseded");
    assert_eq!(submit(&mut w, &seal_input(&o, 0, &"1".repeat(64), "no", 1, r)).unwrap()["reject_reason"], "REVISION_CONFLICT");
    // B9 schema; B7 via the oracle
    assert_eq!(submit(&mut w, &seal_input(&o, 0, &"2".repeat(64), "maybe", 0, r)).unwrap()["reject_reason"], "INPUT_SCHEMA_INVALID");
    w.revoked.lock().unwrap().insert("3".repeat(64));
    assert_eq!(submit(&mut w, &seal_input(&o, 0, &"3".repeat(64), "yes", 0, r)).unwrap()["reject_reason"], "INPUT_CARD_REVOKED");
    // B1: not sealed to this job's key → plain error, no receipt
    let other = Opened { job_hash: o.job_hash, job_pk: notary_crypto::XWingKey::generate().public_key().to_vec() };
    assert_eq!(submit(&mut w, &seal_input(&other, 0, &"4".repeat(64), "yes", 0, r)), Err("INPUT_UNDECRYPTABLE".into()));
}

#[test]
fn close_needs_both_clocks_and_produces_a_verifiable_notarization() {
    let mut w = world("dedicated", "latest_wins", 2);
    push_header(&mut w, T0);
    let job = job_for(&w, &MlDsaKey::generate(), 1);
    let o = create_and_open(&mut w, &job);
    let r = push_header(&mut w, OPENS + 1000);
    let mut stored = vec![];
    for (i, choice) in ["yes", "yes", "no", "yes"].iter().enumerate() {
        let s = seal_input(&o, 0, &format!("{i}").repeat(64), choice, 0, r);
        assert_eq!(submit(&mut w, &s).unwrap()["status"], "accepted");
        stored.push(s.sealed);
    }
    let dropped = stored.pop().unwrap(); // the host "loses" one accepted input
    let _ = dropped;
    let close = |w: &mut World, stored: &[Value]| {
        w.broker.handle(&mut w.host, &json!({ "kind": "close_chunk", "req_id": "x", "job_hash": b64u::encode(&o.job_hash), "seq": 0, "sealed_inputs": stored, "last": true }));
        w.host.take()
    };
    // chain time past closes_at but the attested clock is not: no close
    push_header(&mut w, CLOSES + 5000);
    assert_eq!(find(&close(&mut w, &stored), "error").unwrap()["code"], "CLOSE_NOT_DUE");
    // attested clock past, chain still before: no close
    let mut w2 = world("dedicated", "latest_wins", 2);
    push_header(&mut w2, T0);
    let job2 = job_for(&w2, &MlDsaKey::generate(), 2);
    let o2 = create_and_open(&mut w2, &job2);
    w2.enclave.set_clock_ms(Some(CLOSES as u64 + 10));
    w2.broker.handle(&mut w2.host, &json!({ "kind": "close_chunk", "req_id": "x", "job_hash": b64u::encode(&o2.job_hash), "seq": 0, "sealed_inputs": [], "last": true }));
    assert_eq!(find(&w2.host.take(), "error").unwrap()["code"], "CLOSE_NOT_DUE");
    // both due
    w.enclave.set_clock_ms(Some(CLOSES as u64 + 10));
    let out = close(&mut w, &stored);
    let closed = find(&out, "job_closed").unwrap_or_else(|| panic!("{out:?}"));
    let n = &closed["notarization"];
    assert_eq!(n["output"]["public"], json!({ "no": 1, "yes": 2 }));
    assert_eq!((n["accepted"].as_u64(), n["dropped_after_acceptance"].as_u64(), n["suppressed"].as_bool()), (Some(3), Some(1), Some(false)));
    // cosignature over the raw 32 bytes of H(body); notary_signature over everything but itself
    let body = jcs::without_fields(n, &["cosignatures", "notary_signature"]);
    let digest = jcs::h_bytes(&body).unwrap();
    let cos = &n["cosignatures"][0]["instance_signature"];
    assert!(mldsa_verify(&b64u::decode(cos["public_key"].as_str().unwrap()).unwrap(), &digest, &b64u::decode(cos["signature"].as_str().unwrap()).unwrap()));
    assert!(verify_object(n, "notary_signature", &id_pubkey_of(&w)));
    // input_commitment over the counted hashes, published as counted_inputs
    let mut counted: Vec<[u8; 32]> = stored.iter().map(|s| jcs::h_bytes(s).unwrap()).collect();
    counted.sort();
    assert_eq!(n["input_commitment"], b64u::encode(&merkle::input_commitment(&counted).unwrap()));
    assert_eq!(n["output_hash"], jcs::h(&json!({ "no": 1, "yes": 2 })).unwrap());
    assert_eq!(n["closed_at"], n["chain_state"]["block_timestamp"]);
    let publishes: Vec<&Value> = out.iter().filter(|m| m["kind"] == "publish").collect();
    assert!(publishes.len() >= 3, "counted_inputs, notarization and the notarized record are published");
    // keys are erased only once the `notarized` record is anchored
    assert!(!w.broker.job_epochs_for_tests(&o.job_hash).is_empty());
    let seq = find(&out, "eas_anchor").unwrap()["seq"].as_u64().unwrap();
    w.broker.handle(&mut w.host, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": b64u::encode(&o.job_hash), "seq": seq, "tx_receipt": "0x2" }));
    assert!(w.broker.job_epochs_for_tests(&o.job_hash).is_empty(), "K_job erased after the notarized anchor");
}

#[test]
fn k_min_suppresses_and_the_program_does_not_run() {
    let mut w = world("dedicated", "reject_duplicates", 5);
    push_header(&mut w, T0);
    let job = job_for(&w, &MlDsaKey::generate(), 1);
    let o = create_and_open(&mut w, &job);
    let r = push_header(&mut w, OPENS + 1000);
    let s = seal_input(&o, 0, &"1".repeat(64), "yes", 0, r);
    submit(&mut w, &s).unwrap();
    // reject_duplicates: a second input from the same contributor
    assert_eq!(submit(&mut w, &seal_input(&o, 0, &"1".repeat(64), "no", 0, r)).unwrap()["reject_reason"], "INPUT_DUPLICATE");
    assert_eq!(submit(&mut w, &seal_input(&o, 0, &"2".repeat(64), "no", 1, r)).unwrap()["reject_reason"], "INPUT_REVISION_INVALID");
    push_header(&mut w, CLOSES + 1000);
    w.enclave.set_clock_ms(Some(CLOSES as u64 + 10));
    w.broker.handle(&mut w.host, &json!({ "kind": "close_chunk", "req_id": "x", "job_hash": b64u::encode(&o.job_hash), "seq": 0, "sealed_inputs": [s.sealed], "last": true }));
    let out = w.host.take();
    let n = &find(&out, "job_closed").unwrap()["notarization"];
    assert_eq!(n["suppressed"], true);
    assert_eq!(n["output"]["public"], json!({ "insufficient_participation": true }));
    assert_eq!(n["rejected"], 2);
}

#[test]
fn jobs_are_isolated_from_each_other() {
    let mut w = world("dedicated", "latest_wins", 1);
    push_header(&mut w, T0);
    let ja = job_for(&w, &MlDsaKey::generate(), 1);
    let a = create_and_open(&mut w, &ja);
    // dedicated: a second job is refused while the first is held
    let jb = job_for(&w, &MlDsaKey::generate(), 2);
    let prog = b64u::encode(&w.program);
    w.broker.handle(&mut w.host, &json!({ "kind": "create_job", "req_id": "c2", "job": jb, "program": prog }));
    assert_eq!(find(&w.host.take(), "job_rejected").unwrap()["code"], "ADM_DEDICATED_REQUIRED");

    let mut s = world("shared", "latest_wins", 1);
    push_header(&mut s, T0);
    let (ja2, jb2) = (job_for(&s, &MlDsaKey::generate(), 1), job_for(&s, &MlDsaKey::generate(), 2));
    let a2 = create_and_open(&mut s, &ja2);
    let b2 = create_and_open(&mut s, &jb2);
    assert_ne!(a2.job_pk, b2.job_pk, "each job has its own key");
    let r = push_header(&mut s, OPENS + 1000);
    // an input sealed to job A's key, presented as job B's: B's key can't open it
    let mut cross = seal_input(&a2, 0, &"1".repeat(64), "yes", 0, r);
    cross.sealed["job_hash"] = json!(b64u::encode(&b2.job_hash));
    assert_eq!(submit(&mut s, &cross), Err("INPUT_UNDECRYPTABLE".into()));
    // an input for B, sealed with A's info/aad binding, also fails (info binds job_hash)
    let wrong_binding = Opened { job_hash: a2.job_hash, job_pk: b2.job_pk.clone() };
    let mut sub = seal_input(&wrong_binding, 0, &"1".repeat(64), "yes", 0, r);
    sub.sealed["job_hash"] = json!(b64u::encode(&b2.job_hash));
    assert_eq!(submit(&mut s, &sub), Err("INPUT_UNDECRYPTABLE".into()));
    // aborting A erases only A's key
    s.broker.handle(&mut s.host, &json!({ "kind": "abort_job", "req_id": "ab", "job_hash": b64u::encode(&a2.job_hash), "reason": "test" }));
    let out = s.host.take();
    let seq = find(&out, "eas_anchor").unwrap()["seq"].as_u64().unwrap();
    s.broker.handle(&mut s.host, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": b64u::encode(&a2.job_hash), "seq": seq, "tx_receipt": "0x3" }));
    assert!(s.broker.job_epochs_for_tests(&a2.job_hash).is_empty());
    assert_eq!(s.broker.job_epochs_for_tests(&b2.job_hash), vec![0]);
    assert_eq!(submit(&mut s, &seal_input(&b2, 0, &"1".repeat(64), "yes", 0, r)).unwrap()["status"], "accepted");
    let _ = a;
}

#[test]
fn enclaves_do_not_enforce_the_single_operator_switch() {
    // E34: wallets (W7) and verifiers (N) enforce it; an enclave reading host-supplied notary cards couldn't.
    let mut w = world_ext("dedicated", "latest_wins", 2, true);
    push_header(&mut w, T0);
    let job = job_for(&w, &MlDsaKey::generate(), 1);
    create_and_open(&mut w, &job);
}

/// The end-to-end run (step 5.5, `notary/e2e`) uses this same tally program as a committed fixture.
/// `UPDATE_E2E_FIXTURE=1 cargo test -p notary-broker --test broker e2e_tally_fixture` rewrites it.
#[test]
fn e2e_tally_fixture_is_current() {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../e2e/fixtures/tally.wasm");
    let program = tally_program(&output_schema());
    if std::env::var("UPDATE_E2E_FIXTURE").is_ok() {
        std::fs::write(&p, &program).unwrap();
    }
    assert_eq!(std::fs::read(&p).expect("run with UPDATE_E2E_FIXTURE=1"), program, "notary/e2e/fixtures/tally.wasm is stale");
}
