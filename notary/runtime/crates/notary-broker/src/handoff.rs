//! The handoff protocol (notary_replication_and_recovery.md §3, steps 5–10; algorithm P).
//!
//! A sender S moves keys to a receiver R, through hosts, in four peer messages (`peer.rs`, protocol-objects.md §35):
//!
//! 1. S → R `handoff_offer`: the scope (`job`, `identity`, `template`), S's fresh challenge, and for job scope the public
//!    `NotaryJob` (R runs the step-17 job checks and algorithm A on it; the program comes from R's own host by CID).
//! 2. R → S `hello`: R's fresh challenge, an ephemeral X-Wing handoff key, its purpose-0x03 attestation
//!    (`nonce` = S's challenge, `public_key` = SHA-256(handoff key)), for job scope its purpose-0x04 attestation, and a
//!    `K_id` signature over S's challenge (job and template scope: R proves it holds its notary card's key).
//! 3. S runs algorithm P on R (P1–P5) and the capacity cap (step 7, counted from the job log, Q7), then sends
//!    `handoff_payload`: its own purpose-0x03 attestation (`nonce` = R's challenge), a `K_id` signature over R's
//!    challenge, for job scope its purpose-0x02 attestation, and the payload HPKE-sealed to R's handoff key with
//!    `info = "card-notary-handoff-v1" || S challenge || R challenge`, plus `K_inst`'s signature over SHA-256(ciphertext).
//! 4. R runs algorithm P on S, opens the payload, refuses a lineage containing a vulnerable runtime (P5) and a state
//!    version below one it has seen, installs the keys, erases the handoff key, and returns `handoff_ack` with the
//!    `HandoffRecord` (§29) signed by its `K_inst`. S writes the `handoff` record (job log for job scope, S's identity
//!    log otherwise). R serves only after it sees that record anchored (step 10; `replication.rs`, log following).
//!
//! Refusals raise an `alert` with the code to the refusing side's own host and end the session; the handoff key is
//! erased when a session ends or after five minutes.
//!
//! **Invariants.** I1: keys leave only through `Keyring::export_*`, which take a `PeerChecked` that only this module
//! constructs, after P passed. I2: keys enter only through `Keyring::install_*`, which take a `PayloadOpened` that only
//! this module constructs, after P passed on the sender and the payload opened under this enclave's own handoff key.
//! P5: an exposed key is never exported (the keyring refuses, and P5 is checked before).
use crate::{
    env::HostIo,
    host_proto::Broker,
    jobs::{isolation_byte, Checked, Member, State},
    keyring::ExportedIdentity,
};
use notary_attest::{
    verify::{verify_envelope, verify_parsed, Context, Expected},
    Envelope,
};
use notary_crypto::{keccak256, mldsa_verify, sha256, xwing_seal, SecretBytes, XWingKey};
use notary_types::{b64u, formats, jcs, objects, user_data::UserData};
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Proof that algorithm P passed on a receiver. Only this module constructs it (I1).
pub struct PeerChecked(());
/// Proof that a payload was opened under this enclave's handoff key from a sender that passed P. Only this module
/// constructs it (I2).
pub struct PayloadOpened(());

pub const HANDOFF_INFO: &[u8] = b"card-notary-handoff-v1";
pub const ABI: &str = "notary_v1";
/// Handoff attestation age (replication §1) and session lifetime.
pub const MAX_AGE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HScope {
    Job { hash: [u8; 32], epoch: u64 },
    Identity { card: String },
    Template { template: String },
}

impl HScope {
    pub fn name(&self) -> &'static str {
        match self {
            HScope::Job { .. } => "job",
            HScope::Identity { .. } => "identity",
            HScope::Template { .. } => "template",
        }
    }
}

pub struct SendSession {
    pub scope: HScope,
    pub to: String,
    pub chal_s: [u8; 32],
    pub started_ms: i64,
    /// S's notary card (the job's card, or the identity / template holder card).
    pub my_card: String,
    pub chal_r: Option<[u8; 32]>,
    pub from_att_cid: Option<String>,
    pub to_att_cid: Option<String>,
    pub pcr0_to: Option<Vec<u8>>,
    pub to_card: Option<String>,
    pub state_version: u64,
    pub state_hash: String,
    pub key_generation: Option<u64>,
}

pub struct RecvSession {
    pub scope: HScope,
    pub from: String,
    pub chal_s: [u8; 32],
    pub chal_r: [u8; 32],
    pub hk: XWingKey,
    pub started_ms: i64,
    /// R's card: the job's replica card or the template card (job, template); the card requested (identity).
    pub card: String,
    pub(crate) checked: Option<Checked>,
    pub att_doc: Vec<u8>,
    pub adm_att_doc: Option<Vec<u8>>,
}

type Res<T> = Result<T, &'static str>;

fn arr32(v: &[u8]) -> Option<[u8; 32]> {
    v.try_into().ok()
}
fn b64_32(v: Option<&Value>) -> Option<[u8; 32]> {
    v.and_then(Value::as_str).and_then(|s| b64u::decode_len(s, 32).ok()).and_then(|b| arr32(&b))
}
fn b64_bytes(v: Option<&Value>) -> Option<Vec<u8>> {
    v.and_then(Value::as_str).and_then(|s| b64u::decode(s).ok())
}
fn lineage_json(l: &BTreeSet<Vec<u8>>) -> Value {
    json!(l.iter().map(|p| b64u::encode(p)).collect::<Vec<_>>())
}
fn lineage_of(v: &Value) -> Option<BTreeSet<Vec<u8>>> {
    v.as_array()?.iter().map(|p| p.as_str().and_then(|s| b64u::decode(s).ok())).collect()
}
/// Notary JSON never carries `null`: absent optional fields are omitted (notary conventions).
fn strip_nulls(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|_, x| !x.is_null());
            m.values_mut().for_each(strip_nulls);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

fn handoff_info(chal_s: &[u8; 32], chal_r: &[u8; 32]) -> Vec<u8> {
    let mut info = HANDOFF_INFO.to_vec();
    info.extend_from_slice(chal_s);
    info.extend_from_slice(chal_r);
    info
}
fn handoff_aad(from: &str, to: &str, id: &str, scope: &str) -> Vec<u8> {
    jcs::canonical(&json!({ "from": from, "handoff_id": id, "scope": scope, "to": to })).expect("strings")
}

