//! Step 5.6 capacity benchmark (implementation plan 5.6; code-plan §11).
//!
//! Drives the real broker (`notary-broker`) under the simulator, exactly as the host does, with the real card checks
//! (`SnapshotOracle` over `notary-cards`: B5–B8 on every input, and again at close), real X-Wing sealing and opening,
//! real ML-DSA receipts and the real worker engine (wasmi, the tally program from `notary/e2e/fixtures`).
//!
//! Measured per scenario: inputs per second through `submit_input` (one broker = one enclave core), resident memory
//! with N inputs held, and the close (`close_chunk` → `job_closed`: re-open, re-check and run over every input).
//!
//! Not measured here: the vsock round trip (`fetch` is answered in-process), host time, and the worker sandbox's process
//! boundary (`InProcessWorkers`). The policy and requester reads and the governance-list reads are fixed (`BenchOracle`):
//! they run once per job, not per input.
//!
//!   cargo run --release -p notary-capacity -- --world W.json --inputs 1000 --jobs 1
use notary_broker::{
    cards_oracle::{CardPins, SnapshotOracle},
    chain::encode_test_header,
    env::{CardOracle, HostIo, InProcessWorkers, Platform, PolicyView},
    lists::{approval_digest, Keyset, ListVersion, Pins},
    Broker,
};
use notary_crypto::{sealed_input_info_aad, xwing_seal, ChainKey, MlDsaKey, SecretBytes};
use notary_sim::{EnclaveConfig, FakeEnclave};
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Instant;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// Resets the kernel's peak-RSS counter (Linux; `VmHWM` then tracks from here).
fn reset_peak() {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
}

/// Resident set (and its peak), in MiB: `/proc/self/status` on Linux, `ps` elsewhere (no peak; unreliable on macOS).
fn rss_mib() -> (f64, f64) {
    if let Ok(s) = std::fs::read_to_string("/proc/self/status") {
        let field = |k: &str| s.lines().find(|l| l.starts_with(k)).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0;
        return (field("VmRSS:"), field("VmHWM:"));
    }
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok();
    let kb = out.and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(0.0);
    (kb / 1024.0, f64::NAN)
}

// ---- the host side: answers `fetch` from the world, collects what the broker sends ---------------------------------

struct WorldIo {
    cards: Map<String, Value>,
    subcards: Map<String, Value>,
    ipfs: HashMap<String, Vec<u8>>,
    fetches: usize,
    out: Vec<Value>,
}
impl HostIo for WorldIo {
    fn send(&mut self, msg: Value) {
        self.out.push(msg);
    }
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
        self.fetches += 1;
        let (kind, a) = what.split_once(':')?;
        match kind {
            "ipfs" => self.ipfs.get(a).cloned(),
            "card_head" => {
                let c = self.cards.get(a)?;
                jcs::canonical(&json!({ "events": c["events"], "head_cid": c["log_head_cid"] })).ok()
            }
            "subcard" => jcs::canonical(self.subcards.get(a)?).ok(),
            _ => None,
        }
    }
}
impl WorldIo {
    fn take(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.out)
    }
}
fn find<'a>(msgs: &'a [Value], kind: &str) -> Option<&'a Value> {
    msgs.iter().find(|m| m["kind"] == kind)
}

// ---- oracle: real card checks, fixed once-per-job reads -----------------------------------------------------------

struct BenchOracle {
    inner: SnapshotOracle,
    policy: Value,
    approved: Vec<String>,
    lists: (Vec<ListVersion>, Vec<ListVersion>),
    /// Time spent in B5–B8 (card checks), shared with the driver.
    card_check_s: std::rc::Rc<std::cell::Cell<f64>>,
}
impl CardOracle for BenchOracle {
    fn policy(&mut self, _: &mut dyn HostIo, _: &str, _: &str, _: i64) -> Result<PolicyView, &'static str> {
        Ok(PolicyView { notary: self.policy.clone(), approved_notaries: self.approved.clone() })
    }
    fn requester_allowed(&mut self, _: &mut dyn HostIo, _: &Value, _: &Value, _: i64) -> bool {
        true
    }
    fn contributor(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> Result<[u8; 32], &'static str> {
        let t = Instant::now();
        let r = self.inner.contributor(io, input, notary, params, now_ms);
        self.card_check_s.set(self.card_check_s.get() + t.elapsed().as_secs_f64());
        r
    }
    fn list_history(&mut self, _: &mut dyn HostIo, card: &str) -> Option<Vec<ListVersion>> {
        Some(if card == "runtimes" { self.lists.0.clone() } else { self.lists.1.clone() })
    }
    fn on_snapshot(&mut self, policy: &str, msg: &Value) {
        self.inner.on_snapshot(policy, msg)
    }
    fn on_updates(&mut self, policy: &str, msg: &Value) {
        self.inner.on_updates(policy, msg)
    }
}

