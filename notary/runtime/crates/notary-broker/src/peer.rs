//! Enclave-to-enclave messages (protocol-objects.md §35; notary_runtime.md §9 `peer_message` / `peer_send`), the peer
//! directory, timers (`tick`), heartbeats, liveness and leadership (notary_replication_and_recovery.md §1, §6).
//!
//! **The envelope.** `{ type: "notary.peer.v1", kind, from, to, body, instance_signature }`, RFC 8785 JSON, signed by the
//! sender's `K_inst` over the envelope without `instance_signature`. `from` and `to` are instance ids
//! (`SHA-256(K_inst)`); a receiver checks `SHA-256(instance_signature.public_key) == from`, `to` is itself and the
//! signature verifies. Hosts relay the bytes and never parse them. Who a sender *is* comes from elsewhere: handoff
//! peers prove it with attestations (algorithm P), and every other kind is accepted only from a replica the anchored
//! job log names (`Job::members`).
//!
//! **The directory** (`peer_directory`) is an untrusted hint: where to send. Nothing in it is trusted; every peer still
//! passes algorithm P before a key moves.
//!
//! **Timers (Q6).** The host sends `tick {}` about once a second and it carries no time. The broker reads the attested
//! clock at most once per tick and runs every due timer against that reading: heartbeats (30 s), the liveness window
//! (120 s), the acknowledgment timeout (60 s), handoff sessions (5 min), close-body resends, and a governance-list
//! re-read (60 s). A host that withholds ticks only slows timers.
//!
//! **Leadership.** The job leader is the live replica with the lowest instance id (live: this replica, and members
//! heard from within the liveness window that haven't said they stop). A partition can make two leaders; they can fork
//! the job log but can't both close (two quorums share an honest replica, §5).
use crate::{env::HostIo, handoff::HScope, host_proto::Broker, jobs::State};
use notary_crypto::{mldsa_verify, sha256};
use notary_types::{b64u, jcs, objects};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const PEER_TYPE: &str = "notary.peer.v1";
pub const KINDS: [&str; 11] = ["hello", "handoff_offer", "handoff_payload", "handoff_ack", "input_forward", "input_ack", "close_body", "close_cosign", "close_mismatch", "heartbeat", "replica_gone"];
pub const HEARTBEAT_MS: i64 = 30_000;
pub const LIVENESS_MS: i64 = 120_000;
pub const ACK_TIMEOUT_MS: i64 = 60_000;
pub const LIST_REFRESH_MS: i64 = 60_000;

/// A directory entry (untrusted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerHint {
    pub notary_card: String,
    pub inst_pubkey: Vec<u8>,
    pub host_url: String,
}

/// What this enclave has heard from a peer instance.
#[derive(Debug, Clone, Default)]
pub struct Heard {
    pub last_ms: i64,
    pub hb_seq: Option<u64>,
    pub job_versions: BTreeMap<String, u64>,
    pub identity_version: Option<u64>,
    /// 6.5: the cards whose derived-card jobs this peer said it serves (its latest heartbeat).
    pub serving_cards: std::collections::BTreeSet<String>,
}

/// An opened, authenticated envelope.
pub struct Envelope {
    pub kind: String,
    pub from: String,
    pub inst_pubkey: Vec<u8>,
    pub body: Value,
}

/// Builds and signs an envelope (canonical bytes).
pub fn seal_envelope(inst: &notary_crypto::MlDsaKey, to: &str, kind: &str, body: Value) -> Vec<u8> {
    let from = b64u::encode(&sha256(inst.public_key()));
    let mut env = json!({ "body": body, "from": from, "kind": kind, "to": to, "type": PEER_TYPE });
    env["instance_signature"] = inst.sign_object(&env, "instance_signature").expect("peer envelope is notary JSON");
    jcs::canonical(&env).expect("peer envelope is notary JSON")
}