impl Broker {
    fn refuse(&mut self, io: &mut dyn HostIo, id: &str, code: &'static str) {
        if let Some(s) = self.sends.remove(id) {
            // a refused peer isn't offered the same scope again for a while (it would be refused the same way)
            let now = self.clock_ms();
            self.refused.insert(s.to, now);
        }
        self.recvs.remove(id); // drops (zeroizes) the handoff key
        io.send(json!({ "kind": "alert", "req_id": format!("handoff-{id}"), "level": "warn", "code": code }));
    }

    /// Algorithm P needs verified lists (P2, P4, P5): read them if this runtime has none yet.
    fn ensure_lists(&mut self, io: &mut dyn HostIo) {
        if self.lists.versions().0 == 0 {
            self.refresh_lists(io);
        }
    }

    pub(crate) fn clock_ms(&self) -> i64 {
        self.tick_ms.or_else(|| self.attested_now_ms().ok()).unwrap_or(0)
    }

    /// V1–V5 through the platform's verifier module (this runtime's own platform and pinned root).
    pub(crate) fn parse_attestation(&self, doc: &[u8]) -> Option<Envelope> {
        verify_envelope(doc, &self.platform.peer_roots, self.platform.attest.platform()).ok()
    }

    /// V6–V12 with this runtime's verified accepted-runtime list.
    fn check_doc(&self, env: &Envelope, ud: UserData, nonce: Option<Vec<u8>>, public_key: Option<Vec<u8>>, max_age: Option<i64>) -> Res<Vec<u8>> {
        let now = self.attested_now_ms().map_err(|_| "ATT_UNAVAILABLE")?;
        let rts = self.lists.accepted_runtimes();
        let ctx = Context { t_eval_ms: now, now_ms: now, max_age_ms: max_age, accepted_runtimes: &rts, platform: self.platform.attest.platform() };
        let v = verify_parsed(env, &Expected { user_data: ud, nonce, public_key }, &ctx)?;
        if !v.warnings.is_empty() {
            return Err("ATT_RUNTIME_NOT_ACCEPTED");
        }
        Ok(v.measurement)
    }

    /// P1 and P2 on a peer's purpose-0x03 attestation: returns the peer's PCR0.
    fn p1_p2(&self, doc: &[u8], inst_pk: &[u8], nonce: &[u8; 32], public_key: Option<[u8; 32]>) -> Res<Vec<u8>> {
        let env = self.parse_attestation(doc).ok_or("ATT_MALFORMED")?;
        let ud = UserData { purpose: 0x03, inst_key_hash: sha256(inst_pk), ..Default::default() };
        let pcr0 = match self.check_doc(&env, ud, Some(nonce.to_vec()), public_key.map(|k| k.to_vec()), Some(MAX_AGE_MS)) {
            Ok(p) => p,
            Err("ATT_RUNTIME_NOT_ACCEPTED") => return Err("HANDOFF_RUNTIME_NOT_ACCEPTED"),
            Err(c) => return Err(c),
        };
        // P2: two different PCR0s only if both are accepted (a runtime upgrade)
        if pcr0 != self.keys.pcr0() && !self.own_runtime_accepted() {
            return Err("HANDOFF_RUNTIME_NOT_ACCEPTED");
        }
        Ok(pcr0)
    }

    fn own_runtime_accepted(&self) -> bool {
        let Ok(now) = self.attested_now_ms() else { return false };
        self.lists.accepted_runtimes().iter().any(|r| r.pcr0 == self.keys.pcr0() && r.accepted_from_ms <= now && r.retired_at_ms.is_none_or(|t| now < t))
    }

    /// P4's `close_compat` half: both runtimes' accepted entries carry the same value.
    fn same_compat(&self, other_pcr0: &[u8]) -> bool {
        let (a, b) = (self.lists.close_compat(self.keys.pcr0()), self.lists.close_compat(other_pcr0));
        a.is_some() && a == b
    }

    fn exposed_lineage(&self, l: &BTreeSet<Vec<u8>>) -> bool {
        let v = self.lists.vulnerable_pcr0s();
        l.iter().any(|p| v.contains(p))
    }

    fn id_proof(&self, card: &str, chal: &[u8; 32]) -> Option<(String, String)> {
        let i = self.keys.identity(card)?;
        Some((b64u::encode(i.id.public_key()), b64u::encode(&i.id.sign(chal))))
    }

    /// P3's key proof: `id_pubkey` hashes to the card and signed the challenge.
    fn proves_card(body: &Value, chal: &[u8; 32]) -> Option<String> {
        let pk = b64_bytes(body.get("id_pubkey"))?;
        let sig = b64_bytes(body.get("id_proof"))?;
        mldsa_verify(&pk, chal, &sig).then(|| formats::card_pointer(&pk))
    }

    // ---- sender ------------------------------------------------------------------------------------------------

    /// Step 5 (S): offers a handoff of `scope` to `to`.
    pub(crate) fn offer_handoff(&mut self, io: &mut dyn HostIo, scope: HScope, to: &str, my_card: &str) {
        self.ensure_lists(io);
        let chal_s: [u8; 32] = notary_crypto::random_array();
        let id = b64u::encode(&chal_s);
        let mut body = json!({ "challenge": id, "from_card": my_card, "handoff_id": id, "scope": scope.name() });
        match &scope {
            HScope::Job { hash, epoch } => {
                let Some(j) = self.jobs.get(hash) else { return };
                body["job"] = j.job.clone();
                body["epoch"] = json!(epoch);
            }
            HScope::Identity { card } => body["card"] = json!(card),
            HScope::Template { template } => body["template"] = json!(template),
        }
        let now = self.clock_ms();
        self.sends.insert(
            id.clone(),
            SendSession { scope, to: to.into(), chal_s, started_ms: now, my_card: my_card.into(), chal_r: None, from_att_cid: None, to_att_cid: None, pcr0_to: None, to_card: None, state_version: 0, state_hash: String::new(), key_generation: None },
        );
        self.send_peer(io, to, "handoff_offer", body);
    }

