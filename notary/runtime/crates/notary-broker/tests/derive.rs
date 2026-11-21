//! Step 6.4, derived cards (derived_card_revocation_propagation.md §1, §3, §4, §5; notary_lifecycle.md Phase 5), on the
//! in-process harness (`support`): a real broker with a real fake enclave, the committed `derive` module under the real
//! worker engine, real X-Wing / ML-DSA / secp256r1. What is stood in for: the card-chain verification of the source card
//! (a fixed oracle, as in the other broker tests; `notary-cards` does it in the enclave and the end-to-end run), and the
//! chain, which is `support::Registry`: the write gate checks the `RegisterCard` signature, the sequence and that every
//! signed field equals the calldata (E-49).
//!
//! The holder's side (the wallet, `Holder`) is test code here: it builds the input, opens the receipt, countersigns the
//! offer with the derived key, and resubmits when an offer goes stale.
mod support;
use notary_crypto::MlDsaKey;
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use support::*;

const X: u8 = 0x42;
/// The template policy T: the job's `policy_id`. The CID of `TEMPLATE_DOC`, so the end-to-end fixture can pin the document. (`field_definitions` is the object form Stage 5 of the verifier reads; the spec's array form is read as required fields "0", "1", "2": reported in plans/notary-questions-6.4.md.)
const T: &str = "bafkreihfhzmyd2xol7vxrhncbto4ctafwvhud4zj3xb5cruk6ypjsk2d64";
const TEMPLATE_DOC: &str = r#"{"field_definitions":{"dup_tag":{"required":true,"type":"base64url"},"projected":{"required":true,"type":"text"},"source_policy":{"required":true,"type":"cid"}},"type":"policy"}"#;
const SOURCE: &str = "bafkreisource";
const PERIOD: i64 = 86_400_000; // P1D
const BATCH: i64 = 3_600_000; // PT1H

fn rt(seed: u8, compat: &'static str) -> Runtime {
    Runtime { seed, compat, retired: None }
}

/// The derive template's module and its `notary` section with test values: a one-day period with a six-hour renewal
/// window, hourly batches of at least two cards, and an anonymity set of three.
fn template(over: Value) -> (Vec<u8>, Value) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../templates");
    let module = std::fs::read(root.join("modules/derive.wasm")).expect("run templates/build.sh derive");
    let policy: Value = serde_json::from_str(&std::fs::read_to_string(root.join("derive/policy.json")).unwrap()).unwrap();
    let mut n = policy["notary"].clone();
    n["platform"] = json!("simulator");
    n["program_cid"] = json!(formats::cid_of_bytes(&module));
    n["derived_card"] = json!({ "issuance_batch_interval": "PT1H", "min_anonymity_set": 3, "min_batch_size": 2, "nullifier_period": "P1D", "renewal_window": "PT6H", "source_kind": "card" });
    for (k, v) in over.as_object().cloned().unwrap_or_default() {
        n[k] = v;
    }
    (module, n)
}

/// A source card the oracle will show: `member` byte, the field values, and the root key (the same root key under two
/// card pointers is one master card across a key rotation).
fn source(root: u8, fields: Value) -> SourceCard {
    let root_key = root_key_of(root);
    SourceCard { address: pointer(root), pubkey: source_pubkey(root), root_key_hash: notary_crypto::sha256(&root_key), root_key, policy_id: SOURCE.into(), fields: fields.as_object().unwrap().clone() }
}
use notary_broker::env::SourceCard;

/// The source card's `recipient_pubkey` (its content key decrypts the card's log entries).
fn source_pubkey(member: u8) -> Vec<u8> {
    expand("source-recipient-pubkey", member, 1312)
}

/// A source card's root key. High-entropy on purpose (6.6): repeated-byte test values alias with other repeated data
/// once base64-encoded, which would make a "the host's records never name this card" scan meaningless.
fn root_key_of(member: u8) -> Vec<u8> {
    expand("source-root-key", member, 1312)
}

fn pointer(member: u8) -> String {
    expand("source-card-pointer", member, 32).iter().map(|b| format!("{b:02x}")).collect()
}

fn expand(label: &str, member: u8, len: usize) -> Vec<u8> {
    let mut out = vec![];
    let mut counter = 0u32;
    while out.len() < len {
        let mut input = label.as_bytes().to_vec();
        input.push(member);
        input.extend_from_slice(&counter.to_be_bytes());
        out.extend_from_slice(&notary_crypto::sha256(&input));
        counter += 1;
    }
    out.truncate(len);
    out
}

/// A derived-card job under `T` for the notary card served by node `i`, signed by `requester`.
fn derive_job(card: &str, requester: &MlDsaKey, nonce: u8, fields: &[&str], key_period: &str) -> Value {
    let mut job = json!({
        "created_at": formats::format_timestamp(T0), "ends_at": formats::format_timestamp(T0 + 3 * PERIOD), "kem": "x-wing-draft-06", "key_period": key_period, "min_live": 1,
        "nonce": b64u::encode(&[nonce; 16]), "opens_at": formats::format_timestamp(OPENS), "parameters": { "projected_fields": fields, "source_policy": SOURCE },
        "policy_id": T, "policy_state_cid": "bafkreistate", "replica_set": [{ "instances": 1, "notary_card": card }],
        "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1",
    });
    job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
    job
}

struct World {
    net: Net,
    card: String,
    requester: MlDsaKey,
    job: Value,
    job_hash: String,
}

impl World {
    /// One enclave, a notary card, the template key seeded, and a derived-card job under `T`.
    fn new() -> Self {
        Self::with(template(json!({})), &["level"], |_| {})
    }

    fn with(t: (Vec<u8>, Value), fields: &[&str], tweak: impl FnOnce(&mut Value)) -> Self {
        let (module, notary) = t;
        let mut net = Net::new_with(&[rt(X, "c1")], module, notary);
        let a = net.add_node("a", X);
        let card = net.genesis(a);
        {
            let mut s = net.oracle.0.lock().unwrap();
            s.policy_key = MlDsaKey::generate().public_key().to_vec();
            s.snapshot_cards = Some(50);
            // the source policy's press (E4: an update counts only if a certified press signed it)
            s.certified_presses.insert(test_press(1).public_key().to_vec());
            // four members share one value, so the groups can fill
            for m in 1..=8u8 {
                s.sources.insert(pointer(m), source(m, json!({ "level": "gold", "team": "red", "policy_id": SOURCE })));
            }
        }
        let seeded = net.call(a, json!({ "kind": "seed_template", "req_id": "seed", "template": T, "notary_card": card, "nullifier_period": "P1D" }));
        assert_eq!(find(&seeded, "template_seeded").unwrap_or_else(|| panic!("{seeded:?}"))["generation"], 0);
        let requester = MlDsaKey::generate();
        let mut job = json!({
            "created_at": formats::format_timestamp(T0), "ends_at": formats::format_timestamp(T0 + 3 * PERIOD), "kem": "x-wing-draft-06", "key_period": "PT1H", "min_live": 1,
            "nonce": b64u::encode(&[1u8; 16]), "opens_at": formats::format_timestamp(OPENS), "parameters": { "projected_fields": fields, "source_policy": SOURCE },
            "policy_id": T, "policy_state_cid": "bafkreistate", "replica_set": [{ "instances": 1, "notary_card": card }],
            "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1",
        });
        tweak(&mut job);
        job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
        let job_hash = jcs::h(&job).unwrap();
        let mut w = World { net, card, requester, job, job_hash };
        let out = w.net.create_job(0, &w.job.clone());
        assert!(find(&out, "job_keyed").is_some(), "{out:?}");
        w.net.advance(60_000, 60_000);
        w
    }

    fn ann(&self) -> Value {
        self.net.announcement(&self.job_hash).expect("announced")
    }

    /// The current period index and the next batch boundary.
    fn period(&self) -> u64 {
        (self.net.now / PERIOD) as u64
    }
    fn boundary_after(&self, ms: i64) -> i64 {
        (ms / BATCH + 1) * BATCH
    }

    fn request(&mut self, h: &Holder, target: u64) -> Value {
        let ann = self.ann();
        let b = self.ask_input(&ann, h, target);
        self.net.submit(0, &b).unwrap_or_else(|e| panic!("submit: {e}"))
    }

    fn ask_input(&self, ann: &Value, h: &Holder, target: u64) -> Ballot {
        let job_hash: [u8; 32] = jcs::h_bytes(&ann["job"]).unwrap();
        let input = h.input(&self.net, &b64u::encode(&job_hash), target);
        self.net.seal_plain(ann, &input)
    }

    fn countersign(&mut self, h: &Holder, receipt: &Value) -> Value {
        let ann = self.ann();
        let msg = h.countersign(&b64u::encode(&jcs::h_bytes(&ann["job"]).unwrap()), &receipt["derived_offer"]);
        let b = self.net.seal_plain(&ann, &msg);
        self.net.submit(0, &b).unwrap_or_else(|e| panic!("countersign: {e}"))
    }

    /// A holder asks, and countersigns the offer if it got one.
    fn obtain(&mut self, h: &Holder, target: u64) -> Value {
        let r = self.request(h, target);
        assert_eq!(r["status"], "accepted", "{r}");
        let c = self.countersign(h, &r);
        assert_eq!(c["status"], "accepted", "countersign: {c}");
        r
    }

    fn log(&self) -> Vec<Value> {
        self.net.job_log(&self.job_hash)
    }
}

struct Holder {
    member: u8,
    d: MlDsaKey,
    /// The signed input the wallet keeps (it resubmits the same one for a new offer, replication §7).
    kept: std::cell::RefCell<std::collections::BTreeMap<(String, u64), Value>>,
}