/// Opens an envelope addressed to `me`. Fails closed on anything malformed, misaddressed or badly signed.
pub fn open_envelope(bytes: &[u8], me: &str) -> Option<Envelope> {
    let env = jcs::parse_canonical(bytes).ok()?;
    let obj = env.as_object()?;
    let allowed = ["body", "from", "instance_signature", "kind", "to", "type"];
    if obj.len() != allowed.len() || !obj.keys().all(|k| allowed.contains(&k.as_str())) {
        return None;
    }
    if env["type"] != PEER_TYPE || env["to"] != me {
        return None;
    }
    let kind = env["kind"].as_str().filter(|k| KINDS.contains(k))?.to_string();
    let from = env["from"].as_str()?.to_string();
    let pk = b64u::decode(env["instance_signature"]["public_key"].as_str()?).ok()?;
    let sig = b64u::decode(env["instance_signature"]["signature"].as_str()?).ok()?;
    if b64u::encode(&sha256(&pk)) != from {
        return None;
    }
    let msg = jcs::canonical(&jcs::without_fields(&env, &["instance_signature"])).ok()?;
    if !mldsa_verify(&pk, &msg, &sig) {
        return None;
    }
    Some(Envelope { kind, from, inst_pubkey: pk, body: env["body"].clone() })
}

impl Broker {
    pub(crate) fn send_peer(&mut self, io: &mut dyn HostIo, to: &str, kind: &str, body: Value) {
        let bytes = seal_envelope(self.keys.inst(), to, kind, body);
        self.peer_seq += 1;
        io.send(json!({ "kind": "peer_send", "req_id": format!("peer-{}", self.peer_seq), "to_instance": to, "bytes": b64u::encode(&bytes) }));
    }

    pub(crate) fn mark_heard(&mut self, instance: &str) {
        let now = self.clock_ms();
        let h = self.heard.entry(instance.to_string()).or_default();
        h.last_ms = h.last_ms.max(now);
    }

    /// `peer_message { from_instance, bytes }`: open, authenticate, dispatch.
    pub(crate) fn on_peer_message(&mut self, io: &mut dyn HostIo, msg: &Value) {
        let Some(bytes) = msg.get("bytes").and_then(Value::as_str).and_then(|b| b64u::decode(b).ok()) else { return };
        let me = self.instance_id();
        let Some(env) = open_envelope(&bytes, &me) else { return };
        if msg.get("from_instance").and_then(Value::as_str).is_some_and(|f| f != env.from) {
            return;
        }
        let (from, pk, body) = (env.from.clone(), env.inst_pubkey.clone(), env.body);
        match env.kind.as_str() {
            "handoff_offer" => self.on_handoff_offer(io, &from, &body),
            "hello" => self.on_hello(io, &from, &pk, &body),
            "handoff_payload" => self.on_handoff_payload(io, &from, &pk, &body),
            "handoff_ack" => self.on_handoff_ack(io, &from, &pk, &body),
            "heartbeat" => self.on_heartbeat(io, &from, &pk, &body),
            "replica_gone" => self.on_replica_gone(io, &from, &body),
            "input_forward" => self.on_input_forward(io, &from, &body),
            "input_ack" => self.on_input_ack(io, &from, &body),
            "close_body" => self.on_close_body(io, &from, &body),
            "close_cosign" => self.on_close_cosign(io, &from, &pk, &body),
            "close_mismatch" => self.on_close_mismatch(io, &from, &body),
            _ => {}
        }
    }

    /// `peer_directory { peers: [{ instance, notary_card, inst_pubkey, attestation, host_url }] }`: an untrusted hint.
    pub(crate) fn on_peer_directory(&mut self, io: &mut dyn HostIo, msg: &Value) {
        // the host's current view replaces the previous one (a stopped enclave drops out of it)
        self.directory.clear();
        for p in msg.get("peers").and_then(Value::as_array).into_iter().flatten() {
            let (Some(i), Some(card), Some(pk)) = (p["instance"].as_str(), p["notary_card"].as_str(), p["inst_pubkey"].as_str().and_then(|k| b64u::decode(k).ok())) else { continue };
            // the instance id must at least be the hash of the key it names (the rest is checked by algorithm P)
            if b64u::encode(&sha256(&pk)) != i || i == self.instance_id() {
                continue;
            }
            self.directory.insert(i.into(), crate::peer::PeerHint { notary_card: card.into(), inst_pubkey: pk, host_url: p["host_url"].as_str().unwrap_or_default().into() });
        }
        // offers to peers the host no longer lists won't complete; they stop holding a place
        let dir = &self.directory;
        self.sends.retain(|_, s| dir.contains_key(&s.to));
        let hashes: Vec<[u8; 32]> = self.jobs.keys().copied().collect();
        for h in hashes {
            self.offer_job_handoffs(io, &h);
        }
    }