    /// Host-started identity and template handoffs (`start_handoff`); job-scope handoffs are started by the job leader.
    pub(crate) fn on_start_handoff(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        let to = msg.get("to_instance").and_then(Value::as_str).unwrap_or_default().to_string();
        let r = match msg.get("scope").and_then(Value::as_str) {
            Some("identity") => {
                let card = msg.get("card").and_then(Value::as_str).unwrap_or_default().to_string();
                // an exposed identity is still offered, so that P5 refuses it visibly (HANDOFF_KEY_EXPOSED)
                if self.keys.identity_held(&card).is_none() {
                    Err("HANDOFF_SCOPE_DENIED")
                } else {
                    self.offer_handoff(io, HScope::Identity { card: card.clone() }, &to, &card);
                    Ok(())
                }
            }
            Some("template") => {
                let template = msg.get("template").and_then(Value::as_str).unwrap_or_default().to_string();
                let card = msg.get("card").and_then(Value::as_str).unwrap_or_default().to_string();
                if self.keys.template_key(&template).is_none() || self.keys.identity(&card).is_none() {
                    Err("HANDOFF_SCOPE_DENIED")
                } else {
                    self.offer_handoff(io, HScope::Template { template }, &to, &card);
                    Ok(())
                }
            }
            _ => Err("NH_MALFORMED"),
        };
        match r {
            Ok(()) => json!({ "kind": "handoff_started", "req_id": req_id }),
            Err(c) => crate::host_proto::error(req_id, c, "cannot start that handoff"),
        }
    }

    /// Step 7 (S): algorithm P on R, the capacity cap, then step 8: seal and send the payload.
    pub(crate) fn on_hello(&mut self, io: &mut dyn HostIo, from: &str, inst_pk: &[u8], body: &Value) {
        let Some(id) = body.get("handoff_id").and_then(Value::as_str).map(String::from) else { return };
        let Some(s) = self.sends.get(&id) else { return };
        if s.to != from || s.chal_r.is_some() {
            return;
        }
        match self.sender_checks(io, &id, inst_pk, body) {
            Ok(checked) => {
                if let Err(c) = self.send_payload(io, &id, &checked, body) {
                    self.refuse(io, &id, c);
                }
            }
            Err(c) => self.refuse(io, &id, c),
        }
    }

    fn sender_checks(&mut self, io: &mut dyn HostIo, id: &str, inst_pk: &[u8], body: &Value) -> Res<PeerChecked> {
        let s = &self.sends[id];
        let (scope, chal_s, my_card) = (s.scope.clone(), s.chal_s, s.my_card.clone());
        let chal_r = b64_32(body.get("challenge")).ok_or("NH_MALFORMED")?;
        let hk_pub = b64_bytes(body.get("handoff_pubkey")).ok_or("NH_MALFORMED")?;
        let doc = b64_bytes(body.get("attestation")).ok_or("ATT_MALFORMED")?;
        // P1, P2
        let pcr0_r = self.p1_p2(&doc, inst_pk, &chal_s, Some(sha256(&hk_pub)))?;
        // P3
        let to_card = match &scope {
            HScope::Job { hash, .. } => {
                let card = Self::proves_card(body, &chal_s).ok_or("HANDOFF_SCOPE_DENIED")?;
                let j = self.jobs.get(hash).ok_or("NH_JOB_UNKNOWN")?;
                if !j.allowed.contains_key(&card) {
                    return Err("HANDOFF_SCOPE_DENIED");
                }
                card
            }
            HScope::Identity { card } => {
                if *card != my_card || self.keys.identity_held(card).is_none() {
                    return Err("HANDOFF_SCOPE_DENIED");
                }
                card.clone()
            }
            HScope::Template { template } => {
                let card = Self::proves_card(body, &chal_s).ok_or("HANDOFF_SCOPE_DENIED")?;
                if !self.oracle.serves_template(io, &card, template) {
                    return Err("HANDOFF_SCOPE_DENIED");
                }
                card
            }
        };
        // P4 (job scope): R's purpose-0x04 attestation binds the same program, job, epoch and isolation; same ABI;
        // both runtimes share close_compat.
        if let HScope::Job { hash, epoch } = &scope {
            let j = &self.jobs[hash];
            let adm = b64_bytes(body.get("admitted_attestation")).ok_or("HANDOFF_PROGRAM_MISMATCH")?;
            let env = self.parse_attestation(&adm).ok_or("ATT_MALFORMED")?;
            let id_pk = b64_bytes(body.get("id_pubkey")).ok_or("HANDOFF_SCOPE_DENIED")?;
            let ud = UserData {
                purpose: 0x04,
                id_key_hash: keccak256(&id_pk),
                inst_key_hash: sha256(inst_pk),
                program_hash: j.admitted.program_hash,
                job_hash: *hash,
                epoch: *epoch,
                isolation: isolation_byte(&j.admitted),
                ..Default::default()
            };
            match self.check_doc(&env, ud, Some(chal_s.to_vec()), Some(sha256(&hk_pub).to_vec()), Some(MAX_AGE_MS)) {
                Ok(_) => {}
                Err("ATT_BINDING_MISMATCH" | "ATT_PURPOSE_MISMATCH") => return Err("HANDOFF_PROGRAM_MISMATCH"),
                Err("ATT_RUNTIME_NOT_ACCEPTED") => return Err("HANDOFF_RUNTIME_NOT_ACCEPTED"),
                Err(c) => return Err(c),
            }
            if body.get("abi").and_then(Value::as_str) != Some(ABI) {
                return Err("HANDOFF_PROGRAM_MISMATCH");
            }
            if !self.same_compat(&pcr0_r) {
                return Err("HANDOFF_COMPAT_MISMATCH");
            }
        }
        // P5: no key being transferred has a vulnerable runtime in its lineage
        let exposed = match &scope {
            HScope::Job { hash, epoch } => self.keys.job_key_exposed(hash, *epoch) || self.keys.job_lineage(hash, *epoch).is_none_or(|l| self.exposed_lineage(l)),
            HScope::Identity { card } => self.keys.identity_held(card).is_none_or(|i| i.exposed || self.exposed_lineage(&i.lineage)),
            HScope::Template { template } => self.keys.template_key(template).is_none_or(|t| self.exposed_lineage(&t.lineage)),
        };
        if exposed {
            return Err("HANDOFF_KEY_EXPOSED");
        }
        // Step 7 (Q7): R's card already runs as many instances as replica_set allows, counted from the job log
        if let HScope::Job { hash, .. } = &scope {
            let j = &self.jobs[hash];
            let live = j.members.iter().filter(|(i, m)| m.card == to_card && !j.gone.contains(*i)).count() as u32
                + j.formation.iter().filter(|(_, m, _)| m.card == to_card).count() as u32;
            if live >= j.allowed.get(&to_card).copied().unwrap_or(0) {
                return Err("HANDOFF_OVER_CAPACITY");
            }
        }
        let s = self.sends.get_mut(id).expect("present");
        s.chal_r = Some(chal_r);
        s.pcr0_to = Some(pcr0_r);
        s.to_card = Some(to_card);
        s.to_att_cid = Some(formats::cid_of_bytes(&doc));
        Ok(PeerChecked(()))
    }

