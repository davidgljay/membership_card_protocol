//! Step 6.3, replication (notary_replication_and_recovery.md), on the multi-broker harness (`support`): real brokers,
//! real attestations from per-node fake enclaves, a bus standing in for hosts that can drop, hold, replay and rewrite.
mod support;
use notary_crypto::{mldsa_verify, MlDsaKey};
use notary_types::{b64u, jcs};
use serde_json::{json, Value};
use support::*;

const X: u8 = 0x42; // the runtime most tests use

fn rt(seed: u8, compat: &'static str) -> Runtime {
    Runtime { seed, compat, retired: None }
}

/// Three operators, one replica each.
fn three_operators() -> (Net, [usize; 3], [String; 3]) {
    let mut net = Net::new(&[rt(X, "c1")]);
    let n = [net.add_node("a", X), net.add_node("b", X), net.add_node("c", X)];
    let cards = [net.genesis(n[0]), net.genesis(n[1]), net.genesis(n[2])];
    net.directory();
    (net, n, cards)
}

fn kinds(log: &[Value]) -> Vec<String> {
    log.iter().map(|r| r["kind"].as_str().unwrap().to_string()).collect()
}

/// Opens a 3-replica vote and returns (job hash, announcement).
fn open_vote(net: &mut Net, origin: usize, cards: &[String; 3], min_live: u32) -> (String, Value) {
    let job = net.job(&MlDsaKey::generate(), 1, &[(&cards[0], 1), (&cards[1], 1), (&cards[2], 1)], min_live);
    let job_hash = jcs::h(&job).unwrap();
    let out = net.create_job(origin, &job);
    assert!(find(&out, "job_keyed").is_some(), "{out:?}");
    net.advance(120_000, 60_000);
    if net.announcement(&job_hash).is_none() {
        for (i, n) in net.nodes.iter().enumerate() {
            eprintln!("node {i} alerts {:?} saw {:?}", n.alerts, n.saw.iter().filter(|k| *k != "publish").collect::<Vec<_>>());
        }
        eprintln!("anchors {:?}", net.anchors);
    }
    let ann = net.announcement(&job_hash).expect("announced");
    (job_hash, ann)
}

#[test]
fn a_vote_forms_by_handoff_acknowledges_by_quorum_and_closes_cosigned() {
    let (mut net, [a, b, c], cards) = three_operators();
    let (job_hash, ann) = open_vote(&mut net, a, &cards, 2);
    // replication §2: `opened` lists the holders' purpose-0x02 attestations, then one `handoff` record per receiver
    let log = net.job_log(&job_hash);
    assert_eq!(kinds(&log)[..3], ["opened", "handoff", "handoff"]);
    assert!(log[0]["body"]["attestations"].as_array().unwrap().len() >= 2, "opened once q hold the key");
    assert_eq!(ann["attestations"].as_array().unwrap().len(), 3, "one attestation per live replica");
    // §4: a ballot through any replica is acknowledged by a quorum
    let mut ballots = vec![];
    for (k, (node, choice)) in [(a, "yes"), (b, "no"), (c, "yes"), (b, "yes")].into_iter().enumerate() {
        let bal = net.ballot(&ann, k as u8 + 1, choice, 0);
        let r = net.submit(node, &bal).unwrap_or_else(|e| panic!("ballot {k}: {e}"));
        assert_eq!(r["status"], "accepted");
        assert!(r["acks"].as_u64().unwrap() >= 2, "acks >= q");
        ballots.push(bal);
    }
    // every host stored every ciphertext (store_input from the peers)
    for i in [a, b, c] {
        assert_eq!(net.nodes[i].store.len(), 4, "host {i} stores every acknowledged input");
    }
    net.advance(CLOSES - net.now + 10_000, 60_000);
    net.close(&job_hash, &[a, b, c]);
    let n = net.notarization().expect("closed");
    assert_eq!(n["output"]["public"], json!({ "abstain": 0, "no": 1, "yes": 3 }));
    assert_eq!((n["close_quorum"].as_u64(), n["accepted"].as_u64()), (Some(2), Some(4)));
    // q cosignatures from distinct instances, each over the raw bytes of H(body)
    let body = jcs::without_fields(&n, &["cosignatures", "notary_signature"]);
    let digest = jcs::h_bytes(&body).unwrap();
    let cos = n["cosignatures"].as_array().unwrap();
    assert!(cos.len() >= 2);
    let mut seen = std::collections::BTreeSet::new();
    for c in cos {
        let pk = b64u::decode(c["instance_signature"]["public_key"].as_str().unwrap()).unwrap();
        assert!(mldsa_verify(&pk, &digest, &b64u::decode(c["instance_signature"]["signature"].as_str().unwrap()).unwrap()));
        assert!(seen.insert(pk));
    }
    let _ = ballots;
}

/// An identity-scope handoff of `card` from node `from` to node `to`, started by the operator's host.
fn identity_handoff(net: &mut Net, from: usize, to: usize, card: &str) {
    let to_inst = net.instance(to);
    let out = net.call(from, json!({ "kind": "start_handoff", "req_id": "sh", "scope": "identity", "card": card, "to_instance": to_inst }));
    assert!(find(&out, "handoff_started").is_some(), "{out:?}");
    net.run();
    net.nodes[to].card = card.to_string();
}

