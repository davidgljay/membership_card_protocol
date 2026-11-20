//! Revocation propagation (step 6.5): `derived_card_revocation_propagation.md` §5–§7, and the sealed-link state blob
//! (`notary_replication_and_recovery.md` §8).
//!
//! **Modes.** Under `expiry_only` (§5) the enclave keeps no link between a source card and its derived card: a revoked
//! source card simply can't be presented again, and the derived card lapses at `expires_at`. Under `sealed_link` (§6) it
//! keeps one link per released card, `{ derived card, source card, source key, expiry }`, in memory and in the state blob,
//! never anywhere readable outside an enclave.
//!
//! **Watch loop (§6).** Every `policy_snapshot` and `policy_updates` of a source policy is run against the links in the
//! same way, whatever is linked: the work, and anything asked of the host (nothing), never depends on the link set. A
//! linked source card's new head is decrypted with the source key the link stores (ADR-006 content key); its `code`
//! is tested against `propagated_codes`, and a match queues a revocation of the derived card with the mapped code.
//!
//! **Release (§7).** A queued revocation is eligible `min_delay` after the source update, counted from the later of the
//! update's block time (host-supplied) and the moment the enclave received it (attested clock), so a host can delay
//! eligibility but never advance it. At each `batch_window` boundary the identity leader releases every eligible
//! revocation if at least `min_revocation_batch` are eligible, else holds them all; a held revocation whose derived card
//! expires is dropped. A release is one shuffled `BatchUpdateCardHeads` under the template (up to 100 per transaction),
//! each entry a revocation `LogEntry` signed by `K_id` twice (intent and press) and encrypted under the derived card's
//! content key, the chain payload signed by `K_chain`.
//!
//! **State blob (§8).** The identity leader writes a new blob after each issuance or propagation batch: the body (tags,
//! derived keys seen, released groups, links, queue) encrypted under the identity's state key, and a `StateBlobHeader`
//! signed by `K_id` with `version` + 1 and `prev_hash`. Other holders learn `{ version, header_cid }` from heartbeats
//! and load it only if the version is higher; a holder that received the identity by handoff loads only the exact header
//! the handoff named. So a host can lose blobs, but can't roll a holder back.
use crate::{derive::Book, env::HostIo, host_proto::Broker};
use notary_crypto::{sha256, shuffle};
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;
/// `MAX_BATCH_SIZE` of `BatchUpdateCardHeads` (registry_contract §4.15).
pub const MAX_CHAIN_BATCH: usize = 100;
pub const STATE_BLOB_TYPE: &str = "notary.state_blob.v1";
pub const STATE_BODY_TYPE: &str = "notary.state_body.v1";
pub const PROPAGATION_BATCH_TYPE: &str = "notary.propagation_batch.v1";