    fn send_payload(&mut self, io: &mut dyn HostIo, id: &str, checked: &PeerChecked, hello: &Value) -> Res<()> {
        let s = &self.sends[id];
        let (scope, to, chal_s, chal_r, my_card) = (s.scope.clone(), s.to.clone(), s.chal_s, s.chal_r.expect("set"), s.my_card.clone());
        let hk_pub = b64_bytes(hello.get("handoff_pubkey")).ok_or("NH_MALFORMED")?;
        let me = self.instance_id();
        // the payload (step 8); key material only through export_* (I1)
        let (payload, version, hash_s, generation) = match &scope {
            HScope::Job { hash, epoch } => {
                let x = self.keys.export_job_key(checked, hash, *epoch).ok_or("HANDOFF_KEY_EXPOSED")?;
                let j = &self.jobs[hash];
                let index: Vec<Value> = j
                    .index
                    .iter()
                    .map(|(root, e)| json!({ "block": b64u::encode(&e.block), "epoch": e.epoch, "input_digest": b64u::encode(&e.input_digest), "input_hash": e.input_hash, "revision": e.revision, "root": b64u::encode(root) }))
                    .collect();
                // R3: the headers the index's inputs point to, so the receiver can re-run B3 on them at close
                let blocks: BTreeSet<[u8; 32]> = j.index.values().map(|e| e.block).collect();
                let headers: Vec<Value> = blocks
                    .iter()
                    .filter_map(|b| self.chain.get(b))
                    .map(|h| json!({ "hash": b64u::encode(&h.hash), "number": h.number, "parent": b64u::encode(&h.parent), "state_root": b64u::encode(&h.state_root), "timestamp": h.timestamp }))
                    .collect();
                let members: Vec<Value> = j.members.iter().map(|(i, m)| json!({ "attestation": m.attestation, "card": m.card, "instance": i })).collect();
                let head = self.logs.head(&j.job_hash_b64);
                let settled = head.as_ref().is_none_or(|(seq, _)| self.logs.is_settled(&j.job_hash_b64, *seq));
                let state_hash = jcs::h(&json!(index)).expect("notary JSON");
                let p = json!({
                    "announcement_cid": j.announcement_cid, "epoch": epoch, "epoch_reason": j.epoch_reason, "headers": headers, "index": index, "job_hash": j.job_hash_b64,
                    "key": b64u::encode(x.secret.expose()), "lineage": lineage_json(&x.lineage), "log_head": head.as_ref().map(|h| h.1.clone()),
                    "log_seq": head.as_ref().map(|h| h.0), "log_settled": settled, "lost_this_epoch": j.lost_this_epoch, "members": members,
                    "opened": j.opened, "rejected": j.rejected, "scope": "job", "state_hash": state_hash, "state_version": j.state_version, "transport": j.transport,
                });
                (p, j.state_version, state_hash, None)
            }
            HScope::Identity { card } => {
                let x: ExportedIdentity = self.keys.export_identity(checked, card).ok_or("HANDOFF_KEY_EXPOSED")?;
                let head = self.logs.head(card);
                let settled = head.as_ref().is_none_or(|(seq, _)| self.logs.is_settled(card, *seq));
                let (rt, pa) = self.lists.versions();
                let p = json!({
                    "card": card, "chain_secret": b64u::encode(x.chain_secret.expose()), "id_seed": b64u::encode(x.id_seed.expose()),
                    "lineage": lineage_json(&x.lineage), "list_versions": { "accepted_runtimes": rt, "program_allowlist": pa },
                    "log_head": head.as_ref().map(|h| h.1.clone()), "log_seq": head.as_ref().map(|h| h.0), "log_settled": settled, "scope": "identity",
                    "state_hash": x.state_hash, "state_key": b64u::encode(x.state_key.expose()), "state_version": x.state_version,
                });
                (p, x.state_version, x.state_hash.clone(), None)
            }
            HScope::Template { template } => {
                let (x, generation) = self.keys.export_template_key(checked, template).ok_or("HANDOFF_KEY_EXPOSED")?;
                let empty = b64u::encode(&sha256(b""));
                let p = json!({ "generation": generation, "key": b64u::encode(x.secret.expose()), "lineage": lineage_json(&x.lineage), "scope": "template",
                    "state_hash": empty, "state_version": 0, "template": template });
                (p, 0, empty, Some(generation))
            }
        };
        let mut payload = payload;
        strip_nulls(&mut payload);
        let plain = SecretBytes::from_vec(jcs::canonical(&payload).map_err(|_| "NH_MALFORMED")?);
        drop(payload);
        let sealed = xwing_seal(&hk_pub, &handoff_info(&chal_s, &chal_r), &handoff_aad(&me, &to, id, scope.name()), plain.expose()).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
        // S's own purpose-0x03 attestation, nonce = R's challenge (step 6)
        let ud = UserData { purpose: 0x03, inst_key_hash: self.keys.inst_key_hash(), ..Default::default() };
        let (doc, att_cid) = self.attest(ud, None, chal_r).map_err(|_| "ATT_UNAVAILABLE")?;
        self.publish(io, &doc);
        let (id_pubkey, id_proof) = self.id_proof(&my_card, &chal_r).ok_or("HANDOFF_KEY_EXPOSED")?;
        let mut body = json!({
            "attestation": b64u::encode(&doc), "ct": b64u::encode(&sealed.ct), "ct_signature": b64u::encode(&self.keys.inst().sign(&sha256(&sealed.ct))),
            "enc": b64u::encode(&sealed.enc), "handoff_id": id, "id_proof": id_proof, "id_pubkey": id_pubkey,
        });
        if let HScope::Job { hash, .. } = &scope {
            let j = &self.jobs[hash];
            let job_att = io.fetch(&format!("ipfs:{}", j.attestation_cid)).filter(|b| formats::cid_of_bytes(b) == j.attestation_cid);
            match job_att {
                Some(b) => body["job_attestation"] = json!(b64u::encode(&b)),
                None => {
                    // re-attest the held key (the host lost the published document)
                    let (card, adm, h, e) = (j.card.clone(), j.admitted.clone(), j.job_hash, j.epoch);
                    let (d, _) = self.attest_job_key(io, &card, &adm, h, e).map_err(|_| "ATT_UNAVAILABLE")?;
                    body["job_attestation"] = json!(b64u::encode(&d));
                }
            }
        }
        let s = self.sends.get_mut(id).expect("present");
        s.from_att_cid = Some(att_cid);
        s.state_version = version;
        s.state_hash = hash_s;
        s.key_generation = generation;
        self.send_peer(io, &to, "handoff_payload", body);
        Ok(())
    }