impl Holder {
    fn new(member: u8) -> Self {
        Self { member, d: MlDsaKey::generate(), kept: Default::default() }
    }
    fn input(&self, net: &Net, job_hash: &str, target: u64) -> Value {
        self.kept.borrow_mut().entry((job_hash.to_string(), target)).or_insert_with(|| self.fresh_input(net, job_hash, target)).clone()
    }
    fn fresh_input(&self, net: &Net, job_hash: &str, target: u64) -> Value {
        json!({
            "chain_ref": net.chain_ref(net.newest_header()), "contributor_card": pointer(self.member), "contributor_card_pubkey": "AA",
            "contributor_signature": { "public_key": "AA", "signature": "AA" }, "evidence": [], "job_hash": job_hash,
            "payload": { "derived_recipient_pubkey": b64u::encode(self.d.public_key()), "target_period": target }, "revision": 0,
            "signed_at": "2027-01-15T00:10:00.000Z", "type": "notary.input.v1",
        })
    }
    /// `notary.countersign.v1` (protocol-objects §23.1): the derived key signs the offer plus `recipient_pubkey`.
    fn countersign(&self, job_hash: &str, offer: &Value) -> Value {
        let mut signed = offer.clone();
        signed["recipient_pubkey"] = json!(b64u::encode(self.d.public_key()));
        let sig = self.d.sign(&jcs::canonical(&signed).unwrap());
        json!({ "holder_signature": b64u::encode(&sig), "job_hash": job_hash, "offer_hash": jcs::h(offer).unwrap(), "type": "notary.countersign.v1" })
    }
    fn address(&self) -> String {
        b64u::encode(&notary_crypto::keccak256(self.d.public_key()))
    }
}

fn registered(w: &World, h: &Holder) -> Option<String> {
    w.net.registry.cards.iter().find(|(a, _)| *a == h.address()).map(|(_, c)| c.clone())
}

// ---------------------------------------------------------------------------------------------------------------------

