//! D9 (decided by David 2026-11-21): the card checks of template-scope handoff P3. A peer that proved it holds `K_id`
//! serves template `T` only if its notary card is registered and binds `K_id`, names `T` as `issuer_card`, is listed in
//! `T.approved_notaries` at T's current head, and verifies (trusted root, not revoked). The `AuthorizePress(T, card)`
//! half is read by the broker's oracle (`notary-broker/tests/cards_oracle.rs`). Each refusal is checked against an
//! otherwise valid world.
use notary_cards::policy::{template_notary, TemplateNotary};
use notary_cards::stages::Roots;
use notary_cards::support::{address_of, aes_gcm_encrypt, content_key};
use notary_cards::world::{CardEntry, Event, World};
use notary_crypto::MlDsaKey;
use notary_types::{b64u, formats};
use serde_json::{json, Value};

const NOW: i64 = 1_800_000_000_000;
const CHAIN_KEY: [u8; 64] = [0x5a; 64];

struct Fixture {
    world: World,
    root: MlDsaKey,
    template_id: String,
    template_key: MlDsaKey,
    notary: MlDsaKey,
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

/// The notary card document for `notary`, issued for `issuer` (a template address), chaining to `ancestor`.
fn notary_doc(notary: &MlDsaKey, issuer: &str, ancestor: &[u8]) -> Value {
    json!({
        "recipient_pubkey": b64u::encode(notary.public_key()),
        "ancestry_pubkeys": [b64u::encode(ancestor)],
        "issuer_card": issuer,
        "chain_pubkey": b64u::encode(&CHAIN_KEY[..]),
        "operator_card": "b3BlcmF0b3I",
        "platform": "simulator",
    })
}

fn fixture() -> Fixture {
    let mut world = World::default();
    let template_key = MlDsaKey::generate();
    let template_id = put(&mut world, serde_json::to_vec(&json!({ "recipient_pubkey": b64u::encode(template_key.public_key()) })).unwrap());
    let (root, notary) = (MlDsaKey::generate(), MlDsaKey::generate());
    let mut f = Fixture { world, root, template_id, template_key, notary };
    let doc = notary_doc(&f.notary, &address_of(f.template_key.public_key()), f.root.public_key());
    let genesis = sealed(&mut f.world, f.notary.public_key(), &doc);
    register(&mut f.world, f.notary.public_key(), &[genesis]);
    let listed = vec![address_of(f.notary.public_key())];
    approve(&mut f, listed);
    f
}

fn approve(f: &mut Fixture, notaries: Vec<String>) {
    let head = sealed(&mut f.world, f.template_key.public_key(), &json!({ "approved_notaries": notaries }));
    register(&mut f.world, f.template_key.public_key(), &[head]);
}

fn check(f: &Fixture, id_pubkey: &[u8]) -> Result<TemplateNotary, &'static str> {
    let trusted = [address_of(f.root.public_key())];
    let roots = Roots { trusted: &trusted, app_certification: "", login_service: "", max_depth: 8 };
    template_notary(&f.world, id_pubkey, &f.template_id, &roots, NOW)
}

const DENIED: Result<TemplateNotary, &str> = Err("HANDOFF_SCOPE_DENIED");

#[test]
fn a_listed_notary_card_issued_for_the_template_passes_and_names_its_chain_key() {
    let f = fixture();
    let t = check(&f, f.notary.public_key()).unwrap();
    assert_eq!(t.template_address, address_of(f.template_key.public_key()));
    assert_eq!(t.card_address, address_of(f.notary.public_key()));
    assert_eq!(t.chain_pubkey, CHAIN_KEY.to_vec(), "the key AuthorizePress(T, card) must carry");
}

#[test]
fn a_notary_card_the_template_does_not_list_is_refused() {
    let mut f = fixture();
    approve(&mut f, vec![]);
    assert_eq!(check(&f, f.notary.public_key()), DENIED, "removed from approved_notaries at the current head");
    let other = address_of(MlDsaKey::generate().public_key());
    approve(&mut f, vec![other]);
    assert_eq!(check(&f, f.notary.public_key()), DENIED);
}

#[test]
fn a_notary_card_issued_for_another_policy_is_refused_even_if_listed() {
    // an operator's card for policy X can't receive T's template key
    let mut f = fixture();
    let x = address_of(MlDsaKey::generate().public_key());
    let doc = notary_doc(&f.notary, &x, f.root.public_key());
    let genesis = sealed(&mut f.world, f.notary.public_key(), &doc);
    register(&mut f.world, f.notary.public_key(), &[genesis]);
    assert_eq!(check(&f, f.notary.public_key()), DENIED);
}

#[test]
fn an_unregistered_card_or_one_bound_to_another_key_is_refused() {
    let f = fixture();
    let stranger = MlDsaKey::generate();
    assert_eq!(check(&f, stranger.public_key()), DENIED, "no card at keccak256(K_id)");

    // the stranger's address carries the honest notary's card: it doesn't bind the stranger's key
    let mut f = fixture();
    let honest = f.world.cards[&address_of(f.notary.public_key())].clone();
    f.world.cards.insert(address_of(stranger.public_key()), honest);
    let listed = vec![address_of(f.notary.public_key()), address_of(stranger.public_key())];
    approve(&mut f, listed);
    assert_eq!(check(&f, stranger.public_key()), DENIED);
}

#[test]
fn a_card_that_does_not_reach_a_trusted_root_is_refused() {
    let mut f = fixture();
    let rogue = MlDsaKey::generate();
    let doc = notary_doc(&f.notary, &address_of(f.template_key.public_key()), rogue.public_key());
    let genesis = sealed(&mut f.world, f.notary.public_key(), &doc);
    register(&mut f.world, f.notary.public_key(), &[genesis]);
    assert_eq!(check(&f, f.notary.public_key()), DENIED);
}

#[test]
fn a_revoked_notary_card_is_refused() {
    let mut f = fixture();
    let genesis = f.world.cards[&address_of(f.notary.public_key())].log_head_cid.clone();
    let rev = json!({ "code": 901, "entry_type": "revocation", "history": [genesis], "prev_log_root": genesis, "card_state": {}, "revocation": { "effective_date": formats::format_timestamp(NOW - 3_600_000) }, "version": 1 });
    let rev_cid = sealed(&mut f.world, f.notary.public_key(), &rev);
    register(&mut f.world, f.notary.public_key(), &[genesis, rev_cid]);
    assert_eq!(check(&f, f.notary.public_key()), DENIED);
}

#[test]
fn an_unreadable_template_is_refused() {
    let mut f = fixture();
    f.world.cards.remove(&address_of(f.template_key.public_key()));
    assert_eq!(check(&f, f.notary.public_key()), DENIED, "no current head to read approved_notaries from");
    let mut f = fixture();
    f.world.ipfs.remove(&f.template_id.clone());
    assert_eq!(check(&f, f.notary.public_key()), DENIED);
}

#[test]
fn a_card_without_a_chain_key_is_refused() {
    let mut f = fixture();
    let mut doc = notary_doc(&f.notary, &address_of(f.template_key.public_key()), f.root.public_key());
    doc.as_object_mut().unwrap().remove("chain_pubkey");
    let genesis = sealed(&mut f.world, f.notary.public_key(), &doc);
    register(&mut f.world, f.notary.public_key(), &[genesis]);
    assert_eq!(check(&f, f.notary.public_key()), DENIED);
}