    /// Step 10 (S): R's signed HandoffRecord. S writes the `handoff` record (and, for a job whose replica set lost a
    /// member this epoch, `replicated`). Before `opened`, job-scope receivers are collected until q hold the key.
    pub(crate) fn on_handoff_ack(&mut self, io: &mut dyn HostIo, from: &str, inst_pk: &[u8], body: &Value) {
        let Some(id) = body.get("handoff_id").and_then(Value::as_str).map(String::from) else { return };
        let Some(s) = self.sends.get(&id) else { return };
        if s.to != from || s.from_att_cid.is_none() {
            return;
        }
        let rec = body.get("record").cloned().unwrap_or(Value::Null);
        let Ok(typed) = objects::from_value::<objects::HandoffRecord>(&rec, objects::types::HANDOFF) else { return self.refuse(io, &id, "HANDOFF_RECORD_INVALID") };
        let me = self.instance_id();
        let expect_job = match &s.scope {
            HScope::Job { hash, epoch } => (Some(b64u::encode(hash)), Some(*epoch)),
            _ => (None, None),
        };
        let ok = typed.scope == s.scope.name()
            && typed.from_instance == me
            && typed.to_instance == from
            && Some(&typed.from_attestation) == s.from_att_cid.as_ref()
            && Some(&typed.to_attestation) == s.to_att_cid.as_ref()
            && Some(&typed.to_notary_card) == s.to_card.as_ref()
            && typed.pcr0_from == b64u::encode(self.keys.pcr0())
            && Some(typed.pcr0_to.clone()) == s.pcr0_to.as_ref().map(|p| b64u::encode(p))
            && typed.state_version == s.state_version
            && typed.state_hash == s.state_hash
            && typed.key_generation == s.key_generation
            && (typed.job_hash.clone(), typed.epoch) == expect_job
            && typed.receiver_signature.public_key == b64u::encode(inst_pk)
            && notary_crypto::verify_object(&rec, "receiver_signature", inst_pk);
        if !ok {
            return self.refuse(io, &id, "HANDOFF_RECORD_INVALID");
        }
        let s = self.sends.remove(&id).expect("present");
        match s.scope {
            HScope::Job { hash, epoch } => {
                let att = body.get("job_attestation").and_then(Value::as_str).map(String::from);
                let card = typed.to_notary_card.clone();
                let Some(j) = self.jobs.get_mut(&hash) else { return };
                if j.epoch != epoch || !j.state.live() {
                    return;
                }
                let member = Member { card, attestation: att.clone() };
                if !j.opened {
                    j.formation.push((from.to_string(), member, rec));
                    if 1 + j.formation.len() as u32 >= j.q {
                        let _ = self.write_opened(io, &hash);
                    }
                    return;
                }
                let (scope, my_card, lost) = (j.job_hash_b64.clone(), j.card.clone(), j.lost_this_epoch);
                j.members.insert(from.to_string(), member);
                self.mark_heard(from);
                let _ = self.append_log(io, &scope, &my_card, "handoff", rec);
                if lost {
                    let _ = self.append_log(io, &scope, &my_card, "replicated", json!({ "attestation": att.unwrap_or_default(), "instance": from }));
                }
            }
            HScope::Identity { card } => {
                self.instance_cards.insert(from.to_string(), card.clone());
                let _ = self.append_log(io, &card, &card, "handoff", rec);
            }
            HScope::Template { .. } => {
                let _ = self.append_log(io, &s.my_card, &s.my_card, "handoff", rec);
            }
        }
    }

    // ---- receiver ----------------------------------------------------------------------------------------------

    /// Steps 5–6 (R): checks what it can of the offer, makes a handoff key and attests it.
    pub(crate) fn on_handoff_offer(&mut self, io: &mut dyn HostIo, from: &str, body: &Value) {
        let Some(id) = body.get("handoff_id").and_then(Value::as_str).map(String::from) else { return };
        let Some(chal_s) = b64_32(body.get("challenge")) else { return };
        if self.recvs.contains_key(&id) || b64u::encode(&chal_s) != id {
            return;
        }
        let r = self.receiver_prepare(io, from, &id, chal_s, body);
        match r {
            Ok(hello) => self.send_peer(io, from, "hello", hello),
            Err(c) => {
                io.send(json!({ "kind": "alert", "req_id": format!("handoff-{id}"), "level": "warn", "code": c }));
            }
        }
    }