    /// Whether this replica is the job's leader: the lowest instance id among live members.
    pub(crate) fn is_leader(&self, hash: &[u8; 32]) -> bool {
        let Some(j) = self.jobs.get(hash) else { return false };
        let me = self.instance_id();
        self.live_members(hash).first() == Some(&me) && j.serving
    }

    /// Live members, sorted: this replica (when it is one), and members heard within the liveness window.
    pub(crate) fn live_members(&self, hash: &[u8; 32]) -> Vec<String> {
        let Some(j) = self.jobs.get(hash) else { return vec![] };
        let (me, now) = (self.instance_id(), self.clock_ms());
        let mut v: Vec<String> = j
            .members
            .keys()
            .filter(|i| !j.gone.contains(*i))
            .filter(|i| **i == me || self.heard.get(*i).is_some_and(|h| now - h.last_ms <= LIVENESS_MS))
            .cloned()
            .collect();
        v.sort();
        v
    }

    /// Step 2 / 22: the leader offers the job key to directory peers of `replica_set` cards while the job has fewer than
    /// N members, within each card's capacity.
    pub(crate) fn offer_job_handoffs(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) {
        let Some(j) = self.jobs.get(hash) else { return };
        if !j.serving || !matches!(j.state, State::Keyed | State::Open) || self.keys.job_key(hash, j.epoch).is_none() {
            return;
        }
        if !self.is_leader(hash) {
            return;
        }
        let me = self.instance_id();
        let in_flight: Vec<String> = self.sends.values().filter(|s| matches!(&s.scope, HScope::Job { hash: h, .. } if h == hash)).map(|s| s.to.clone()).collect();
        let held = j.members.len() + j.formation.len() + in_flight.len();
        if held as u32 >= j.n {
            return;
        }
        let mut count: BTreeMap<String, u32> = BTreeMap::new();
        for (i, m) in &j.members {
            if !j.gone.contains(i) {
                *count.entry(m.card.clone()).or_default() += 1;
            }
        }
        for (_, m, _) in &j.formation {
            *count.entry(m.card.clone()).or_default() += 1;
        }
        let now = self.clock_ms();
        let mut targets = vec![];
        let mut room = j.n as usize - held;
        for (inst, hint) in &self.directory {
            if room == 0 {
                break;
            }
            let recently_refused = self.refused.get(inst).is_some_and(|t| now - t <= crate::handoff::MAX_AGE_MS);
            if *inst == me || recently_refused || j.members.contains_key(inst) || j.formation.iter().any(|(i, _, _)| i == inst) || in_flight.contains(inst) {
                continue;
            }
            let c = count.entry(hint.notary_card.clone()).or_default();
            if *c >= j.allowed.get(&hint.notary_card).copied().unwrap_or(0) {
                continue;
            }
            *c += 1;
            room -= 1;
            targets.push(inst.clone());
        }
        let (epoch, card) = (j.epoch, j.card.clone());
        for t in targets {
            self.offer_handoff(io, HScope::Job { hash: *hash, epoch }, &t, &card);
        }
    }