fn signed_lists(program_cid: &str) -> (Vec<ListVersion>, Vec<ListVersion>, Keyset) {
    let members: Vec<ChainKey> = (0..5).map(|_| ChainKey::generate()).collect();
    let keyset = Keyset { keys: members.iter().map(|k| k.public_key_xy()).collect(), quorum: 4, version: 1, key_scheme: 0 };
    let sign = |list: &str, card: &str, value: &Value| -> String {
        let mut a = json!({ "governance_version": 1, "kind": "standard", "list": list, "list_card": card, "list_hash": jcs::h(value).unwrap(),
            "list_version": 1, "signatures": [], "type": "notary_list_approval" });
        let d = approval_digest(&a).unwrap();
        a["signatures"] = json!((0..4).map(|i| json!({ "key_index": i, "signature": b64u::encode(&members[i].sign_digest(&d).unwrap()) })).collect::<Vec<_>>());
        String::from_utf8(jcs::canonical(&a).unwrap()).unwrap()
    };
    let rt = json!([{ "accepted_from": "2026-01-01T00:00:00Z", "build_recipe_cid": "bafkreirecipe", "close_compat": "c1", "pcr0": b64u::encode(&notary_sim::pcr0_of(0x42)),
        "platform": "simulator", "source_commit": "abc", "version": "1" }]);
    let progs = json!([{ "accepted_from": "2026-01-01T00:00:00Z", "audit_report_cid": "bafkreiaudit", "name": "tally", "program_cid": program_cid,
        "source_commit": "abc", "toolchain": "wat", "version": "1" }]);
    (
        vec![ListVersion { approval_text: Some(sign("accepted_runtimes", "runtimes", &rt)), value: rt }],
        vec![ListVersion { approval_text: Some(sign("program_allowlist", "programs", &progs)), value: progs }],
        keyset,
    )
}

// ---- the benchmark ------------------------------------------------------------------------------------------------

struct Bench {
    broker: Broker,
    io: WorldIo,
    enclave: FakeEnclave,
    headers: Vec<([u8; 32], u64)>,
    card: String,
    program: Vec<u8>,
    snapshot: Value,
    oracle_parts: Option<(CardPins, Value, (Vec<ListVersion>, Vec<ListVersion>))>,
}

impl Bench {
    fn push_header(&mut self, ts_ms: i64) -> ([u8; 32], u64) {
        let parent = self.headers.last().map(|h| h.0).unwrap_or([0u8; 32]);
        let number = self.headers.len() as u64 + 100;
        let rlp = encode_test_header(parent, number, (ts_ms / 1000) as u64);
        let h = notary_crypto::keccak256(&rlp);
        self.headers.push((h, number));
        self.broker.handle(&mut self.io, &json!({ "kind": "chain_headers", "req_id": "h", "headers": [{ "number": number, "header_rlp": b64u::encode(&rlp) }] }));
        self.io.take();
        (h, number)
    }
}

struct Opened {
    job_hash: [u8; 32],
    job_pk: Vec<u8>,
    closes_ms: i64,
}