    fn receiver_prepare(&mut self, io: &mut dyn HostIo, from: &str, id: &str, chal_s: [u8; 32], body: &Value) -> Res<Value> {
        self.ensure_lists(io);
        let (scope, card, checked) = match body.get("scope").and_then(Value::as_str) {
            Some("job") => {
                let job = body.get("job").ok_or("NH_MALFORMED")?;
                let epoch = body.get("epoch").and_then(Value::as_u64).ok_or("NH_MALFORMED")?;
                let hash = jcs::h_bytes(job).map_err(|_| "NH_MALFORMED")?;
                if self.keys.job_key(&hash, epoch).is_some() {
                    return Err("HANDOFF_ALREADY_HELD");
                }
                let cid = job.pointer("/policy_id").and_then(Value::as_str).ok_or("NH_MALFORMED")?.to_string();
                let _ = cid;
                // the program comes from this enclave's own host by CID (checked), never from the offer
                let program_cid = self.program_cid_for(io, job)?;
                let program = io.fetch(&format!("ipfs:{program_cid}")).filter(|b| formats::cid_of_bytes(b) == program_cid).ok_or("HANDOFF_PROGRAM_UNAVAILABLE")?;
                // step 6: program admission (and the step-17 job checks) before anything is attested
                let c = self.check_job(io, job, program, Some(hash)).map_err(|(code, _)| code)?;
                (HScope::Job { hash, epoch }, c.card.clone(), Some(c))
            }
            Some("identity") => {
                let card = body.get("card").and_then(Value::as_str).ok_or("NH_MALFORMED")?.to_string();
                if self.keys.identity_held(&card).is_some() {
                    return Err("HANDOFF_ALREADY_HELD");
                }
                (HScope::Identity { card: card.clone() }, card, None)
            }
            Some("template") => {
                let template = body.get("template").and_then(Value::as_str).ok_or("NH_MALFORMED")?.to_string();
                let card = self.keys.identity_cards().into_iter().next().ok_or("HANDOFF_SCOPE_DENIED")?;
                (HScope::Template { template }, card, None)
            }
            _ => return Err("NH_MALFORMED"),
        };
        let chal_r: [u8; 32] = notary_crypto::random_array();
        let hk = XWingKey::generate();
        let hk_hash = sha256(hk.public_key());
        let ud = UserData { purpose: 0x03, inst_key_hash: self.keys.inst_key_hash(), ..Default::default() };
        let (doc, _) = self.attest(ud, Some(hk_hash), chal_s).map_err(|_| "ATT_UNAVAILABLE")?;
        self.publish(io, &doc);
        let mut hello = json!({ "abi": ABI, "attestation": b64u::encode(&doc), "challenge": b64u::encode(&chal_r), "handoff_id": id, "handoff_pubkey": b64u::encode(hk.public_key()) });
        let mut adm_doc = None;
        if let (HScope::Job { hash, epoch }, Some(c)) = (&scope, &checked) {
            let (idh, _) = self.keys.identity_binding(&card).ok_or("HANDOFF_SCOPE_DENIED")?;
            let ud = UserData { purpose: 0x04, id_key_hash: idh, inst_key_hash: self.keys.inst_key_hash(), program_hash: c.admitted.program_hash, job_hash: *hash, epoch: *epoch, isolation: isolation_byte(&c.admitted), ..Default::default() };
            let (d, _) = self.attest(ud, Some(hk_hash), chal_s).map_err(|_| "ATT_UNAVAILABLE")?;
            self.publish(io, &d);
            hello["admitted_attestation"] = json!(b64u::encode(&d));
            adm_doc = Some(d);
        }
        if !matches!(scope, HScope::Identity { .. }) {
            let (pk, sig) = self.id_proof(&card, &chal_s).ok_or("HANDOFF_SCOPE_DENIED")?;
            hello["id_pubkey"] = json!(pk);
            hello["id_proof"] = json!(sig);
        }
        let now = self.clock_ms();
        self.recvs.insert(id.into(), RecvSession { scope, from: from.into(), chal_s, chal_r, hk, started_ms: now, card, checked, att_doc: doc, adm_att_doc: adm_doc });
        Ok(hello)
    }

    /// The program CID the job's policy names (read through the oracle, as the job checks do).
    fn program_cid_for(&mut self, io: &mut dyn HostIo, job: &Value) -> Res<String> {
        let typed: objects::NotaryJob = objects::from_value(job, objects::types::JOB).map_err(|_| "JOB_MALFORMED")?;
        let now = self.chain_now_ms().or_else(|| self.attested_now_ms().ok()).unwrap_or(0);
        let p = self.oracle.policy(io, &typed.policy_id, &typed.policy_state_cid, now)?;
        p.notary.get("program_cid").and_then(Value::as_str).map(String::from).ok_or("JOB_MALFORMED")
    }

    /// Step 9 (R): algorithm P on S, open, P5, state version, install, erase the handoff key, sign the record.
    pub(crate) fn on_handoff_payload(&mut self, io: &mut dyn HostIo, from: &str, inst_pk: &[u8], body: &Value) {
        let Some(id) = body.get("handoff_id").and_then(Value::as_str).map(String::from) else { return };
        let Some(r) = self.recvs.get(&id) else { return };
        if r.from != from {
            return;
        }
        let r = self.recvs.remove(&id).expect("present");
        match self.receive(io, &id, from, inst_pk, body, r) {
            Ok(ack) => self.send_peer(io, from, "handoff_ack", ack),
            Err(c) => io.send(json!({ "kind": "alert", "req_id": format!("handoff-{id}"), "level": "warn", "code": c })),
        }
    }