// ---------------------------------------------------------------------------------------------------------------------
// Parameters (§9)

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DerivedCode {
    /// 8xx → 820, 9xx → 920.
    Range,
    Fixed(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropParams {
    pub sealed: bool,
    /// `"8xx"`, `"9xx"`, or single codes 800–999.
    pub codes: Vec<String>,
    pub derived_code: DerivedCode,
    pub min_delay_ms: i64,
    pub window_ms: i64,
    pub min_batch: usize,
}

fn revocation_code(c: u32) -> bool {
    (800..=999).contains(&c)
}

impl PropParams {
    /// `T.notary.revocation_propagation` with the defaults of §9, checked against its bounds.
    pub fn from_notary(notary: &Value) -> Result<Self, String> {
        let r = notary.get("revocation_propagation").cloned().unwrap_or(json!({}));
        let sealed = match r.get("mode").and_then(Value::as_str) {
            Some("sealed_link") => true,
            Some("expiry_only") => false,
            _ => return Err("revocation_propagation.mode must be expiry_only or sealed_link".into()),
        };
        let codes: Vec<String> = match r.get("propagated_codes") {
            None => vec!["8xx".into(), "9xx".into()],
            Some(v) => v.as_array().ok_or("propagated_codes must be an array")?.iter().map(|c| c.as_str().map(String::from).ok_or("propagated_codes are strings")).collect::<Result<_, _>>()?,
        };
        for c in &codes {
            let ok = c == "8xx" || c == "9xx" || c.parse::<u32>().is_ok_and(revocation_code);
            if !ok {
                return Err(format!("propagated code {c} is not 8xx, 9xx or a code from 800 to 999"));
            }
        }
        let derived_code = match r.get("derived_code") {
            None => DerivedCode::Range,
            Some(Value::String(s)) if s == "range" => DerivedCode::Range,
            Some(v) => match v.as_u64() {
                Some(c) if revocation_code(c as u32) => DerivedCode::Fixed(c as u32),
                _ => return Err("derived_code must be \"range\" or one code from 800 to 999".into()),
            },
        };
        let dur = |k: &str, default: &str| formats::parse_duration(r.get(k).and_then(Value::as_str).unwrap_or(default)).map_err(|_| format!("revocation_propagation.{k} is not an ISO 8601 duration"));
        let p = Self {
            sealed,
            codes,
            derived_code,
            min_delay_ms: dur("min_delay", "PT24H")?,
            window_ms: dur("batch_window", "PT24H")?,
            min_batch: r.get("min_revocation_batch").map_or(Some(3), Value::as_u64).ok_or("min_revocation_batch must be an integer")? as usize,
        };
        if p.min_delay_ms < HOUR_MS {
            return Err("min_delay must be at least one hour".into());
        }
        if !(HOUR_MS..=7 * DAY_MS).contains(&p.window_ms) {
            return Err("batch_window must be one hour to seven days".into());
        }
        if p.min_batch < 1 {
            return Err("min_revocation_batch must be at least 1".into());
        }
        Ok(p)
    }

    /// Whether a source code is propagated.
    pub fn propagates(&self, code: u32) -> bool {
        revocation_code(code) && self.codes.iter().any(|c| (c == "8xx" && code / 100 == 8) || (c == "9xx" && code / 100 == 9) || c.parse::<u32>() == Ok(code))
    }

    /// The code posted on the derived card: never the source subcode (§6 code mapping).
    pub fn mapped(&self, code: u32) -> u32 {
        match self.derived_code {
            DerivedCode::Fixed(c) => c,
            DerivedCode::Range if code / 100 == 9 => 920,
            DerivedCode::Range => 820,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "codes": self.codes, "derived_code": match self.derived_code { DerivedCode::Range => json!("range"), DerivedCode::Fixed(c) => json!(c) },
            "min_batch": self.min_batch, "min_delay_ms": self.min_delay_ms, "sealed": self.sealed, "window_ms": self.window_ms,
        })
    }

    pub fn from_json(v: &Value) -> Option<Self> {
        Some(Self {
            sealed: v.get("sealed")?.as_bool()?,
            codes: v.get("codes")?.as_array()?.iter().filter_map(|c| c.as_str().map(String::from)).collect(),
            derived_code: match v.get("derived_code")? {
                Value::String(_) => DerivedCode::Range,
                n => DerivedCode::Fixed(n.as_u64()? as u32),
            },
            min_delay_ms: v.get("min_delay_ms")?.as_i64()?,
            window_ms: v.get("window_ms")?.as_i64()?,
            min_batch: v.get("min_batch")?.as_u64()? as usize,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// State

/// One sealed link (§6). Keyed in the book by the derived card's pointer.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    /// The derived card's key `D` (its content key and address come from it).
    pub d_pub: Vec<u8>,
    /// The source card's pointer, as the registry and the snapshot name it.
    pub source: String,
    /// The source card's `recipient_pubkey`: decrypts the source card's future log entries.
    pub source_pubkey: Vec<u8>,
    pub source_policy: String,
    pub expires_ms: i64,
    /// The derived card's current head (its genesis CID; the revocation is its first entry).
    pub head_cid: String,
    /// The derived card's policy-defined fields, reposted in the revocation's `card_state`.
    pub card_state: Value,
    /// Set by a 100–102 entry naming a `successor` (key rotation, §6 step 3).
    pub successor: Option<String>,
}

/// A queued revocation of a derived card.
#[derive(Debug, Clone, PartialEq)]
pub struct Queued {
    pub code: u32,
    pub eligible_ms: i64,
}

/// A `BatchUpdateCardHeads` waiting for the host's `chain_result`.
#[derive(Debug, Clone)]
pub struct RevSubmission {
    pub updates: Vec<Value>,
    pub batch_seq: u64,
    pub boundary_ms: i64,
    pub tries: u32,
}

impl Link {
    fn to_json(&self, derived: &str) -> Value {
        // RFC 8785 as the notary writes it has no nulls: absent values are left out
        let mut v = json!({
            "card_state": self.card_state, "d_pub": b64u::encode(&self.d_pub), "derived": derived, "expires_ms": self.expires_ms, "head_cid": self.head_cid,
            "source": self.source, "source_policy": self.source_policy, "source_pubkey": b64u::encode(&self.source_pubkey),
        });
        if let Some(s) = &self.successor {
            v["successor"] = json!(s);
        }
        v
    }
    fn from_json(v: &Value) -> Option<(String, Self)> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        Some((
            s("derived")?,
            Self {
                d_pub: b64u::decode(v.get("d_pub")?.as_str()?).ok()?,
                source: s("source")?,
                source_pubkey: b64u::decode(v.get("source_pubkey")?.as_str()?).ok()?,
                source_policy: s("source_policy")?,
                expires_ms: v.get("expires_ms")?.as_i64()?,
                head_cid: s("head_cid")?,
                card_state: v.get("card_state")?.clone(),
                successor: s("successor"),
            },
        ))
    }
}

// ---------------------------------------------------------------------------------------------------------------------

impl Broker {
    // -----------------------------------------------------------------------------------------------------------------
    // Identity leader (replication §1)

    /// The identity leader (replication §1): the only writer of the card's chain payloads and state blob. Among the live
    /// holders of `K_id`, those that serve the card's derived-card jobs come first (that is where the pool, the tags and
    /// the registrations are); among them, or among all holders if none serves one, the lowest instance id. Holders are
    /// known from completed identity handoffs (`instance_cards`), never from the host's directory. (6.5: plain "lowest
    /// instance id" would hand leadership to a fresh standby that holds none of the state; `plans/notary-questions-6.5.md`.)
    pub(crate) fn is_identity_leader(&self, card: &str) -> bool {
        if self.keys.identity(card).is_none() {
            return false;
        }
        let me = self.instance_id();
        let peers = self.live_identity_peers(card);
        let serving: Vec<&String> = peers.iter().filter(|i| self.heard.get(*i).is_some_and(|h| h.serving_cards.contains(card))).collect();
        if self.serves_derived(card) {
            serving.iter().all(|i| **i > me)
        } else if serving.is_empty() {
            peers.iter().all(|i| *i > me)
        } else {
            false
        }
    }

    /// Live holders of `card`'s identity other than this enclave.
    pub(crate) fn live_identity_peers(&self, card: &str) -> Vec<String> {
        let now = self.clock_ms();
        self.instance_cards.iter().filter(|(_, c)| *c == card).map(|(i, _)| i.clone()).filter(|i| self.heard.get(i).is_some_and(|h| now - h.last_ms <= crate::peer::LIVENESS_MS)).collect()
    }

    /// Whether this enclave serves a live derived-card job of `card`.
    pub(crate) fn serves_derived(&self, card: &str) -> bool {
        self.jobs.values().any(|j| j.card == card && j.derive.is_some() && j.state.live())
    }

    /// Whether another live holder of `card` serves a derived-card job: then this enclave must not open one (one writer).
    pub(crate) fn other_holder_serves_derived(&self, card: &str) -> bool {
        self.live_identity_peers(card).iter().any(|i| self.heard.get(i).is_some_and(|h| h.serving_cards.contains(card)))
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Watch loop (§6)

    /// A snapshot of a source policy: every card's current head goes through the same test as an update, so a revocation
    /// that happened while no holder was watching (an enclave restart, a new leader) is found again.
    pub(crate) fn derive_watch_snapshot(&mut self, policy: &str, msg: &Value) {
        let heads: BTreeMap<&str, &str> = msg.get("heads").and_then(Value::as_array).into_iter().flatten().filter_map(|h| Some((h.get("cid")?.as_str()?, h.get("bytes")?.as_str()?))).collect();
        let mut updates = vec![];
        for e in msg.get("entries").and_then(Value::as_array).into_iter().flatten() {
            let (Some(a), Some(h)) = (e.get("address").and_then(Value::as_str), e.get("head_cid").and_then(Value::as_str)) else { continue };
            let ts = e.get("events").and_then(Value::as_array).and_then(|ev| ev.iter().rev().find(|x| x.get("cid").and_then(Value::as_str) == Some(h))).and_then(|x| x.get("timestamp")).cloned().unwrap_or(Value::Null);
            updates.push(json!({ "card_address": a, "head_cid": h, "bytes": heads.get(h).copied(), "timestamp": ts }));
        }
        self.derive_watch(policy, &json!({ "updates": updates }));
    }

    /// `policy_updates` of a source policy (§6 steps 2–4).
    pub(crate) fn derive_watch(&mut self, policy: &str, msg: &Value) {
        let received = self.tick_ms.or_else(|| self.attested_now_ms().ok()).unwrap_or(0);
        let updates: Vec<Value> = msg.get("updates").and_then(Value::as_array).cloned().unwrap_or_default();
        let keys: Vec<(String, String)> = self.derive.keys().cloned().collect();
        for u in &updates {
            let Some(addr) = u.get("card_address").and_then(Value::as_str) else { continue };
            let bytes = u.get("bytes").and_then(Value::as_str).and_then(|b| b64u::decode(b).ok());
            let block_ms = u.get("timestamp").and_then(Value::as_str).and_then(|t| formats::parse_timestamp(t).ok()).unwrap_or(0);
            for key in &keys {
                let Some(prop) = self.derive.get(key).and_then(|b| b.prop.clone()) else { continue };
                if !prop.sealed {
                    continue;
                }
                let linked: Vec<String> = self.derive[key].links.iter().filter(|(_, l)| l.source == addr && l.source_policy == policy).map(|(d, _)| d.clone()).collect();
                for derived in linked {
                    let link = self.derive[key].links[&derived].clone();
                    // the new head, readable only with the source card's key
                    let Some(entry) = bytes.as_deref().and_then(|b| notary_cards::support::aes_gcm_decrypt(&notary_cards::support::content_key(&link.source_pubkey), b)).and_then(|p| jcs::parse_canonical(&p).ok()) else { continue };
                    let Some(code) = entry.get("code").and_then(Value::as_u64).map(|c| c as u32) else { continue };
                    let book = self.derive.get_mut(key).expect("book");
                    if (100..=102).contains(&code) {
                        if let Some(s) = entry.pointer("/card_state/successor").and_then(Value::as_str) {
                            book.links.get_mut(&derived).expect("link").successor = Some(s.to_string());
                        }
                        continue;
                    }
                    if !prop.propagates(code) {
                        continue;
                    }
                    // §6 step 3: the quiet revocation of a card that names a successor under the same source policy is a
                    // key rotation, not propagated. The enclave can't read the successor's entries (they are under the new
                    // key), so the link ends and the derived card lapses at its expiry. A 9xx is always propagated.
                    if code / 100 == 8 && link.successor.as_deref().is_some_and(|s| self.oracle.card_policy(s).as_deref() == Some(policy)) {
                        self.derive.get_mut(key).expect("book").links.remove(&derived);
                        continue;
                    }
                    let eligible_ms = block_ms.max(received) + prop.min_delay_ms;
                    let book = self.derive.get_mut(key).expect("book");
                    book.queued.entry(derived.clone()).or_insert(Queued { code: prop.mapped(code), eligible_ms });
                }
            }
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Release (§7)

    /// On a tick: links and queued revocations of expired derived cards are erased; at a `batch_window` boundary the
    /// identity leader releases the eligible revocations if there are enough. Returns whether anything was released.
    pub(crate) fn propagation_tick(&mut self, io: &mut dyn HostIo, key: &(String, String), now: i64) -> bool {
        let Some(prop) = self.derive.get(key).and_then(|b| b.prop.clone()) else { return false };
        {
            let book = self.derive.get_mut(key).expect("book");
            // a held revocation whose derived card expires is dropped: expiry does the same without an event (§7 step 3)
            book.links.retain(|_, l| l.expires_ms > now);
            let live: BTreeSet<String> = book.links.keys().cloned().collect();
            book.queued.retain(|d, _| live.contains(d));
        }
        if !prop.sealed || !self.is_identity_leader(&key.0) || !self.state_loaded(&key.0) {
            return false;
        }
        let boundary = now.div_euclid(prop.window_ms) * prop.window_ms;
        if boundary <= self.derive[key].last_rev_boundary_ms {
            return false;
        }
        let eligible: Vec<String> = self.derive[key].queued.iter().filter(|(_, q)| q.eligible_ms <= now).map(|(d, _)| d.clone()).collect();
        if eligible.len() < prop.min_batch {
            self.derive.get_mut(key).expect("book").last_rev_boundary_ms = boundary;
            return false;
        }
        let Some(policy_address) = self.oracle.policy_public_key(&key.1).map(|k| formats::card_pointer(&k)) else { return false };
        // the press's next sequence under T, read through the host; without it the batch waits for the next boundary
        let Some(mut sequence) = self.press_sequence(io, &policy_address, &key.0) else { return false };
        self.derive.get_mut(key).expect("book").last_rev_boundary_ms = boundary;
        let mut released = eligible;
        shuffle(&mut released);
        for chunk in released.chunks(MAX_CHAIN_BATCH) {
            let mut updates = vec![];
            for derived in chunk {
                let (link, q) = {
                    let b = &self.derive[key];
                    (b.links[derived].clone(), b.queued[derived].clone())
                };
                let Some(entry) = self.revocation_entry(&key.0, derived, &link, q.code, now) else { continue };
                let Ok(plain) = jcs::canonical(&entry) else { continue };
                let enc = notary_cards::support::aes_gcm_encrypt(&notary_cards::support::content_key(&link.d_pub), &plain);
                let new_cid = formats::cid_of_bytes(&enc);
                self.publish(io, &enc);
                updates.push(json!({
                    "card_address": b64u::encode(&notary_crypto::keccak256(&link.d_pub)),
                    "new_log_cid": b64u::encode(new_cid.as_bytes()),
                    "prev_log_cid": b64u::encode(link.head_cid.as_bytes()),
                }));
                let book = self.derive.get_mut(key).expect("book");
                book.links.remove(derived);
                book.queued.remove(derived);
            }
            if updates.is_empty() {
                continue;
            }
            let batch_seq = {
                let book = self.derive.get_mut(key).expect("book");
                book.batch_seq += 1;
                book.batch_seq
            };
            let sub = RevSubmission { updates, batch_seq, boundary_ms: boundary, tries: 0 };
            self.submit_revocations(io, key, sub, &policy_address, sequence, now);
            sequence += 1;
        }
        true
    }

    /// `PressAuthorizations[policy][press].next_sequence`, read through the host (an untrusted read: a wrong number only
    /// makes the transaction fail).
    pub(crate) fn press_sequence(&self, io: &mut dyn HostIo, policy_address: &str, press: &str) -> Option<u64> {
        let b = io.fetch(&format!("press_auth:{policy_address},{press}"))?;
        serde_json::from_slice::<Value>(&b).ok()?.get("next_sequence")?.as_u64()
    }

    /// The revocation `LogEntry` (protocol-objects §3, §32): the mapped code, both signatures by `K_id`, no note,
    /// `effective_date` the release time, `notify_holder`.
    fn revocation_entry(&self, card: &str, derived: &str, link: &Link, code: u32, now: i64) -> Option<Value> {
        let ident = self.keys.identity(card)?;
        let at = formats::format_timestamp(now);
        let kid = b64u::encode(ident.id.public_key());
        let intent = json!({ "code": code, "notify_holder": true, "revocation": { "effective_date": at }, "target_card": derived, "timestamp": at, "updater_card": card });
        let mut entry = json!({
            "card_state": link.card_state, "code": code, "entry_type": "revocation", "history": [link.head_cid], "notify_holder": true,
            "prev_log_root": link.head_cid, "revocation": { "effective_date": at }, "version": 1,
            "intent_signature": { "public_key": kid, "signature": b64u::encode(&ident.id.sign(&jcs::canonical(&intent).ok()?)) },
        });
        let press = ident.id.sign(&jcs::canonical(&entry).ok()?);
        entry["press_signature"] = json!({ "public_key": kid, "signature": b64u::encode(&press) });
        Some(entry)
    }

    /// Signs the `BatchUpdateCardHeadsPayload` (registry_contract §4.15) with `K_chain` and hands the host a
    /// `PropagationBatch` (protocol-objects §32) to submit with the calldata the payload names (§6.1 step 8).
    fn submit_revocations(&mut self, io: &mut dyn HostIo, key: &(String, String), sub: RevSubmission, policy_address: &str, sequence: u64, now: i64) {
        let (card, template) = key;
        let Some(ident) = self.keys.identity(card) else { return };
        let (Ok(policy_bytes), Ok(press_bytes)) = (crate::derive::hex_to_32(policy_address), crate::derive::hex_to_32(card)) else { return };
        let payload = json!({
            "op": "batch_update_card_heads", "policy_address": b64u::encode(&policy_bytes), "press_address": b64u::encode(&press_bytes),
            "sequence": sequence, "timestamp": formats::format_timestamp(now), "updates": sub.updates,
        });
        let Ok(bytes) = jcs::canonical(&payload) else { return };
        let Ok(sig) = ident.chain.sign_digest(&notary_crypto::keccak256(&bytes)) else { return };
        let entries: Vec<Value> = sub
            .updates
            .iter()
            .map(|u| {
                let s = |k: &str| u[k].as_str().and_then(|x| b64u::decode(x).ok()).unwrap_or_default();
                json!({ "card_address": s("card_address").iter().map(|b| format!("{b:02x}")).collect::<String>(), "log_entry_cid": String::from_utf8_lossy(&s("new_log_cid")), "prev_log_cid": String::from_utf8_lossy(&s("prev_log_cid")) })
            })
            .collect();
        let batch = json!({
            "batch_seq": sub.batch_seq, "chain_payload": payload, "chain_signature": b64u::encode(&sig), "entries": entries, "notary_card": card, "policy_id": template,
            "release_not_before": formats::format_timestamp(sub.boundary_ms), "type": PROPAGATION_BATCH_TYPE,
        });
        let req_id = format!("rev-{card}-{}-{}", sub.batch_seq, sub.tries);
        io.send(json!({
            "kind": "chain_submit", "req_id": req_id, "op": "batch_update_card_heads", "payload": payload, "signature": b64u::encode(&sig),
            "calldata": { "policy_address": b64u::encode(&policy_bytes), "press_address": b64u::encode(&press_bytes), "updates": sub.updates },
            "propagation_batch": batch,
        }));
        self.derive.get_mut(key).expect("book").rev_regs.insert(req_id, sub);
    }

    /// The host's answer to a propagation batch: a failure is signed again with a fresh sequence, a few times.
    /// Returns false if `req_id` isn't one.
    pub(crate) fn on_revocation_result(&mut self, io: &mut dyn HostIo, msg: &Value, req_id: &str) -> bool {
        let Some(key) = self.derive.iter().find(|(_, b)| b.rev_regs.contains_key(req_id)).map(|(k, _)| k.clone()) else { return false };
        let sub = self.derive.get_mut(&key).expect("book").rev_regs.remove(req_id).expect("sub");
        if msg.get("failed").is_none() {
            return true;
        }
        if sub.tries + 1 >= crate::derive::MAX_REGISTRATION_TRIES {
            io.send(json!({ "kind": "alert", "req_id": "propagation-failed", "level": "error", "code": "propagation_failed" }));
            return true;
        }
        let Some(policy_address) = self.oracle.policy_public_key(&key.1).map(|k| formats::card_pointer(&k)) else { return true };
        let Some(sequence) = self.press_sequence(io, &policy_address, &key.0) else { return true };
        let Ok(now) = self.attested_now_ms() else { return true };
        self.submit_revocations(io, &key, RevSubmission { tries: sub.tries + 1, ..sub }, &policy_address, sequence, now);
        true
    }

    // -----------------------------------------------------------------------------------------------------------------
    // State blob (replication §8)

    pub(crate) fn state_loaded(&self, card: &str) -> bool {
        self.keys.identity(card).is_some_and(|i| i.state_loaded)
    }

    /// The body: everything a holder must not lose, for every template this card serves.
    fn state_body(&self, card: &str) -> Value {
        let books: Vec<Value> = self.derive.iter().filter(|((c, _), _)| c == card).map(|((_, t), b)| book_to_json(t, b)).collect();
        json!({ "books": books, "notary_card": card, "type": STATE_BODY_TYPE })
    }

    /// Step 30: the identity leader writes a new blob (`version` + 1) and asks its host to store it unpinned.
    pub(crate) fn write_state_blob(&mut self, io: &mut dyn HostIo, card: &str) {
        if !self.is_identity_leader(card) || !self.state_loaded(card) {
            return;
        }
        let Ok(body) = jcs::canonical(&self.state_body(card)) else { return };
        let Ok(now) = self.attested_now_ms() else { return };
        let Some(ident) = self.keys.identity(card) else { return };
        let mut key = [0u8; 32];
        key.copy_from_slice(ident.state_key.expose());
        let enc = notary_cards::support::aes_gcm_encrypt(&key, &body);
        let version = ident.state_version + 1;
        let mut header = json!({
            "at": formats::format_timestamp(now), "body_cid": formats::cid_of_bytes(&enc), "body_hash": b64u::encode(&sha256(&enc)), "notary_card": card,
            "type": STATE_BLOB_TYPE, "version": version,
        });
        if ident.state_version > 0 {
            header["prev_hash"] = json!(ident.state_hash);
        }
        let Ok(unsigned) = jcs::canonical(&header) else { return };
        header["notary_signature"] = json!({ "public_key": b64u::encode(ident.id.public_key()), "signature": b64u::encode(&ident.id.sign(&unsigned)) });
        let Ok(hbytes) = jcs::canonical(&header) else { return };
        let header_cid = formats::cid_of_bytes(&hbytes);
        for b in [&enc, &hbytes] {
            io.send(json!({ "kind": "publish", "req_id": format!("state-{}", formats::cid_of_bytes(b)), "object": b64u::encode(b), "pin": false }));
        }
        if let Some(i) = self.keys.identity_mut(card) {
            i.state_version = version;
            i.state_hash = b64u::encode(&sha256(&hbytes));
            i.state_header_cid = Some(header_cid);
        }
    }

    /// Steps 31–32: loads a blob named by a heartbeat (`exact` = None: only a higher version) or by a handoff
    /// (`exact` = the version and header hash the handoff carried). Anything else is refused, so a host can't roll a
    /// holder back: it can only withhold.
    pub(crate) fn load_state_blob(&mut self, io: &mut dyn HostIo, card: &str, header_cid: &str, exact: Option<(u64, String)>) -> Result<u64, &'static str> {
        let (kid, current, key) = {
            let i = self.keys.identity(card).ok_or("STATE_BLOB_UNKNOWN_CARD")?;
            let mut k = [0u8; 32];
            k.copy_from_slice(i.state_key.expose());
            (i.id.public_key().to_vec(), i.state_version, k)
        };
        let hbytes = io.fetch(&format!("ipfs:{header_cid}")).filter(|b| formats::cid_of_bytes(b) == header_cid).ok_or("STATE_BLOB_UNAVAILABLE")?;
        let header = jcs::parse_canonical(&hbytes).map_err(|_| "STATE_BLOB_INVALID")?;
        let typed = notary_types::objects::from_value::<notary_types::objects::StateBlobHeader>(&header, STATE_BLOB_TYPE).map_err(|_| "STATE_BLOB_INVALID")?;
        if typed.notary_card != card || !notary_crypto::verify_object(&header, "notary_signature", &kid) {
            return Err("STATE_BLOB_INVALID");
        }
        match &exact {
            Some((v, h)) if typed.version != *v || b64u::encode(&sha256(&hbytes)) != *h => return Err("STATE_ROLLBACK"),
            None if typed.version <= current => return Err("STATE_ROLLBACK"),
            _ => {}
        }
        let enc = io.fetch(&format!("ipfs:{}", typed.body_cid)).filter(|b| formats::cid_of_bytes(b) == typed.body_cid).ok_or("STATE_BLOB_UNAVAILABLE")?;
        if b64u::encode(&sha256(&enc)) != typed.body_hash {
            return Err("STATE_BLOB_INVALID");
        }
        let plain = notary_cards::support::aes_gcm_decrypt(&key, &enc).ok_or("STATE_BLOB_INVALID")?;
        let body = jcs::parse_canonical(&plain).map_err(|_| "STATE_BLOB_INVALID")?;
        if body.get("type").and_then(Value::as_str) != Some(STATE_BODY_TYPE) || body.get("notary_card").and_then(Value::as_str) != Some(card) {
            return Err("STATE_BLOB_INVALID");
        }
        for b in body.get("books").and_then(Value::as_array).into_iter().flatten() {
            let Some((template, loaded)) = book_from_json(b) else { return Err("STATE_BLOB_INVALID") };
            let book = self.derive.entry((card.to_string(), template)).or_default();
            book.params = loaded.params;
            book.prop = loaded.prop;
            book.seen_d = loaded.seen_d;
            book.tags = loaded.tags;
            book.released = loaded.released;
            book.links = loaded.links;
            book.queued = loaded.queued;
            book.last_rev_boundary_ms = loaded.last_rev_boundary_ms;
            book.batch_seq = loaded.batch_seq;
        }
        if let Some(i) = self.keys.identity_mut(card) {
            i.state_version = typed.version;
            i.state_hash = b64u::encode(&sha256(&hbytes));
            i.state_header_cid = Some(header_cid.to_string());
            i.state_loaded = true;
        }
        Ok(typed.version)
    }

    /// A heartbeat from a holder of the same identity named a state version (step 31).
    pub(crate) fn on_identity_state_hint(&mut self, io: &mut dyn HostIo, from: &str, states: &[Value]) {
        for s in states {
            let (Some(card), Some(v), Some(cid)) = (s.get("notary_card").and_then(Value::as_str), s.get("version").and_then(Value::as_u64), s.get("header_cid").and_then(Value::as_str)) else { continue };
            if v == 0 {
                continue;
            }
            // only a holder known from an identity handoff speaks for this card's state, and for who else holds it
            if self.instance_cards.get(from).map(String::as_str) != Some(card) {
                continue;
            }
            self.learn_identity_holders(card, s.get("holders"));
            let Some(i) = self.keys.identity(card) else { continue };
            let exact = (!i.state_loaded && v == i.state_version).then(|| (v, i.state_hash.clone()));
            if v > i.state_version || exact.is_some() {
                let _ = self.load_state_blob(io, card, cid, exact);
            }
        }
    }

    /// Every instance this enclave knows holds `card`'s identity, itself included (sorted).
    pub(crate) fn identity_holders(&self, card: &str) -> Vec<String> {
        let mut v: Vec<String> = self.instance_cards.iter().filter(|(_, c)| *c == card).map(|(i, _)| i.clone()).collect();
        v.push(self.instance_id());
        v.sort();
        v.dedup();
        v
    }

    /// Adds holders named by a trusted source (an identity handoff payload, or a heartbeat from a known holder), so two
    /// holders that each received the identity from a third know each other when it dies (no two leaders).
    pub(crate) fn learn_identity_holders(&mut self, card: &str, holders: Option<&Value>) {
        let me = self.instance_id();
        for h in holders.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if h != me {
                self.instance_cards.entry(h.to_string()).or_insert_with(|| card.to_string());
            }
        }
    }

    /// What this enclave's heartbeats say about the identities it holds: `{ notary_card, version, header_cid }`.
    pub(crate) fn identity_states(&self) -> Vec<Value> {
        self.keys
            .identity_cards()
            .iter()
            .filter_map(|c| self.keys.identity(c))
            .filter(|i| i.state_loaded)
            .map(|i| {
                let mut s = json!({ "holders": self.identity_holders(&i.card), "notary_card": i.card, "serving": self.serves_derived(&i.card), "version": i.state_version });
                if let Some(h) = &i.state_header_cid {
                    s["header_cid"] = json!(h);
                }
                s
            })
            .collect()
    }
}

fn b64_set(s: &BTreeSet<[u8; 32]>) -> Vec<String> {
    s.iter().map(|t| b64u::encode(t)).collect()
}

fn set_of(v: &Value) -> Option<BTreeSet<[u8; 32]>> {
    v.as_array()?.iter().map(|x| b64u::decode(x.as_str()?).ok()?.try_into().ok()).collect()
}

fn book_to_json(template: &str, b: &Book) -> Value {
    let tags: Map<String, Value> = b.tags.iter().map(|(p, s)| (p.to_string(), json!(b64_set(s)))).collect();
    let released: Vec<Value> = b.released.iter().map(|(g, s)| json!({ "group": [g.0, g.1, g.2], "tags": b64_set(s) })).collect();
    let links: Vec<Value> = b.links.iter().map(|(d, l)| l.to_json(d)).collect();
    let queued: Vec<Value> = b.queued.iter().map(|(d, q)| json!({ "code": q.code, "derived": d, "eligible_ms": q.eligible_ms })).collect();
    let mut v = json!({
        "batch_seq": b.batch_seq, "last_rev_boundary_ms": b.last_rev_boundary_ms, "links": links,
        "queued": queued, "released": released, "seen_d": b64_set(&b.seen_d), "tags": tags, "template": template,
    });
    if let Some(p) = &b.params {
        v["params"] = p.to_json();
    }
    if let Some(p) = &b.prop {
        v["prop"] = p.to_json();
    }
    v
}

fn book_from_json(v: &Value) -> Option<(String, Book)> {
    let mut b = Book::default();
    let template = v.get("template")?.as_str()?.to_string();
    b.params = v.get("params").and_then(crate::derive::DeriveParams::from_json);
    b.prop = v.get("prop").and_then(PropParams::from_json);
    b.seen_d = set_of(v.get("seen_d")?)?;
    for (p, s) in v.get("tags")?.as_object()? {
        b.tags.insert(p.parse().ok()?, set_of(s)?);
    }
    for r in v.get("released")?.as_array()? {
        let g = r.get("group")?.as_array()?;
        b.released.insert((g.first()?.as_str()?.into(), g.get(1)?.as_str()?.into(), g.get(2)?.as_u64()?), set_of(r.get("tags")?)?);
    }
    for l in v.get("links")?.as_array()? {
        let (d, link) = Link::from_json(l)?;
        b.links.insert(d, link);
    }
    for q in v.get("queued")?.as_array()? {
        b.queued.insert(q.get("derived")?.as_str()?.into(), Queued { code: q.get("code")?.as_u64()? as u32, eligible_ms: q.get("eligible_ms")?.as_i64()? });
    }
    b.last_rev_boundary_ms = v.get("last_rev_boundary_ms")?.as_i64()?;
    b.batch_seq = v.get("batch_seq")?.as_u64()?;
    Some((template, b))
}
