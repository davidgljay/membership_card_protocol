//! Step 6.5, E4: a linked source card's new head counts only if a certified press of the source policy signed it.
//! `policy::certified_press_keys` reads the policy's certified presses (per policy, never per update);
//! `policy::entry_press_signed` checks one entry against them. Each refusal is checked against an otherwise valid world.
use notary_cards::policy::{certified_press_keys, entry_press_signed, read_certified_presses, PressRead};
use notary_cards::stages::Roots;
use notary_cards::support::{address_of, aes_gcm_encrypt, content_key};
use notary_cards::world::{CardEntry, Event, World};
use notary_crypto::MlDsaKey;
use notary_types::{b64u, formats};
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;

struct Fixture {
    world: World,
    root: MlDsaKey,
    policy_id: String,
    policy_key: MlDsaKey,
}

fn put(w: &mut World, bytes: Vec<u8>) -> String {
    let cid = formats::cid_of_bytes(&bytes);
    w.ipfs.insert(cid.clone(), bytes);
    cid
}

fn sealed(w: &mut World, pk: &[u8], doc: &Value) -> String {
    put(w, aes_gcm_encrypt(&content_key(pk), &serde_json::to_vec(doc).unwrap()))
}

fn register(w: &mut World, pk: &[u8], cids: &[String]) {
    let events = cids.iter().map(|c| Event { cid: c.clone(), timestamp: formats::format_timestamp(NOW - 86_400_000) }).collect();
    w.cards.insert(address_of(pk), CardEntry { log_head_cid: cids.last().unwrap().clone(), events });
}

/// A press card for `press` under `ancestor`: a published (readable) CardDocument, registered. Returns its CID.
fn press_card(w: &mut World, press: &MlDsaKey, ancestor: &[u8]) -> String {
    let doc = json!({ "recipient_pubkey": b64u::encode(press.public_key()), "ancestry_pubkeys": [b64u::encode(ancestor)] });
    let cid = put(w, serde_json::to_vec(&doc).unwrap());
    register(w, press.public_key(), std::slice::from_ref(&cid));
    cid
}

fn fixture() -> Fixture {
    let mut world = World::default();
    let policy_key = MlDsaKey::generate();
    let policy_id = put(&mut world, serde_json::to_vec(&json!({ "recipient_pubkey": b64u::encode(policy_key.public_key()) })).unwrap());
    let mut f = Fixture { world, root: MlDsaKey::generate(), policy_id, policy_key };
    approve(&mut f, vec![]);
    f
}

fn approve(f: &mut Fixture, approved: Vec<String>) {
    let head = sealed(&mut f.world, f.policy_key.public_key(), &json!({ "approved_presses": approved }));
    register(&mut f.world, f.policy_key.public_key(), &[head]);
}

fn entry(by: &MlDsaKey) -> Value {
    let mut e = json!({ "code": 901, "entry_type": "revocation", "revocation": { "effective_date": formats::format_timestamp(NOW - 1000) }, "card_state": {}, "notify_holder": true, "version": 2 });
    e["press_signature"] = by.sign_object(&e, "press_signature").unwrap();
    e
}

fn keys(f: &Fixture) -> Result<Vec<Vec<u8>>, &'static str> {
    let trusted = [address_of(f.root.public_key())];
    let roots = Roots { trusted: &trusted, app_certification: "", login_service: "", max_depth: 8 };
    certified_press_keys(&f.world, &f.policy_id, &roots, NOW)
}

fn read(f: &Fixture) -> Result<PressRead, &'static str> {
    let trusted = [address_of(f.root.public_key())];
    let roots = Roots { trusted: &trusted, app_certification: "", login_service: "", max_depth: 8 };
    read_certified_presses(&f.world, &f.policy_id, &roots, NOW)
}

fn check(f: &Fixture, e: &Value) -> Result<(), &'static str> {
    entry_press_signed(e, &keys(f)?)
}

#[test]
fn a_certified_approved_press_is_accepted_by_card_cid_or_by_pointer() {
    let mut f = fixture();
    let press = MlDsaKey::generate();
    let cid = press_card(&mut f.world, &press, f.root.public_key());
    approve(&mut f, vec![cid]);
    assert_eq!(check(&f, &entry(&press)), Ok(()), "the press writes the press card's CID");
    approve(&mut f, vec![address_of(press.public_key())]);
    assert_eq!(check(&f, &entry(&press)), Ok(()), "the spec's card pointer");
}

#[test]
fn any_approved_press_will_do() {
    let mut f = fixture();
    let (a, b) = (MlDsaKey::generate(), MlDsaKey::generate());
    let ca = press_card(&mut f.world, &a, f.root.public_key());
    press_card(&mut f.world, &b, f.root.public_key());
    approve(&mut f, vec![ca, address_of(b.public_key())]);
    assert_eq!(keys(&f).unwrap().len(), 2);
    assert_eq!(check(&f, &entry(&a)), Ok(()));
    assert_eq!(check(&f, &entry(&b)), Ok(()));
}

