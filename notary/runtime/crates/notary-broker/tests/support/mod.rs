//! The in-process multi-broker harness (step 6.3, Q9; reused by 6.4 and 6.5).
//!
//! Several real `Broker`s, each with its own fake enclave (its own PCR0 and attested clock), joined by a controllable
//! message bus (`Net`) standing in for their hosts. The bus:
//! - routes `peer_send` to the broker that owns the instance, as `peer_message`;
//! - plays IPFS (`publish` / `fetch ipfs:`), EAS (`eas_anchor` → `anchor_receipt` to the writer, and to every other host
//!   with the record bytes, the way hosts watching the chain would), and each host's ciphertext store (`store_input`,
//!   `need_inputs`, with the host-side `H(sealed) == input_hash` check of Q8);
//! - can **drop, hold (delay / reorder), replay and rewrite** any peer message or anchor through `fault`;
//! - records what each host saw (`Node::saw`: kinds of enclave requests, peer bytes it relayed).
//!
//! Hosts are honest here unless a test installs a fault; the enclaves are the real code.
#![allow(dead_code)]
use notary_attest::{sim::SimulatorBackend, verify::Config};
use notary_broker::{
    chain::encode_test_header,
    env::{CardOracle, HostIo, InProcessWorkers, Platform, PolicyView, RecipientTarget, SourceCard},
    lists::{approval_digest, Keyset, ListVersion, Pins},
    Broker,
};
use notary_crypto::{sealed_input_info_aad, sha256, xwing_seal, ChainKey, MlDsaKey};
use notary_sim::{EnclaveConfig, FakeEnclave};
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};

pub const T0: i64 = 1_800_000_000_000; // 2027-01-15
pub const OPENS: i64 = T0 + 60_000;
pub const CLOSES: i64 = T0 + 3_600_000;

// ---------------------------------------------------------------------------------------------------------------
// Governance lists

pub struct Runtime {
    pub seed: u8,
    pub compat: &'static str,
    pub retired: Option<(&'static str, i64)>, // (reason, retired_at)
}

pub struct Gov {
    members: Vec<ChainKey>,
    pub keyset: Keyset,
}

impl Gov {
    pub fn new() -> Self {
        let members: Vec<ChainKey> = (0..5).map(|_| ChainKey::generate()).collect();
        let keyset = Keyset { keys: members.iter().map(|k| k.public_key_xy()).collect(), quorum: 4, version: 1, key_scheme: 0 };
        Self { members, keyset }
    }

    fn approve(&self, list: &str, card: &str, value: &Value, version: u64, prev: Option<&Value>, kind: &str, signers: usize) -> String {
        let mut a = json!({ "governance_version": 1, "kind": kind, "list": list, "list_card": card, "list_hash": jcs::h(value).unwrap(),
            "list_version": version, "signatures": [], "type": "notary_list_approval" });
        if let Some(p) = prev {
            a["prev_list_hash"] = json!(jcs::h(p).unwrap());
        }
        let d = approval_digest(&a).unwrap();
        a["signatures"] = json!((0..signers).map(|i| json!({ "key_index": i, "signature": b64u::encode(&self.members[i].sign_digest(&d).unwrap()) })).collect::<Vec<_>>());
        String::from_utf8(jcs::canonical(&a).unwrap()).unwrap()
    }

    pub fn runtimes_value(rts: &[Runtime]) -> Value {
        json!(rts
            .iter()
            .map(|r| {
                let mut e = json!({ "accepted_from": "2026-01-01T00:00:00Z", "build_recipe_cid": "bafkreirecipe", "close_compat": r.compat,
                    "pcr0": b64u::encode(&notary_sim::pcr0_of(r.seed)), "platform": "simulator", "source_commit": "abc", "version": format!("v{}", r.seed) });
                if let Some((reason, at)) = r.retired {
                    e["retire_reason"] = json!(reason);
                    e["retired_at"] = json!(formats::format_timestamp(at));
                }
                e
            })
            .collect::<Vec<_>>())
    }

    /// Version 1 of both lists (standard, 4 of 5).
    pub fn lists(&self, rts: &[Runtime], program_cid: &str) -> (Vec<ListVersion>, Vec<ListVersion>) {
        let rt = Self::runtimes_value(rts);
        let progs = json!([{ "accepted_from": "2026-01-01T00:00:00Z", "audit_report_cid": "bafkreiaudit", "name": "vote-yna", "program_cid": program_cid,
            "source_commit": "abc", "toolchain": "rust", "version": "1" }]);
        (
            vec![ListVersion { approval_text: Some(self.approve("accepted_runtimes", "runtimes", &rt, 1, None, "standard", 4)), value: rt }],
            vec![ListVersion { approval_text: Some(self.approve("program_allowlist", "programs", &progs, 1, None, "standard", 4)), value: progs }],
        )
    }