/// The whole flow for four holders who share the values: offers carry the next boundary and the period's end; after the
/// countersign the cards wait for the boundary; at it they are released as one batch, signed, encrypted, published and
/// registered through payloads the enclave signed with `K_chain`; the job log says only how many.
#[test]
fn derived_cards_are_offered_countersigned_released_in_a_batch_and_registered() {
    let mut w = World::new();
    let p = w.period();
    let hs: Vec<Holder> = (1..=4).map(Holder::new).collect();
    let mut offers = vec![];
    for h in &hs {
        let r = w.obtain(h, p);
        offers.push(r["derived_offer"].clone());
    }
    let boundary = w.boundary_after(w.net.now);
    let kid = w.net.nodes[0].broker.identity_pubkey_for_tests(&w.card).unwrap();
    let tpub = w.net.oracle.0.lock().unwrap().policy_key.clone();
    for o in &offers {
        assert_eq!(o["issued_at"], formats::format_timestamp(boundary).as_str(), "issued_at is the next batch boundary, not the request time");
        assert_eq!(o["expires_at"], formats::format_timestamp((p as i64 + 1) * PERIOD).as_str(), "every card of a period expires when it ends");
        assert_eq!((o["issuer_card"].as_str(), o["press_card"].as_str(), o["policy_id"].as_str()), (Some(w.card.as_str()), Some(w.card.as_str()), Some(T)));
        assert_eq!((o["source_policy"].as_str(), o["projected"].as_str()), (Some(SOURCE), Some(r#"{"level":"gold"}"#)), "only the projected field, verbatim");
        assert_eq!(o["ancestry_pubkeys"], json!([b64u::encode(&kid), b64u::encode(&tpub)]));
        assert!(o.get("recipient_pubkey").is_none() && o.get("holder_signature").is_none() && o.get("press_signature").is_none());
        // the offer is signed by K_id over the offer without its signature
        let sig = b64u::decode(o["issuer_signature"].as_str().unwrap()).unwrap();
        assert!(notary_crypto::mldsa_verify(&kid, &jcs::canonical(&jcs::without_fields(o, &["issuer_signature"])).unwrap(), &sig));
    }
    assert_eq!(offers.iter().map(|o| o["dup_tag"].as_str().unwrap()).collect::<BTreeSet<_>>().len(), 4, "four source cards, four tags");
    assert!(w.net.registry.cards.is_empty(), "nothing is registered before the boundary");
    // the boundary passes
    w.net.advance(boundary - w.net.now + 1000, 300_000);
    assert_eq!(w.net.registry.cards.len(), 4, "the batch is registered: {:?}", w.net.registry.submissions.len());
    let version = "0.1";
    for (h, offer) in hs.iter().zip(&offers) {
        let cid = registered(&w, h).expect("registered under keccak256(D)");
        // the registered head is the card, encrypted under D's content key (ADR-006)
        let enc = w.net.ipfs.get(&cid).expect("pinned");
        let plain = notary_cards::support::aes_gcm_decrypt(&notary_cards::support::content_key(h.d.public_key()), enc).expect("opens with D's content key");
        let card: Value = jcs::parse_canonical(&plain).unwrap();
        assert_eq!(card["recipient_pubkey"], b64u::encode(h.d.public_key()).as_str());
        assert_eq!(card["protocol_version"], version);
        for f in ["issued_at", "expires_at", "dup_tag", "projected", "source_policy", "ancestry_pubkeys", "issuer_signature", "policy_id"] {
            assert_eq!(card[f], offer[f], "{f} is as offered");
        }
        // all three signatures: issuer (offer), holder (offer + D), press (everything else)
        let ok = |key: &[u8], doc: &Value, sig: &Value| notary_crypto::mldsa_verify(key, &jcs::canonical(doc).unwrap(), &b64u::decode(sig.as_str().unwrap()).unwrap());
        assert!(ok(h.d.public_key(), &jcs::without_fields(&card, &["holder_signature", "press_signature", "protocol_version"]), &card["holder_signature"]));
        assert!(ok(&kid, &jcs::without_fields(&card, &["press_signature"]), &card["press_signature"]), "press_signature by K_id");
        assert_eq!(card["issuer_card"], card["press_card"]);
        assert_eq!(formats::cid_of_bytes(enc), cid);
    }
    // sequences 0..4 went to the registry, each signed by K_chain (the registry checked) and bound to its calldata
    assert_eq!(w.net.registry.next_sequence, 4);
    // the job log: one `issued` record with only a count, the period and the boundary
    let issued: Vec<Value> = w.log().into_iter().filter(|r| r["kind"] == "issued").collect();
    assert_eq!(issued.len(), 1);
    assert_eq!(issued[0]["body"], json!({ "batch_boundary": formats::format_timestamp(boundary), "count": 4, "period": p }));
    // the end-to-end fixture the TypeScript verification test replays (notary/e2e/test/derived.test.ts)
    write_fixture(&w, &hs, "issued.json", json!({}));
    // no PressIssuanceRecord, no delivery: the wallet finds the card by watching keccak256(D) (§3 step 9)
    assert!(!w.net.nodes[0].saw.iter().any(|k| k == "deliver"), "no records or deliveries: {:?}", w.net.nodes[0].saw);
}

/// The fixture a TypeScript end-to-end test replays (`notary/e2e/test/`), written with NOTARY_WRITE_VECTORS=1: the
/// notary's genesis, every chain submission in order, every IPFS object, and the holders' derived keys.
fn write_fixture(w: &World, hs: &[Holder], name: &str, extra: Value) {
    if std::env::var("NOTARY_WRITE_VECTORS").is_err() {
        return;
    }
    assert_eq!(formats::cid_of_bytes(TEMPLATE_DOC.as_bytes()), T);
    let kid = w.net.nodes[0].broker.identity_pubkey_for_tests(&w.card).unwrap();
    let tpub = w.net.oracle.0.lock().unwrap().policy_key.clone();
    let mut ipfs = serde_json::Map::new();
    ipfs.insert(T.into(), json!(b64u::encode(TEMPLATE_DOC.as_bytes())));
    for (cid, b) in &w.net.ipfs {
        ipfs.insert(cid.clone(), json!(b64u::encode(b)));
    }
    let mut fixture = json!({
        "about": "Written by notary-broker tests/derive.rs with NOTARY_WRITE_VECTORS=1: one real broker issuing derived cards.",
        "now_ms": w.net.now, "trust_root": b64u::encode(&notary_sim::test_root_der()), "pcr0": b64u::encode(&notary_sim::pcr0_of(X)), "notary_card": w.card,
        "genesis": w.net.geneses[&w.card], "template_pubkey": b64u::encode(&tpub), "template_policy_id": T, "source_policy": SOURCE,
        "submissions": w.net.registry.submissions, "ipfs": ipfs,
        "holders": hs.iter().map(|h| json!({ "pubkey": b64u::encode(h.d.public_key()), "seed": b64u::encode(h.d.seed().expose()) })).collect::<Vec<_>>(),
        "k_id": b64u::encode(&kid),
    });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        fixture[k] = v;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/derived");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(name), serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
}

/// D3: a second card for the same source card and period is refused, whatever the derived key or the card pointer; and
/// not for another period.
#[test]
fn a_second_card_for_one_source_card_and_period_is_refused_as_a_duplicate() {
    let mut w = World::new();
    let p = w.period();
    let first = Holder::new(1);
    w.obtain(&first, p);
    // same source card, fresh derived key
    let again = Holder::new(1);
    let r = w.request(&again, p);
    assert_eq!((r["status"].as_str(), r["reject_reason"].as_str()), (Some("rejected"), Some("DERIVE_DUPLICATE")));
    assert!(r.get("derived_offer").is_none());
    // the same master card after a key rotation has another pointer and the same root key: the same tag
    w.net.oracle.0.lock().unwrap().sources.insert(pointer(100), source(1, json!({ "level": "gold", "policy_id": SOURCE })));
    let rotated = Holder::new(100);
    assert_eq!(w.request(&rotated, p)["reject_reason"], "DERIVE_DUPLICATE", "a key rotation doesn't make a fresh source card");
    // someone else is fine
    assert_eq!(w.request(&Holder::new(2), p)["status"], "accepted");
    // a different source policy would make a different tag: the same root key under another policy is another card
    // (the tag takes the source policy as input; see `dup_tag_is_keyed_by_root_key_policy_period_and_template_key`)
}

/// D1: the current period, or the next one only inside the renewal window; the renewed card has a fresh key, the next
/// period's tag and expires one period later.
#[test]
fn the_period_is_the_current_one_or_the_next_inside_the_renewal_window() {
    let mut w = World::new();
    let p = w.period();
    let h = Holder::new(1);
    for bad in [p + 1, p + 2, p.wrapping_sub(1)] {
        assert_eq!(w.request(&Holder::new(7), bad)["reject_reason"], "DERIVE_PERIOD_INVALID", "target {bad} at the start of period {p}");
    }
    let first = w.obtain(&h, p);
    // the renewal window is the last six hours of the period
    let window = (p as i64 + 1) * PERIOD - 6 * 3_600_000;
    w.net.advance(window - w.net.now - 1000, 600_000);
    let still = Holder::new(8);
    assert_eq!(w.request(&still, p + 1)["reject_reason"], "DERIVE_PERIOD_INVALID", "one second before the window");
    w.net.advance(2000, 1000);
    // renewal: the holder presents the same source card again for period p + 1, with a fresh key
    let renewed = Holder::new(1);
    let r = w.obtain(&renewed, p + 1);
    let (a, b) = (&first["derived_offer"], &r["derived_offer"]);
    assert_ne!(a["dup_tag"], b["dup_tag"], "tags change every period, so cards in different periods can't be linked");
    assert_eq!(b["expires_at"], formats::format_timestamp((p as i64 + 2) * PERIOD).as_str());
    // a second card for the same period p + 1 is a duplicate
    assert_eq!(w.request(&Holder::new(1), p + 1)["reject_reason"], "DERIVE_DUPLICATE");
    // and still, in the window, period p is allowed for those who haven't one
    assert_eq!(w.request(&Holder::new(2), p)["status"], "accepted");
}

/// D2: a derived key that has appeared in any accepted input is never accepted again, for another source card.
#[test]
fn a_derived_key_cannot_be_reused() {
    let mut w = World::new();
    let p = w.period();
    let (a, mut b) = (Holder::new(1), Holder::new(2));
    w.obtain(&a, p);
    b.d = MlDsaKey::from_seed(notary_crypto::SecretBytes::from_vec(a.d.seed().expose().to_vec())).unwrap(); // b brings a's key
    b.kept.borrow_mut().clear();
    assert_eq!(w.request(&b, p)["reject_reason"], "DERIVE_KEY_REUSED");
    // a resubmission of the very same signed input is not a reuse: it is the same request
    let ann = w.ann();
    let again = Holder::new(3);
    let input = w.ask_input(&ann, &again, p);
    let r1 = w.net.submit(0, &input).unwrap();
    let resealed = w.net.seal_plain(&ann, &input.input);
    let r2 = w.net.submit(0, &resealed).unwrap();
    assert_eq!((r1["status"].as_str(), r2["status"].as_str()), (Some("accepted"), Some("accepted")));
    assert_eq!(r1["derived_offer"], r2["derived_offer"], "the same offer, though the input was re-sealed");
}

/// The anonymity-set rule: a card is released only when at least `min_anonymity_set` distinct tags share its group
/// (source policy, projected values, period), the batch holds `min_batch_size` cards, and the source-policy snapshot lists
/// at least that many cards. Short of that, nothing is registered and the offers go stale.
#[test]
fn a_group_below_the_anonymity_set_is_not_released() {
    let mut w = World::new();
    let p = w.period();
    // two members share a value: a group of two, below three
    let (h1, h2) = (Holder::new(1), Holder::new(2));
    w.obtain(&h1, p);
    w.obtain(&h2, p);
    let b1 = w.boundary_after(w.net.now);
    w.net.advance(b1 - w.net.now + 1000, 300_000);
    assert!(w.net.registry.cards.is_empty(), "a group of two is not released");
    assert!(w.log().iter().all(|r| r["kind"] != "issued"), "and no `issued` record is written");
    // their offers' boundary passed: a countersign of the old offer is refused (stale), a resubmission gets a new boundary
    let r = w.request(&h1, p);
    assert_eq!(r["status"], "accepted", "the same signed request again: {r}");
    let b2 = w.boundary_after(w.net.now);
    assert_eq!(r["derived_offer"]["issued_at"], formats::format_timestamp(b2).as_str(), "a fresh offer for the next boundary");
    w.countersign(&h1, &r);
    let r2 = w.request(&h2, p);
    w.countersign(&h2, &r2);
    // a third joins before the boundary: now three share the group
    w.obtain(&Holder::new(3), p);
    w.net.advance(b2 - w.net.now + 1000, 300_000);
    assert_eq!(w.net.registry.cards.len(), 3, "three share the group, so all three are released");
    assert_eq!(registered(&w, &h1).is_some() && registered(&w, &h2).is_some(), true);
}

/// Groups are by value: three holders with three different values form three groups of one, so nothing is released even
/// though the batch is large.
#[test]
fn people_with_rare_values_are_not_released_and_the_old_offer_cannot_be_countersigned_late() {
    let mut w = World::new();
    let p = w.period();
    {
        let mut s = w.net.oracle.0.lock().unwrap();
        for (m, level) in [(1u8, "gold"), (2, "silver"), (3, "bronze"), (4, "gold")] {
            s.sources.insert(pointer(m), source(m, json!({ "level": level, "policy_id": SOURCE })));
        }
    }
    let hs: Vec<Holder> = (1..=4).map(Holder::new).collect();
    let mut receipts = vec![];
    for h in &hs {
        receipts.push(w.obtain(h, p));
    }
    assert_ne!(receipts[0]["derived_offer"]["projected"], receipts[1]["derived_offer"]["projected"], "projected values differ");
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    assert!(w.net.registry.cards.is_empty(), "groups of two, one and one: none reaches three");
    // the boundary has passed: countersigning the offer now is refused
    let late = w.net.seal_plain(&w.ann(), &hs[0].countersign(&b64u::encode(&jcs::h_bytes(&w.ann()["job"]).unwrap()), &receipts[0]["derived_offer"]));
    let r = w.net.submit(0, &late).unwrap();
    assert_eq!((r["status"].as_str(), r["reject_reason"].as_str()), (Some("rejected"), Some("DERIVE_OFFER_STALE")));
}

/// A group that already has released members counts them: later arrivals join a qualifying group, but the batch still has
/// to hold `min_batch_size` cards; and the second floor, the source-policy snapshot's size, holds a release back.
#[test]
fn released_members_count_toward_the_set_and_the_snapshot_is_a_second_floor() {
    let mut w = World::new();
    let p = w.period();
    for m in 1..=3 {
        w.obtain(&Holder::new(m), p);
    }
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    assert_eq!(w.net.registry.cards.len(), 3);
    // one more: the group would be four, but a batch of one is below min_batch_size, so it waits
    let late = Holder::new(4);
    w.obtain(&late, p);
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    assert_eq!(w.net.registry.cards.len(), 3, "a batch of one is held");
    // two more arrive; the late one asks again (its offer went stale), and the batch of three goes
    let r = w.request(&late, p);
    w.countersign(&late, &r);
    w.obtain(&Holder::new(5), p);
    // the snapshot lists only two cards: the second floor holds everything back
    w.net.oracle.0.lock().unwrap().snapshot_cards = Some(2);
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    assert_eq!(w.net.registry.cards.len(), 3, "the snapshot lists fewer than min_anonymity_set cards");
    w.net.oracle.0.lock().unwrap().snapshot_cards = Some(50);
    for h in [&late] {
        let r = w.request(h, p);
        w.countersign(h, &r);
    }
    let r5 = w.request(&Holder::new(5), p); // same signed input would be needed; a fresh holder is a duplicate
    assert_eq!(r5["reject_reason"], "DERIVE_DUPLICATE");
}

/// A card still pooled when its period ends is dropped and registers nowhere; a new period starts clean.
#[test]
fn cards_still_waiting_when_the_period_ends_are_dropped() {
    let mut w = World::new();
    let p = w.period();
    let (h1, h2) = (Holder::new(1), Holder::new(2));
    w.obtain(&h1, p);
    w.obtain(&h2, p);
    w.net.advance((p as i64 + 1) * PERIOD - w.net.now + 3_600_000, 1_800_000);
    assert!(w.net.registry.cards.is_empty(), "never released");
    // the next period: the same people may ask again
    let np = w.period();
    assert_eq!(np, p + 1);
    assert_eq!(w.request(&Holder::new(1), np)["status"], "accepted");
}

/// The job key rotates every `key_period`: a new epoch is written, announced after its anchor, the old key still opens
/// inputs for an hour and is then erased.
#[test]
fn the_job_key_rotates_each_key_period_with_an_hour_of_grace() {
    let mut w = World::new();
    let ann0 = w.ann();
    assert_eq!(ann0["epoch"], 0);
    let p = w.period();
    // an hour after opens_at the key rotates
    w.net.advance(60 * 60_000 + 1000, 60_000);
    let ann1 = w.ann();
    assert_eq!((ann1["epoch"].as_u64(), ann1["epoch_reason"].as_str()), (Some(1), Some("key_period")));
    assert_ne!(ann1["job_public_key"], ann0["job_public_key"]);
    assert!(ann1["prev_announcement"].is_string());
    let rec = w.log().into_iter().filter(|r| r["kind"] == "epoch_started").last().unwrap();
    assert_eq!(rec["body"], json!({ "epoch": 1, "epoch_reason": "key_period" }));
    // inputs sealed to either epoch are opened during the grace hour; the receipt names the input's epoch
    let (h_old, h_new) = (Holder::new(1), Holder::new(2));
    let job_hash = b64u::encode(&jcs::h_bytes(&ann0["job"]).unwrap());
    let old = w.net.seal_plain(&ann0, &h_old.input(&w.net, &job_hash, p));
    assert_eq!(w.net.submit(0, &old).unwrap()["epoch"], 0);
    let new = w.net.seal_plain(&ann1, &h_new.input(&w.net, &job_hash, p));
    assert_eq!(w.net.submit(0, &new).unwrap()["epoch"], 1);
    assert_eq!(w.net.nodes[0].broker.job_epochs_for_tests(&jcs::h_bytes(&ann0["job"]).unwrap()), vec![0, 1]);
    // an hour on: K_job,0 is erased (and the key rotates again)
    w.net.advance(60 * 60_000, 60_000);
    let hash = jcs::h_bytes(&ann0["job"]).unwrap();
    assert!(!w.net.nodes[0].broker.job_epochs_for_tests(&hash).contains(&0), "epoch 0 key erased");
    let stale = w.net.seal_plain(&ann0, &Holder::new(3).input(&w.net, &job_hash, p));
    assert_eq!(w.net.submit(0, &stale), Err("INPUT_UNDECRYPTABLE".into()));
    assert!(w.ann()["epoch"].as_u64().unwrap() >= 2, "and the next epoch followed");
}

/// The job refuses what v1 doesn't do, with the codes the specs give: a source kind other than `card` and `escrowed_link`
/// (algorithm A), `sealed_link` and replica sets until 6.5, protocol fields in `projected_fields`, no template key.
#[test]
fn refusals_at_job_creation() {
    let new_job = |w: &mut World, tweak: &dyn Fn(&mut Value), nonce: u8| {
        let mut job = w.job.clone();
        job.as_object_mut().unwrap().remove("requester_signature");
        job["nonce"] = json!(b64u::encode(&[nonce; 16]));
        tweak(&mut job);
        job["requester_signature"] = w.requester.sign_object(&job, "requester_signature").unwrap();
        w.net.create_job(0, &job)
    };
    let mut w = World::new();
    let code = |out: &[Value]| out.iter().find(|m| m["kind"] == "job_rejected" || m["kind"] == "error").map(|m| m["code"].as_str().unwrap().to_string());
    // protocol fields never project (they would hand the holder's key or signatures to a verifier)
    for bad in ["recipient_pubkey", "past_keys", "issuer_signature", "dup_tag"] {
        let out = new_job(&mut w, &|j| j["parameters"]["projected_fields"] = json!([bad]), 2);
        assert_eq!(code(&out).as_deref(), Some("JOB_PARAMETERS_OUT_OF_BOUNDS"), "{bad}");
    }
    // the bounds: at most three fields, names in the field-name form, distinct, at least one
    for fields in [json!([]), json!(["a", "b", "c", "d"]), json!(["Level"]), json!(["a", "a"]), json!("level")] {
        let out = new_job(&mut w, &|j| j["parameters"]["projected_fields"] = fields.clone(), 3);
        assert_eq!(code(&out).as_deref(), Some("JOB_PARAMETERS_OUT_OF_BOUNDS"), "{fields}");
    }
    // key_period and ends_at are required, and within bounds
    assert_eq!(code(&new_job(&mut w, &|j| j["key_period"] = json!("PT1M"), 4)).as_deref(), Some("JOB_MALFORMED"));
    // two replicas: the state blob is step 6.5
    let card = w.card.clone();
    assert_eq!(code(&new_job(&mut w, &|j| { j["replica_set"] = json!([{ "instances": 3, "notary_card": card }]); j["min_live"] = json!(2); }, 5)).as_deref(), Some("NH_UNSUPPORTED"));

    // the source-kind refusal: a policy with web_evidence (and escrowed_link) is refused by algorithm A, so no key exists
    let web = json!({ "derived_card": { "issuance_batch_interval": "PT1H", "min_anonymity_set": 3, "min_batch_size": 2, "nullifier_period": "P1D", "renewal_window": "PT6H", "source_kind": "web_evidence" } });
    let (c, net, job_hash) = World::with_raw(template(web));
    assert_eq!(c.as_deref(), Some("ADM_FEATURE_UNSUPPORTED"), "source_kind web_evidence");
    assert!(net.nodes[0].broker.job_epochs_for_tests(&job_hash).is_empty(), "no job key before admission");
    assert!(net.announcement(&hex_job(&job_hash)).is_none());
    let (c, _, _) = World::with_raw(template(json!({ "revocation_propagation": { "mode": "escrowed_link" } })));
    assert_eq!(c.as_deref(), Some("ADM_FEATURE_UNSUPPORTED"), "escrowed_link");
    // sealed_link is served since 6.5 (propagation.rs); its parameters are checked against their bounds
    let (c, net, job_hash) = World::with_raw(template(json!({ "revocation_propagation": { "mode": "sealed_link" } })));
    assert_eq!(c, None, "sealed_link is accepted");
    assert!(!net.nodes[0].broker.job_epochs_for_tests(&job_hash).is_empty());
    let (c, _, _) = World::with_raw(template(json!({ "revocation_propagation": { "mode": "sealed_link", "min_delay": "PT10M" } })));
    assert_eq!(c.as_deref(), Some("JOB_MALFORMED"), "min_delay below one hour");
    let (c, _, _) = World::with_raw(template(json!({ "revocation_propagation": { "mode": "sealed_link", "derived_code": 301 } })));
    assert_eq!(c.as_deref(), Some("JOB_MALFORMED"), "a fixed derived code must be a revocation code");
    // and a policy that is not a card policy at all is not accepted as one
    let (c, _, _) = World::with_raw(template(json!({ "output_action": "statement" })));
    assert_eq!(c.as_deref(), Some("NH_UNSUPPORTED"));
}

fn hex_job(h: &[u8; 32]) -> String {
    b64u::encode(h)
}

impl World {
    /// Creates the world but returns the job's first answer code instead of asserting it was keyed.
    fn with_raw(t: (Vec<u8>, Value)) -> (Option<String>, Net, [u8; 32]) {
        let (module, notary) = t;
        let mut net = Net::new_with(&[rt(X, "c1")], module, notary);
        let a = net.add_node("a", X);
        let card = net.genesis(a);
        {
            let mut s = net.oracle.0.lock().unwrap();
            s.policy_key = MlDsaKey::generate().public_key().to_vec();
        }
        net.call(a, json!({ "kind": "seed_template", "req_id": "seed", "template": T, "notary_card": card, "nullifier_period": "P1D" }));
        let requester = MlDsaKey::generate();
        let mut job = json!({
            "created_at": formats::format_timestamp(T0), "ends_at": formats::format_timestamp(T0 + 3 * PERIOD), "kem": "x-wing-draft-06", "key_period": "PT1H", "min_live": 1,
            "nonce": b64u::encode(&[1u8; 16]), "opens_at": formats::format_timestamp(OPENS), "parameters": { "projected_fields": ["level"], "source_policy": SOURCE },
            "policy_id": T, "policy_state_cid": "bafkreistate", "replica_set": [{ "instances": 1, "notary_card": card }],
            "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1",
        });
        job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
        let out = net.create_job(0, &job);
        let code = out.iter().find(|m| m["kind"] == "job_rejected" || m["kind"] == "error").map(|m| m["code"].as_str().unwrap().to_string());
        (code, net, jcs::h_bytes(&job).unwrap())
    }
}

/// Without a template key there is no job (propagation Preconditions); the key is seeded once.
#[test]
fn a_job_needs_the_template_key_and_the_key_is_seeded_once() {
    let (module, notary) = template(json!({}));
    let mut net = Net::new_with(&[rt(X, "c1")], module, notary);
    let a = net.add_node("a", X);
    let card = net.genesis(a);
    net.oracle.0.lock().unwrap().policy_key = MlDsaKey::generate().public_key().to_vec();
    let requester = MlDsaKey::generate();
    let mut job = json!({
        "created_at": formats::format_timestamp(T0), "ends_at": formats::format_timestamp(T0 + 3 * PERIOD), "kem": "x-wing-draft-06", "key_period": "PT1H", "min_live": 1,
        "nonce": b64u::encode(&[1u8; 16]), "opens_at": formats::format_timestamp(OPENS), "parameters": { "projected_fields": ["level"], "source_policy": SOURCE },
        "policy_id": T, "policy_state_cid": "bafkreistate", "replica_set": [{ "instances": 1, "notary_card": card }],
        "requester_card": formats::card_pointer(requester.public_key()), "requester_pubkey": b64u::encode(requester.public_key()), "type": "notary.job.v1",
    });
    job["requester_signature"] = requester.sign_object(&job, "requester_signature").unwrap();
    let out = net.create_job(0, &job);
    assert_eq!(find(&out, "error").unwrap()["code"], "TEMPLATE_KEY_MISSING");
    let seed = |net: &mut Net| net.call(a, json!({ "kind": "seed_template", "req_id": "s", "template": T, "notary_card": card, "nullifier_period": "P1D" }));
    assert!(find(&seed(&mut net), "template_seeded").is_some());
    assert_eq!(find(&seed(&mut net), "error").unwrap()["code"], "TEMPLATE_KEY_EXISTS", "a second seed would split the tags across operators");
    assert!(find(&net.create_job(0, &job), "job_keyed").is_some());
    // a card this enclave doesn't hold can't be used to seed
    let other = net.call(a, json!({ "kind": "seed_template", "req_id": "s", "template": "bafkreiother", "notary_card": "ab".repeat(32), "nullifier_period": "P1D" }));
    assert_eq!(find(&other, "error").unwrap()["code"], "NOTARY_KEY_EXPOSED");
}

/// A source card that is revoked, or from another policy, or without a projected field, is not eligible.
#[test]
fn only_eligible_source_cards_get_an_offer() {
    let mut w = World::new();
    let p = w.period();
    w.net.oracle.0.lock().unwrap().revoked.insert(pointer(1));
    assert_eq!(w.request(&Holder::new(1), p)["reject_reason"], "INPUT_CARD_REVOKED");
    {
        let mut s = w.net.oracle.0.lock().unwrap();
        let mut other = source(2, json!({ "level": "gold", "policy_id": "bafkreiother" }));
        other.policy_id = "bafkreiother".into();
        s.sources.insert(pointer(2), other);
        s.sources.insert(pointer(3), source(3, json!({ "team": "red", "policy_id": SOURCE })));
        s.sources.insert(pointer(4), source(4, json!({ "level": ["gold"], "policy_id": SOURCE })));
    }
    for (m, why) in [(2u8, "a card of another policy"), (3, "no `level` field"), (4, "a field that isn't a scalar")] {
        assert_eq!(w.request(&Holder::new(m), p)["reject_reason"], "INPUT_NOT_ELIGIBLE", "{why}");
    }
    // none of them reserved a tag: a good card still gets its offer
    assert_eq!(w.request(&Holder::new(5), p)["status"], "accepted");
    // a derived key of the wrong size, or a revision other than 0
    let ann = w.ann();
    let job_hash = b64u::encode(&jcs::h_bytes(&ann["job"]).unwrap());
    let h = Holder::new(6);
    let mut bad = h.input(&w.net, &job_hash, p);
    bad["payload"]["derived_recipient_pubkey"] = json!(b64u::encode(&[1u8; 32]));
    let r = w.net.submit(0, &w.net.seal_plain(&ann, &bad)).unwrap();
    assert_eq!(r["reject_reason"], "INPUT_SCHEMA_INVALID");
    let mut rev = h.input(&w.net, &job_hash, p);
    rev["revision"] = json!(1);
    assert_eq!(w.net.submit(0, &w.net.seal_plain(&ann, &rev)).unwrap()["reject_reason"], "INPUT_REVISION_INVALID");
}

/// A countersign must be the derived key's signature over this offer: another key's, a made-up offer's, or one for an
/// offer the enclave never made is refused, and the card is not pooled.
#[test]
fn a_countersign_must_come_from_the_derived_key_over_the_enclaves_offer() {
    let mut w = World::new();
    let p = w.period();
    let h = Holder::new(1);
    let r = w.request(&h, p);
    let ann = w.ann();
    let job_hash = b64u::encode(&jcs::h_bytes(&ann["job"]).unwrap());
    let mut forged = h.countersign(&job_hash, &r["derived_offer"]);
    forged["holder_signature"] = json!(b64u::encode(&MlDsaKey::generate().sign(b"x")));
    let sub = |w: &mut World, m: &Value| w.net.submit(0, &w.net.seal_plain(&w.ann(), m)).unwrap();
    assert_eq!(sub(&mut w, &forged)["reject_reason"], "DERIVE_COUNTERSIGN_INVALID");
    let mut other = h.countersign(&job_hash, &r["derived_offer"]);
    other["offer_hash"] = json!(b64u::encode(&[9u8; 32]));
    assert_eq!(sub(&mut w, &other)["reject_reason"], "DERIVE_OFFER_UNKNOWN");
    // another holder's key signing this offer
    let stranger = Holder::new(2);
    assert_eq!(sub(&mut w, &stranger.countersign(&job_hash, &r["derived_offer"]))["reject_reason"], "DERIVE_COUNTERSIGN_INVALID");
    // a countersign for a different job
    let mut wrong = h.countersign(&job_hash, &r["derived_offer"]);
    wrong["job_hash"] = json!(b64u::encode(&[7u8; 32]));
    assert_eq!(sub(&mut w, &wrong)["reject_reason"], "INPUT_WRONG_JOB");
    // the right one is accepted, twice (idempotent)
    let ok = h.countersign(&job_hash, &r["derived_offer"]);
    assert_eq!(sub(&mut w, &ok)["status"], "accepted");
    assert_eq!(sub(&mut w, &ok)["status"], "accepted");
}

/// A failed registration is signed again with a fresh sequence, a few times; a card is never registered twice.
#[test]
fn a_failed_registration_is_signed_again_and_a_silent_host_only_delays() {
    let mut w = World::new();
    let p = w.period();
    let hs: Vec<Holder> = (1..=3).map(Holder::new).collect();
    for h in &hs {
        w.obtain(h, p);
    }
    // the host can't read the version or the sequence: nothing is released at this boundary (the offers go stale)
    w.net.registry.silent = true;
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    assert!(w.net.registry.cards.is_empty() && w.net.registry.submissions.is_empty());
    w.net.registry.silent = false;
    // asking again gives a new offer for the next boundary; the first submission of the batch fails once
    for h in &hs {
        let r = w.request(h, p);
        w.countersign(h, &r);
    }
    w.net.registry.fail_next = vec!["revert".into()];
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    assert_eq!(w.net.registry.cards.len(), 3, "the failed one was signed again and went through");
    assert!(w.net.registry.submissions.len() >= 4);
    let seqs: Vec<u64> = w.net.registry.submissions.iter().map(|m| m["payload"]["sequence"].as_u64().unwrap()).collect();
    assert!(seqs.iter().all(|s| *s < 4));
}

/// The enclave refuses to sign a derived-card job's registration with anything but what it was asked for: the calldata
/// the host is told to use equals the signed fields (so the write gate's check, §6.1 step 8, can pass), and the payload's
/// fields are in the registry's encodings.
#[test]
fn registration_payloads_are_bound_to_their_calldata_in_the_registrys_encodings() {
    let mut w = World::new();
    let p = w.period();
    for m in 1..=3 {
        w.obtain(&Holder::new(m), p);
    }
    let b = w.boundary_after(w.net.now);
    w.net.advance(b - w.net.now + 1000, 300_000);
    let subs = w.net.registry.submissions.clone();
    assert_eq!(subs.len(), 3);
    let tpub = w.net.oracle.0.lock().unwrap().policy_key.clone();
    for (i, m) in subs.iter().enumerate() {
        let pl = &m["payload"];
        assert_eq!(m["op"], "register_card");
        assert_eq!((pl["op"].as_str(), pl["sequence"].as_u64()), (Some("register_card"), Some(i as u64)));
        // bytes32 and CIDs are unpadded base64url, the CID as the UTF-8 bytes of its string (as the press writes it)
        assert_eq!(pl["policy_address"], b64u::encode(&notary_crypto::keccak256(&tpub)).as_str());
        assert_eq!(pl["press_address"], b64u::encode(&hex_bytes(&w.card)).as_str());
        let cid = String::from_utf8(b64u::decode(pl["initial_log_cid"].as_str().unwrap()).unwrap()).unwrap();
        assert!(w.net.ipfs.contains_key(&cid), "the pinned card");
        assert_eq!(pl["card_address"].as_str().unwrap().len(), 43);
        for f in ["card_address", "initial_log_cid", "policy_address", "press_address"] {
            assert_eq!(pl[f], m["calldata"][f], "{f}");
        }
    }
    // a host that changes the calldata is refused by the write gate (the gate here is the registry's step 8)
    let mut forged = subs[0].clone();
    forged["calldata"]["initial_log_cid"] = json!(b64u::encode(b"bafkreijunk"));
    assert_ne!(forged["payload"]["initial_log_cid"], forged["calldata"]["initial_log_cid"]);
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

/// `dup_tag = HMAC-SHA256(k_T,p, root_source_key || source_policy || p)` and the ratchet
/// `k_T,p = HKDF-SHA256(k_T,p-1, info = "card-notary-dup-tag-ratchet" || p)` (propagation §1), pinned with a vector that the
/// TypeScript check (`notary/vectors-tools`) reproduces.
#[test]
fn dup_tag_is_keyed_by_root_key_policy_period_and_template_key() {
    use notary_broker::derive::dup_tag;
    let k = [7u8; 32];
    let root = vec![3u8; 1312];
    let t = dup_tag(&k, &root, SOURCE, 100);
    assert_eq!(t, dup_tag(&k, &root, SOURCE, 100));
    assert_ne!(t, dup_tag(&k, &root, SOURCE, 101), "another period");
    assert_ne!(t, dup_tag(&k, &root, "bafkreiother", 100), "another source policy");
    assert_ne!(t, dup_tag(&k, &vec![4u8; 1312], SOURCE, 100), "another source card");
    assert_ne!(t, dup_tag(&[8u8; 32], &root, SOURCE, 100), "another template key");
    // the ratchet: one-way, and deriving forward step by step equals deriving at once
    let step = |prev: &[u8], p: u64| {
        let mut info = b"card-notary-dup-tag-ratchet".to_vec();
        info.extend_from_slice(&p.to_be_bytes());
        let mut out = [0u8; 32];
        notary_crypto::hkdf_sha256(prev, &[], &info, &mut out).unwrap();
        out
    };
    if std::env::var("NOTARY_WRITE_VECTORS").is_ok() {
        let k100 = [7u8; 32];
        let cases: Vec<Value> = [(100u64, SOURCE), (101, SOURCE), (100, "bafkreiother")]
            .iter()
            .map(|(p, sp)| {
                let key = if *p == 100 { k100 } else { step(&k100, *p) };
                json!({ "k_t_p": b64u::encode(&key), "root_source_key": b64u::encode(&root), "source_policy": sp, "period": p, "dup_tag": b64u::encode(&dup_tag(&key, &root, sp, *p)) })
            })
            .collect();
        let v = json!({ "about": "dup_tag (propagation §1). k_t_p of period 101 is the ratchet step from period 100's key. Written by notary-broker tests/derive.rs.", "ratchet_info": "card-notary-dup-tag-ratchet", "k_t_100": b64u::encode(&k100), "cases": cases });
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../vectors/dup_tag");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cases.json"), serde_json::to_string_pretty(&v).unwrap() + "\n").unwrap();
    }
    let k101 = step(&k, 101);
    assert_ne!(k101, k);
    assert_eq!(step(&k101, 102), step(&step(&k, 101), 102));
}

/// Two operators' enclaves share the template key by handoff, so the same source card gets the same tag from both
/// (propagation §1: duplicates are detected where the cards are used). When the runtime that held the key is retired as
/// vulnerable the chain is re-seeded as generation 1 by the clean enclave; the exposed key is kept to the period's end
/// only to catch duplicates already issued, and every period key before the current one is gone.
#[test]
fn operators_share_tags_by_template_handoff_and_an_exposed_chain_is_re_seeded() {
    const Y: u8 = 0x59;
    let (module, notary) = template(json!({}));
    let mut net = Net::new_with(&[rt(X, "c1"), rt(Y, "c1")], module, notary);
    let (a, b) = (net.add_node("a", X), net.add_node("b", Y));
    let (ca, cb) = (net.genesis(a), net.genesis(b));
    {
        let mut s = net.oracle.0.lock().unwrap();
        s.policy_key = MlDsaKey::generate().public_key().to_vec();
        s.snapshot_cards = Some(50);
        s.template_cards.insert((ca.clone(), T.into()));
        s.template_cards.insert((cb.clone(), T.into()));
        for m in 1..=8u8 {
            s.sources.insert(pointer(m), source(m, json!({ "level": "gold", "policy_id": SOURCE })));
        }
    }
    assert!(find(&net.call(a, json!({ "kind": "seed_template", "req_id": "s", "template": T, "notary_card": ca, "nullifier_period": "P1D" })), "template_seeded").is_some());
    // B has none: no job there
    let requester = MlDsaKey::generate();
    assert_eq!(find(&net.create_job(b, &derive_job(&cb, &requester, 2, &["level"], "P30D")), "error").unwrap()["code"], "TEMPLATE_KEY_MISSING");
    let to = net.instance(b);
    net.call(a, json!({ "kind": "start_handoff", "req_id": "t", "scope": "template", "template": T, "card": ca, "to_instance": to }));
    net.run();
    assert_eq!(net.nodes[b].broker.template_generation_for_tests(T), Some(0));
    let p = (net.now / PERIOD) as u64;
    assert_eq!(net.nodes[a].broker.template_key_fingerprint_for_tests(T, p), net.nodes[b].broker.template_key_fingerprint_for_tests(T, p), "one chain, held by both");
    assert!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, p + 1).is_some(), "later periods follow by the ratchet");
    assert_ne!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, p + 1), net.nodes[b].broker.template_key_fingerprint_for_tests(T, p));
    assert!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, p - 1).is_none(), "the key of an earlier period can't be recomputed");
    let (ja, jb) = (derive_job(&ca, &requester, 1, &["level"], "P30D"), derive_job(&cb, &requester, 2, &["level"], "P30D"));
    net.create_job(a, &ja);
    assert!(find(&net.create_job(b, &jb), "job_keyed").is_some());
    net.advance(60_000, 60_000);
    let (hja, hjb) = (jcs::h(&ja).unwrap(), jcs::h(&jb).unwrap());
    let (ann_a, ann_b) = (net.announcement(&hja).unwrap(), net.announcement(&hjb).unwrap());
    let ask = |net: &mut Net, node: usize, ann: &Value, h: &Holder, target: u64| {
        let jh = b64u::encode(&jcs::h_bytes(&ann["job"]).unwrap());
        let sealed = net.seal_plain(ann, &h.input(net, &jh, target));
        net.submit(node, &sealed).unwrap()
    };
    // the same source card, two operators: the same tag
    let (m1a, m1b) = (Holder::new(1), Holder::new(1));
    let (ra, rb) = (ask(&mut net, a, &ann_a, &m1a, p), ask(&mut net, b, &ann_b, &m1b, p));
    assert_eq!((ra["status"].as_str(), rb["status"].as_str()), (Some("accepted"), Some("accepted")));
    assert_eq!(ra["derived_offer"]["dup_tag"], rb["derived_offer"]["dup_tag"], "any notary serving T gives one source card one tag per period");
    assert_ne!(ra["derived_offer"]["issuer_card"], rb["derived_offer"]["issuer_card"], "though the issuers differ");
    let other = ask(&mut net, b, &ann_b, &Holder::new(2), p);
    assert_ne!(other["derived_offer"]["dup_tag"], rb["derived_offer"]["dup_tag"]);

    // the runtime that held the key first is retired as vulnerable: every key whose lineage includes it is exposed
    {
        let mut st = net.oracle.0.lock().unwrap();
        let mut rts = st.runtimes.clone();
        net.gov.emergency_retire(&mut rts, &[Runtime { seed: X, compat: "c1", retired: Some(("vulnerable", net.now - 1000)) }, rt(Y, "c1")]);
        st.runtimes = rts;
    }
    net.advance(120_000, 60_000);
    // A runs the vulnerable image: it can't re-seed, and it has no usable chain
    assert!(net.nodes[a].broker.template_key_fingerprint_for_tests(T, p).is_none());
    // B is clean: generation 1, a fresh random key (not derived from the exposed one)
    assert_eq!(net.nodes[b].broker.template_generation_for_tests(T), Some(1));
    assert!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, p).is_some());
    // the same source card asks again in this period, with a new derived key: still a duplicate, caught by the exposed key
    // that is kept to the end of the period for exactly this
    let again = ask(&mut net, b, &ann_b, &Holder::new(1), p);
    assert_eq!(again["reject_reason"], "DERIVE_DUPLICATE", "{again}");
    // others are issued under generation 1: their tags don't continue the exposed chain
    let g1 = ask(&mut net, b, &ann_b, &Holder::new(3), p);
    assert_eq!(g1["status"], "accepted");
    // the next period: the exposed key is gone, the old period's key too
    net.advance((p as i64 + 1) * PERIOD - net.now + 3_600_000, 1_800_000);
    assert!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, p).is_some(), "a period's key is kept until the period plus the renewal window has passed");
    net.advance(6 * 3_600_000, 1_800_000);
    let np = (net.now / PERIOD) as u64;
    assert!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, np).is_some());
    assert!(net.nodes[b].broker.template_key_fingerprint_for_tests(T, p).is_none(), "the erased period's key can't be recomputed from the later one");
}