#[test]
fn a_changed_entry_or_a_missing_signature_is_refused() {
    let mut f = fixture();
    let press = MlDsaKey::generate();
    let cid = press_card(&mut f.world, &press, f.root.public_key());
    approve(&mut f, vec![cid]);
    let mut e = entry(&press);
    e["code"] = json!(801);
    assert_eq!(check(&f, &e), Err("PRESS_SIGNATURE_INVALID"));
    let mut e = entry(&press);
    e.as_object_mut().unwrap().remove("press_signature");
    assert_eq!(check(&f, &e), Err("PRESS_SIGNATURE_INVALID"));
}

#[test]
fn a_press_the_policy_does_not_approve_is_refused() {
    let mut f = fixture();
    let (approved, other) = (MlDsaKey::generate(), MlDsaKey::generate());
    let cid = press_card(&mut f.world, &approved, f.root.public_key());
    press_card(&mut f.world, &other, f.root.public_key());
    approve(&mut f, vec![cid]);
    assert_eq!(check(&f, &entry(&other)), Err("PRESS_NOT_CERTIFIED"));
}

#[test]
fn a_forger_with_only_the_source_cards_public_key_is_refused() {
    // the attack E4 closes: anyone who knows the source card's public key can encrypt an entry; signing it with a key of
    // their own gets nowhere, even if the host also lists that key as approved
    let mut f = fixture();
    let forger = MlDsaKey::generate();
    let rogue_root = MlDsaKey::generate();
    let cid = press_card(&mut f.world, &forger, rogue_root.public_key());
    approve(&mut f, vec![cid]);
    assert_eq!(check(&f, &entry(&forger)), Err("PRESS_NOT_CERTIFIED"));
    // a pointer to an unregistered card, and a pointer whose card is someone else's key
    let bare = MlDsaKey::generate();
    approve(&mut f, vec![address_of(bare.public_key())]);
    assert_eq!(check(&f, &entry(&bare)), Err("PRESS_NOT_CERTIFIED"));
    let honest = MlDsaKey::generate();
    press_card(&mut f.world, &honest, f.root.public_key());
    let (pointer, card) = (address_of(forger.public_key()), f.world.cards[&address_of(honest.public_key())].clone());
    f.world.cards.insert(pointer.clone(), card);
    approve(&mut f, vec![pointer]);
    assert!(keys(&f).unwrap().is_empty(), "a pointer must be keccak256 of the document's key");
}

#[test]
fn a_revoked_press_card_is_refused() {
    let mut f = fixture();
    let press = MlDsaKey::generate();
    let genesis = press_card(&mut f.world, &press, f.root.public_key());
    approve(&mut f, vec![genesis.clone()]);
    assert_eq!(check(&f, &entry(&press)), Ok(()));
    let rev = json!({ "code": 901, "entry_type": "revocation", "history": [genesis], "prev_log_root": genesis, "card_state": {}, "revocation": { "effective_date": formats::format_timestamp(NOW - 3_600_000) }, "version": 1 });
    let rev_cid = sealed(&mut f.world, press.public_key(), &rev);
    register(&mut f.world, press.public_key(), &[genesis, rev_cid]);
    assert_eq!(check(&f, &entry(&press)), Err("PRESS_NOT_CERTIFIED"));
}

#[test]
fn an_unreadable_source_policy_is_refused() {
    let mut f = fixture();
    f.world.cards.clear();
    assert_eq!(keys(&f), Err("SOURCE_POLICY_UNREADABLE"));
}

#[test]
fn an_unreadable_pointer_is_skipped_and_counted_while_the_good_presses_still_count() {
    // F8.6: registry heads are sealed, so a pointer to a press card only works if its first event is the plain document.
    // One such entry must not drop the list: it is skipped (fail closed for that press) and counted, so the operator is told.
    let mut f = fixture();
    let (good, bad) = (MlDsaKey::generate(), MlDsaKey::generate());
    let good_cid = press_card(&mut f.world, &good, f.root.public_key());
    let sealed_genesis = sealed(&mut f.world, bad.public_key(), &json!({ "recipient_pubkey": b64u::encode(bad.public_key()) }));
    register(&mut f.world, bad.public_key(), &[sealed_genesis]);
    approve(&mut f, vec![good_cid.clone(), address_of(bad.public_key())]);
    assert_eq!(keys(&f).unwrap().len(), 1, "the good press is kept");
    assert_eq!(check(&f, &entry(&good)), Ok(()));
    assert_eq!(check(&f, &entry(&bad)), Err("PRESS_NOT_CERTIFIED"), "the unreadable press certifies nothing");
    assert_eq!(read(&f).unwrap().unreadable, 1);
    approve(&mut f, vec![good_cid]);
    assert_eq!(read(&f).unwrap().unreadable, 0, "control: a clean list counts none");
}
