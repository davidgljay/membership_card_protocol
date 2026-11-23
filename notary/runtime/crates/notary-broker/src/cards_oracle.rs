//! The enclave's `CardOracle` over `notary-cards` (step 5.3a).
//!
//! Card data comes from three places, in this order, and every IPFS object is checked against its CID:
//! 1. the input's `evidence` (lifecycle step 27: every object needed to check the contributor's chain);
//! 2. the host's **whole-policy snapshots** and updates (host §8): registry entries, sub-card registrations and head
//!    bytes for every card under each snapshotted policy, never filtered;
//! 3. a per-card `fetch` (`card_head:` / `subcard:` / `ipfs:`), only for cards outside snapshotted policies (the
//!    disclosed fallback of step 31: ancestors, the signing sub-card's app-card chain).
//!
//! Trusted roots and the app-certification / login-service roots are pinned in the image (E29).
//!
//! The policy and requester reads use algorithm R (lifecycle Appendix A.7) and the list histories use
//! `notary_cards::lists_read` (runtime §12): all over vsock `fetch`, with no network connection.
use crate::env::{CardOracle, HostIo, PolicyView, RecipientTarget, SourceCard};
use crate::lists::ListVersion;
use notary_cards::{check_contributor, CardEntry, CardSource, ContributorConfig, ContributorResult, SubCardEntry};
use notary_types::{b64u, formats};
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct ListCardPin {
    pub address: String,
    pub public_key: Vec<u8>,
    /// `accepted_runtimes` or `program_allowlist`.
    pub field: String,
}

#[derive(Debug, Clone)]
pub struct CardPins {
    pub trusted_roots: Vec<String>,
    pub app_certification_root: String,
    pub login_service_root: String,
    pub max_chain_depth: usize,
    /// The two governance list cards (runtime §12, as amended 2026-11-12).
    pub list_cards: Vec<ListCardPin>,
    /// Keys allowed to sign list updates: the list holder (intent) and the PressRegistryBody press.
    pub list_holder_key: Vec<u8>,
    pub list_press_key: Vec<u8>,
}

#[derive(Default)]
struct Snapshots {
    /// policy → (head of the policy card the snapshot was built against, newest block applied)
    policy_state: BTreeMap<String, (String, u64)>,
    /// card address → the policy whose snapshot or update delivered it
    card_policy: BTreeMap<String, String>,
    /// sub-card address → the policy whose snapshot delivered its registration
    subcard_policy: BTreeMap<String, String>,
    cards: BTreeMap<String, CardEntry>,
    subcards: BTreeMap<String, SubCardEntry>,
    heads: BTreeMap<String, Vec<u8>>,
}

pub struct SnapshotOracle {
    pins: CardPins,
    snap: Snapshots,
    /// policy_id → policy address, from the last algorithm R read (for R5's `is_holder`).
    policy_addresses: BTreeMap<String, String>,
    /// policy_id → the policy card's public key, from the same read.
    policy_keys: BTreeMap<String, Vec<u8>>,
    /// How many `approved_presses` entries of each source policy could not be read at the last refresh (alerted when it changes).
    press_unreadable: BTreeMap<String, usize>,
    /// source policy → (when read, the certified presses' ML-DSA-44 keys): step 6.5, E4.
    source_presses: BTreeMap<String, (i64, Vec<Vec<u8>>)>,
    /// source policy → (when read, its `derivable: false` field names): step 6.5a.
    field_control: BTreeMap<String, (i64, Vec<String>)>,
    cache: RefCell<IpfsCache>,
}

/// How often a watched source policy's certified presses are read again (E4). Press changes are rare; a refresh costs a
/// few registry reads.
pub const PRESS_REFRESH_MS: i64 = 10 * 60_000;

/// How old a source policy's field control (`derivable`) may be when a job or an input is checked (6.5a, Q3).
pub const FIELD_CONTROL_REFRESH_MS: i64 = 10 * 60_000;

impl SnapshotOracle {
    /// Number of verified IPFS objects held for reuse across inputs.
    pub fn cached_objects(&self) -> usize {
        self.cache.borrow().len()
    }

    pub fn new(pins: CardPins) -> Self {
        Self { pins, snap: Snapshots::default(), policy_addresses: BTreeMap::new(), policy_keys: BTreeMap::new(), press_unreadable: BTreeMap::new(), source_presses: BTreeMap::new(), field_control: BTreeMap::new(), cache: RefCell::new(IpfsCache::default()) }
    }
}