    fn receive(&mut self, io: &mut dyn HostIo, id: &str, from: &str, inst_pk: &[u8], body: &Value, r: RecvSession) -> Res<Value> {
        // P1, P2 on S (nonce = R's challenge, no public key)
        let doc = b64_bytes(body.get("attestation")).ok_or("ATT_MALFORMED")?;
        let pcr0_s = self.p1_p2(&doc, inst_pk, &r.chal_r, None)?;
        // P3 on S
        let s_card = Self::proves_card(body, &r.chal_r).ok_or("HANDOFF_SCOPE_DENIED")?;
        match &r.scope {
            HScope::Job { .. } => {
                let c = r.checked.as_ref().expect("job scope");
                if !c.allowed.contains_key(&s_card) {
                    return Err("HANDOFF_SCOPE_DENIED");
                }
            }
            HScope::Identity { card } => {
                if s_card != *card {
                    return Err("HANDOFF_SCOPE_DENIED");
                }
            }
            HScope::Template { template } => {
                if !self.oracle.serves_template(io, &s_card, template) {
                    return Err("HANDOFF_SCOPE_DENIED");
                }
            }
        }
        // the ciphertext signature (step 8)
        let ct = b64_bytes(body.get("ct")).ok_or("HANDOFF_PAYLOAD_INVALID")?;
        let enc = b64_bytes(body.get("enc")).ok_or("HANDOFF_PAYLOAD_INVALID")?;
        let ct_sig = b64_bytes(body.get("ct_signature")).ok_or("HANDOFF_PAYLOAD_INVALID")?;
        if !mldsa_verify(inst_pk, &sha256(&ct), &ct_sig) {
            return Err("HANDOFF_PAYLOAD_INVALID");
        }
        let me = self.instance_id();
        let opened = r.hk.open(&enc, &ct, &handoff_info(&r.chal_s, &r.chal_r), &handoff_aad(from, &me, id, r.scope.name())).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
        let p = jcs::parse_canonical(opened.plaintext.expose()).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
        drop(opened);
        if p.get("scope").and_then(Value::as_str) != Some(r.scope.name()) {
            return Err("HANDOFF_PAYLOAD_INVALID");
        }
        // P5 on the received lineage
        let lineage = lineage_of(&p["lineage"]).ok_or("HANDOFF_PAYLOAD_INVALID")?;
        if self.exposed_lineage(&lineage) {
            return Err("HANDOFF_KEY_EXPOSED");
        }
        let state_version = p.get("state_version").and_then(Value::as_u64).ok_or("HANDOFF_PAYLOAD_INVALID")?;
        let state_hash = p.get("state_hash").and_then(Value::as_str).ok_or("HANDOFF_PAYLOAD_INVALID")?.to_string();
        let proof = PayloadOpened(());
        let mut key_generation = None;
        let mut job_att_cid = None;
        let to_card = r.card.clone();
        match &r.scope {
            HScope::Job { hash, epoch } => {
                let c = r.checked.as_ref().expect("job scope");
                // step 9: never older state than this sender's own heartbeats showed
                if self.heard.get(from).and_then(|h| h.job_versions.get(&format!("{}:{}", b64u::encode(hash), epoch))).is_some_and(|v| state_version < *v) {
                    io.send(json!({ "kind": "alert", "req_id": "state-regression", "level": "error", "code": "STATE_VERSION_REGRESSION" }));
                    return Err("STATE_VERSION_REGRESSION");
                }
                let secret = SecretBytes::from_vec(b64_bytes(p.get("key")).ok_or("HANDOFF_PAYLOAD_INVALID")?);
                // P4 on S: S's purpose-0x02 attestation binds this job, epoch, program, isolation and the very key sent
                let sdoc = b64_bytes(body.get("job_attestation")).ok_or("HANDOFF_PROGRAM_MISMATCH")?;
                let env = self.parse_attestation(&sdoc).ok_or("ATT_MALFORMED")?;
                let probe = XWingKey::from_secret(SecretBytes::from_vec(secret.expose().to_vec())).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
                let ud = UserData {
                    purpose: 0x02,
                    id_key_hash: keccak256(&b64_bytes(body.get("id_pubkey")).unwrap_or_default()),
                    inst_key_hash: sha256(inst_pk),
                    program_hash: c.admitted.program_hash,
                    job_hash: *hash,
                    epoch: *epoch,
                    isolation: isolation_byte(&c.admitted),
                    ..Default::default()
                };
                match self.check_doc(&env, ud, Some(hash.to_vec()), Some(sha256(probe.public_key()).to_vec()), None) {
                    Ok(_) => {}
                    Err("ATT_BINDING_MISMATCH" | "ATT_PURPOSE_MISMATCH" | "ATT_KEY_MISMATCH" | "ATT_NONCE_MISMATCH") => return Err("HANDOFF_PROGRAM_MISMATCH"),
                    Err("ATT_RUNTIME_NOT_ACCEPTED") => return Err("HANDOFF_RUNTIME_NOT_ACCEPTED"),
                    Err(code) => return Err(code),
                }
                drop(probe);
                if !self.same_compat(&pcr0_s) {
                    return Err("HANDOFF_COMPAT_MISMATCH");
                }
                self.keys.install_job_key(&proof, &c.admitted, *hash, *epoch, secret, lineage).map_err(|_| "HANDOFF_ALREADY_HELD")?;
                // this replica's own purpose-0x02 attestation for the key it now holds
                let (_, att) = self.attest_job_key(io, &c.card, &c.admitted, *hash, *epoch).map_err(|(code, _)| code)?;
                job_att_cid = Some(att.clone());
                self.install_job_state(io, c, *epoch, att, &p);
            }
            HScope::Identity { card } => {
                let x = ExportedIdentity {
                    id_seed: SecretBytes::from_vec(b64_bytes(p.get("id_seed")).ok_or("HANDOFF_PAYLOAD_INVALID")?),
                    chain_secret: SecretBytes::from_vec(b64_bytes(p.get("chain_secret")).ok_or("HANDOFF_PAYLOAD_INVALID")?),
                    state_key: SecretBytes::from_vec(b64_bytes(p.get("state_key")).ok_or("HANDOFF_PAYLOAD_INVALID")?),
                    state_version,
                    state_hash: state_hash.clone(),
                    lineage,
                };
                // step 9 / 31: never a state version below one seen from a holder of this card
                let seen = self.heard.iter().filter(|(i, _)| self.instance_cards.get(*i) == Some(card)).filter_map(|(_, h)| h.identity_version).max();
                if seen.is_some_and(|v| state_version < v) {
                    io.send(json!({ "kind": "alert", "req_id": "state-regression", "level": "error", "code": "STATE_VERSION_REGRESSION" }));
                    return Err("STATE_VERSION_REGRESSION");
                }
                self.keys.install_identity(&proof, card, x)?;
                // the identity log continues from the sender's head; this enclave follows it to see its own record
                let head = p.get("log_head").and_then(Value::as_str).map(String::from).zip(p.get("log_seq").and_then(Value::as_u64)).map(|(c, s)| (s, c));
                let settled = p.get("log_settled").and_then(Value::as_bool).unwrap_or(false);
                self.logs.follow_from(card, true, head, settled);
                self.instance_cards.insert(from.to_string(), card.clone());
                // the highest governance-list versions seen travel with the identity (runtime §12 step 4)
                let lv = &p["list_versions"];
                self.lists.raise_floors(lv.get("accepted_runtimes").and_then(Value::as_u64).unwrap_or(0), lv.get("program_allowlist").and_then(Value::as_u64).unwrap_or(0));
                self.drain_follow_buffer(io, card);
            }
            HScope::Template { template } => {
                let generation = p.get("generation").and_then(Value::as_u64).ok_or("HANDOFF_PAYLOAD_INVALID")?;
                let key = SecretBytes::from_vec(b64_bytes(p.get("key")).ok_or("HANDOFF_PAYLOAD_INVALID")?);
                self.keys.install_template_key(&proof, template, generation, key, lineage)?;
                key_generation = Some(generation);
                // S writes the record to its own identity log; this enclave watches that log for it
                self.template_watch.insert(s_card.clone(), template.clone());
                self.drain_follow_buffer(io, &s_card);
            }
        }
        // the handoff key is erased here (r.hk dropped with the session at the end of this function)
        let at = self.now_iso().map_err(|_| "ATT_UNAVAILABLE")?;
        let mut rec = json!({
            "at": at, "from_attestation": formats::cid_of_bytes(&doc), "from_instance": from, "pcr0_from": b64u::encode(&pcr0_s),
            "pcr0_to": b64u::encode(self.keys.pcr0()), "scope": r.scope.name(), "state_hash": state_hash, "state_version": state_version,
            "to_attestation": formats::cid_of_bytes(&r.att_doc), "to_instance": me, "to_notary_card": to_card, "type": objects::types::HANDOFF,
        });
        if let HScope::Job { hash, epoch } = &r.scope {
            rec["job_hash"] = json!(b64u::encode(hash));
            rec["epoch"] = json!(epoch);
        }
        if let Some(g) = key_generation {
            rec["key_generation"] = json!(g);
        }
        rec["receiver_signature"] = self.keys.inst().sign_object(&rec, "receiver_signature").map_err(|_| "NH_MALFORMED")?;
        let mut ack = json!({ "handoff_id": id, "record": rec });
        if let Some(a) = job_att_cid {
            ack["job_attestation"] = json!(a);
        }
        drop(r);
        Ok(ack)
    }