/// Two clean enclaves that each seeded generation 0 settle on one key when they meet: the key whose SHA-256 is lower wins
/// on both sides.
#[test]
fn two_seeds_of_one_generation_settle_on_the_lower_hash() {
    let (module, notary) = template(json!({}));
    let mut net = Net::new_with(&[rt(X, "c1")], module, notary);
    let (a, b) = (net.add_node("a", X), net.add_node("b", X));
    let (ca, cb) = (net.genesis(a), net.genesis(b));
    {
        let mut s = net.oracle.0.lock().unwrap();
        s.template_cards.insert((ca.clone(), T.into()));
        s.template_cards.insert((cb.clone(), T.into()));
    }
    for (n, c) in [(a, &ca), (b, &cb)] {
        assert!(find(&net.call(n, json!({ "kind": "seed_template", "req_id": "s", "template": T, "notary_card": c, "nullifier_period": "P1D" })), "template_seeded").is_some());
    }
    let p = (net.now / PERIOD) as u64;
    let fp = |net: &Net, n: usize| net.nodes[n].broker.template_key_fingerprint_for_tests(T, p);
    let (fa, fb) = (fp(&net, a), fp(&net, b));
    assert_ne!(fa, fb, "two independent seeds");
    let lower = fa.min(fb);
    for (from, to, card, i) in [(a, b, &ca, 0), (b, a, &cb, 1)] {
        let inst = net.instance(to);
        net.call(from, json!({ "kind": "start_handoff", "req_id": format!("h{i}"), "scope": "template", "template": T, "card": card, "to_instance": inst }));
        net.run();
    }
    assert_eq!((fp(&net, a), fp(&net, b)), (lower, lower), "both hold the lower-hash chain");
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 6.5: revocation propagation (derived_card_revocation_propagation.md §5–§7) and the state blob (replication §8)

/// A `sealed_link` template with short timing: a one-hour minimum delay, hourly windows, batches of at least two.
fn sealed(over: Value) -> (Vec<u8>, Value) {
    let mut rp = json!({ "batch_window": "PT1H", "min_delay": "PT1H", "min_revocation_batch": 2, "mode": "sealed_link" });
    for (k, v) in over.as_object().cloned().unwrap_or_default() {
        rp[k] = v;
    }
    template(json!({ "revocation_propagation": rp }))
}

const HOUR: i64 = 3_600_000;

impl World {
    /// Holders `members` obtain cards for this period, and the batch is released and registered.
    fn issue(&mut self, members: &[u8]) -> Vec<Holder> {
        let p = self.period();
        let hs: Vec<Holder> = members.iter().map(|m| Holder::new(*m)).collect();
        for h in &hs {
            self.obtain(h, p);
        }
        let b = self.boundary_after(self.net.now);
        self.net.advance(b - self.net.now + 1000, 300_000);
        for h in &hs {
            assert!(registered(self, h).is_some(), "member {} registered", h.member);
        }
        hs
    }

    /// The source card of `member` gets a new log entry with `code` (and `card_state`): the host relays the registry's
    /// `CardHeadUpdated` with the new head's bytes, encrypted under the source card's content key, to node `i`.
    fn source_update(&mut self, i: usize, member: u8, code: u32, card_state: Value) {
        self.source_update_by(i, member, code, card_state, &test_press(1));
    }

    /// As `source_update`, with the entry's `press_signature` by `press`.
    fn source_update_by(&mut self, i: usize, member: u8, code: u32, card_state: Value, press: &MlDsaKey) {
        let mut entry = json!({ "card_state": card_state, "code": code, "entry_type": if code >= 800 { "revocation" } else { "field_update" }, "version": 2 });
        entry["press_signature"] = press.sign_object(&entry, "press_signature").unwrap();
        let enc = notary_cards::support::aes_gcm_encrypt(&notary_cards::support::content_key(&source_pubkey(member)), &jcs::canonical(&entry).unwrap());
        let cid = formats::cid_of_bytes(&enc);
        let at = formats::format_timestamp(self.net.now);
        let upd = json!({ "card_address": pointer(member), "head_cid": cid, "bytes": b64u::encode(&enc), "timestamp": at, "block": 10 });
        self.net.call(i, json!({ "kind": "policy_updates", "req_id": "u", "policy_address": SOURCE, "updates": [upd] }));
        self.net.run();
    }

    /// The revocation entry now at the head of a derived card, opened with the holder's content key.
    fn revocation_of(&self, h: &Holder) -> Option<Value> {
        let cid = registered(self, h)?;
        let enc = self.net.ipfs.get(&cid)?;
        let plain = notary_cards::support::aes_gcm_decrypt(&notary_cards::support::content_key(h.d.public_key()), enc)?;
        let v: Value = jcs::parse_canonical(&plain).ok()?;
        (v["entry_type"] == "revocation").then_some(v)
    }

    fn state(&self, i: usize) -> (u64, bool, Option<String>) {
        self.net.nodes[i].broker.state_for_tests(&self.card).expect("identity held")
    }
}

/// §6–§7, the whole path: links are made at release; a field update does nothing; an 8xx and a 9xx of two source cards
/// queue revocations that wait `min_delay`, then go out together at the next window as one `BatchUpdateCardHeads`
/// (signed by `K_chain`, bound to its calldata), each a revocation `LogEntry` with the mapped code (820, 920; never the
/// source subcode), signed by `K_id` twice, no note, under the derived card's content key. Cards whose source wasn't
/// revoked are untouched.
#[test]
fn a_source_revocation_is_propagated_within_the_batching_window_with_the_mapped_code() {
    let mut w = World::with(sealed(json!({})), &["level"], |_| {});
    let hs = w.issue(&[1, 2, 3, 4]);
    let card = w.card.clone();
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 0), "one sealed link per released card");
    let genesis: Vec<String> = hs.iter().map(|h| registered(&w, h).unwrap()).collect();
    let v_issued = w.state(0).0;
    assert!(v_issued >= 1, "a state blob after the issuance batch");

    // a field update of a linked source card is not a revocation
    w.source_update(0, 3, 300, json!({ "level": "gold" }));
    // a revocation of an unlinked card under the policy changes nothing either
    w.source_update(0, 7, 801, json!({}));
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 0));

    // the revocations land ten minutes before a window boundary
    let nb = (w.net.now / HOUR + 1) * HOUR;
    w.net.advance(nb - 10 * 60_000 - w.net.now, 300_000);
    w.source_update(0, 1, 803, json!({}));
    w.source_update(0, 2, 905, json!({}));
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 2), "two revocations queued");
    // that boundary passes: they are not eligible yet (min_delay), so nothing goes out with it
    w.net.advance(HOUR / 2, 300_000);
    assert!(w.net.registry.batches.is_empty(), "nothing is released before min_delay");
    // eligible after an hour; released at the next window boundary
    w.net.advance(2 * HOUR, 300_000);
    assert_eq!(w.net.registry.batches.len(), 1, "one transaction for the window");
    let batch = &w.net.registry.batches[0];
    assert_eq!(batch["updates"].as_array().unwrap().len(), 2);
    let sub = w.net.registry.submissions.iter().find(|s| s["op"] == "batch_update_card_heads").unwrap();
    let pb = &sub["propagation_batch"];
    assert_eq!((pb["type"].as_str(), pb["policy_id"].as_str(), pb["notary_card"].as_str()), (Some("notary.propagation_batch.v1"), Some(T), Some(card.as_str())));
    assert_eq!(pb["chain_payload"], sub["payload"]);

    let kid = w.net.nodes[0].broker.identity_pubkey_for_tests(&card).unwrap();
    for (h, (want, g)) in hs.iter().zip([(Some(820), &genesis[0]), (Some(920), &genesis[1]), (None, &genesis[2]), (None, &genesis[3])]) {
        let rev = w.revocation_of(h);
        assert_eq!(rev.as_ref().and_then(|r| r["code"].as_u64()), want.map(|c| c as u64), "member {}", h.member);
        let Some(r) = rev else {
            assert_eq!(registered(&w, h).as_ref(), Some(g), "untouched");
            continue;
        };
        assert_eq!(r["prev_log_root"], g.as_str());
        assert_eq!(r["history"], json!([g]));
        assert!(r["revocation"].get("note").is_none(), "no note");
        assert_eq!(r["notify_holder"], true);
        assert!(r["revocation"]["effective_date"].is_string());
        assert_eq!(r["card_state"]["source_policy"], SOURCE);
        // both signatures by K_id: the intent, and the entry without press_signature
        for f in ["intent_signature", "press_signature"] {
            assert_eq!(r[f]["public_key"], b64u::encode(&kid).as_str());
        }
        let press = b64u::decode(r["press_signature"]["signature"].as_str().unwrap()).unwrap();
        assert!(notary_crypto::mldsa_verify(&kid, &jcs::canonical(&jcs::without_fields(&r, &["press_signature"])).unwrap(), &press));
    }
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (2, 0), "revoked cards' links end");
    write_fixture(&w, &hs, "revoked.json", json!({ "about": "Written by notary-broker tests/derive.rs with NOTARY_WRITE_VECTORS=1: four derived cards issued under sealed_link, then two revoked by propagation (820, 920).", "revoked": [820, 920, null, null] }));
    assert!(w.state(0).0 > v_issued, "a new state blob after the propagation batch");
    // nothing is released again
    w.net.advance(2 * HOUR, 300_000);
    assert_eq!(w.net.registry.batches.len(), 1);
}