    /// An emergency retirement (two members, removal only) appended to the accepted-runtime history.
    pub fn emergency_retire(&self, history: &mut Vec<ListVersion>, new: &[Runtime]) {
        let prev = history.last().unwrap().value.clone();
        let next = Self::runtimes_value(new);
        let version = history.len() as u64 + 1;
        let text = self.approve("accepted_runtimes", "runtimes", &next, version, Some(&prev), "emergency_retirement", 2);
        history.push(ListVersion { approval_text: Some(text), value: next });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The card oracle (card-chain checks are notary-cards' job; here they are fixed answers, shared by every broker)

#[derive(Default)]
pub struct OracleState {
    pub policy: Value,
    pub approved: Vec<String>,
    pub revoked: BTreeSet<String>,
    pub runtimes: Vec<ListVersion>,
    pub programs: Vec<ListVersion>,
    pub template_cards: BTreeSet<(String, String)>,
    /// Derived-card jobs (step 6.4): the source cards the host's evidence would show, by card pointer.
    pub sources: BTreeMap<String, SourceCard>,
    /// The template policy's public key (a derived card's `ancestry_pubkeys` ends with it).
    pub policy_key: Vec<u8>,
    /// How many cards the source-policy snapshot lists (the second anonymity floor).
    pub snapshot_cards: Option<usize>,
    /// The policy a snapshot delivered each card under (step 6.5, the successor rule).
    pub card_policies: BTreeMap<String, String>,
    /// Public keys of certified, approved presses of the source policy (step 6.5, E4). Which keys count is
    /// `notary_cards::policy::entry_press_certified`'s job (its own tests); here the signature is checked for real.
    pub certified_presses: BTreeSet<Vec<u8>>,
}

/// A deterministic test press key.
pub fn test_press(n: u8) -> MlDsaKey {
    MlDsaKey::from_seed(notary_crypto::SecretBytes::from_vec(vec![n; 32])).expect("seed")
}

#[derive(Clone, Default)]
pub struct Oracle(pub Arc<Mutex<OracleState>>);

impl CardOracle for Oracle {
    fn policy(&mut self, _: &mut dyn HostIo, _: &str, _: &str, _: i64) -> Result<PolicyView, &'static str> {
        let s = self.0.lock().unwrap();
        Ok(PolicyView { notary: s.policy.clone(), approved_notaries: s.approved.clone() })
    }
    fn requester_allowed(&mut self, _: &mut dyn HostIo, _: &Value, _: &Value, _: i64) -> bool {
        true
    }
    fn contributor(&mut self, _: &mut dyn HostIo, input: &Value, _: &Value, _: &Value, _: i64) -> Result<[u8; 32], &'static str> {
        let card = input["contributor_card"].as_str().unwrap_or_default();
        if self.0.lock().unwrap().revoked.contains(card) {
            return Err("INPUT_CARD_REVOKED");
        }
        Ok(sha256(card.as_bytes()))
    }
    fn source_card(&mut self, _: &mut dyn HostIo, input: &Value, _: &Value, _: &Value, _: i64) -> Result<SourceCard, &'static str> {
        let card = input["contributor_card"].as_str().unwrap_or_default();
        let s = self.0.lock().unwrap();
        if s.revoked.contains(card) {
            return Err("INPUT_CARD_REVOKED");
        }
        // the master card is the one the input names (a rotated key's card has its own pointer)
        s.sources.get(card).cloned().map(|mut c| {
            c.address = card.to_string();
            c
        }).ok_or("INPUT_NOT_ELIGIBLE")
    }
    fn card_policy(&self, card: &str) -> Option<String> {
        self.0.lock().unwrap().card_policies.get(card).cloned()
    }
    fn source_entry_certified(&self, _: &str, entry: &Value) -> Result<(), &'static str> {
        let sig = &entry["press_signature"];
        let pk = sig["public_key"].as_str().and_then(|k| b64u::decode(k).ok()).ok_or("PRESS_SIGNATURE_INVALID")?;
        let s = sig["signature"].as_str().and_then(|k| b64u::decode(k).ok()).ok_or("PRESS_SIGNATURE_INVALID")?;
        let msg = jcs::canonical(&jcs::without_fields(entry, &["press_signature"])).map_err(|_| "PRESS_SIGNATURE_INVALID")?;
        if !notary_crypto::mldsa_verify(&pk, &msg, &s) {
            return Err("PRESS_SIGNATURE_INVALID");
        }
        if self.0.lock().unwrap().certified_presses.contains(&pk) { Ok(()) } else { Err("PRESS_NOT_CERTIFIED") }
    }
    fn policy_public_key(&self, _: &str) -> Option<Vec<u8>> {
        let k = self.0.lock().unwrap().policy_key.clone();
        (!k.is_empty()).then_some(k)
    }
    fn policy_card_count(&self, _: &str) -> Option<usize> {
        self.0.lock().unwrap().snapshot_cards
    }
    fn recipient_targets(&mut self, _: &mut dyn HostIo, _: &[u8]) -> Result<Vec<RecipientTarget>, &'static str> {
        Err("RECIPIENT_UNREADABLE")
    }
    fn list_history(&mut self, _: &mut dyn HostIo, card: &str) -> Option<Vec<ListVersion>> {
        let s = self.0.lock().unwrap();
        Some(if card == "runtimes" { s.runtimes.clone() } else { s.programs.clone() })
    }
    fn contributor_policy_state(&self, policy: &str) -> Option<(String, u64)> {
        (policy == "bafkreisource").then(|| ("bafkreisourcestate".to_string(), 7))
    }
    fn contributor_from_snapshot(&self, _: &str, _: &str, policies: &[String]) -> bool {
        policies == ["bafkreisource"]
    }
    fn serves_template(&mut self, _: &mut dyn HostIo, id_pubkey: &[u8], template: &str, _: i64) -> bool {
        let card = notary_types::formats::card_pointer(id_pubkey);
        self.0.lock().unwrap().template_cards.contains(&(card, template.to_string()))
    }
    fn on_snapshot(&mut self, _: &str, _: &Value) {}
    fn on_updates(&mut self, _: &str, _: &Value) {}
}

// ---------------------------------------------------------------------------------------------------------------
// Nodes and the bus

pub struct Node {
    pub name: String,
    pub broker: Broker,
    pub enclave: FakeEnclave,
    pub inst_pubkey: Vec<u8>,
    pub instance: String,
    /// The notary card this node's operator means it to serve (the directory hint; untrusted by the enclaves).
    pub card: String,
    pub up: bool,
    /// The host's stored ciphertexts: input_hash → SealedInput.
    pub store: BTreeMap<String, Value>,
    pub alerts: Vec<String>,
    pub announcements: Vec<Value>,
    pub need_replica: Vec<String>,
    /// Replies and unsolicited answers to host requests (input_result, job_closed, close_pending, errors…).
    pub replies: Vec<Value>,
    /// Kinds of every enclave request this host saw, in order.
    pub saw: Vec<String>,
    /// Every message this host's enclave sent it, in full (what an operator who logged everything would hold).
    pub seen: Vec<Value>,
    pub clock: i64,
    pub headers_fed: usize,
    /// The notary card's `K_chain` public key (x || y), from genesis: what the simulated registry verifies against.
    pub chain_pubkey: Vec<u8>,
}

