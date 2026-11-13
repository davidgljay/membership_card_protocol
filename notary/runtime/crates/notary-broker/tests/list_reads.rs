//! Governance list histories read over `fetch` (runtime §12 as amended 2026-11-12): a real list card (versions
//! encrypted under the pinned list-card key, press-signed, intent by the pinned holder key, member-approved lists) is
//! read through the oracle and accepted by algorithm L; tampering with any link is refused.
use notary_broker::cards_oracle::{CardPins, ListCardPin, SnapshotOracle};
use notary_broker::env::{CardOracle, HostIo};
use notary_broker::lists::{approval_digest, Keyset, ListKind, Lists, Pins};
use notary_cards::support::{canonicalize, content_key, without};
use notary_crypto::{ChainKey, MlDsaKey};
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn encrypt(key: &[u8; 32], v: &Value, nonce: u8) -> Vec<u8> {
    use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm};
    let n = [nonce; 12];
    let mut out = n.to_vec();
    out.extend(Aes256Gcm::new_from_slice(key).unwrap().encrypt(&n.into(), serde_json::to_vec(v).unwrap().as_slice()).unwrap());
    out
}

struct Host {
    ipfs: BTreeMap<String, Vec<u8>>,
    head: Value,
    address: String,
}
impl HostIo for Host {
    fn send(&mut self, _: Value) {}
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>> {
        let (k, a) = what.split_once(':')?;
        match k {
            "ipfs" => self.ipfs.get(a).cloned(),
            "card_head" if a == self.address => Some(serde_json::to_vec(&self.head).unwrap()),
            _ => None,
        }
    }
}

struct Fixture {
    list_key: MlDsaKey,
    press: MlDsaKey,
    holder: MlDsaKey,
    members: Vec<ChainKey>,
    keyset: Keyset,
}

fn fixture() -> Fixture {
    let members: Vec<ChainKey> = (0..5).map(|_| ChainKey::generate()).collect();
    let keyset = Keyset { keys: members.iter().map(|m| m.public_key_xy()).collect(), quorum: 4, version: 1, key_scheme: 0 };
    Fixture { list_key: MlDsaKey::generate(), press: MlDsaKey::generate(), holder: MlDsaKey::generate(), members, keyset }
}

fn approval(f: &Fixture, card: &str, value: &Value, version: u64, prev: Option<&Value>) -> String {
    let mut a = json!({ "governance_version": 1, "kind": "standard", "list": "accepted_runtimes", "list_card": card, "list_hash": jcs::h(value).unwrap(),
        "list_version": version, "signatures": [], "type": "notary_list_approval" });
    if let Some(p) = prev { a["prev_list_hash"] = json!(jcs::h(p).unwrap()); }
    let d = approval_digest(&a).unwrap();
    a["signatures"] = json!((0..4).map(|i| json!({ "key_index": i, "signature": b64u::encode(&f.members[i].sign_digest(&d).unwrap()) })).collect::<Vec<_>>());
    String::from_utf8(jcs::canonical(&a).unwrap()).unwrap()
}

/// Builds the card. `tamper` can change the press key used for v1, its prev_log_root, its intent key, or the head.
fn build(f: &Fixture, tamper: &str) -> (Host, String) {
    let card = formats::card_pointer(f.list_key.public_key());
    let key = content_key(f.list_key.public_key());
    let rt = |b: u8| json!({ "accepted_from": "2026-01-01T00:00:00Z", "build_recipe_cid": "bafkreib", "close_compat": "c1", "pcr0": b64u::encode(&[b; 48]), "platform": "simulator", "source_commit": "c", "version": "1" });
    let v1 = json!([rt(1)]);
    let v2 = json!([rt(1), rt(2)]);
    let mut genesis = json!({ "accepted_runtimes": v1, "list_approval": approval(f, &card, &v1, 1, None), "policy_id": "bafkreilists", "recipient_pubkey": b64u::encode(f.list_key.public_key()) });
    genesis["press_signature"] = json!(b64u::encode(&f.press.sign(&canonicalize(&genesis).unwrap())));
    let g_bytes = encrypt(&key, &genesis, 1);
    let g_cid = formats::cid_of_bytes(&g_bytes);
    let intent_key = if tamper == "intent" { MlDsaKey::generate().public_key().to_vec() } else { f.holder.public_key().to_vec() };
    let mut entry = json!({ "card_state": { "accepted_runtimes": v2, "list_approval": approval(f, &card, &v2, 2, Some(&v1)) }, "code": 300, "entry_type": "field_update",
        "history": [g_cid], "intent_signature": { "public_key": b64u::encode(&intent_key), "signature": "AA" },
        "prev_log_root": if tamper == "prev" { json!("bafkreiwrong") } else { json!(g_cid) }, "version": 1 });
    let press = if tamper == "press" { MlDsaKey::generate() } else { MlDsaKey::from_seed(notary_crypto::SecretBytes::from_vec(f.press.seed().expose().to_vec())).unwrap() };
    let sig = press.sign(&canonicalize(&without(&entry, &["press_signature"])).unwrap());
    entry["press_signature"] = json!({ "public_key": b64u::encode(press.public_key()), "signature": b64u::encode(&sig) });
    let e_bytes = encrypt(&key, &entry, 2);
    let e_cid = formats::cid_of_bytes(&e_bytes);
    let head = if tamper == "head" { g_cid.clone() } else { e_cid.clone() };
    let host = Host {
        ipfs: [(g_cid.clone(), g_bytes), (e_cid.clone(), e_bytes)].into_iter().collect(),
        head: json!({ "head_cid": head, "events": [{ "cid": g_cid, "timestamp": "2026-01-01T00:00:00.000Z" }, { "cid": e_cid, "timestamp": "2026-02-01T00:00:00.000Z" }] }),
        address: card.clone(),
    };
    (host, card)
}

fn oracle(f: &Fixture, card: &str) -> SnapshotOracle {
    SnapshotOracle::new(CardPins {
        trusted_roots: vec![], app_certification_root: String::new(), login_service_root: String::new(), max_chain_depth: 8,
        list_cards: vec![ListCardPin { address: card.into(), public_key: f.list_key.public_key().to_vec(), field: "accepted_runtimes".into() }],
        list_holder_key: f.holder.public_key().to_vec(), list_press_key: f.press.public_key().to_vec(),
    })
}

#[test]
fn a_genuine_list_card_is_read_and_accepted_by_algorithm_l() {
    let f = fixture();
    let (mut host, card) = build(&f, "");
    let history = oracle(&f, &card).list_history(&mut host, &card).expect("history");
    assert_eq!(history.len(), 2);
    let mut lists = Lists::new(Pins { accepted_runtimes_card: card.clone(), program_allowlist_card: "p".into(), keyset: f.keyset.clone(), accepted_runtimes_floor: 1, program_allowlist_floor: 0 });
    assert_eq!(lists.update(ListKind::AcceptedRuntimes, &history), Ok(2));
    assert_eq!(lists.accepted_runtimes().len(), 2);
}

#[test]
fn tampered_list_cards_are_refused() {
    let f = fixture();
    for t in ["press", "prev", "intent", "head"] {
        let (mut host, card) = build(&f, t);
        assert!(oracle(&f, &card).list_history(&mut host, &card).is_none(), "tamper {t} must be refused");
    }
    // an unpinned card is never read
    let (mut host, card) = build(&f, "");
    assert!(oracle(&f, "0000").list_history(&mut host, &card).is_none());
}