/// §7 steps 2–3: below `min_revocation_batch` everything is held; a held revocation whose derived card expires is dropped
/// with its link, without any event.
#[test]
fn revocations_below_the_minimum_batch_are_held_and_dropped_at_expiry() {
    let mut w = World::with(sealed(json!({})), &["level"], |_| {});
    let _hs = w.issue(&[1, 2, 3, 4]);
    let card = w.card.clone();
    w.source_update(0, 1, 801, json!({}));
    w.net.advance(4 * HOUR, 300_000);
    assert!(w.net.registry.batches.is_empty(), "one eligible revocation is below the minimum batch of two");
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 1), "held");
    // the period ends: every card of the period expires, and so do the links and the held revocation
    let end = (w.period() as i64 + 1) * PERIOD;
    w.net.advance(end - w.net.now + 1000, 1_800_000);
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (0, 0));
    assert!(w.net.registry.batches.is_empty(), "expiry did it without an event");
}

/// §6 step 3 (E2, decided by David 2026-11-19) and the code mapping. After the holder names a successor under the same
/// source policy (100/101), only the rotation flow's own revocations, 801 and 810, are not propagated (the link ends; the
/// card lapses at expiry). An issuer's 800 is propagated even after a successor; a 9xx always is; the issuer's 102
/// (pending, cancellable) sets no successor; a successor under another policy doesn't count. A template's fixed
/// `derived_code` is posted for every propagated revocation.
#[test]
fn the_successor_rule_and_a_fixed_derived_code() {
    let mut w = World::with(sealed(json!({ "derived_code": 830 })), &["level"], |_| {});
    let hs = w.issue(&[1, 2, 3, 4, 5, 6, 7, 8]);
    let card = w.card.clone();
    w.net.oracle.0.lock().unwrap().card_policies.insert(pointer(9), SOURCE.into());
    let s9 = json!({ "successor": pointer(9) });
    // 1, 2: the holder's rotation, then the rotation flow's surrender (801) or compromise (810): not propagated
    w.source_update(0, 1, 101, s9.clone());
    w.source_update(0, 1, 801, s9.clone());
    w.source_update(0, 2, 100, s9.clone());
    w.source_update(0, 2, 810, s9.clone());
    // 3: a successor, then the issuer's "role ended" (800): propagated, so a successor can't dodge an issuer
    w.source_update(0, 3, 100, s9.clone());
    w.source_update(0, 3, 800, s9.clone());
    // 4: a successor, then a loud revocation: always propagated
    w.source_update(0, 4, 101, s9.clone());
    w.source_update(0, 4, 901, s9.clone());
    // 5: the issuer's recovery rotation (102) sets no successor
    w.source_update(0, 5, 102, s9.clone());
    w.source_update(0, 5, 801, s9.clone());
    // 6: a successor under another policy is no rotation within the source policy
    w.source_update(0, 6, 100, json!({ "successor": pointer(10) }));
    w.source_update(0, 6, 801, json!({ "successor": pointer(10) }));
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (6, 4), "members 1 and 2's links ended; 3, 4, 5, 6 queued");
    w.net.advance(3 * HOUR, 300_000);
    assert_eq!(w.net.registry.batches.len(), 1);
    let codes: Vec<Option<u64>> = hs.iter().map(|h| w.revocation_of(h).and_then(|r| r["code"].as_u64())).collect();
    assert_eq!(codes, vec![None, None, Some(830), Some(830), Some(830), Some(830), None, None], "the fixed code, never the source subcode");
}