    /// `tick {}`: one attested-clock reading, then every due timer.
    pub(crate) fn on_tick(&mut self, io: &mut dyn HostIo) {
        let Ok(now) = self.attested_now_ms() else { return };
        self.tick_ms = Some(now);
        if self.last_lists_ms.is_none_or(|t| now - t >= LIST_REFRESH_MS) {
            self.last_lists_ms = Some(now);
            self.refresh_lists(io);
        }
        self.expire_handoffs(now);
        if self.last_hb_ms.is_none_or(|t| now - t >= HEARTBEAT_MS) {
            self.last_hb_ms = Some(now);
            self.send_heartbeats(io);
            self.resend_close_bodies(io);
        }
        self.expire_pending_inputs(io, now);
        // derived cards: rotation, the issuance pool, key upkeep, all on this tick's one clock reading (step 6.4)
        self.derive_tick(io, now);
        let hashes: Vec<[u8; 32]> = self.jobs.keys().copied().collect();
        for h in hashes {
            self.check_liveness(io, &h);
            self.offer_job_handoffs(io, &h);
        }
    }

    /// Step 20: a signed Heartbeat (§30) to every peer this replica serves a job with.
    fn send_heartbeats(&mut self, io: &mut dyn HostIo) {
        let me = self.instance_id();
        let mut peers: Vec<String> = vec![];
        let mut jobs = vec![];
        for j in self.jobs.values().filter(|j| j.state.live() && j.serving) {
            jobs.push(json!({ "epoch": j.epoch, "job_hash": j.job_hash_b64, "state_version": j.state_version }));
            peers.extend(j.members.keys().filter(|i| **i != me && !j.gone.contains(*i)).cloned());
        }
        // 6.5: the other holders of this enclave's identities (known from identity handoffs), for the state blob
        let mine = self.keys.identity_cards();
        peers.extend(self.instance_cards.iter().filter(|(_, c)| mine.contains(c)).map(|(i, _)| i.clone()));
        peers.sort();
        peers.dedup();
        if peers.is_empty() {
            return;
        }
        self.hb_seq += 1;
        let (rt, pa) = self.lists.versions();
        let head = self.chain.newest_header().map(|h| json!({ "block_hash": b64u::encode(&h.hash), "block_number": h.number })).unwrap_or(json!({ "block_hash": b64u::encode(&[0u8; 32]), "block_number": 0 }));
        let now = self.clock_ms();
        let seen: Vec<String> = self.heard.iter().filter(|(_, h)| now - h.last_ms <= LIVENESS_MS).map(|(i, _)| i.clone()).collect();
        let mut hb = json!({
            "chain_head": head, "instance": me, "jobs": jobs, "list_versions": { "accepted_runtimes": rt, "program_allowlist": pa },
            "peers_seen": seen, "seq": self.hb_seq, "type": objects::types::HEARTBEAT,
        });
        if let Some(v) = self.keys.identity_cards().iter().filter_map(|c| self.keys.identity(c)).map(|i| i.state_version).max() {
            hb["identity_state_version"] = json!(v);
        }
        let states = self.identity_states();
        if !states.is_empty() {
            hb["identity_states"] = json!(states);
        }
        hb["instance_signature"] = self.keys.inst().sign_object(&hb, "instance_signature").expect("heartbeat is notary JSON");
        for p in peers {
            self.send_peer(io, &p, "heartbeat", hb.clone());
        }
    }

    /// A heartbeat counts only if signed by the sender's `K_inst` and its `seq` is newer than any seen (no replay).
    fn on_heartbeat(&mut self, io: &mut dyn HostIo, from: &str, pk: &[u8], body: &Value) {
        let Ok(hb) = objects::from_value::<objects::Heartbeat>(body, objects::types::HEARTBEAT) else { return };
        if hb.instance != from || !notary_crypto::verify_object(body, "instance_signature", pk) {
            return;
        }
        let now = self.clock_ms();
        let h = self.heard.entry(from.to_string()).or_default();
        if h.hb_seq.is_some_and(|s| hb.seq <= s) {
            return;
        }
        h.hb_seq = Some(hb.seq);
        h.last_ms = h.last_ms.max(now);
        for pj in &hb.jobs {
            let v = h.job_versions.entry(format!("{}:{}", pj.job_hash, pj.epoch)).or_default();
            *v = (*v).max(pj.state_version);
        }
        if let Some(v) = hb.identity_state_version {
            h.identity_version = Some(h.identity_version.map_or(v, |o| o.max(v)));
        }
        h.serving_cards = hb.identity_states.iter().filter(|s| s.serving).map(|s| s.notary_card.clone()).collect();
        if !hb.identity_states.is_empty() {
            let states: Vec<Value> = hb.identity_states.iter().map(|s| json!({ "header_cid": s.header_cid, "holders": s.holders, "notary_card": s.notary_card, "version": s.version })).collect();
            self.on_identity_state_hint(io, from, &states);
        }
    }