#[derive(Debug, Clone)]
pub enum Item {
    /// A peer message relayed between hosts: (from node, to node, envelope bytes).
    Peer { from: usize, to: usize, bytes: Vec<u8> },
    /// A log record another host published, relayed to a host's enclave (`log_record`).
    Record { to: usize, scope: String, seq: u64, record: Vec<u8> },
    /// An anchor receipt delivered to a host's enclave.
    Anchor { to: usize, scope: String, seq: u64, record: Option<Vec<u8>> },
    /// The host's answer to a `chain_submit`.
    ChainResult { to: usize, req_id: String, failed: Option<String> },
}

pub enum Fate {
    Deliver,
    Drop,
    /// Kept in `Net::held` until the test releases it (delay, reorder).
    Hold,
    /// Delivered twice.
    Replay,
    Rewrite(Item),
}

struct Io<'a> {
    out: Vec<Value>,
    ipfs: &'a BTreeMap<String, Vec<u8>>,
    /// What the host reads from the chain for the enclave (step 6.4): the registry's protocol version and the press's
    /// next sequence. `None` simulates a host that doesn't answer.
    version: Option<&'a str>,
    next_sequence: Option<u64>,
}

impl HostIo for Io<'_> {
    fn send(&mut self, msg: Value) {
        self.out.push(msg);
    }
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
        if what == "protocol_version" {
            return self.version.map(|v| v.as_bytes().to_vec());
        }
        if what.starts_with("press_auth:") {
            return self.next_sequence.map(|n| format!("{{\"next_sequence\":{n}}}").into_bytes());
        }
        what.strip_prefix("ipfs:").and_then(|cid| self.ipfs.get(cid).cloned())
    }
}

/// The simulated registry's write gate for `RegisterCard` (registry_contract §4.1, §6.1 steps 4, 5 and 8), as far as the
/// notary's payload goes: the press signature over `keccak256(payload)`, the sequence, and that every signed field equals
/// the calldata. (The TypeScript end-to-end run has its own, `notary/e2e/src/sim-chain.ts`.)
#[derive(Default)]
pub struct Registry {
    pub next_sequence: u64,
    /// card address (b64u) → head CID, in registration order.
    pub cards: Vec<(String, String)>,
    /// Chain submissions to refuse once each, with this message (a host or registry failure).
    pub fail_next: Vec<String>,
    pub submissions: Vec<Value>,
    /// Withhold the version / sequence reads (a host that doesn't answer).
    pub silent: bool,
    /// Accepted `BatchUpdateCardHeads` payloads (step 6.5).
    pub batches: Vec<Value>,
}

pub struct Net {
    pub nodes: Vec<Node>,
    pub oracle: Oracle,
    pub gov: Gov,
    pub ipfs: BTreeMap<String, Vec<u8>>,
    /// (scope, seq) → record CID, in anchoring order (the public EAS view).
    pub anchors: Vec<(String, u64, String)>,
    pub headers: Vec<([u8; 32], u64, Vec<u8>, i64)>,
    pub queue: VecDeque<Item>,
    pub held: Vec<Item>,
    pub fault: Option<Box<dyn FnMut(&Net, &Item) -> Fate>>,
    pub now: i64,
    pub program: Vec<u8>,
    pub program_cid: String,
    pub policy_notary: Value,
    /// Peer messages addressed to an instance no node owns (a scripted impostor): (from node, to instance, bytes).
    pub outbox: Vec<(usize, String, Vec<u8>)>,
    pub registry: Registry,
    /// What each genesis produced, by notary card: the completed request, the attestation, the countersigned card offer.
    pub geneses: BTreeMap<String, Value>,
}

pub fn find<'a>(msgs: &'a [Value], kind: &str) -> Option<&'a Value> {
    msgs.iter().find(|m| m["kind"] == kind)
}

/// The vote-yna template module and its `notary` section, with test values filled in.
pub fn vote_template() -> (Vec<u8>, Value) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../templates");
    let module = std::fs::read(root.join("modules/vote-yna.wasm")).expect("run templates/build.sh vote-yna");
    let policy: Value = serde_json::from_str(&std::fs::read_to_string(root.join("vote-yna/policy.json")).unwrap()).unwrap();
    let mut n = policy["notary"].clone();
    n["contributor_predicate"] = json!({ "issued_under_template": "bafkreisource" });
    n["platform"] = json!("simulator");
    n["privacy"] = json!({ "k_min": 1 });
    n["program_cid"] = json!(formats::cid_of_bytes(&module));
    n.as_object_mut().unwrap().remove("job_requester_predicate");
    (module, n)
}

impl Net {
    pub fn new(runtimes: &[Runtime]) -> Self {
        let (program, notary) = vote_template();
        Self::new_with(runtimes, program, notary)
    }

    /// A network for another template: its module (allowlisted) and its `notary` section (what the oracle reads).
    pub fn new_with(runtimes: &[Runtime], program: Vec<u8>, notary: Value) -> Self {
        let program_cid = formats::cid_of_bytes(&program);
        let gov = Gov::new();
        let (rt, progs) = gov.lists(runtimes, &program_cid);
        let oracle = Oracle::default();
        {
            let mut s = oracle.0.lock().unwrap();
            s.policy = notary.clone();
            s.runtimes = rt;
            s.programs = progs;
        }
        let mut ipfs = BTreeMap::new();
        ipfs.insert(program_cid.clone(), program.clone());
        let mut net = Net { nodes: vec![], oracle, gov, ipfs, anchors: vec![], headers: vec![], queue: VecDeque::new(), held: vec![], fault: None, now: T0, program, program_cid, policy_notary: notary, outbox: vec![], registry: Registry { next_sequence: 0, ..Default::default() }, geneses: BTreeMap::new() };
        net.push_header(T0);
        net
    }