fn events_of(v: &Value) -> Vec<notary_cards::world::Event> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| Some(notary_cards::world::Event { cid: e.get("cid")?.as_str()?.into(), timestamp: e.get("timestamp")?.as_str()?.into() }))
        .collect()
}

fn checked(cid: &str, bytes: Vec<u8>) -> Option<Vec<u8>> {
    (formats::cid_of_bytes(&bytes) == cid).then_some(bytes)
}

/// Verified IPFS objects, kept between inputs (5.7, Q9). An object is stored only after its bytes hash to its CID,
/// and a CID names exactly one byte string, so a cached object can't be stale or wrong. `card_head:` and `subcard:`
/// answers are registry state that changes (revocation), so they are never cached. Bounded; the oldest entries go first.
#[derive(Default)]
pub struct IpfsCache {
    map: BTreeMap<String, Vec<u8>>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}

impl IpfsCache {
    pub const MAX_BYTES: usize = 64 * 1024 * 1024;

    pub fn get(&self, cid: &str) -> Option<&Vec<u8>> {
        self.map.get(cid)
    }

    /// Call only with bytes already checked against `cid`.
    pub fn put(&mut self, cid: &str, bytes: &[u8], max: usize) {
        if bytes.len() > max / 4 || self.map.contains_key(cid) {
            return;
        }
        while self.bytes + bytes.len() > max {
            let Some(old) = self.order.pop_front() else { break };
            if let Some(b) = self.map.remove(&old) {
                self.bytes -= b.len();
            }
        }
        self.bytes += bytes.len();
        self.order.push_back(cid.to_string());
        self.map.insert(cid.to_string(), bytes.to_vec());
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

struct Source<'a> {
    cache: &'a RefCell<IpfsCache>,
    io: RefCell<&'a mut dyn HostIo>,
    evidence: BTreeMap<String, Vec<u8>>,
    snap: &'a Snapshots,
}

impl CardSource for Source<'_> {
    fn card(&self, address: &str) -> Option<CardEntry> {
        if let Some(c) = self.snap.cards.get(address) {
            return Some(c.clone());
        }
        let bytes = self.io.borrow_mut().fetch(&format!("card_head:{address}"))?;
        let v: Value = serde_json::from_slice(&bytes).ok()?;
        Some(CardEntry { log_head_cid: v.get("head_cid")?.as_str()?.into(), events: events_of(v.get("events")?) })
    }
    fn subcard(&self, address: &str) -> Option<SubCardEntry> {
        if let Some(s) = self.snap.subcards.get(address) {
            return Some(s.clone());
        }
        let bytes = self.io.borrow_mut().fetch(&format!("subcard:{address}"))?;
        let v: Value = serde_json::from_slice(&bytes).ok()?;
        Some(SubCardEntry {
            master_card_address: v.get("master_card_address")?.as_str()?.into(),
            sub_card_doc_cid: v.get("sub_card_doc_cid")?.as_str()?.into(),
            active: v.get("active")?.as_bool()?,
        })
    }
    fn fetch(&self, cid: &str) -> Option<Vec<u8>> {
        if let Some(b) = self.evidence.get(cid).or_else(|| self.snap.heads.get(cid)) {
            return Some(b.clone());
        }
        if let Some(b) = self.cache.borrow().get(cid) {
            return Some(b.clone());
        }
        let bytes = checked(cid, self.io.borrow_mut().fetch(&format!("ipfs:{cid}"))?)?;
        self.cache.borrow_mut().put(cid, &bytes, IpfsCache::MAX_BYTES);
        Some(bytes)
    }
}