#[test]
fn killing_one_replica_mid_vote_loses_no_ballots() {
    let (mut net, [a, b, c], cards) = three_operators();
    let (job_hash, ann) = open_vote(&mut net, a, &cards, 2);
    // one ballot reaches the host that is about to die, and is acknowledged by a quorum before it does
    let early = net.ballot(&ann, 1, "no", 0);
    assert!(net.submit(c, &early).unwrap()["acks"].as_u64().unwrap() >= 2);
    net.kill(c);
    let mut n_yes = 0;
    for v in 2..6u8 {
        let node = if v % 2 == 0 { a } else { b };
        let r = net.submit(node, &net.ballot(&ann, v, "yes", 0)).unwrap();
        assert_eq!((r["status"].as_str(), r["acks"].as_u64()), (Some("accepted"), Some(2)), "two live replicas still make a quorum");
        n_yes += 1;
    }
    // voter 1 changes their mind after the replica died
    assert_eq!(net.submit(a, &net.ballot(&ann, 1, "yes", 1)).unwrap()["status"], "accepted");
    net.advance(CLOSES - net.now + 10_000, 60_000);
    net.close(&job_hash, &[a, b]);
    let n = net.notarization().expect("the two live replicas close");
    assert_eq!(n["output"]["public"], json!({ "abstain": 0, "no": 0, "yes": n_yes + 1 }), "no ballot lost, the latest revision counts");
    assert_eq!(n["dropped_after_acceptance"], 0);
    assert_eq!(n["cosignatures"].as_array().unwrap().len(), 2);
}

#[test]
fn re_replication_restores_min_live_and_every_handoff_is_logged() {
    let mut net = Net::new(&[rt(X, "c1")]);
    let (a1, a2, b1) = (net.add_node("a1", X), net.add_node("a2", X), net.add_node("b1", X));
    let ca = net.genesis(a1);
    let cb = net.genesis(b1);
    identity_handoff(&mut net, a1, a2, &ca);
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 2), (&cb, 1)], 3);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(a1, &job);
    net.advance(120_000, 60_000);
    let ann = net.announcement(&job_hash).expect("announced");
    for v in 1..4u8 {
        let r = net.submit([a1, a2, b1][v as usize - 1], &net.ballot(&ann, v, "yes", 0));
        if r.is_err() {
            eprintln!("log {:?}", kinds(&net.job_log(&job_hash)));
            for (i, n) in net.nodes.iter().enumerate() { eprintln!("node {i} alerts {:?}", n.alerts); }
        }
        assert!(r.is_ok(), "ballot {v}: {r:?}");
    }
    // a2 dies; after the liveness window the leader writes replica_lost and asks its host for a replica
    let a2_inst = net.instance(a2);
    net.kill(a2);
    net.advance(180_000, 60_000);
    let log = net.job_log(&job_hash);
    assert!(log.iter().any(|r| r["kind"] == "replica_lost" && r["body"]["instance"] == a2_inst.as_str()), "{:?}", kinds(&log));
    assert!(net.nodes.iter().any(|n| n.need_replica.contains(&job_hash)), "need_replica sent");
    // while fewer than min_live but at least q are live, receipts still need q acknowledgments
    assert!(net.submit(b1, &net.ballot(&ann, 4, "no", 0)).is_ok());
    // the operator starts a new enclave, gives it the identity, and the leader hands it the job
    let a3 = net.add_node("a3", X);
    identity_handoff(&mut net, a1, a3, &ca);
    net.directory();
    net.advance(60_000, 60_000);
    let log = net.job_log(&job_hash);
    let a3_inst = net.instance(a3);
    assert!(log.iter().any(|r| r["kind"] == "handoff" && r["body"]["to_instance"] == a3_inst.as_str()), "{:?}", kinds(&log));
    assert!(log.iter().any(|r| r["kind"] == "replicated" && r["body"]["instance"] == a3_inst.as_str()), "re-replication is logged: {:?}", kinds(&log));
    // every replica that ever served appears in a handoff record (or opened the job)
    let served: Vec<String> = log.iter().filter(|r| r["kind"] == "handoff").map(|r| r["body"]["to_instance"].as_str().unwrap().to_string()).collect();
    for i in [a2, b1, a3] {
        assert!(served.contains(&net.instance(i)), "node {i} served only after a logged handoff");
    }
    // the new replica serves, and the close counts every acknowledged ballot, including those from before it joined
    assert!(net.submit(a3, &net.ballot(&ann, 5, "yes", 0)).unwrap()["acks"].as_u64().unwrap() >= 2);
    assert_eq!(net.nodes[a3].store.len(), 5, "need_inputs: the new host fetched the earlier ciphertexts from its peers");
    net.advance(CLOSES - net.now + 10_000, 60_000);
    net.close(&job_hash, &[a1, b1, a3]);
    let n = net.notarization().expect("closed");
    assert_eq!(n["output"]["public"], json!({ "abstain": 0, "no": 1, "yes": 4 }));
}

/// The newest `handoff_offer` a node sent to `to`: (handoff id, S's challenge, the offer body).
fn offer_to(net: &Net, to: &str) -> Option<(String, [u8; 32], Value, usize)> {
    net.outbox.iter().rev().find_map(|(from, t, bytes)| {
        let v = jcs::parse_canonical(bytes).ok()?;
        (t == to && v["kind"] == "handoff_offer").then(|| {
            let id = v["body"]["handoff_id"].as_str().unwrap().to_string();
            let chal: [u8; 32] = b64u::decode_len(&id, 32).unwrap().try_into().unwrap();
            (id, chal, v["body"].clone(), *from)
        })
    })
}