/// §5, `expiry_only`: no link is kept, not even while a card waits in the pool; a source revocation causes no event; the
/// card states its expiry (the period's end, the same for every card of the period); and a revoked source card can't be
/// presented again, so the holder can't renew.
#[test]
fn expiry_only_keeps_no_link_and_the_card_lapses_at_expiry() {
    let mut w = World::new();
    let p = w.period();
    let hs = w.issue(&[1, 2, 3, 4]);
    let card = w.card.clone();
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (0, 0), "expiry_only keeps no link");
    w.source_update(0, 1, 905, json!({}));
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (0, 0));
    w.net.advance(3 * HOUR, 300_000);
    assert!(w.net.registry.batches.is_empty(), "no propagation event under expiry_only");
    // the registered card lapses at the end of its period
    let cid = registered(&w, &hs[0]).unwrap();
    let plain = notary_cards::support::aes_gcm_decrypt(&notary_cards::support::content_key(hs[0].d.public_key()), &w.net.ipfs[&cid]).unwrap();
    let doc: Value = jcs::parse_canonical(&plain).unwrap();
    assert_eq!(doc["expires_at"], formats::format_timestamp((p as i64 + 1) * PERIOD).as_str());
    // inside the renewal window, the revoked source card can't be presented for the next period
    w.net.oracle.0.lock().unwrap().revoked.insert(pointer(1));
    let window = (p as i64 + 1) * PERIOD - 6 * HOUR;
    w.net.advance(window - w.net.now + 60_000, 1_800_000);
    let again = Holder::new(1);
    let r = w.request(&again, p + 1);
    assert_eq!((r["status"].as_str(), r["reject_reason"].as_str()), (Some("rejected"), Some("INPUT_CARD_REVOKED")), "{r}");
    // an unrevoked holder renews
    assert_eq!(w.request(&Holder::new(2), p + 1)["status"], "accepted");
}