    pub fn pins(&self) -> Pins {
        Pins { accepted_runtimes_card: "runtimes".into(), program_allowlist_card: "programs".into(), keyset: self.gov.keyset.clone(), accepted_runtimes_floor: 1, program_allowlist_floor: 1 }
    }

    /// A new enclave with its own fake enclave service (PCR0 from `seed`, clock at `self.now`) and broker.
    pub fn add_node(&mut self, name: &str, seed: u8) -> usize {
        let enclave = FakeEnclave::start_tcp("127.0.0.1:0", EnclaveConfig { pcr0_seed: seed, debug: false, clock_ms: Some(self.now as u64) }).unwrap();
        let addr = enclave.addr.clone();
        let clock = SimulatorBackend::new(addr.clone());
        let platform = Platform {
            attest: Box::new(SimulatorBackend::new(addr)),
            attested_time_ms: Box::new(move || clock.attested_time_ms().map_err(|e| e.to_string())),
            pcr0: notary_sim::pcr0_of(seed),
            peer_roots: Config { roots: [("simulator".to_string(), notary_sim::test_root_der())].into(), allow_simulator: true },
        };
        let broker = Broker::new(self.pins(), Box::new(self.oracle.clone()), Box::new(InProcessWorkers::default()), platform);
        let instance = broker.instance_id();
        let node = Node {
            name: name.into(), broker, enclave, inst_pubkey: vec![], instance, card: String::new(), up: true, store: BTreeMap::new(), alerts: vec![],
            announcements: vec![], need_replica: vec![], replies: vec![], saw: vec![], seen: vec![], clock: self.now, headers_fed: 0, chain_pubkey: vec![],
        };
        self.nodes.push(node);
        let i = self.nodes.len() - 1;
        let ack = self.call(i, json!({ "kind": "hello", "req_id": "hello", "challenge": b64u::encode(&[1u8; 32]) }));
        self.nodes[i].inst_pubkey = b64u::decode(find(&ack, "hello_ack").unwrap()["inst_pubkey"].as_str().unwrap()).unwrap();
        self.feed_headers(i);
        i
    }

    /// Genesis on node `i` (lifecycle Phase 0): a fresh notary card, identity-log `seq` 0 anchored, approved.
    pub fn genesis(&mut self, i: usize) -> String {
        let req = json!({ "chain_pubkey": "HOST", "id_pubkey": "HOST", "nonce": b64u::encode(&[i as u8; 16]), "operator_card": format!("{:064x}", i + 1),
            "operator_host_pubkey": b64u::encode(MlDsaKey::generate().public_key()), "platform": "simulator", "policy_id": "bafkreipolicy",
            "requested_at": "2027-01-15T00:00:00.000Z", "type": "notary.genesis_request.v1" });
        let out = self.call(i, json!({ "kind": "genesis", "req_id": "g", "request": req }));
        let ready = find(&out, "genesis_ready").expect("genesis_ready").clone();
        let card = ready["notary_card"].as_str().unwrap().to_string();
        self.nodes[i].chain_pubkey = b64u::decode(ready["chain_pubkey"].as_str().unwrap()).unwrap();
        let att_cid = formats::cid_of_bytes(&b64u::decode(ready["attestation"].as_str().unwrap()).unwrap());
        let offer = json!({ "chain_pubkey": ready["chain_pubkey"], "genesis_attestation": att_cid, "issuer_card": "c".repeat(64), "operator_card": format!("{:064x}", i + 1),
            "platform": "simulator", "policy_id": "bafkreinotarycardpolicy", "recipient_pubkey": ready["id_pubkey"], "issuer_signature": "sig" });
        let signed = self.call(i, json!({ "kind": "countersign_notary_card", "req_id": "c", "offer": offer }));
        self.geneses.insert(card.clone(), json!({ "request": ready["request"], "attestation": ready["attestation"], "offer": find(&signed, "countersigned").map(|c| c["offer"].clone()), "id_pubkey": ready["id_pubkey"], "chain_pubkey": ready["chain_pubkey"] }));
        self.run();
        self.oracle.0.lock().unwrap().approved.push(card.clone());
        self.nodes[i].card = card.clone();
        card
    }

    /// The write gate for a `RegisterCard` the notary asked its host to submit.
    fn registry_accepts(&mut self, i: usize, m: &Value) -> Result<(), String> {
        let (payload, calldata) = (&m["payload"], &m["calldata"]);
        let bytes = jcs::canonical(payload).map_err(|e| e.message)?;
        let sig = b64u::decode(m["signature"].as_str().unwrap_or_default()).map_err(|_| "bad signature encoding".to_string())?;
        // step 4: the press's key verifies the signature over keccak256(payload)
        if !notary_crypto::p256_verify_digest(&self.nodes[i].chain_pubkey, &notary_crypto::keccak256(&bytes), &sig) {
            return Err("PRESS_SIGNATURE_INVALID".into());
        }
        if payload["op"] == "batch_update_card_heads" && m["op"] == "batch_update_card_heads" {
            return self.registry_batch(payload, calldata);
        }
        if payload["op"] != "register_card" || m["op"] != "register_card" {
            return Err("OP_MISMATCH".into());
        }
        // step 5: the sequence
        if payload["sequence"].as_u64() != Some(self.registry.next_sequence) {
            return Err("SEQUENCE_MISMATCH".into());
        }
        // step 8: every signed field equals the calldata (E-49)
        for f in ["card_address", "initial_log_cid", "policy_address", "press_address"] {
            if payload[f] != calldata[f] {
                return Err("PAYLOAD_CALLDATA_MISMATCH".into());
            }
        }
        let addr = payload["card_address"].as_str().unwrap_or_default().to_string();
        if self.registry.cards.iter().any(|(a, _)| *a == addr) {
            return Err("CARD_EXISTS".into());
        }
        let cid = String::from_utf8(b64u::decode(payload["initial_log_cid"].as_str().unwrap_or_default()).unwrap_or_default()).unwrap_or_default();
        self.registry.next_sequence += 1;
        self.registry.cards.push((addr, cid));
        Ok(())
    }