fn payload_sent_to(net: &Net, to: &str) -> bool {
    net.outbox.iter().any(|(_, t, b)| t == to && jcs::parse_canonical(b).unwrap()["kind"] == "handoff_payload")
}

struct HelloOpts {
    nonce_ok: bool,
    program_ok: bool,
    abi: &'static str,
    card_in_set: bool,
    proof_ok: bool,
}

const GOOD: HelloOpts = HelloOpts { nonce_ok: true, program_ok: true, abi: "notary_v1", card_in_set: true, proof_ok: true };

fn crafted_hello(net: &mut Net, imp: &Impostor, o: HelloOpts) -> Vec<String> {
    crafted_hello_with(net, imp, o, None)
}

/// The impostor answers the latest offer with a crafted `hello`; returns the sender's new alerts.
fn crafted_hello_with(net: &mut Net, imp: &Impostor, o: HelloOpts, setup: Option<&dyn Fn(&Impostor)>) -> Vec<String> {
    use notary_types::user_data::UserData;
    // a refused peer is offered again only after the back-off (five minutes)
    net.advance(301_000, 60_000);
    imp.enclave.set_clock_ms(Some(net.now as u64));
    if let Some(f) = setup {
        f(imp);
    }
    net.directory_with(&[(&imp.instance, imp.inst.public_key(), &imp.card())]);
    let (id, chal_s, offer, s) = offer_to(net, &imp.instance).expect("the leader offered the job to the directory peer");
    let job_hash: [u8; 32] = jcs::h_bytes(&offer["job"]).unwrap();
    let hk = notary_crypto::XWingKey::generate();
    let hkh = notary_crypto::sha256(hk.public_key());
    let nonce = if o.nonce_ok { chal_s } else { [9u8; 32] };
    let att = imp.attest(UserData { purpose: 0x03, inst_key_hash: notary_crypto::sha256(imp.inst.public_key()), ..Default::default() }, Some(hkh), nonce);
    let id_key = if o.card_in_set { &imp.id } else { &MlDsaKey::generate() };
    let program_hash = if o.program_ok { notary_crypto::sha256(&net.program) } else { [7u8; 32] };
    let adm = imp.attest(
        UserData { purpose: 0x04, id_key_hash: notary_crypto::keccak256(id_key.public_key()), inst_key_hash: notary_crypto::sha256(imp.inst.public_key()), program_hash, job_hash, epoch: 0, isolation: 0x01, ..Default::default() },
        Some(hkh),
        nonce,
    );
    let proof = if o.proof_ok { id_key.sign(&chal_s) } else { id_key.sign(b"something else") };
    let hello = json!({ "abi": o.abi, "admitted_attestation": b64u::encode(&adm), "attestation": b64u::encode(&att), "challenge": b64u::encode(&[3u8; 32]),
        "handoff_id": id, "handoff_pubkey": b64u::encode(hk.public_key()), "id_proof": b64u::encode(&proof), "id_pubkey": b64u::encode(id_key.public_key()) });
    let before = net.nodes[s].alerts.len();
    let bytes = imp.envelope(&net.instance(s), "hello", hello);
    net.call(s, json!({ "kind": "peer_message", "req_id": "p", "from_instance": imp.instance, "bytes": b64u::encode(&bytes) }));
    net.run();
    net.nodes[s].alerts[before..].to_vec()
}

/// Replication §3 step 7: the sender refuses each mismatch (P1–P4) and never sends the payload (I1).
#[test]
fn the_sender_refuses_a_handoff_for_each_mismatch() {
    let mut net = Net::new(&[rt(X, "c1"), rt(0x55, "c2")]);
    let (a, b) = (net.add_node("a", X), net.add_node("b", X));
    let (ca, cb) = (net.genesis(a), net.genesis(b));
    let imp = Impostor::new(X, net.now);
    net.oracle.0.lock().unwrap().approved.push(imp.card());
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 1), (&cb, 1), (&imp.card(), 1)], 2);
    net.create_job(a, &job);
    let cases: Vec<(&str, HelloOpts, Option<Box<dyn Fn(&Impostor)>>)> = vec![
        ("ATT_NONCE_MISMATCH", HelloOpts { nonce_ok: false, ..GOOD }, None),
        ("ATT_DEBUG_MODE", GOOD, Some(Box::new(|i: &Impostor| i.enclave.set_debug(true)))),
        ("ATT_STALE", GOOD, Some(Box::new(|i: &Impostor| i.enclave.set_clock_ms(Some((T0 - 600_000) as u64))))),
        ("HANDOFF_RUNTIME_NOT_ACCEPTED", GOOD, Some(Box::new(|i: &Impostor| i.enclave.set_pcr0_seed(0x66)))),
        ("HANDOFF_SCOPE_DENIED", HelloOpts { card_in_set: false, ..GOOD }, None),
        ("HANDOFF_SCOPE_DENIED", HelloOpts { proof_ok: false, ..GOOD }, None),
        ("HANDOFF_PROGRAM_MISMATCH", HelloOpts { program_ok: false, ..GOOD }, None),
        ("HANDOFF_PROGRAM_MISMATCH", HelloOpts { abi: "notary_v2", ..GOOD }, None),
        ("HANDOFF_COMPAT_MISMATCH", GOOD, Some(Box::new(|i: &Impostor| i.enclave.set_pcr0_seed(0x55)))),
    ];
    for (code, opts, setup) in cases {
        imp.enclave.set_debug(false);
        imp.enclave.set_pcr0_seed(X);
        let alerts = crafted_hello_with(&mut net, &imp, opts, setup.as_deref());
        assert_eq!(alerts, vec![code.to_string()], "expected {code}");
        assert!(!payload_sent_to(&net, &imp.instance), "{code}: no key leaves (I1)");
    }
    // the baseline passes P and gets the (sealed) payload, which shows the cases above failed for their own reason
    imp.enclave.set_pcr0_seed(X);
    imp.enclave.set_clock_ms(Some(net.now as u64));
    let base = crafted_hello(&mut net, &imp, GOOD);
    assert!(base.is_empty(), "{base:?}");
    assert!(payload_sent_to(&net, &imp.instance));
}