fn sub_key(name: &str) -> MlDsaKey {
    let seed = Sha256::digest(format!("card-notary-e2e-key-{name}").as_bytes()).to_vec();
    MlDsaKey::from_seed(SecretBytes::from_vec(seed)).expect("seed")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let world_path = arg(&args, "--world").expect("--world FILE (from notary/e2e/src/bench-world.ts)");
    let n_inputs: usize = arg(&args, "--inputs").and_then(|v| v.parse().ok()).unwrap_or(1000);
    let n_jobs: usize = arg(&args, "--jobs").and_then(|v| v.parse().ok()).unwrap_or(1);
    // `dedicated` admits one job per runtime (admission A11), so concurrent jobs need `shared` (allowlisted programs)
    let isolation = arg(&args, "--isolation").unwrap_or_else(|| "shared".into());
    let program_path = arg(&args, "--program").unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../../../e2e/fixtures/tally.wasm").into());

    let t = Instant::now();
    let w: Value = serde_json::from_slice(&std::fs::read(&world_path).expect("world file")).expect("world json");
    let contributors = w["contributors"].as_array().expect("contributors").clone();
    assert!(contributors.len() >= n_inputs, "the world has {} contributors; need {n_inputs}", contributors.len());
    let ipfs: HashMap<String, Vec<u8>> = w["world"]["ipfs"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), b64u::decode(v.as_str().unwrap()).unwrap())).collect();
    let mut snapshot = w["snapshot"].clone();
    snapshot["heads"] = json!(snapshot["entries"].as_array().unwrap().iter().map(|e| json!({ "cid": e["head_cid"], "bytes": b64u::encode(&ipfs[e["head_cid"].as_str().unwrap()]) })).collect::<Vec<_>>());
    snapshot["kind"] = json!("policy_snapshot");
    snapshot["req_id"] = json!("snap");
    let io = WorldIo { cards: w["world"]["cards"].as_object().unwrap().clone(), subcards: w["world"]["subcards"].as_object().unwrap().clone(), ipfs, fetches: 0, out: vec![] };
    let program = std::fs::read(&program_path).expect("program");
    let program_cid = formats::cid_of_bytes(&program);
    eprintln!("loaded world ({} contributors) in {:.1} s", contributors.len(), t.elapsed().as_secs_f64());

    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let t0 = now_ms - now_ms % 1000;
    let enclave = FakeEnclave::start_tcp("127.0.0.1:0", EnclaveConfig { pcr0_seed: 0x42, debug: false, clock_ms: Some(t0 as u64) }).unwrap();
    let (rt, progs, keyset) = signed_lists(&program_cid);
    let policy = json!({
        "contributor_predicate": { "issued_under_template": w["source_policy"] }, "input_replacement": "latest_wins",
        "input_schema": [{ "name": "choice", "type": "text", "required": true, "enum": ["yes", "no"] }],
        "isolation": isolation, "mode": "aggregate", "output_action": "statement",
        "output_recipients": { "cards": [], "job_requester": false, "public": true },
        "output_schema": [{ "name": "no", "type": "integer", "required": true, "clamp": [0, 1000000] }, { "name": "yes", "type": "integer", "required": true, "clamp": [0, 1000000] }],
        "platform": "simulator", "privacy": { "k_min": 2 }, "program_cid": program_cid, "retention": "none",
    });
    let strs = |k: &str| w[k].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>();
    let card_pins = CardPins {
        trusted_roots: strs("trusted_roots"), app_certification_root: w["app_certification_root"].as_str().unwrap().into(),
        login_service_root: w["login_service_root"].as_str().unwrap().into(), max_chain_depth: 64, list_cards: vec![], list_holder_key: vec![], list_press_key: vec![],
    };
    let addr = enclave.addr.clone();
    let clock = notary_attest::sim::SimulatorBackend::new(addr.clone());
    let platform = Platform {
        attest: Box::new(notary_attest::sim::SimulatorBackend::new(addr)),
        attested_time_ms: Box::new(move || clock.attested_time_ms().map_err(|e| e.to_string())),
        pcr0: notary_sim::pcr0_of(0x42),
    };
    let pins = Pins { accepted_runtimes_card: "runtimes".into(), program_allowlist_card: "programs".into(), keyset, accepted_runtimes_floor: 1, program_allowlist_floor: 1 };
    let card_check_s = std::rc::Rc::new(std::cell::Cell::new(0.0));
    let oracle = BenchOracle { inner: SnapshotOracle::new(card_pins.clone()), policy: policy.clone(), approved: vec![], lists: (rt.clone(), progs.clone()), card_check_s: card_check_s.clone() };
    let mut b = Bench {
        broker: Broker::new(pins, Box::new(oracle), Box::new(InProcessWorkers::default()), platform),
        io, enclave, headers: vec![], card: String::new(), program, snapshot, oracle_parts: Some((card_pins, policy, (rt, progs))),
    };

    // genesis, countersign, identity-log seq 0 anchored (lifecycle steps 2–9)
    let req = json!({ "chain_pubkey": "x", "id_pubkey": "x", "nonce": b64u::encode(&[7u8; 16]), "operator_card": "a".repeat(64),
        "operator_host_pubkey": b64u::encode(MlDsaKey::generate().public_key()), "platform": "simulator", "policy_id": "bafkreipolicy",
        "requested_at": formats::format_timestamp(t0), "type": "notary.genesis_request.v1" });
    b.broker.handle(&mut b.io, &json!({ "kind": "genesis", "req_id": "g", "request": req }));
    let ready = find(&b.io.take(), "genesis_ready").expect("genesis_ready").clone();
    b.card = ready["notary_card"].as_str().unwrap().to_string();
    let att_cid = formats::cid_of_bytes(&b64u::decode(ready["attestation"].as_str().unwrap()).unwrap());
    let offer = json!({ "chain_pubkey": ready["chain_pubkey"], "genesis_attestation": att_cid, "issuer_card": "c".repeat(64), "operator_card": "a".repeat(64),
        "platform": "simulator", "policy_id": "bafkreinotarycardpolicy", "recipient_pubkey": ready["id_pubkey"], "issuer_signature": "sig" });
    b.broker.handle(&mut b.io, &json!({ "kind": "countersign_notary_card", "req_id": "c", "offer": offer }));
    b.io.take();
    b.broker.handle(&mut b.io, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": b.card, "seq": 0, "tx_receipt": "0x0" }));
    b.io.take();
    // the policy approves the card; the host sends the source policy's whole snapshot
    let (cp, pol, lists) = b.oracle_parts.take().unwrap();
    b.broker.set_oracle_for_tests(Box::new(BenchOracle { inner: SnapshotOracle::new(cp), policy: pol, approved: vec![b.card.clone()], lists, card_check_s: card_check_s.clone() }));
    let snap = std::mem::take(&mut b.snapshot);
    drop(w);
    reset_peak();
    let (rss_pre_snapshot, _) = rss_mib();
    b.broker.handle(&mut b.io, &snap);
    b.io.take();
    drop(snap);
    let (rss_post_snapshot, _) = rss_mib();
    b.push_header(t0);
    let (rss_base, _) = rss_mib();

    // jobs
    let mut jobs = vec![];
    for j in 0..n_jobs {
        let requester = MlDsaKey::generate();
        let closes_ms = t0 + 3_600_000;
        let mut job = json!({ "closes_at": formats::format_timestamp(closes_ms), "created_at": formats::format_timestamp(t0), "kem": "x-wing-draft-06",
            "min_live": 1, "nonce": b64u::encode(&(j as u128).to_be_bytes()), "opens_at": formats::format_timestamp(t0), "parameters": {},
            "policy_id": "bafkreipolicy", "policy_state_cid": "bafkreistate", "replica_set": [{ "instances": 1, "notary_card": b.card }],
            "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1" });
        job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
        b.broker.handle(&mut b.io, &json!({ "kind": "create_job", "req_id": "cj", "job": job, "program": b64u::encode(&b.program) }));
        let out = b.io.take();
        let keyed = find(&out, "job_keyed").unwrap_or_else(|| panic!("job not keyed: {out:?}")).clone();
        let job_hash: [u8; 32] = jcs::h_bytes(&job).unwrap();
        b.broker.handle(&mut b.io, &json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": b64u::encode(&job_hash), "seq": 0, "tx_receipt": "0x1" }));
        b.io.take();
        jobs.push(Opened { job_hash, job_pk: b64u::decode(keyed["job_public_key"].as_str().unwrap()).unwrap(), closes_ms });
    }

    // wallets: sign and seal every input (client cost, timed apart)
    let t = Instant::now();
    let chain_ref = *b.headers.last().unwrap();
    let mut sealed: Vec<Vec<Value>> = vec![vec![]; n_jobs];
    for (i, c) in contributors.iter().take(n_inputs).enumerate() {
        let key = sub_key(c["sub_seed_name"].as_str().unwrap());
        for (j, o) in jobs.iter().enumerate() {
            let input = json!({ "chain_ref": { "block_hash": b64u::encode(&chain_ref.0), "block_number": chain_ref.1 }, "contributor_card": c["card"],
                "contributor_card_pubkey": c["card_pubkey"], "evidence": [], "job_hash": b64u::encode(&o.job_hash),
                "payload": { "choice": if i % 3 == 2 { "no" } else { "yes" } }, "revision": 0, "signed_at": formats::format_timestamp(t0), "type": "notary.input.v1" });
            let sig = key.sign(&jcs::canonical(&input).unwrap());
            let mut signed = input.clone();
            signed["contributor_signature"] = json!({ "public_key": b64u::encode(key.public_key()), "signature": b64u::encode(&sig) });
            let (info, aad) = sealed_input_info_aad(&o.job_hash, 0);
            let s = xwing_seal(&o.job_pk, &info, &aad, &jcs::canonical(&signed).unwrap()).unwrap();
            sealed[j].push(json!({ "ct": b64u::encode(&s.ct), "enc": b64u::encode(&s.enc), "epoch": 0, "job_hash": b64u::encode(&o.job_hash), "kem": "x-wing-draft-06", "type": "notary.sealed_input.v1" }));
        }
    }
    let seal_s = t.elapsed().as_secs_f64();

    // the enclave: submit_input, round robin across jobs
    let (rss_pre_submit, _) = rss_mib();
    let fetches_before = b.io.fetches;
    card_check_s.set(0.0);
    let t = Instant::now();
    let mut rejected: HashMap<String, usize> = HashMap::new();
    for i in 0..n_inputs {
        for (j, o) in jobs.iter().enumerate() {
            b.broker.handle(&mut b.io, &json!({ "kind": "submit_input", "req_id": "s", "job_hash": b64u::encode(&o.job_hash), "sealed_input": sealed[j][i] }));
            let out = b.io.take();
            if find(&out, "input_result").is_none() {
                let code = find(&out, "error").and_then(|e| e["code"].as_str()).unwrap_or("none").to_string();
                *rejected.entry(code).or_default() += 1;
            }
        }
    }
    let submit_s = t.elapsed().as_secs_f64();
    let submit_card_s = card_check_s.get();
    card_check_s.set(0.0);
    let total = n_inputs * n_jobs;
    let per_input_fetches = (b.io.fetches - fetches_before) as f64 / total as f64;
    let (rss_held, _) = rss_mib();

    // close every job: re-open, re-check, run the tally (replication §5)
    let close_at = jobs.iter().map(|o| o.closes_ms).max().unwrap();
    b.push_header(close_at + 1000);
    b.enclave.set_clock_ms(Some((close_at + 1000) as u64));
    reset_peak();
    let mut close_times = vec![];
    let mut accepted = vec![];
    for (j, o) in jobs.iter().enumerate() {
        let t = Instant::now();
        let chunk = std::mem::take(&mut sealed[j]);
        b.broker.handle(&mut b.io, &json!({ "kind": "close_chunk", "req_id": "cl", "job_hash": b64u::encode(&o.job_hash), "seq": 0, "sealed_inputs": chunk, "last": true }));
        let out = b.io.take();
        close_times.push(t.elapsed().as_secs_f64());
        let n = find(&out, "job_closed").unwrap_or_else(|| panic!("no job_closed: {:?}", find(&out, "error")));
        accepted.push(n["notarization"]["accepted"].as_u64().unwrap_or(0));
    }
    let close_card_s = card_check_s.get();
    let (rss_end, rss_peak) = rss_mib();
    let close_total: f64 = close_times.iter().sum();
    let result = json!({
        "inputs_per_job": n_inputs, "jobs": n_jobs, "isolation": isolation, "total_inputs": total,
        "client_seal_s": seal_s,
        "submit": { "seconds": submit_s, "inputs_per_second": total as f64 / submit_s, "ms_per_input": submit_s * 1000.0 / total as f64, "rejected": rejected, "host_fetches_per_input": per_input_fetches, "card_checks_ms_per_input": submit_card_s * 1000.0 / total as f64 },
        "close": { "seconds_total": close_total, "seconds_per_job_max": close_times.iter().cloned().fold(0.0, f64::max), "ms_per_input": close_total * 1000.0 / total as f64, "card_checks_ms_per_input": close_card_s * 1000.0 / total as f64, "accepted": accepted },
        "memory_mib": {
            "snapshot": rss_post_snapshot - rss_pre_snapshot,
            "jobs_opened": rss_pre_submit - rss_base,
            "inputs_held_per_job": (rss_held - rss_pre_submit) / n_jobs as f64,
            "close_peak_over_held": rss_peak - rss_held,
            "process_rss_after_close": rss_end,
        },
    });
    println!("{}", serde_json::to_string(&result).unwrap());
}