    /// `BatchUpdateCardHeads` (registry_contract §4.15, §6.1): the sequence, every signed field equal to the calldata
    /// (the `updates` list in order), each card registered and its `prev_log_cid` its current head; then every head moves.
    fn registry_batch(&mut self, payload: &Value, calldata: &Value) -> Result<(), String> {
        if payload["sequence"].as_u64() != Some(self.registry.next_sequence) {
            return Err("SEQUENCE_MISMATCH".into());
        }
        for f in ["policy_address", "press_address", "updates"] {
            if payload[f] != calldata[f] {
                return Err("PAYLOAD_CALLDATA_MISMATCH".into());
            }
        }
        let ups = payload["updates"].as_array().ok_or("BATCH_SIZE_INVALID")?;
        if ups.is_empty() || ups.len() > 100 {
            return Err("BATCH_SIZE_INVALID".into());
        }
        let text = |v: &Value| String::from_utf8(b64u::decode(v.as_str().unwrap_or_default()).unwrap_or_default()).unwrap_or_default();
        for u in ups {
            let addr = u["card_address"].as_str().unwrap_or_default();
            let head = self.registry.cards.iter().find(|(a, _)| a == addr).map(|(_, c)| c.clone()).ok_or("CARD_NOT_FOUND")?;
            if head != text(&u["prev_log_cid"]) {
                return Err("STALE_PREV_CID".into());
            }
        }
        for u in ups {
            let addr = u["card_address"].as_str().unwrap_or_default();
            let slot = self.registry.cards.iter_mut().find(|(a, _)| a == addr).expect("checked");
            slot.1 = text(&u["new_log_cid"]);
        }
        self.registry.next_sequence += 1;
        self.registry.batches.push(payload.clone());
        Ok(())
    }

    pub fn instance(&self, i: usize) -> String {
        self.nodes[i].instance.clone()
    }