/// Step 7 (Q7): the capacity cap is counted from the job log, whatever the directory claims; and step 10: a receiver
/// serves only after its own `handoff` record is anchored, so a host that withholds the anchor keeps it idle.
#[test]
fn over_capacity_is_refused_and_a_receiver_serves_only_after_its_handoff_anchor() {
    let mut net = Net::new(&[rt(X, "c1")]);
    let (a, b, a2) = (net.add_node("a", X), net.add_node("b", X), net.add_node("a2", X));
    let (ca, cb) = (net.genesis(a), net.genesis(b));
    identity_handoff(&mut net, a, a2, &ca);
    // the host lies: a2 (which holds card A) is listed as a card-B instance, where replica_set has room
    net.nodes[a2].card = cb.clone();
    let b_inst = net.instance(b);
    let b_idx = b;
    // withhold from b the anchor of any `handoff` record naming it
    net.fault = Some(Box::new(move |_net: &Net, item: &Item| match item {
        Item::Anchor { to, record: Some(r), .. } if *to == b_idx => {
            let v = jcs::parse_canonical(r).unwrap();
            if v["kind"] == "handoff" && v["body"]["to_instance"] == b_inst.as_str() { Fate::Hold } else { Fate::Deliver }
        }
        _ => Fate::Deliver,
    }));
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 1), (&cb, 2)], 2);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(a, &job);
    assert!(net.alerts(a).contains(&"HANDOFF_OVER_CAPACITY".to_string()), "card A already runs its one instance: {:?}", net.alerts(a));
    let a2_inst = net.instance(a2);
    assert!(net.job_log(&job_hash).iter().all(|r| r["body"]["to_instance"] != a2_inst.as_str()), "no handoff to a2");
    net.advance(60_000, 60_000);
    let ann = net.announcement(&job_hash).expect("announced: the leader saw its anchors");
    // b holds the key but hasn't seen its handoff record anchored: it does not serve
    assert_eq!(net.submit(b, &net.ballot(&ann, 1, "yes", 0)), Err("NH_ENCLAVE_UNAVAILABLE".into()));
    net.fault = None;
    net.release(|_| {});
    let r = net.submit(b, &net.ballot(&ann, 2, "yes", 0)).unwrap();
    assert_eq!((r["status"].as_str(), r["acks"].as_u64()), (Some("accepted"), Some(2)));
}

const Y: u8 = 0x43; // a newer runtime with the same close_compat

fn cosigner_instances(n: &Value) -> Vec<String> {
    n["cosignatures"].as_array().unwrap().iter().map(|c| b64u::encode(&notary_crypto::sha256(&b64u::decode(c["instance_signature"]["public_key"].as_str().unwrap()).unwrap()))).collect()
}