impl SnapshotOracle {
    fn roots(&self) -> notary_cards::stages::Roots<'_> {
        notary_cards::stages::Roots {
            trusted: &self.pins.trusted_roots,
            app_certification: &self.pins.app_certification_root,
            login_service: &self.pins.login_service_root,
            max_depth: self.pins.max_chain_depth,
        }
    }

    fn run_contributor(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> ContributorResult {
        let evidence: BTreeMap<String, Vec<u8>> = input
            .get("evidence")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let cid = e.get("cid")?.as_str()?;
                Some((cid.to_string(), checked(cid, b64u::decode(e.get("bytes")?.as_str()?).ok()?)?))
            })
            .collect();
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence, snap: &self.snap };
        let empty = Map::new();
        let cfg = ContributorConfig {
            trusted_roots: &self.pins.trusted_roots,
            app_certification_root: &self.pins.app_certification_root,
            login_service_root: &self.pins.login_service_root,
            now_ms,
            max_chain_depth: self.pins.max_chain_depth,
        };
        let predicate = notary.get("contributor_predicate").cloned().unwrap_or(Value::Null);
        check_contributor(&src, input, &predicate, params.as_object().unwrap_or(&empty), &cfg)
    }
}

impl CardOracle for SnapshotOracle {
    fn policy(&mut self, io: &mut dyn HostIo, policy_id: &str, state_cid: &str, now_ms: i64) -> Result<PolicyView, &'static str> {
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        let roots = self.roots();
        // R4 (replica cards approved) is checked by the broker against `approved_notaries` (W10).
        let r = notary_cards::policy::read_policy(&src, policy_id, state_cid, &[], &roots, now_ms)?;
        self.policy_addresses.insert(policy_id.to_string(), r.policy_address);
        self.policy_keys.insert(policy_id.to_string(), r.policy_pubkey);
        Ok(PolicyView { notary: r.notary, approved_notaries: r.approved_notaries })
    }

    fn requester_allowed(&mut self, io: &mut dyn HostIo, job: &Value, predicate: &Value, now_ms: i64) -> bool {
        let Some(addr) = job.get("policy_id").and_then(Value::as_str).and_then(|p| self.policy_addresses.get(p)).cloned() else { return false };
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        notary_cards::policy::requester_allowed(&src, job, predicate, &addr, &self.roots(), now_ms)
    }

    fn source_card(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> Result<SourceCard, &'static str> {
        match self.run_contributor(io, input, notary, params, now_ms) {
            ContributorResult::Ok { root_key_hash, root_key, master_doc, .. } => {
                let policy_id = master_doc.get("policy_id").and_then(Value::as_str).unwrap_or_default().to_string();
                let address = input.get("contributor_card").and_then(Value::as_str).unwrap_or_default().to_string();
                let pubkey = master_doc.get("recipient_pubkey").and_then(Value::as_str).map(notary_cards::support::b64_lenient).unwrap_or_default();
                Ok(SourceCard { address, pubkey, root_key, root_key_hash, policy_id, fields: master_doc })
            }
            ContributorResult::Err { code, .. } => Err(code),
        }
    }

    fn refresh_source_presses(&mut self, io: &mut dyn HostIo, policy_id: &str, now_ms: i64) {
        if self.source_presses.get(policy_id).is_some_and(|(at, _)| now_ms - at < PRESS_REFRESH_MS) {
            return;
        }
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        // a failed read keeps the last good set (withholding reads is the host's to do anyway, L4)
        let read = notary_cards::policy::read_certified_presses(&src, policy_id, &self.roots(), now_ms).ok();
        drop(src);
        let entry = self.source_presses.entry(policy_id.to_string()).or_insert((now_ms, vec![]));
        entry.0 = now_ms;
        if let Some(r) = read {
            entry.1 = r.keys;
            // one unreadable entry no longer drops the others, but the operator is told (once per change in the count)
            if self.press_unreadable.get(policy_id).copied().unwrap_or(0) != r.unreadable {
                self.press_unreadable.insert(policy_id.to_string(), r.unreadable);
                if r.unreadable > 0 {
                    io.send(serde_json::json!({ "kind": "alert", "req_id": format!("press-unreadable-{policy_id}"), "level": "warn", "code": "press_unreadable" }));
                }
            }
        }
    }

    fn non_derivable_fields(&mut self, io: &mut dyn HostIo, policy_id: &str, now_ms: i64) -> Result<Vec<String>, &'static str> {
        if let Some((at, names)) = self.field_control.get(policy_id) {
            if now_ms - at < FIELD_CONTROL_REFRESH_MS {
                return Ok(names.clone());
            }
        }
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        match notary_cards::policy::non_derivable_fields(&src, policy_id, &self.roots(), now_ms) {
            Ok(names) => {
                self.field_control.insert(policy_id.to_string(), (now_ms, names.clone()));
                Ok(names)
            }
            // a refresh the host withheld keeps the last good answer (L4: it can only delay a change)
            Err(e) => self.field_control.get(policy_id).map(|(_, n)| n.clone()).ok_or(e),
        }
    }

    fn source_entry_certified(&self, policy_id: &str, entry: &Value) -> Result<(), &'static str> {
        let keys = self.source_presses.get(policy_id).map(|(_, k)| k.as_slice()).unwrap_or_default();
        notary_cards::policy::entry_press_signed(entry, keys)
    }

    fn serves_template(&mut self, io: &mut dyn HostIo, id_pubkey: &[u8], template: &str, now: i64) -> bool {
        let roots = self.roots();
        let checked = {
            let src = Source { cache: &self.cache, io: RefCell::new(&mut *io), evidence: BTreeMap::new(), snap: &self.snap };
            notary_cards::policy::template_notary(&src, id_pubkey, template, &roots, now)
        };
        let Ok(t) = checked else { return false };
        // AuthorizePress(T, card): active, and its key is the card's chain_pubkey (registry_contract §4.7).
        let Some(auth) = io.fetch(&format!("press_auth:{},{}", t.template_address, t.card_address)).and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else {
            return false;
        };
        auth.get("active").and_then(Value::as_bool) == Some(true)
            && auth.get("press_public_key").and_then(Value::as_str).map(notary_cards::support::b64_lenient) == Some(t.chain_pubkey)
    }

    fn policy_public_key(&self, policy_id: &str) -> Option<Vec<u8>> {
        self.policy_keys.get(policy_id).cloned()
    }

    fn learn_policy_key(&mut self, io: &mut dyn HostIo, policy_id: &str) -> Option<Vec<u8>> {
        if let Some(k) = self.policy_keys.get(policy_id) {
            return Some(k.clone());
        }
        // the policy's plain document, checked against its CID (the host is not trusted); its `recipient_pubkey` is the key
        let bytes = io.fetch(&format!("ipfs:{policy_id}")).filter(|b| formats::cid_of_bytes(b) == policy_id)?;
        let doc: Value = serde_json::from_slice(&bytes).ok()?;
        let key = b64u::decode_len(doc.get("recipient_pubkey")?.as_str()?, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok()?;
        self.policy_keys.insert(policy_id.to_string(), key.clone());
        Some(key)
    }

    fn card_policy(&self, card: &str) -> Option<String> {
        self.snap.card_policy.get(card).cloned()
    }

    fn policy_card_count(&self, policy: &str) -> Option<usize> {
        self.snap.policy_state.get(policy)?;
        Some(self.snap.card_policy.values().filter(|p| *p == policy).count())
    }

    fn contributor(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> Result<[u8; 32], &'static str> {
        match self.run_contributor(io, input, notary, params, now_ms) {
            ContributorResult::Ok { root_key_hash, .. } => Ok(root_key_hash),
            ContributorResult::Err { code, .. } => Err(code),
        }
    }

    fn recipient_targets(&mut self, io: &mut dyn HostIo, master_pubkey: &[u8]) -> Result<Vec<RecipientTarget>, &'static str> {
        use notary_cards::support::{address_of, b64_lenient, content_key, decrypt_card_head};
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        let roots = self.roots();
        let address = address_of(master_pubkey);
        let entry = src.card(&address).ok_or("RECIPIENT_UNREADABLE")?;
        let head = decrypt_card_head(&src, &entry.log_head_cid, &content_key(master_pubkey)).ok_or("RECIPIENT_UNREADABLE")?;
        let mut out = vec![];
        for key in head.get("active_subcards").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let sub_pk = b64_lenient(key);
            // the sub-card must verify, and be this recipient's own (its holder signature is by the recipient's master key)
            let Ok(s2) = notary_cards::stages::stage2(&src, &sub_pk, &roots) else { continue };
            if address_of(&s2.master_pubkey) != address {
                continue;
            }
            let Some(kem) = s2.sub_doc.get("kem_pubkey").and_then(Value::as_str).map(b64_lenient).filter(|k| k.len() == notary_messaging::KEM_PUBLIC_KEY_LEN) else { continue };
            out.push(RecipientTarget { sub_card: address_of(&sub_pk), kem_public_key: kem });
        }
        Ok(out)
    }

    fn list_history(&mut self, io: &mut dyn HostIo, list_card: &str) -> Option<Vec<ListVersion>> {
        let pin = self.pins.list_cards.iter().find(|p| p.address == list_card)?.clone();
        let src = Source { cache: &self.cache, io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        let pins = notary_cards::lists_read::ListCardPins {
            address: &pin.address,
            public_key: &pin.public_key,
            field: &pin.field,
            holder_key: &self.pins.list_holder_key,
            press_key: &self.pins.list_press_key,
        };
        let versions = notary_cards::lists_read::read_list_history(&src, &pins)?;
        Some(versions.into_iter().map(|(value, approval_text)| ListVersion { value, approval_text }).collect())
    }

    fn on_snapshot(&mut self, policy: &str, msg: &Value) {
        let block = msg.get("at_block").and_then(Value::as_u64).unwrap_or(0);
        let head = msg.get("policy_head_cid").and_then(Value::as_str).unwrap_or_default().to_string();
        self.snap.policy_state.insert(policy.into(), (head, block));
        for e in msg.get("entries").and_then(Value::as_array).into_iter().flatten() {
            let (Some(a), Some(h)) = (e.get("address").and_then(Value::as_str), e.get("head_cid").and_then(Value::as_str)) else { continue };
            let events = e.get("events").map(events_of).unwrap_or_default();
            self.snap.cards.insert(a.into(), CardEntry { log_head_cid: h.into(), events });
            self.snap.card_policy.insert(a.into(), policy.into());
        }
        for s in msg.get("subcards").and_then(Value::as_array).into_iter().flatten() {
            let (Some(m), Some(sub), Some(cid), Some(active)) = (
                s.get("master_card").and_then(Value::as_str),
                s.get("sub_card").and_then(Value::as_str),
                s.get("sub_card_doc_cid").and_then(Value::as_str),
                s.get("active").and_then(Value::as_bool),
            ) else {
                continue;
            };
            self.snap.subcards.insert(sub.into(), SubCardEntry { master_card_address: m.into(), sub_card_doc_cid: cid.into(), active });
            self.snap.subcard_policy.insert(sub.into(), policy.into());
        }
        for h in msg.get("heads").and_then(Value::as_array).into_iter().flatten() {
            let (Some(cid), Some(b)) = (h.get("cid").and_then(Value::as_str), h.get("bytes").and_then(Value::as_str)) else { continue };
            if let Some(bytes) = b64u::decode(b).ok().and_then(|b| checked(cid, b)) {
                self.snap.heads.insert(cid.into(), bytes);
            }
        }
    }

    fn contributor_policy_state(&self, policy: &str) -> Option<(String, u64)> {
        self.snap.policy_state.get(policy).filter(|(head, _)| !head.is_empty()).cloned()
    }

    fn contributor_from_snapshot(&self, master_card: &str, sub_card: &str, policies: &[String]) -> bool {
        let from = |m: &BTreeMap<String, String>, k: &str| m.get(k).is_some_and(|p| policies.contains(p));
        from(&self.snap.card_policy, master_card) && from(&self.snap.subcard_policy, sub_card)
    }

    fn on_updates(&mut self, policy: &str, msg: &Value) {
        for u in msg.get("updates").and_then(Value::as_array).into_iter().flatten() {
            let (Some(a), Some(h), Some(ts)) = (u.get("card_address").and_then(Value::as_str), u.get("head_cid").and_then(Value::as_str), u.get("timestamp").and_then(Value::as_str)) else {
                continue;
            };
            self.snap.card_policy.insert(a.into(), policy.into());
            if let (Some(b), Some(st)) = (u.get("block").and_then(Value::as_u64), self.snap.policy_state.get_mut(policy)) {
                st.1 = st.1.max(b);
            }
            let entry = self.snap.cards.entry(a.into()).or_insert_with(|| CardEntry { log_head_cid: h.into(), events: vec![] });
            entry.log_head_cid = h.into();
            if !entry.events.iter().any(|e| e.cid == h) {
                entry.events.push(notary_cards::world::Event { cid: h.into(), timestamp: ts.into() });
            }
            if let Some(bytes) = u.get("bytes").and_then(Value::as_str).and_then(|b| b64u::decode(b).ok()).and_then(|b| checked(h, b)) {
                self.snap.heads.insert(h.into(), bytes);
            }
        }
    }
}
