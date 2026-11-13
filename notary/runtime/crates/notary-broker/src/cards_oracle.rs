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
use crate::env::{CardOracle, HostIo, PolicyView};
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
    cards: BTreeMap<String, CardEntry>,
    subcards: BTreeMap<String, SubCardEntry>,
    heads: BTreeMap<String, Vec<u8>>,
}

pub struct SnapshotOracle {
    pins: CardPins,
    snap: Snapshots,
    /// policy_id → policy address, from the last algorithm R read (for R5's `is_holder`).
    policy_addresses: BTreeMap<String, String>,
}

impl SnapshotOracle {
    pub fn new(pins: CardPins) -> Self {
        Self { pins, snap: Snapshots::default(), policy_addresses: BTreeMap::new() }
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

struct Source<'a> {
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
        checked(cid, self.io.borrow_mut().fetch(&format!("ipfs:{cid}"))?)
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
}

impl CardOracle for SnapshotOracle {
    fn policy(&mut self, io: &mut dyn HostIo, policy_id: &str, state_cid: &str, now_ms: i64) -> Result<PolicyView, &'static str> {
        let src = Source { io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        let roots = self.roots();
        // R4 (replica cards approved) is checked by the broker against `approved_notaries` (W10).
        let r = notary_cards::policy::read_policy(&src, policy_id, state_cid, &[], &roots, now_ms)?;
        self.policy_addresses.insert(policy_id.to_string(), r.policy_address);
        Ok(PolicyView { notary: r.notary, approved_notaries: r.approved_notaries })
    }

    fn requester_allowed(&mut self, io: &mut dyn HostIo, job: &Value, predicate: &Value, now_ms: i64) -> bool {
        let Some(addr) = job.get("policy_id").and_then(Value::as_str).and_then(|p| self.policy_addresses.get(p)).cloned() else { return false };
        let src = Source { io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
        notary_cards::policy::requester_allowed(&src, job, predicate, &addr, &self.roots(), now_ms)
    }

    fn contributor(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> Result<[u8; 32], &'static str> {
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
        let src = Source { io: RefCell::new(io), evidence, snap: &self.snap };
        let empty = Map::new();
        let cfg = ContributorConfig {
            trusted_roots: &self.pins.trusted_roots,
            app_certification_root: &self.pins.app_certification_root,
            login_service_root: &self.pins.login_service_root,
            now_ms,
            max_chain_depth: self.pins.max_chain_depth,
        };
        let predicate = notary.get("contributor_predicate").cloned().unwrap_or(Value::Null);
        match check_contributor(&src, input, &predicate, params.as_object().unwrap_or(&empty), &cfg) {
            ContributorResult::Ok { root_key_hash, .. } => Ok(root_key_hash),
            ContributorResult::Err { code, .. } => Err(code),
        }
    }

    fn list_history(&mut self, io: &mut dyn HostIo, list_card: &str) -> Option<Vec<ListVersion>> {
        let pin = self.pins.list_cards.iter().find(|p| p.address == list_card)?.clone();
        let src = Source { io: RefCell::new(io), evidence: BTreeMap::new(), snap: &self.snap };
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
        let _ = policy;
        for e in msg.get("entries").and_then(Value::as_array).into_iter().flatten() {
            let (Some(a), Some(h)) = (e.get("address").and_then(Value::as_str), e.get("head_cid").and_then(Value::as_str)) else { continue };
            let events = e.get("events").map(events_of).unwrap_or_default();
            self.snap.cards.insert(a.into(), CardEntry { log_head_cid: h.into(), events });
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
        }
        for h in msg.get("heads").and_then(Value::as_array).into_iter().flatten() {
            let (Some(cid), Some(b)) = (h.get("cid").and_then(Value::as_str), h.get("bytes").and_then(Value::as_str)) else { continue };
            if let Some(bytes) = b64u::decode(b).ok().and_then(|b| checked(cid, b)) {
                self.snap.heads.insert(cid.into(), bytes);
            }
        }
    }

    fn on_updates(&mut self, _policy: &str, msg: &Value) {
        for u in msg.get("updates").and_then(Value::as_array).into_iter().flatten() {
            let (Some(a), Some(h), Some(ts)) = (u.get("card_address").and_then(Value::as_str), u.get("head_cid").and_then(Value::as_str), u.get("timestamp").and_then(Value::as_str)) else {
                continue;
            };
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