/// Replication §3, runtime upgrades, same `close_compat`: a rolling handoff, one replica at a time. Each old replica
/// stops (`replica_gone` → `replica_lost`, which frees its place under the cap), a new-image enclave gets the identity
/// and then the job; live replicas never drop below `min_live`; no ballot is lost.
#[test]
fn a_rolling_upgrade_of_a_live_vote_loses_no_ballots() {
    let mut net = Net::new(&[rt(X, "c1"), rt(Y, "c1")]);
    let old = [net.add_node("x1", X), net.add_node("x2", X), net.add_node("x3", X)];
    let ca = net.genesis(old[0]);
    identity_handoff(&mut net, old[0], old[1], &ca);
    identity_handoff(&mut net, old[0], old[2], &ca);
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 3)], 2);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(old[0], &job);
    net.advance(60_000, 60_000);
    let ann = net.announcement(&job_hash).expect("announced");
    let mut voter = 0u8;
    let mut yes = 0;
    let mut vote = |net: &mut Net, at: usize| {
        voter += 1;
        let r = net.submit(at, &net.ballot(&ann, voter, "yes", 0)).unwrap_or_else(|e| panic!("voter {voter} at node {at}: {e}"));
        assert!(r["acks"].as_u64().unwrap() >= 2);
        yes += 1;
    };
    vote(&mut net, old[0]);
    vote(&mut net, old[1]);
    let mut live: Vec<usize> = old.to_vec();
    let mut new = vec![];
    for (k, &o) in old.iter().enumerate() {
        // the old replica stops
        let out = net.call(o, json!({ "kind": "shutdown", "req_id": "stop" }));
        assert!(find(&out, "shutdown_ack").is_some());
        net.run();
        net.kill(o);
        live.retain(|&i| i != o);
        let lost = net.job_log(&job_hash).iter().filter(|r| r["kind"] == "replica_lost").count();
        if lost != k + 1 {
            for r in net.job_log(&job_hash) { eprintln!("{} {} by {} body {}", r["seq"], r["kind"], r["instance"], r["body"]); }
            for &i in &old { eprintln!("node {i} = {}", net.instance(i)); }
        }
        assert_eq!(lost, k + 1, "replica_gone made public as replica_lost");
        vote(&mut net, live[0]);
        // a new-image enclave: identity first (P2 accepts both runtimes), then the job (P4: same close_compat)
        let y = net.add_node(&format!("y{}", k + 1), Y);
        identity_handoff(&mut net, live[0], y, &ca);
        net.directory();
        net.advance(60_000, 60_000);
        let y_inst = net.instance(y);
        assert!(net.job_log(&job_hash).iter().any(|r| r["kind"] == "handoff" && r["body"]["to_instance"] == y_inst.as_str() && r["body"]["pcr0_to"] == b64u::encode(&notary_sim::pcr0_of(Y))));
        live.push(y);
        new.push(y);
        vote(&mut net, y);
    }
    net.advance(CLOSES - net.now + 10_000, 60_000);
    net.close(&job_hash, &new);
    let n = net.notarization().expect("closed on the new image");
    assert_eq!(n["output"]["public"]["yes"], yes);
    let news: Vec<String> = new.iter().map(|&i| net.instance(i)).collect();
    assert!(cosigner_instances(&n).iter().all(|c| news.contains(c)), "cosigned by new-image replicas");
    // the identity log shows every identity holder's runtime (algorithm E's lineage)
    let id_log = net.job_log(&ca);
    let lineage: std::collections::BTreeSet<String> = id_log.iter().filter(|r| r["kind"] == "handoff").map(|r| r["body"]["pcr0_to"].as_str().unwrap().to_string()).collect();
    assert!(lineage.contains(&b64u::encode(&notary_sim::pcr0_of(Y))));
}

const Z: u8 = 0x44; // a newer runtime with a different close_compat

fn last_log_cid(net: &Net, job_hash: &str) -> String {
    notary_types::formats::cid_of_bytes(&jcs::canonical(net.job_log(job_hash).last().unwrap()).unwrap())
}

fn restart(net: &mut Net, at: usize, job: &Value, prev_epoch: u64, last_log: &str, reason: &str, prev_attestation: Option<&str>) -> Vec<Value> {
    let mut r = json!({ "prev_epoch": prev_epoch, "last_log": last_log, "reason": reason });
    if let Some(a) = prev_attestation {
        r["prev_attestation"] = json!(a);
    }
    let program = b64u::encode(&net.program);
    let out = net.call(at, json!({ "kind": "create_job", "req_id": "rs", "job": job, "program": program, "transport": {}, "restart": r }));
    net.run();
    out
}

/// Replication §3 (different `close_compat`) and §7: a job can't be handed to the incompatible runtime
/// (`HANDOFF_COMPAT_MISMATCH`); it moves by a `runtime_migration` epoch keyed on the new image, old replicas stop at the
/// anchored `epoch_started`, wallets resubmit, and the new epoch closes.
#[test]
fn an_incompatible_upgrade_moves_the_job_by_a_migration_epoch() {
    let mut net = Net::new(&[rt(X, "c1"), rt(Z, "c2")]);
    let (x1, x2) = (net.add_node("x1", X), net.add_node("x2", X));
    let ca = net.genesis(x1);
    identity_handoff(&mut net, x1, x2, &ca);
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 3)], 2);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(x1, &job);
    net.advance(60_000, 60_000);
    let ann0 = net.announcement(&job_hash).unwrap();
    for v in 1..4u8 {
        net.submit(x1, &net.ballot(&ann0, v, if v == 1 { "no" } else { "yes" }, 0)).unwrap();
    }
    // new-image enclaves get the identity (no close_compat rule for identity scope)
    let (z1, z2) = (net.add_node("z1", Z), net.add_node("z2", Z));
    identity_handoff(&mut net, x1, z1, &ca);
    identity_handoff(&mut net, x1, z2, &ca);
    net.directory();
    net.advance(60_000, 60_000);
    assert!(net.nodes[x1].alerts.iter().chain(net.nodes[x2].alerts.iter()).any(|a| a == "HANDOFF_COMPAT_MISMATCH"), "the job is not handed across close_compat");
    // a migration can't be claimed by an enclave of the same runtime
    let head = last_log_cid(&net, &job_hash);
    let x1_att = net.job_log(&job_hash)[0]["body"]["attestations"][0].as_str().unwrap().to_string();
    assert_eq!(find(&restart(&mut net, x2, &job, 0, &head, "runtime_migration", Some(&x1_att)), "job_rejected").unwrap()["code"], "JOB_MALFORMED");
    // the new image confirms the previous epoch's runtime differs (from its attestation) and keys epoch 1
    let out = restart(&mut net, z1, &job, 0, &head, "runtime_migration", Some(&x1_att));
    assert_eq!(find(&out, "job_keyed").unwrap_or_else(|| panic!("{out:?}"))["epoch"], 1);
    net.advance(60_000, 60_000);
    let ann1 = net.announcement(&job_hash).unwrap();
    assert_eq!((ann1["epoch"].as_u64(), ann1["epoch_reason"].as_str()), (Some(1), Some("runtime_migration")));
    let log = net.job_log(&job_hash);
    assert!(log.iter().any(|r| r["kind"] == "epoch_started" && r["body"]["epoch_reason"] == "runtime_migration"));
    // old-epoch replicas stopped at the anchored epoch_started
    assert!(net.submit(x1, &net.ballot(&ann0, 9, "yes", 0)).is_err());
    assert!(net.submit(x2, &net.ballot(&ann1, 9, "yes", 0)).is_err(), "an old replica holds no epoch-1 key");
    // wallets resubmit their stored ballots to epoch 1 (voter 1 had changed to yes at revision 1)
    for (v, choice, rev) in [(1u8, "yes", 1u64), (2, "yes", 0), (3, "yes", 0)] {
        let r = net.submit(z1, &net.ballot(&ann1, v, choice, rev)).unwrap();
        assert!(r["acks"].as_u64().unwrap() >= 2);
    }
    net.advance(CLOSES - net.now + 10_000, 60_000);
    net.close(&job_hash, &[z1, z2]);
    let n = net.notarization().expect("the new epoch closes");
    assert_eq!((n["final_epoch"].as_u64(), n["output"]["public"]["yes"].as_u64()), (Some(1), Some(3)));
}