    /// Step 21: below `min_live` with at least one replica alive, the leader writes `replica_lost` for each silent
    /// member and asks its host for a replica (`need_replica`).
    fn check_liveness(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) {
        let Some(j) = self.jobs.get(hash) else { return };
        if !j.state.live() || !j.serving || !j.opened || !self.is_leader(hash) {
            return;
        }
        let live = self.live_members(hash);
        let silent: Vec<String> = j.members.keys().filter(|i| !live.contains(i)).cloned().collect();
        if silent.is_empty() || live.len() as u32 >= j.min_live {
            return;
        }
        for i in silent {
            self.write_replica_lost(io, hash, &i);
        }
    }

    pub(crate) fn write_replica_lost(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], instance: &str) {
        let Some(j) = self.jobs.get_mut(hash) else { return };
        if j.members.remove(instance).is_none() {
            return;
        }
        j.gone.remove(instance);
        j.lost_this_epoch = true;
        let (scope, card, min_live) = (j.job_hash_b64.clone(), j.card.clone(), j.min_live);
        let _ = self.append_log(io, &scope, &card, "replica_lost", json!({ "instance": instance }));
        if (self.live_members(hash).len() as u32) < min_live {
            io.send(json!({ "kind": "need_replica", "req_id": format!("need-replica-{scope}"), "job_hash": scope }));
        }
    }

    /// `replica_gone`: a member says it stops. Heartbeats may only lower the count (Q7); the leader makes it public
    /// with `replica_lost` so the anchored log stays the source of the capacity count.
    fn on_replica_gone(&mut self, io: &mut dyn HostIo, from: &str, body: &Value) {
        let hashes: Vec<[u8; 32]> = match body.get("job_hash").and_then(Value::as_str) {
            Some(s) => b64u::decode_len(s, 32).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).into_iter().collect(),
            None => self.jobs.keys().copied().collect(),
        };
        for h in hashes {
            let Some(j) = self.jobs.get_mut(&h) else { continue };
            if !j.members.contains_key(from) {
                continue;
            }
            j.gone.insert(from.to_string());
            if self.is_leader(&h) && self.jobs[&h].opened {
                self.write_replica_lost(io, &h, from);
            }
        }
    }

    /// `shutdown {}` (host): this replica stops. It tells every peer (`replica_gone`), erases every job key and stops
    /// serving; identities and template keys die with the enclave.
    pub(crate) fn on_shutdown(&mut self, io: &mut dyn HostIo, req_id: &str) -> Value {
        let me = self.instance_id();
        let hashes: Vec<[u8; 32]> = self.jobs.keys().copied().collect();
        for h in hashes {
            let j = &self.jobs[&h];
            if !j.state.live() {
                continue;
            }
            let peers: Vec<String> = j.members.keys().filter(|i| **i != me).cloned().collect();
            let scope = j.job_hash_b64.clone();
            for p in peers {
                self.send_peer(io, &p, "replica_gone", json!({ "instance": me, "job_hash": scope }));
            }
            self.keys.erase_job(&h);
            let j = self.jobs.get_mut(&h).expect("present");
            j.state = State::Superseded;
            j.serving = false;
            j.index.clear();
            j.pending_inputs.clear();
        }
        self.stopped = true;
        json!({ "kind": "shutdown_ack", "req_id": req_id })
    }
}