    pub fn node_of(&self, instance: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.instance == instance)
    }

    /// Sends `msg` to node `i`'s enclave and routes everything it asks for. Returns the replies to the host.
    pub fn call(&mut self, i: usize, msg: Value) -> Vec<Value> {
        if !self.nodes[i].up {
            return vec![];
        }
        let silent = self.registry.silent;
        let mut io = Io { out: vec![], ipfs: &self.ipfs, version: (!silent).then_some("0.1"), next_sequence: (!silent).then_some(self.registry.next_sequence) };
        self.nodes[i].broker.handle(&mut io, &msg);
        let out = io.out;
        let mut replies = vec![];
        for m in out {
            if let Some(r) = self.route(i, m) {
                replies.push(r);
            }
        }
        self.nodes[i].replies.extend(replies.iter().cloned());
        replies
    }

    /// Handles one enclave request on node `i`'s host. Returns it if it is a reply to the host.
    fn route(&mut self, i: usize, m: Value) -> Option<Value> {
        let kind = m["kind"].as_str().unwrap_or_default().to_string();
        self.nodes[i].saw.push(kind.clone());
        self.nodes[i].seen.push(m.clone());
        match kind.as_str() {
            "publish" => {
                let b = b64u::decode(m["object"].as_str().unwrap()).unwrap();
                // hosts relay every job-log and identity-log record their enclave publishes to the other hosts
                if let Ok(v) = jcs::parse_canonical(&b) {
                    if v["type"].as_str().is_some_and(|t| t == "notary.job_log.v1" || t == "notary.identity_log.v1") {
                        let (scope, seq) = (v["job_hash"].as_str().unwrap_or_default().to_string(), v["seq"].as_u64().unwrap_or(0));
                        for j in 0..self.nodes.len() {
                            if j != i {
                                self.queue.push_back(Item::Record { to: j, scope: scope.clone(), seq, record: b.clone() });
                            }
                        }
                    }
                }
                self.ipfs.insert(formats::cid_of_bytes(&b), b);
                None
            }
            "eas_anchor" => {
                let (scope, seq, cid) = (m["scope_id"].as_str().unwrap().to_string(), m["seq"].as_u64().unwrap(), m["record_cid"].as_str().unwrap().to_string());
                self.anchors.push((scope.clone(), seq, cid.clone()));
                let record = self.ipfs.get(&cid).cloned();
                self.queue.push_back(Item::Anchor { to: i, scope: scope.clone(), seq, record: None });
                for j in 0..self.nodes.len() {
                    if j != i {
                        self.queue.push_back(Item::Anchor { to: j, scope: scope.clone(), seq, record: record.clone() });
                    }
                }
                None
            }
            "peer_send" => {
                let bytes = b64u::decode(m["bytes"].as_str().unwrap()).unwrap();
                match self.node_of(m["to_instance"].as_str().unwrap()) {
                    Some(to) => self.queue.push_back(Item::Peer { from: i, to, bytes }),
                    None => self.outbox.push((i, m["to_instance"].as_str().unwrap().into(), bytes)),
                }
                None
            }
            "store_input" => {
                let sealed = m["sealed_input"].clone();
                // the host checks H(sealed) == input_hash itself
                if jcs::h(&sealed).ok().as_deref() == m["input_hash"].as_str() {
                    self.nodes[i].store.insert(m["input_hash"].as_str().unwrap().into(), sealed);
                }
                None
            }
            "need_inputs" => {
                // Q8: fetch each missing ciphertext from peer hosts, check H(sealed) == input_hash, store
                for h in m["hashes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    if self.nodes[i].store.contains_key(h) {
                        continue;
                    }
                    let found = self.nodes.iter().enumerate().filter(|(j, n)| *j != i && n.up).find_map(|(_, n)| n.store.get(h).cloned());
                    if let Some(s) = found.filter(|s| jcs::h(s).ok().as_deref() == Some(h)) {
                        self.nodes[i].store.insert(h.into(), s);
                    }
                }
                None
            }
            "announce" => {
                self.nodes[i].announcements.push(m["announcement"].clone());
                None
            }
            "chain_submit" => {
                let req_id = m["req_id"].as_str().unwrap_or_default().to_string();
                self.registry.submissions.push(m.clone());
                let failed = if self.registry.fail_next.is_empty() { self.registry_accepts(i, &m).err() } else { Some(self.registry.fail_next.remove(0)) };
                self.queue.push_back(Item::ChainResult { to: i, req_id, failed });
                None
            }
            "alert" => {
                self.nodes[i].alerts.push(m["code"].as_str().unwrap_or_default().into());
                None
            }
            "need_replica" => {
                self.nodes[i].need_replica.push(m["job_hash"].as_str().unwrap_or_default().into());
                None
            }
            _ => Some(m),
        }
    }

    /// Delivers queued items until the bus is quiet (or `limit` deliveries).
    pub fn run(&mut self) {
        let mut n = 0;
        while let Some(item) = self.queue.pop_front() {
            n += 1;
            assert!(n < 100_000, "bus did not settle");
            let fate = match self.fault.take() {
                Some(mut f) => {
                    let r = f(self, &item);
                    self.fault = Some(f);
                    r
                }
                None => Fate::Deliver,
            };
            match fate {
                Fate::Deliver => self.deliver(item),
                Fate::Drop => {}
                Fate::Hold => self.held.push(item),
                Fate::Replay => {
                    self.deliver(item.clone());
                    self.deliver(item);
                }
                Fate::Rewrite(x) => self.deliver(x),
            }
        }
    }

    fn deliver(&mut self, item: Item) {
        match item {
            Item::Peer { from, to, bytes } => {
                if !self.nodes[from].up || !self.nodes[to].up {
                    return;
                }
                let from_instance = self.nodes[from].instance.clone();
                self.call(to, json!({ "kind": "peer_message", "req_id": "p", "from_instance": from_instance, "bytes": b64u::encode(&bytes) }));
            }
            Item::Record { to, scope, seq, record } => {
                self.call(to, json!({ "kind": "log_record", "req_id": "r", "scope_id": scope, "seq": seq, "record": b64u::encode(&record) }));
            }
            Item::ChainResult { to, req_id, failed } => {
                let mut msg = json!({ "kind": "chain_result", "req_id": req_id });
                match failed {
                    Some(f) => msg["failed"] = json!(f),
                    None => msg["tx_receipt"] = json!("0xtx"),
                }
                self.call(to, msg);
            }
            Item::Anchor { to, scope, seq, record } => {
                let mut msg = json!({ "kind": "anchor_receipt", "req_id": "a", "scope_id": scope, "seq": seq, "tx_receipt": "0x1" });
                if let Some(r) = record {
                    msg["record"] = json!(b64u::encode(&r));
                }
                self.call(to, msg);
            }
        }
    }

    /// Releases held items into the queue (in the order given) and runs the bus.
    pub fn release(&mut self, order: impl Fn(&mut Vec<Item>)) {
        let mut held = std::mem::take(&mut self.held);
        order(&mut held);
        self.queue.extend(held);
        self.run();
    }

    /// The opened envelope of a relayed peer message: (kind, from instance). Test-side inspection only (hosts don't).
    pub fn peer_kind(bytes: &[u8]) -> (String, String) {
        let v = jcs::parse_canonical(bytes).unwrap();
        (v["kind"].as_str().unwrap().into(), v["from"].as_str().unwrap().into())
    }

    // ---- chain and clocks ----------------------------------------------------------------------------------

    pub fn push_header(&mut self, ts_ms: i64) -> ([u8; 32], u64) {
        let parent = self.headers.last().map(|h| h.0).unwrap_or([0u8; 32]);
        let number = self.headers.len() as u64 + 100;
        let rlp = encode_test_header(parent, number, (ts_ms / 1000) as u64);
        let h = notary_crypto::keccak256(&rlp);
        self.headers.push((h, number, rlp, ts_ms));
        for i in 0..self.nodes.len() {
            self.feed_headers(i);
        }
        (h, number)
    }

    /// Feeds node `i` the headers it hasn't seen. A node's first batch goes newest first: it anchors near its own clock
    /// and ignores the older ones (runtime §9); the headers a job's inputs need come with the job's handoff (R3).
    pub fn feed_headers(&mut self, i: usize) {
        let from = self.nodes[i].headers_fed;
        if from >= self.headers.len() || !self.nodes[i].up {
            return;
        }
        let mut hs: Vec<Value> = self.headers[from..].iter().map(|(_, n, rlp, _)| json!({ "number": n, "header_rlp": b64u::encode(rlp) })).collect();
        if from == 0 {
            hs.reverse();
        }
        self.nodes[i].headers_fed = self.headers.len();
        self.call(i, json!({ "kind": "chain_headers", "req_id": "h", "headers": hs }));
    }

    /// Advances every clock by `ms` (in `step` increments), with a header at each step and a `tick` to every enclave.
    pub fn advance(&mut self, ms: i64, step: i64) {
        let mut done = 0;
        while done < ms {
            let d = step.min(ms - done);
            done += d;
            self.now += d;
            for n in &mut self.nodes {
                n.clock += d;
                n.enclave.set_clock_ms(Some(n.clock as u64));
            }
            self.push_header(self.now);
            for i in 0..self.nodes.len() {
                self.call(i, json!({ "kind": "tick", "req_id": "t" }));
            }
            self.run();
        }
    }

    pub fn tick_all(&mut self) {
        for i in 0..self.nodes.len() {
            self.call(i, json!({ "kind": "tick", "req_id": "t" }));
        }
        self.run();
    }

    /// The host's directory hint: every other running node (with the card its operator means it to serve).
    pub fn directory(&mut self) {
        let entries: Vec<Value> = self
            .nodes
            .iter()
            .filter(|n| n.up)
            .map(|n| json!({ "attestation": "", "host_url": format!("https://{}", n.name), "inst_pubkey": b64u::encode(&n.inst_pubkey), "instance": n.instance, "notary_card": n.card }))
            .collect();
        for i in 0..self.nodes.len() {
            self.call(i, json!({ "kind": "peer_directory", "req_id": "d", "peers": entries }));
        }
        self.run();
    }

    /// The directory plus extra (instance, inst_pubkey, claimed card) entries, e.g. a scripted impostor.
    pub fn directory_with(&mut self, extra: &[(&str, &[u8], &str)]) {
        let mut entries: Vec<Value> = self
            .nodes
            .iter()
            .filter(|n| n.up)
            .map(|n| json!({ "attestation": "", "host_url": format!("https://{}", n.name), "inst_pubkey": b64u::encode(&n.inst_pubkey), "instance": n.instance, "notary_card": n.card }))
            .collect();
        for (i, pk, card) in extra {
            entries.push(json!({ "attestation": "", "host_url": "https://impostor", "inst_pubkey": b64u::encode(pk), "instance": i, "notary_card": card }));
        }
        for i in 0..self.nodes.len() {
            self.call(i, json!({ "kind": "peer_directory", "req_id": "d", "peers": entries }));
        }
        self.run();
    }

    /// Kills node `i`: its host and enclave stop answering; messages to or from it are lost.
    pub fn kill(&mut self, i: usize) {
        self.nodes[i].up = false;
    }

    // ---- jobs and ballots ----------------------------------------------------------------------------------

    pub fn job(&self, requester: &MlDsaKey, nonce: u8, replica_set: &[(&str, u32)], min_live: u32) -> Value {
        let rs: Vec<Value> = replica_set.iter().map(|(c, n)| json!({ "instances": n, "notary_card": c })).collect();
        let mut job = json!({ "closes_at": formats::format_timestamp(CLOSES), "created_at": formats::format_timestamp(T0), "kem": "x-wing-draft-06",
            "min_live": min_live, "nonce": b64u::encode(&[nonce; 16]), "opens_at": formats::format_timestamp(OPENS), "parameters": { "question": "Adopt?" },
            "policy_id": "bafkreipolicy", "policy_state_cid": "bafkreistate", "replica_set": rs,
            "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1" });
        job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
        job
    }

    pub fn create_job(&mut self, i: usize, job: &Value) -> Vec<Value> {
        let msg = json!({ "kind": "create_job", "req_id": "cj", "job": job, "program": b64u::encode(&self.program), "transport": { "key_config_url": "https://h", "relay_target_id": "t" } });
        let out = self.call(i, msg);
        self.run();
        out
    }

    /// The newest announcement any host serves for a job, at the highest epoch.
    pub fn announcement(&self, job_hash: &str) -> Option<Value> {
        self.nodes.iter().flat_map(|n| n.announcements.iter()).filter(|a| a["job"].is_object() && jcs::h(&a["job"]).ok().as_deref() == Some(job_hash)).max_by_key(|a| a["epoch"].as_u64()).cloned()
    }

    /// A ballot sealed to an announcement's key (the wallet's side, §24).
    pub fn ballot(&self, ann: &Value, voter: u8, choice: &str, revision: u64) -> Ballot {
        self.ballot_at(ann, voter, choice, revision, self.headers.len() - 1)
    }

    /// Any plaintext (an input or a countersign) sealed to an announcement's key, the way a wallet seals it.
    pub fn seal_plain(&self, ann: &Value, plaintext: &Value) -> Ballot {
        let job_hash: [u8; 32] = jcs::h_bytes(&ann["job"]).unwrap();
        let epoch = ann["epoch"].as_u64().unwrap();
        let pk = b64u::decode(ann["job_public_key"].as_str().unwrap()).unwrap();
        let (info, aad) = sealed_input_info_aad(&job_hash, epoch);
        let s = xwing_seal(&pk, &info, &aad, &jcs::canonical(plaintext).unwrap()).unwrap();
        let sealed = json!({ "ct": b64u::encode(&s.ct), "enc": b64u::encode(&s.enc), "epoch": epoch, "job_hash": b64u::encode(&job_hash), "kem": "x-wing-draft-06", "type": "notary.sealed_input.v1" });
        Ballot { input_hash: jcs::h(&sealed).unwrap(), sealed, receipt_key: s.receipt_key, input: plaintext.clone() }
    }

    /// The header at index `at` of the bus's chain as a `chain_ref`.
    pub fn chain_ref(&self, at: usize) -> Value {
        json!({ "block_hash": b64u::encode(&self.headers[at].0), "block_number": self.headers[at].1 })
    }

    pub fn newest_header(&self) -> usize {
        self.headers.len() - 1
    }

    /// A ballot whose `chain_ref` is the header at index `at` of the bus's chain.
    pub fn ballot_at(&self, ann: &Value, voter: u8, choice: &str, revision: u64, at: usize) -> Ballot {
        let job_hash: [u8; 32] = jcs::h_bytes(&ann["job"]).unwrap();
        let epoch = ann["epoch"].as_u64().unwrap();
        let pk = b64u::decode(ann["job_public_key"].as_str().unwrap()).unwrap();
        let (bh, bn) = (self.headers[at].0, self.headers[at].1);
        let input = json!({ "chain_ref": { "block_hash": b64u::encode(&bh), "block_number": bn }, "contributor_card": format!("{voter:02x}").repeat(32),
            "contributor_card_pubkey": "AA", "contributor_signature": { "public_key": "AA", "signature": "AA" }, "evidence": [],
            "job_hash": b64u::encode(&job_hash), "payload": { "choice": choice }, "revision": revision, "signed_at": "2027-01-15T00:10:00.000Z", "type": "notary.input.v1" });
        let (info, aad) = sealed_input_info_aad(&job_hash, epoch);
        let s = xwing_seal(&pk, &info, &aad, &jcs::canonical(&input).unwrap()).unwrap();
        let sealed = json!({ "ct": b64u::encode(&s.ct), "enc": b64u::encode(&s.enc), "epoch": epoch, "job_hash": b64u::encode(&job_hash), "kem": "x-wing-draft-06", "type": "notary.sealed_input.v1" });
        Ballot { input_hash: jcs::h(&sealed).unwrap(), sealed, receipt_key: s.receipt_key, input }
    }

    /// Submits through node `i`'s host (stored first, as the host does), runs the bus, and returns the opened receipt
    /// or the error code.
    pub fn submit(&mut self, i: usize, b: &Ballot) -> Result<Value, String> {
        self.nodes[i].store.insert(b.input_hash.clone(), b.sealed.clone());
        let req = format!("s-{}", &b.input_hash[..8]);
        let first = self.call(i, json!({ "kind": "submit_input", "req_id": req, "job_hash": b.sealed["job_hash"], "sealed_input": b.sealed }));
        self.run();
        let all: Vec<Value> = first.into_iter().chain(self.nodes[i].replies.iter().cloned()).filter(|r| r["req_id"] == req.as_str()).collect();
        if let Some(e) = find(&all, "error") {
            return Err(e["code"].as_str().unwrap_or_default().into());
        }
        let r = find(&all, "input_result").ok_or_else(|| "NO_RECEIPT_YET".to_string())?;
        let opened = notary_crypto::open_receipt(&b.receipt_key, &b.input_hash, b.sealed["job_hash"].as_str().unwrap(), &b64u::decode(r["receipt_sealed"].as_str().unwrap()).unwrap()).expect("the wallet opens its receipt");
        Ok(serde_json::from_slice(&opened).unwrap())
    }

    /// Every live replica's host streams its stored ciphertexts (step 15); returns each node's close answer.
    pub fn close(&mut self, job_hash: &str, nodes: &[usize]) -> Vec<(usize, Vec<Value>)> {
        let mut out = vec![];
        for &i in nodes {
            let inputs: Vec<Value> = self.nodes[i].store.values().filter(|s| s["job_hash"] == job_hash).cloned().collect();
            let r = self.call(i, json!({ "kind": "close_chunk", "req_id": format!("close-{i}"), "job_hash": job_hash, "seq": 0, "sealed_inputs": inputs, "last": true }));
            out.push((i, r));
        }
        self.run();
        out
    }

    /// The notarization a host received (`job_closed`), if any.
    pub fn notarization(&self) -> Option<Value> {
        self.nodes.iter().flat_map(|n| n.replies.iter()).find(|r| r["kind"] == "job_closed").map(|r| r["notarization"].clone())
    }

    /// A log, in `seq` order, read from IPFS (the public view), following `prev` back from the newest published record.
    pub fn job_log(&self, scope: &str) -> Vec<Value> {
        let newest = self
            .ipfs
            .iter()
            .filter_map(|(cid, b)| jcs::parse_canonical(b).ok().map(|v| (cid, v)))
            .filter(|(_, v)| v["job_hash"] == scope && v["type"].as_str().is_some_and(|t| t.ends_with("_log.v1")))
            .max_by_key(|(_, v)| v["seq"].as_u64())
            .map(|(c, _)| c.clone());
        let mut out = vec![];
        let mut cur = newest;
        while let Some(cid) = cur {
            let rec = jcs::parse_canonical(&self.ipfs[&cid]).unwrap();
            cur = rec.get("prev").and_then(Value::as_str).map(String::from);
            out.push(rec);
        }
        out.reverse();
        out
    }

    pub fn alerts(&self, i: usize) -> &[String] {
        &self.nodes[i].alerts
    }
}