/// Runtime §4, replication §3 (`vulnerable`) and §7, algorithm E: an emergency retirement exposes every key that lived
/// in the image. The notary card whose key lived there is unusable everywhere (no job, no signature, no handoff:
/// `HANDOFF_KEY_EXPOSED`); the job's key is exposed on every replica (it was made there), receipts stop, and a clean
/// replica re-keys the job by a `key_exposure` epoch that closes on clean keys only.
#[test]
fn an_emergency_retirement_kills_the_card_and_re_keys_its_jobs() {
    let mut net = Net::new(&[rt(X, "c1"), rt(Y, "c1")]);
    let (ax, ay, b1, b2) = (net.add_node("ax", X), net.add_node("ay", Y), net.add_node("b1", Y), net.add_node("b2", Y));
    let ca = net.genesis(ax);
    let cb = net.genesis(b1);
    identity_handoff(&mut net, ax, ay, &ca); // A's lineage: {X, Y}
    identity_handoff(&mut net, b1, b2, &cb); // B's lineage: {Y}
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 1), (&cb, 2)], 2);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(ax, &job); // K_job,0 is made on X
    net.advance(60_000, 60_000);
    let ann0 = net.announcement(&job_hash).unwrap();
    for v in 1..3u8 {
        assert!(net.submit(b1, &net.ballot(&ann0, v, "yes", 0)).unwrap()["acks"].as_u64().unwrap() >= 2);
    }
    // two members retire X as vulnerable (removal only)
    {
        let mut st = net.oracle.0.lock().unwrap();
        let mut rts = st.runtimes.clone();
        net.gov.emergency_retire(&mut rts, &[Runtime { seed: X, compat: "c1", retired: Some(("vulnerable", net.now - 1000)) }, rt(Y, "c1")]);
        st.runtimes = rts;
    }
    net.advance(60_000, 60_000); // every enclave re-reads its lists on a tick
    for i in [ax, ay, b1, b2] {
        assert!(net.alerts(i).contains(&"key_exposed".to_string()), "node {i} found an exposed key");
    }
    // receipts stop: the epoch-0 key is exposed on every replica, so nothing opens
    assert_eq!(net.submit(b1, &net.ballot(&ann0, 3, "yes", 0)), Err("INPUT_UNDECRYPTABLE".into()));
    // card A is dead, even on the clean image: no handoff of it, no job for it
    let fresh = net.add_node("a-new", Y);
    let fresh_inst = net.instance(fresh);
    net.call(ay, json!({ "kind": "start_handoff", "req_id": "sh", "scope": "identity", "card": ca, "to_instance": fresh_inst }));
    net.run();
    assert!(net.alerts(ay).contains(&"HANDOFF_KEY_EXPOSED".to_string()), "P5: {:?}", net.alerts(ay));
    let job2 = net.job(&MlDsaKey::generate(), 2, &[(&ca, 1)], 1);
    assert_eq!(find(&net.create_job(ay, &job2), "job_rejected").unwrap()["code"], "JOB_NOTARY_NOT_APPROVED");
    // a clean card-B replica confirms the exposure from its own verified list and re-keys the job
    let head = last_log_cid(&net, &job_hash);
    let out = restart(&mut net, b1, &job, 0, &head, "key_exposure", None);
    assert_eq!(find(&out, "job_keyed").unwrap_or_else(|| panic!("{out:?}"))["epoch"], 1);
    net.advance(60_000, 60_000);
    let ann1 = net.announcement(&job_hash).unwrap();
    assert_eq!((ann1["epoch"].as_u64(), ann1["epoch_reason"].as_str()), (Some(1), Some("key_exposure")));
    for v in 1..4u8 {
        assert!(net.submit(b2, &net.ballot(&ann1, v, "yes", 0)).unwrap()["acks"].as_u64().unwrap() >= 2);
    }
    net.advance(CLOSES - net.now + 10_000, 60_000);
    net.close(&job_hash, &[b1, b2]);
    let n = net.notarization().expect("closed on clean keys");
    assert_eq!((n["final_epoch"].as_u64(), n["output"]["public"]["yes"].as_u64()), (Some(1), Some(3)));
    assert_eq!(n["notary_card"].as_str(), Some(cb.as_str()));
    // algorithm E's lineage of card A, from its public identity log: genesis on X, then Y; X is now vulnerable
    let id_log = net.job_log(&ca);
    assert_eq!(id_log[0]["kind"], "opened");
    assert!(id_log.iter().any(|r| r["kind"] == "handoff" && r["body"]["pcr0_to"] == b64u::encode(&notary_sim::pcr0_of(Y))));
}