fn identity_to(net: &mut Net, from: usize, to: usize, card: &str) {
    let to_inst = net.instance(to);
    let out = net.call(from, json!({ "kind": "start_handoff", "req_id": "sh", "scope": "identity", "card": card, "to_instance": to_inst }));
    assert!(find(&out, "handoff_started").is_some(), "{out:?}");
    net.run();
    net.nodes[to].card = card.to_string();
    net.nodes[to].chain_pubkey = net.nodes[from].chain_pubkey.clone();
}

/// Replication §8: the identity leader (the holder serving the derived-card job) writes a blob after each batch; another
/// holder learns the version by heartbeat and loads it. A host that serves an old blob in place of the new one is caught:
/// the holder stays where it was and never goes back. A new holder by handoff loads only the exact blob its handoff named,
/// and until it has, it opens no derived-card job. When the leader dies, a holder with the blob takes over the watch loop:
/// the links survive the enclave.
#[test]
fn the_state_blob_survives_the_enclave_and_a_rolled_back_blob_is_refused() {
    let mut w = World::with(sealed(json!({})), &["level"], |_| {});
    let card = w.card.clone();
    let b = w.net.add_node("b", X);
    w.net.directory();
    identity_to(&mut w.net, 0, b, &card);
    w.net.advance(60_000, 30_000);
    assert_eq!(w.state(b), (0, true, None), "nothing written yet");
    assert!(w.net.nodes[0].broker.is_identity_leader_for_tests(&card), "the holder serving the derived-card job leads");
    assert!(!w.net.nodes[b].broker.is_identity_leader_for_tests(&card));

    let hs = w.issue(&[1, 2, 3, 4]);
    let (v1, _, h1) = w.state(0);
    let h1 = h1.expect("a header");
    w.net.advance(60_000, 30_000);
    assert_eq!(w.state(b), (v1, true, Some(h1.clone())), "the other holder loaded the blob from a heartbeat");
    assert_eq!(w.net.nodes[b].broker.links_for_tests(&card), (4, 0), "with the links");

    // a revocation goes out, and a new blob is written (v2)
    w.source_update(0, 1, 801, json!({}));
    w.source_update(0, 2, 801, json!({}));
    let real: std::collections::BTreeMap<String, Vec<u8>> = w.net.ipfs.clone();
    // the host will serve the old header in place of every new object it is asked for
    w.net.advance(2 * HOUR + 60_000, 1_800_000);
    let (v2, _, h2) = w.state(0);
    let h2 = h2.unwrap();
    assert!(v2 > v1);
    assert_eq!(w.net.registry.batches.len(), 1);
    // b may already have loaded v2 by heartbeat; rewind it to test the refusal deterministically on a fresh holder below
    let _ = real;

    // a third enclave receives the identity at v2; its host serves the v1 header under v2's CID
    let c = w.net.add_node("c", X);
    w.net.directory();
    let good = w.net.ipfs[&h2].clone();
    let old = w.net.ipfs[&h1].clone();
    w.net.ipfs.insert(h2.clone(), old);
    identity_to(&mut w.net, 0, c, &card);
    let (vc, loaded, hc) = w.state(c);
    assert_eq!((vc, loaded, hc.as_deref()), (v2, false, Some(h2.as_str())), "the old blob is refused: c knows v2 but holds no state");
    // c opens no derived-card job without its state (and while another holder serves them)
    let job = derive_job(&card, &w.requester, 9, &["level"], "PT1H");
    let out = w.net.create_job(c, &job);
    assert!(out.iter().any(|m| m["code"] == "NH_NOT_IDENTITY_LEADER"), "{out:?}");
    // the right bytes arrive: the next heartbeat names v2, and c loads exactly that
    w.net.ipfs.insert(h2.clone(), good);
    w.net.advance(60_000, 30_000);
    assert_eq!(w.state(c), (v2, true, Some(h2.clone())));
    assert_eq!(w.net.nodes[c].broker.links_for_tests(&card), (2, 0), "the two live links");

    // the leader dies: after the liveness window a holder with the blob leads and keeps watching
    w.net.kill(0);
    w.net.advance(3 * 60_000, 30_000);
    let leader = [b, c].into_iter().find(|i| w.net.nodes[*i].broker.is_identity_leader_for_tests(&card)).expect("a new leader");
    let other = if leader == b { c } else { b };
    assert!(!w.net.nodes[other].broker.is_identity_leader_for_tests(&card), "exactly one");
    for m in [3, 4] {
        w.source_update(leader, m, 905, json!({}));
        w.source_update(other, m, 905, json!({}));
    }
    w.net.advance(3 * HOUR, 300_000);
    assert_eq!(w.net.registry.batches.len(), 2, "the new leader released the batch; the other holder didn't");
    for h in &hs[2..] {
        assert_eq!(w.revocation_of(h).and_then(|r| r["code"].as_u64()), Some(920));
    }
}