pub struct Ballot {
    pub sealed: Value,
    pub input_hash: String,
    pub receipt_key: notary_crypto::SecretBytes,
    pub input: Value,
}

// ---------------------------------------------------------------------------------------------------------------
// A scripted peer: valid simulator attestations over whatever it chooses to bind (a hostile or broken enclave)

pub struct Impostor {
    pub inst: MlDsaKey,
    pub id: MlDsaKey,
    pub enclave: FakeEnclave,
    pub instance: String,
}

impl Impostor {
    pub fn new(seed: u8, clock: i64) -> Self {
        let inst = MlDsaKey::generate();
        let enclave = FakeEnclave::start_tcp("127.0.0.1:0", EnclaveConfig { pcr0_seed: seed, debug: false, clock_ms: Some(clock as u64) }).unwrap();
        let instance = b64u::encode(&sha256(inst.public_key()));
        Self { inst, id: MlDsaKey::generate(), enclave, instance }
    }
    pub fn card(&self) -> String {
        formats::card_pointer(self.id.public_key())
    }
    pub fn attest(&self, ud: notary_types::user_data::UserData, pk: Option<[u8; 32]>, nonce: [u8; 32]) -> Vec<u8> {
        use notary_attest::AttestationBackend;
        SimulatorBackend::new(self.enclave.addr.clone()).attest(ud.encode(), pk, nonce).unwrap()
    }
    /// An envelope from this impostor to `to`.
    pub fn envelope(&self, to: &str, kind: &str, body: Value) -> Vec<u8> {
        notary_broker::peer::seal_envelope(&self.inst, to, kind, body)
    }
}