/// Threat notes, §3–§6: hosts may replay, rewrite and reorder anything they relay.
/// - a replayed handoff payload installs nothing (I2: only an open session's own handoff key opens one);
/// - replayed acknowledgments and heartbeats count once; a rewritten message fails its signature and is dropped;
/// - anchors delivered in reverse order still leave every follower on the same log.
#[test]
fn hostile_relays_cannot_replay_rewrite_or_reorder_their_way_in() {
    let (mut net, [a, b, c], cards) = three_operators();
    // record every handoff payload as it passes, and deliver anchors in reverse order
    let seen = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
    let s2 = seen.clone();
    net.fault = Some(Box::new(move |_n: &Net, item: &Item| match item {
        Item::Peer { to, bytes, .. } => {
            if Net::peer_kind(bytes).0 == "handoff_payload" {
                s2.lock().unwrap().push((*to, bytes.clone()));
            }
            Fate::Deliver
        }
        Item::Anchor { .. } => Fate::Hold,
        _ => Fate::Deliver,
    }));
    let job = net.job(&MlDsaKey::generate(), 1, &[(&cards[0], 1), (&cards[1], 1), (&cards[2], 1)], 2);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(a, &job);
    for _ in 0..4 {
        net.fault = None;
        net.release(|h| h.reverse());
    }
    net.advance(60_000, 60_000);
    let ann = net.announcement(&job_hash).expect("formed despite reordered anchors");
    let hash: [u8; 32] = jcs::h_bytes(&job).unwrap();
    // I2: the recorded payloads, replayed to their receivers and to others, change nothing
    let epochs: Vec<Vec<u64>> = [a, b, c].iter().map(|&i| net.nodes[i].broker.job_epochs_for_tests(&hash)).collect();
    let payloads = seen.lock().unwrap().clone();
    assert!(!payloads.is_empty());
    for (to, bytes) in payloads {
        for i in [to, a, b, c] {
            let from = net.instance(a);
            net.call(i, json!({ "kind": "peer_message", "req_id": "p", "from_instance": from, "bytes": b64u::encode(&bytes) }));
        }
    }
    net.run();
    let after: Vec<Vec<u64>> = [a, b, c].iter().map(|&i| net.nodes[i].broker.job_epochs_for_tests(&hash)).collect();
    assert_eq!(epochs, after, "a replayed handoff payload installs nothing");
    // every follower adopted the same log head
    let heads: Vec<Option<String>> = [a, b, c].iter().map(|&i| net.nodes[i].broker.job_log_head_for_tests(&hash)).collect();
    assert!(heads.iter().all(|h| h.is_some() && *h == heads[0]), "{heads:?}");
    // replayed acknowledgments count once
    net.fault = Some(Box::new(|_: &Net, item: &Item| if matches!(item, Item::Peer { .. }) { Fate::Replay } else { Fate::Deliver }));
    let r = net.submit(a, &net.ballot(&ann, 1, "yes", 0)).unwrap();
    assert!(r["acks"].as_u64().unwrap() <= 3);
    // a rewritten acknowledgment fails its signature: the receipt waits for honest ones
    net.fault = Some(Box::new(|_: &Net, item: &Item| match item {
        Item::Peer { from, to, bytes } if Net::peer_kind(bytes).0 == "input_ack" => {
            let s = String::from_utf8(bytes.clone()).unwrap().replace("\"accepted\"", "\"rejected\"");
            Fate::Rewrite(Item::Peer { from: *from, to: *to, bytes: s.into_bytes() })
        }
        _ => Fate::Deliver,
    }));
    assert_eq!(net.submit(b, &net.ballot(&ann, 2, "yes", 0)), Err("NO_RECEIPT_YET".into()), "no forged acknowledgment counts");
    net.fault = None;
    net.advance(61_000, 61_000);
    let timed_out = net.nodes[b].replies.iter().any(|r| r["code"] == "INPUT_ACK_TIMEOUT");
    assert!(timed_out, "no quorum within 60 s: no receipt (step 13)");
}

/// Replication step 17: a replica never co-signs two bodies for one job, so a second leader (after the first stops
/// mid-close) can't get a different result through; close stalls instead.
#[test]
fn a_replica_never_cosigns_two_bodies_for_one_job() {
    let (mut net, nodes, cards) = three_operators();
    let (job_hash, ann) = open_vote(&mut net, nodes[0], &cards, 2);
    for v in 1..4u8 {
        net.submit(nodes[0], &net.ballot(&ann, v, "yes", 0)).unwrap();
    }
    net.advance(CLOSES - net.now + 10_000, 60_000);
    let mut order: Vec<usize> = nodes.to_vec();
    order.sort_by_key(|&i| net.instance(i));
    let (l, m, f) = (order[0], order[1], order[2]); // leader, next leader, follower
    // F co-signs L's body, but every cosignature is lost, and M never sees L's body
    net.fault = Some(Box::new(move |_: &Net, item: &Item| match item {
        Item::Peer { bytes, .. } if Net::peer_kind(bytes).0 == "close_cosign" => Fate::Drop,
        Item::Peer { to, bytes, .. } if *to == m && Net::peer_kind(bytes).0 == "close_body" => Fate::Drop,
        _ => Fate::Deliver,
    }));
    net.close(&job_hash, &[l, m, f]);
    assert!(net.notarization().is_none());
    // L stops; M leads with its own body; F refuses it
    net.kill(l);
    net.fault = None;
    net.advance(180_000, 60_000);
    assert!(net.alerts(f).contains(&"close_conflicting_body".to_string()), "{:?}", net.alerts(f));
    assert!(net.notarization().is_none(), "no second result");
}