    /// A job-scope receiver's job state: not serving until its handoff record is anchored (step 10).
    fn install_job_state(&mut self, io: &mut dyn HostIo, c: &Checked, epoch: u64, att: String, p: &Value) {
        let transport = p.get("transport").cloned().unwrap_or(json!({ "key_config_url": "", "relay_target_id": "" }));
        let mut j = self.job_entry(c, epoch, att, transport, false);
        for e in p["index"].as_array().into_iter().flatten() {
            let (Some(root), Some(digest), Some(block)) = (b64_32(e.get("root")), b64_32(e.get("input_digest")), b64_32(e.get("block"))) else { continue };
            j.index.insert(
                root,
                crate::inputs::Entry {
                    revision: e["revision"].as_u64().unwrap_or(0),
                    input_hash: e["input_hash"].as_str().unwrap_or_default().into(),
                    epoch: e["epoch"].as_u64().unwrap_or(epoch),
                    input_digest: digest,
                    block,
                },
            );
        }
        for m in p["members"].as_array().into_iter().flatten() {
            if let (Some(i), Some(card)) = (m["instance"].as_str(), m["card"].as_str()) {
                j.members.insert(i.into(), Member { card: card.into(), attestation: m["attestation"].as_str().map(String::from) });
            }
        }
        // R3: the sender's pinned headers, adopted from an attested sender (they never move this chain's time)
        for h in p["headers"].as_array().into_iter().flatten() {
            let (Some(hash), Some(parent), Some(state_root), Some(number), Some(timestamp)) =
                (b64_32(h.get("hash")), b64_32(h.get("parent")), b64_32(h.get("state_root")), h.get("number").and_then(Value::as_u64), h.get("timestamp").and_then(Value::as_u64))
            else { continue };
            self.chain.adopt_trusted(crate::chain::Header { hash, parent, state_root, number, timestamp });
        }
        j.rejected = p["rejected"].as_u64().unwrap_or(0);
        j.state_version = p["state_version"].as_u64().unwrap_or(0);
        j.lost_this_epoch = p["lost_this_epoch"].as_bool().unwrap_or(false);
        j.opened = p["opened"].as_bool().unwrap_or(false);
        j.epoch_reason = p["epoch_reason"].as_str().map(String::from);
        j.announcement_cid = p["announcement_cid"].as_str().map(String::from);
        j.state = State::Keyed;
        let hashes: Vec<String> = j.index.values().filter(|e| e.epoch == epoch).map(|e| e.input_hash.clone()).collect();
        let scope = j.job_hash_b64.clone();
        for i in j.members.keys().cloned().collect::<Vec<_>>() {
            self.mark_heard(&i);
        }
        self.jobs.insert(c.job_hash, j);
        let head = p.get("log_head").and_then(Value::as_str).map(String::from).zip(p.get("log_seq").and_then(Value::as_u64)).map(|(c, s)| (s, c));
        let settled = p.get("log_settled").and_then(Value::as_bool).unwrap_or(false);
        self.logs.follow_from(&scope, false, head, settled);
        // Q8: the ciphertexts this replica's host never stored, fetched from peer hosts and checked by hash there
        if !hashes.is_empty() {
            io.send(json!({ "kind": "need_inputs", "req_id": format!("need-{scope}"), "job_hash": scope, "epoch": epoch, "hashes": hashes }));
        }
        self.drain_follow_buffer(io, &scope);
    }

    /// Five minutes after it started, a handoff session ends and its handoff key is erased.
    pub(crate) fn expire_handoffs(&mut self, now: i64) {
        self.sends.retain(|_, s| now - s.started_ms <= MAX_AGE_MS);
        self.recvs.retain(|_, r| now - r.started_ms <= MAX_AGE_MS);
    }
}