/// E4 (David, 2026-11-19): anyone who knows a source card's public key can make an entry that decrypts under its content
/// key. A linked update counts only if a certified press of the source policy signed it; any such press will do. Forged
/// revocations and a forged successor (which would suppress a later quiet revocation) are ignored, and the operator gets
/// a count, never which card.
#[test]
fn only_updates_signed_by_a_certified_press_count() {
    let mut w = World::with(sealed(json!({})), &["level"], |_| {});
    let hs = w.issue(&[1, 2, 3, 4]);
    let card = w.card.clone();
    w.net.oracle.0.lock().unwrap().card_policies.insert(pointer(9), SOURCE.into());
    let forger = test_press(66);
    // a forged loud revocation of member 1, and a forged rotation of member 2
    w.source_update_by(0, 1, 901, json!({}), &forger);
    w.source_update_by(0, 2, 101, json!({ "successor": pointer(9) }), &forger);
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 0), "nothing queued");
    assert_eq!(w.net.alerts(0).iter().filter(|a| *a == "SOURCE_UPDATE_UNCERTIFIED").count(), 2);
    // a signature that doesn't cover the entry is refused even from a certified press
    let mut bad = json!({ "card_state": {}, "code": 905, "entry_type": "revocation", "version": 2 });
    bad["press_signature"] = test_press(1).sign_object(&json!({ "code": 300 }), "press_signature").unwrap();
    let enc = notary_cards::support::aes_gcm_encrypt(&notary_cards::support::content_key(&source_pubkey(3)), &jcs::canonical(&bad).unwrap());
    let upd = json!({ "card_address": pointer(3), "head_cid": formats::cid_of_bytes(&enc), "bytes": b64u::encode(&enc), "timestamp": formats::format_timestamp(w.net.now), "block": 10 });
    w.net.call(0, json!({ "kind": "policy_updates", "req_id": "u", "policy_address": SOURCE, "updates": [upd] }));
    w.net.run();
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 0));
    // genuine revocations through two different certified presses both count; member 2's quiet revocation propagates,
    // because the forged successor was never recorded
    w.net.oracle.0.lock().unwrap().certified_presses.insert(test_press(2).public_key().to_vec());
    w.source_update(0, 1, 803, json!({}));
    w.source_update_by(0, 2, 801, json!({}), &test_press(2));
    assert_eq!(w.net.nodes[0].broker.links_for_tests(&card), (4, 2));
    w.net.advance(3 * HOUR, 300_000);
    assert_eq!(w.net.registry.batches.len(), 1);
    let codes: Vec<Option<u64>> = hs.iter().map(|h| w.revocation_of(h).and_then(|r| r["code"].as_u64())).collect();
    assert_eq!(codes, vec![Some(820), Some(820), None, None]);
}

/// G1 (derived cards, `sealed_link`): "cannot be linked to the source card by the host's records". The operator who logs
/// everything its enclave sends it, everything it stores and everything it publishes or registers, through issuance and
/// then a propagated revocation, still holds nothing that names a source card: no card pointer, no root key, no
/// `recipient_pubkey`, no root-key hash. (Timing, the batch size and the successor rule's codes are the disclosed
/// residue: replication §6–§7, L8.) Added in the 6.6 review; the objective was only covered indirectly before.
#[test]
fn the_hosts_records_never_name_a_source_card() {
    let mut w = World::with(sealed(json!({})), &["level"], |_| {});
    let hs = w.issue(&[1, 2, 3, 4]);
    let nb = (w.net.now / HOUR + 1) * HOUR;
    w.net.advance(nb - 10 * 60_000 - w.net.now, 300_000);
    w.source_update(0, 1, 803, json!({}));
    w.source_update(0, 2, 905, json!({}));
    w.net.advance(3 * HOUR, 300_000);
    assert_eq!(w.net.registry.batches.len(), 1, "the propagation ran, so its traffic is in what is scanned");
    assert!(!w.net.nodes[0].seen.is_empty() && !w.net.registry.submissions.is_empty());

    // everything the operator holds, as bytes: the enclave's messages in full, the stored ciphertexts, the chain
    // submissions and batches, every pinned object, the public anchors
    let mut held: Vec<Vec<u8>> = vec![];
    for n in &w.net.nodes {
        held.push(serde_json::to_vec(&n.seen).unwrap());
        held.push(serde_json::to_vec(&n.store).unwrap());
    }
    held.push(serde_json::to_vec(&w.net.registry.submissions).unwrap());
    held.push(serde_json::to_vec(&w.net.registry.batches).unwrap());
    held.push(serde_json::to_vec(&w.net.registry.cards).unwrap());
    held.push(serde_json::to_vec(&w.net.anchors).unwrap());
    held.extend(w.net.ipfs.values().cloned());
    let contains = |hay: &[u8], needle: &[u8]| !needle.is_empty() && hay.windows(needle.len()).any(|x| x == needle);

    let mut checked = 0;
    for h in &hs {
        let m = h.member;
        let root_key = root_key_of(m);
        let needles: Vec<(&str, Vec<u8>)> = vec![
            ("source card pointer", pointer(m).into_bytes()),
            ("source card pointer (base64url)", b64u::encode(&hex_bytes(&pointer(m))).into_bytes()),
            ("source card pointer (raw)", hex_bytes(&pointer(m))),
            ("source recipient_pubkey", b64u::encode(&source_pubkey(m)).into_bytes()),
            ("source recipient_pubkey (raw)", source_pubkey(m)),
            ("root key", b64u::encode(&root_key).into_bytes()),
            ("root key (raw)", root_key.clone()),
            ("root-key hash (base64url)", b64u::encode(&notary_crypto::sha256(&root_key)).into_bytes()),
            ("root-key hash (hex)", notary_crypto::sha256(&root_key).iter().map(|b| format!("{b:02x}")).collect::<String>().into_bytes()),
            ("root-key hash (raw)", notary_crypto::sha256(&root_key).to_vec()),
        ];
        for (what, needle) in &needles {
            for (i, hay) in held.iter().enumerate() {
                if let Some(at) = hay.windows(needle.len()).position(|x| x == needle.as_slice()) {
                    let from = at.saturating_sub(120);
                    panic!("member {m}: the operator's records contain the {what} (record set {i}): …{}…", String::from_utf8_lossy(&hay[from..(at + needle.len() + 40).min(hay.len())]));
                }
                checked += 1;
            }
        }
    }
    assert!(checked > 100, "the scan ran over every needle and every record set ({checked})");
    // and the scan can fail: the derived key of a holder IS public (the card is registered under it), so it is found
    let d_addr = formats::card_pointer(hs[0].d.public_key());
    assert!(held.iter().any(|hay| contains(hay, d_addr.as_bytes())), "negative control: a public identifier is found by the same scan");
}
