//! What the card checks may read: registry entries (from policy snapshots in the enclave) and IPFS objects (from the
//! input's `evidence`, CID-checked). `World` is the JSON form used by the conformance vectors.
use notary_types::{b64u, formats};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub cid: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardEntry {
    pub log_head_cid: String,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubCardEntry {
    pub master_card_address: String,
    pub sub_card_doc_cid: String,
    pub active: bool,
}

pub trait CardSource {
    fn card(&self, address: &str) -> Option<CardEntry>;
    fn subcard(&self, address: &str) -> Option<SubCardEntry>;
    /// Bytes of an IPFS object, already checked against its CID.
    fn fetch(&self, cid: &str) -> Option<Vec<u8>>;
}

#[derive(Debug, Clone, Default)]
pub struct World {
    pub cards: BTreeMap<String, CardEntry>,
    pub subcards: BTreeMap<String, SubCardEntry>,
    pub ipfs: BTreeMap<String, Vec<u8>>,
}

impl World {
    /// Parses the vectors' `world` object. IPFS bytes are kept only if they hash to their CID.
    pub fn from_json(v: &Value) -> Option<Self> {
        let mut w = World::default();
        for (addr, c) in v.get("cards")?.as_object()? {
            let events = c
                .get("events")?
                .as_array()?
                .iter()
                .map(|e| Some(Event { cid: e.get("cid")?.as_str()?.into(), timestamp: e.get("timestamp")?.as_str()?.into() }))
                .collect::<Option<Vec<_>>>()?;
            w.cards.insert(addr.clone(), CardEntry { log_head_cid: c.get("log_head_cid")?.as_str()?.into(), events });
        }
        for (addr, s) in v.get("subcards")?.as_object()? {
            w.subcards.insert(
                addr.clone(),
                SubCardEntry {
                    master_card_address: s.get("master_card_address")?.as_str()?.into(),
                    sub_card_doc_cid: s.get("sub_card_doc_cid")?.as_str()?.into(),
                    active: s.get("active")?.as_bool()?,
                },
            );
        }
        for (cid, b) in v.get("ipfs")?.as_object()? {
            let bytes = b64u::decode(b.as_str()?).ok()?;
            if formats::cid_of_bytes(&bytes) == *cid {
                w.ipfs.insert(cid.clone(), bytes);
            }
        }
        Some(w)
    }
}

impl CardSource for World {
    fn card(&self, address: &str) -> Option<CardEntry> {
        self.cards.get(address).cloned()
    }
    fn subcard(&self, address: &str) -> Option<SubCardEntry> {
        self.subcards.get(address).cloned()
    }
    fn fetch(&self, cid: &str) -> Option<Vec<u8>> {
        self.ipfs.get(cid).cloned()
    }
}