/// Template scope (§3): `k_T` moves only between instances of cards that serve template T (P3, checked on both sides),
/// the record goes to the sender's identity log with `key_generation`, and the receiver may use the key only after that
/// record is anchored.
#[test]
fn a_template_key_moves_only_to_a_card_serving_the_template() {
    let mut net = Net::new(&[rt(X, "c1")]);
    let (a, b) = (net.add_node("a", X), net.add_node("b", X));
    let (ca, cb) = (net.genesis(a), net.genesis(b));
    net.nodes[a].broker.create_template_key_for_tests("bafkreitemplate");
    let to = net.instance(b);
    let start = |net: &mut Net| {
        net.call(a, json!({ "kind": "start_handoff", "req_id": "t", "scope": "template", "template": "bafkreitemplate", "card": ca, "to_instance": to }));
        net.run();
    };
    net.oracle.0.lock().unwrap().template_cards.insert((ca.clone(), "bafkreitemplate".into()));
    start(&mut net);
    assert!(net.alerts(a).contains(&"HANDOFF_SCOPE_DENIED".to_string()), "card B doesn't serve T: {:?}", net.alerts(a));
    assert!(!net.nodes[b].broker.template_ready_for_tests("bafkreitemplate"));
    net.oracle.0.lock().unwrap().template_cards.insert((cb.clone(), "bafkreitemplate".into()));
    start(&mut net);
    assert!(net.nodes[b].broker.template_ready_for_tests("bafkreitemplate"), "usable once its record is anchored");
    let rec = net.job_log(&ca).into_iter().find(|r| r["kind"] == "handoff").expect("in the sender's identity log");
    assert_eq!((rec["body"]["scope"].as_str(), rec["body"]["key_generation"].as_u64(), rec["body"]["to_notary_card"].as_str()), (Some("template"), Some(0), Some(cb.as_str())));
}

/// R3, option 1: a replica keeps a window of recent headers plus every header an input it holds names, so a job that
/// runs far past the window still re-checks its early inputs at close (B3); a late-joining replica gets those headers in
/// the job handoff, because its own chain anchored after them.
#[test]
fn a_long_job_keeps_the_headers_its_inputs_name_and_hands_them_on() {
    let mut net = Net::new(&[rt(X, "c1")]);
    let (a, b, c, c2) = (net.add_node("a", X), net.add_node("b", X), net.add_node("c", X), net.add_node("c2", X));
    let (ca, cb, cc) = (net.genesis(a), net.genesis(b), net.genesis(c));
    identity_handoff(&mut net, c, c2, &cc);
    for i in [a, b, c, c2] {
        net.nodes[i].broker.set_header_keep_for_tests(6);
    }
    net.directory();
    let job = net.job(&MlDsaKey::generate(), 1, &[(&ca, 1), (&cb, 1), (&cc, 1)], 3);
    let job_hash = jcs::h(&job).unwrap();
    net.create_job(a, &job);
    net.advance(60_000, 60_000);
    let ann = net.announcement(&job_hash).expect("announced");
    let early = net.headers.len() - 1;
    for v in 1..4u8 {
        assert!(net.submit(a, &net.ballot(&ann, v, "yes", 0)).is_ok());
    }
    // thirty more blocks: far past the 6-header window
    net.advance(30 * 60_000, 60_000);
    // an old header no input names is gone; the early ballots' header is still there
    assert_eq!(net.submit(a, &net.ballot_at(&ann, 9, "no", 0, early - 1)).unwrap()["reject_reason"], "INPUT_CHAIN_REF_UNKNOWN");
    // the replica holding card C's place stops; C's other enclave joins after the early headers left its window
    let holder = net.job_log(&job_hash).iter().find(|r| r["kind"] == "handoff" && r["body"]["to_notary_card"] == cc.as_str()).unwrap()["body"]["to_instance"].as_str().unwrap().to_string();
    let (gone, standby) = if net.instance(c) == holder { (c, c2) } else { (c2, c) };
    net.kill(gone);
    net.directory();
    net.advance(180_000, 60_000);
    let st_inst = net.instance(standby);
    assert!(net.job_log(&job_hash).iter().any(|r| r["kind"] == "replicated" && r["body"]["instance"] == st_inst.as_str()), "re-replicated");
    net.advance(CLOSES - net.now + 10_000, 60_000);
    // the standby must co-sign: the close needs all three live replicas' agreement to be checked here
    net.close(&job_hash, &[a, b, standby]);
    let n = net.notarization().expect("closed");
    assert_eq!((n["accepted"].as_u64(), n["dropped_after_acceptance"].as_u64()), (Some(3), Some(0)), "the early ballots still count");
    assert!(net.alerts(standby).iter().all(|x| x != "close_mismatch"), "the late joiner re-checked the early ballots too: {:?}", net.alerts(standby));
}
