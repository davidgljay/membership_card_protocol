//! Jobs (notary_runtime.md §10; lifecycle Phase 2 steps 16–20; replication §2, §7).
//!
//! `create_job`: the job checks of step 17 (W2–W10 as they apply inside the enclave, plus "this enclave's notary card
//! is in `replica_set`"), then algorithm A, and **only then** `K_job` and the purpose-0x02 attestation. The same checks
//! run on a handoff receiver before it accepts a job key (`check_job`), and on an enclave asked to restart a job it
//! doesn't hold.
//!
//! **Forming the replica set (replication §2).** With N = 1 the originator writes `opened` at once. With N > 1 it hands
//! the key to other instances (job-scope handoff, `handoff.rs`); once q instances hold it, it writes `opened` listing
//! their purpose-0x02 attestations, then a `handoff` record per receiver, and announces only after the last of those is
//! anchored (receivers don't serve before their own record is anchored, step 10).
//!
//! **Epoch restarts (replication §7, steps 25–26).** `total_loss`, `runtime_migration` (confirmed: this enclave's
//! `close_compat` differs from the previous epoch's) and `key_exposure` (confirmed from this enclave's own verified list).
//! An enclave that doesn't hold the job reads the previous log head by CID, runs the full job checks and continues the
//! log from it. Per-input jobs (derived cards) are refused with `NH_UNSUPPORTED` until step 6.4.
use crate::{
    env::HostIo,
    host_proto::{error, Broker},
    inputs::Entry,
};
use notary_admission::{admit, Admitted, Isolation, RuntimeContext};
use notary_types::{b64u, formats, jcs, objects, user_data::UserData};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Keyed,
    Open,
    Closing,
    Finalized,
    Aborted,
    /// A newer epoch was anchored (or this replica was counted lost): the key is erased and nothing is served.
    Superseded,
}

impl State {
    pub fn live(self) -> bool {
        matches!(self, State::Keyed | State::Open | State::Closing)
    }
}

/// A replica of the job, as the anchored job log names it (opened / handoff / replicated, minus replica_lost).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub card: String,
    /// Its purpose-0x02 attestation for this epoch, when known (announcements, `opened`).
    pub attestation: Option<String>,
}

pub struct Job {
    pub job: Value,
    pub job_hash: [u8; 32],
    pub job_hash_b64: String,
    pub job_cid: String,
    pub notary: Value,
    pub params_bytes: Vec<u8>,
    pub program: Vec<u8>,
    pub admitted: Admitted,
    pub card: String,
    pub epoch: u64,
    pub attestation_cid: String,
    pub transport: Value,
    pub opens_ms: i64,
    pub closes_ms: i64,
    pub n: u32,
    pub q: u32,
    pub min_live: u32,
    /// Instances each notary card may run (`replica_set`), for the capacity cap (step 7, Q7).
    pub allowed: BTreeMap<String, u32>,
    pub state: State,
    pub announced: bool,
    /// The job-log `seq` whose EAS anchor releases this epoch's announcement.
    pub announce_after: Option<u64>,
    pub announcement_cid: Option<String>,
    pub epoch_reason: Option<String>,
    /// B10 dedupe index: root-key hash → latest accepted entry. Who has a counted input, not what they chose.
    pub index: BTreeMap<[u8; 32], Entry>,
    pub rejected: u64,
    /// Sealed inputs streamed by the host at close (`close_chunk`).
    pub close_buffer: Vec<Value>,
    // ---- replication (step 6.3) ----
    pub members: BTreeMap<String, Member>,
    /// False on a handoff receiver until it has seen its own `handoff` record anchored (step 10).
    pub serving: bool,
    /// Leader, before `opened`: receivers that hold the key, with their signed HandoffRecords.
    pub formation: Vec<(String, Member, Value)>,
    pub opened: bool,
    /// A `replica_lost` was written this epoch, so later handoffs are re-replications (`replicated`).
    pub lost_this_epoch: bool,
    /// Members that said they stop (`replica_gone`) and are no longer counted live.
    pub gone: BTreeSet<String>,
    /// Count of changes to the dedupe index (`Heartbeat.jobs[].state_version`; handoff `state_version`).
    pub state_version: u64,
    pub pending_inputs: BTreeMap<String, crate::replication::PendingInput>,
    /// `H(body)` this replica co-signed for the job; it never co-signs another (replication step 17).
    pub cosigned: Option<[u8; 32]>,
    pub close: Option<crate::replication::CloseState>,
    /// The body co-signed (kept so a replica that becomes leader proposes the same one).
    pub cosigned_body: Option<Value>,
    /// The leader's latest `close_body`, kept until this replica's own close computation is done.
    pub pending_body: Option<(String, Value)>,
}

const MAX_PER_INPUT_SPAN_MS: i64 = 366 * 86_400_000;

/// A job that passed the step-17 checks and algorithm A on this enclave. No key exists yet.
pub(crate) struct Checked {
    pub job: Value,
    pub job_hash: [u8; 32],
    pub job_bytes: Vec<u8>,
    pub notary: Value,
    pub params_bytes: Vec<u8>,
    pub program: Vec<u8>,
    pub admitted: Admitted,
    pub card: String,
    pub opens_ms: i64,
    pub closes_ms: i64,
    pub n: u32,
    pub q: u32,
    pub min_live: u32,
    pub allowed: BTreeMap<String, u32>,
}

type Fail = (&'static str, String);

impl Broker {
    pub(crate) fn on_create_job(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        match self.create_job(io, msg) {
            Ok(v) => {
                let mut v = v;
                v["req_id"] = json!(req_id);
                v
            }
            Err((code, m)) => {
                if code.starts_with("ADM_") || code.starts_with("JOB_") {
                    json!({ "kind": "job_rejected", "req_id": req_id, "code": code, "message": m })
                } else {
                    error(req_id, code, m)
                }
            }
        }
    }

    /// The step-17 checks (W2–W10 inside the enclave, this enclave's card in `replica_set`, the identity log anchored),
    /// then algorithm A. `exclude` is a job this enclave may already hold (a restart or a re-handoff), so it doesn't
    /// count against the dedicated / full checks.
    pub(crate) fn check_job(&mut self, io: &mut dyn HostIo, job: &Value, program: Vec<u8>, exclude: Option<[u8; 32]>) -> Result<Checked, Fail> {
        let e = |c: &'static str, m: &str| (c, m.to_string());
        let typed: objects::NotaryJob = objects::from_value(job, objects::types::JOB).map_err(|x| ("JOB_MALFORMED", x.message))?;
        // W2: requester binding and signature; job_hash = H(complete job)
        let pk = b64u::decode_len(&typed.requester_pubkey, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).map_err(|_| e("JOB_SIGNATURE_INVALID", "requester key"))?;
        if formats::card_pointer(&pk) != typed.requester_card || typed.requester_signature.public_key != typed.requester_pubkey || !notary_crypto::verify_object(job, "requester_signature", &pk) {
            return Err(e("JOB_SIGNATURE_INVALID", "requester signature does not verify"));
        }
        let job_hash = jcs::h_bytes(job).map_err(|x| ("JOB_MALFORMED", x.message))?;
        // W9
        if typed.kem != notary_crypto::KEM_ID {
            return Err(e("JOB_KEM_UNSUPPORTED", "kem must be x-wing-draft-06"));
        }
        // W7: replica arithmetic and mode fields
        let n: u32 = typed.replica_set.iter().map(|r| r.instances).sum();
        let q = n / 2 + 1;
        if typed.replica_set.is_empty() || typed.replica_set.iter().any(|r| r.instances < 1) || !(q <= typed.min_live && typed.min_live <= n) {
            return Err(e("JOB_MALFORMED", "replica_set and min_live must satisfy q <= min_live <= N"));
        }
        let mut allowed: BTreeMap<String, u32> = BTreeMap::new();
        for r in &typed.replica_set {
            *allowed.entry(r.notary_card.clone()).or_default() += r.instances;
        }
        let ts = |s: &str| formats::parse_timestamp(s).map_err(|_| e("JOB_MALFORMED", "bad timestamp"));
        let opens_ms = ts(&typed.opens_at)?;
        // step 17: this enclave's notary card must be in replica_set
        let held = self.keys.identity_cards();
        let card = typed.replica_set.iter().map(|r| r.notary_card.clone()).find(|c| held.contains(c)).ok_or(e("JOB_NOTARY_NOT_APPROVED", "this enclave holds no replica_set card"))?;
        // lifecycle step 9 (E26): no job until the identity log's `opened` record (seq 0) is anchored
        if !self.logs.is_settled(&card, 0) {
            return Err(e("IDENTITY_LOG_PENDING", "the notary card's identity log has no anchored seq 0 yet; retry after anchoring"));
        }
        // governance lists (runtime §12) before anything depends on them
        self.refresh_lists(io);
        // W3, W4: the policy at policy_state_cid, from a chain to a trusted root
        let read_now = self.chain_now_ms().or_else(|| self.attested_now_ms().ok()).unwrap_or(0);
        let policy = self.oracle.policy(io, &typed.policy_id, &typed.policy_state_cid, read_now).map_err(|c| (c, "policy".to_string()))?;
        let notary = policy.notary.clone();
        // Single-operator quorums are enforced by wallets (W7) and verifiers (N), not here (lifecycle A.4, E34).
        // W10
        if !typed.replica_set.iter().all(|r| policy.approved_notaries.contains(&r.notary_card)) {
            return Err(e("JOB_NOTARY_NOT_APPROVED", "a replica_set card is not in approved_notaries"));
        }
        if notary.get("platform").and_then(Value::as_str) != Some(self.platform.attest.platform()) {
            return Err(e("JOB_NOTARY_NOT_APPROVED", "notary.platform differs from this enclave's platform"));
        }
        let mode = notary.get("mode").and_then(Value::as_str).unwrap_or_default();
        let closes_ms = match (mode, &typed.closes_at, &typed.key_period, &typed.ends_at) {
            ("aggregate", Some(c), None, None) => ts(c)?,
            ("per_input", None, Some(_), Some(end)) => {
                let end = ts(end)?;
                if end - opens_ms > MAX_PER_INPUT_SPAN_MS {
                    return Err(e("JOB_MALFORMED", "ends_at is more than a year after opens_at"));
                }
                return Err(e("NH_UNSUPPORTED", "per-input jobs arrive in step 6.4"));
            }
            _ => return Err(e("JOB_MALFORMED", "mode fields do not match notary.mode")),
        };
        if closes_ms <= opens_ms {
            return Err(e("JOB_MALFORMED", "closes_at must be after opens_at"));
        }
        if notary.get("output_action").and_then(Value::as_str) != Some("statement") {
            return Err(e("NH_UNSUPPORTED", "card output arrives in step 6.4"));
        }
        // W5
        if let Some(pred) = notary.get("job_requester_predicate") {
            if !self.oracle.requester_allowed(io, job, pred, read_now) {
                return Err(e("JOB_REQUESTER_NOT_PERMITTED", "requester does not satisfy job_requester_predicate"));
            }
        }
        // W6a (6.1): private output recipients and their keys
        {
            let listed: BTreeSet<&str> = notary.pointer("/output_recipients/cards").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let given = typed.output_recipient_keys.as_ref();
            let given_set: BTreeSet<&str> = given.into_iter().flat_map(|m| m.keys().map(String::as_str)).collect();
            let keys_ok = given.is_none_or(|m| m.iter().all(|(p, k)| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).is_ok_and(|pk| &formats::card_pointer(&pk) == p)));
            if listed != given_set || !keys_ok {
                return Err(e("JOB_RECIPIENT_KEYS_INVALID", "output_recipient_keys must be exactly the policy's recipient cards, each key hashing to its pointer"));
            }
        }
        // W6
        crate::params::check(&typed.parameters, notary.get("parameter_bounds")).map_err(|m| ("JOB_PARAMETERS_OUT_OF_BOUNDS", m))?;
        // W8: not closed (chain time; the attested clock if no header has arrived yet)
        let now = self.chain_now_ms().or_else(|| self.attested_now_ms().ok()).unwrap_or(i64::MAX);
        if now >= closes_ms {
            return Err(e("JOB_CLOSED", "past closes_at"));
        }
        crate::transforms::check_schema(notary.get("output_schema").unwrap_or(&Value::Null)).map_err(|m| ("JOB_MALFORMED", m))?;
        if notary.pointer("/privacy/k_min").and_then(Value::as_u64).is_none_or(|k| k < 1) {
            return Err(e("JOB_MALFORMED", "privacy.k_min must be an integer >= 1"));
        }

        // Algorithm A. No job key exists before this returns Ok.
        let live_others = |b: &Broker| b.jobs.values().filter(|j| j.state.live() && Some(j.job_hash) != exclude).count();
        let allowlist = self.lists.allowlist().unwrap_or_default();
        let attested_now = self.attested_now_ms().map_err(|m| ("ATT_UNAVAILABLE", m))?;
        let admitted = admit(&program, &notary, &RuntimeContext { allowlist: Some(&allowlist), now_ms: attested_now, held_jobs: live_others(self) }).map_err(|a| (a.code, a.detail))?;
        if self.jobs.values().any(|j| j.admitted.isolation == Isolation::Dedicated && j.state.live() && Some(j.job_hash) != exclude) {
            return Err(e("ADM_DEDICATED_REQUIRED", "this runtime holds a dedicated job"));
        }
        // runtime §3, §14: a shared runtime holds at most 256 live jobs
        if live_others(self) >= self.max_live_jobs {
            return Err(e("ADM_RUNTIME_FULL", "this runtime already holds the maximum number of live jobs"));
        }
        let job_bytes = jcs::canonical(job).map_err(|x| ("JOB_MALFORMED", x.message))?;
        let params_bytes = jcs::canonical(&typed.parameters).map_err(|x| ("JOB_PARAMETERS_OUT_OF_BOUNDS", x.message))?;
        Ok(Checked { job: job.clone(), job_hash, job_bytes, notary, params_bytes, program, admitted, card, opens_ms, closes_ms, n, q, min_live: typed.min_live, allowed })
    }

    /// The purpose-0x02 attestation for a key this enclave holds (§33). Published; returns `(doc, cid)`.
    pub(crate) fn attest_job_key(&self, io: &mut dyn HostIo, card: &str, admitted: &Admitted, job_hash: [u8; 32], epoch: u64) -> Result<(Vec<u8>, String), Fail> {
        let job_pk_hash = self.keys.job_binding(&job_hash, epoch).ok_or(("JOB_KEY_MISSING", String::new()))?;
        let (idh, _) = self.keys.identity_binding(card).ok_or(("NOTARY_KEY_EXPOSED", "identity unusable".to_string()))?;
        let ud = UserData {
            purpose: 0x02,
            id_key_hash: idh,
            inst_key_hash: self.keys.inst_key_hash(),
            program_hash: admitted.program_hash,
            job_hash,
            epoch,
            isolation: isolation_byte(admitted),
            ..Default::default()
        };
        let (doc, cid) = self.attest(ud, Some(job_pk_hash), job_hash).map_err(|m| ("ATT_UNAVAILABLE", m))?;
        self.publish(io, &doc);
        Ok((doc, cid))
    }

    /// A `Job` entry for a checked job and a key this enclave holds for `epoch`.
    pub(crate) fn job_entry(&self, c: &Checked, epoch: u64, attestation_cid: String, transport: Value, serving: bool) -> Job {
        Job {
            job: c.job.clone(),
            job_hash: c.job_hash,
            job_hash_b64: b64u::encode(&c.job_hash),
            job_cid: formats::cid_of_bytes(&c.job_bytes),
            notary: c.notary.clone(),
            params_bytes: c.params_bytes.clone(),
            program: c.program.clone(),
            admitted: c.admitted.clone(),
            card: c.card.clone(),
            epoch,
            attestation_cid,
            transport,
            opens_ms: c.opens_ms,
            closes_ms: c.closes_ms,
            n: c.n,
            q: c.q,
            min_live: c.min_live,
            allowed: c.allowed.clone(),
            state: State::Keyed,
            announced: false,
            announce_after: None,
            announcement_cid: None,
            epoch_reason: None,
            index: BTreeMap::new(),
            rejected: 0,
            close_buffer: vec![],
            members: BTreeMap::new(),
            serving,
            formation: vec![],
            opened: false,
            lost_this_epoch: false,
            gone: BTreeSet::new(),
            state_version: 0,
            pending_inputs: BTreeMap::new(),
            cosigned: None,
            close: None,
            cosigned_body: None,
            pending_body: None,
        }
    }

    fn create_job(&mut self, io: &mut dyn HostIo, msg: &Value) -> Result<Value, Fail> {
        let e = |c: &'static str, m: &str| (c, m.to_string());
        if msg.get("restart").is_some() {
            return self.restart_job(io, msg);
        }
        let job = msg.get("job").cloned().ok_or(e("JOB_MALFORMED", "job missing"))?;
        let program = msg.get("program").and_then(Value::as_str).and_then(|p| b64u::decode(p).ok()).ok_or(e("JOB_MALFORMED", "program missing"))?;
        if let Ok(h) = jcs::h_bytes(&job) {
            if self.jobs.contains_key(&h) {
                return Err(e("JOB_MALFORMED", "this enclave already holds the job"));
            }
        }
        let c = self.check_job(io, &job, program, None)?;
        // K_job,0 and the purpose-0x02 attestation (§33)
        let epoch = 0u64;
        let job_pk = self.keys.create_job_key(&c.admitted, c.job_hash, epoch).map_err(|x| (x, String::new()))?.public_key().to_vec();
        let (doc, att_cid) = self.attest_job_key(io, &c.card, &c.admitted, c.job_hash, epoch)?;
        self.publish(io, &c.job_bytes);
        let transport = msg.get("transport").cloned().unwrap_or(json!({ "key_config_url": "", "relay_target_id": "" }));
        let mut entry = self.job_entry(&c, epoch, att_cid.clone(), transport, true);
        entry.members.insert(self.instance_id(), crate::jobs::Member { card: c.card.clone(), attestation: Some(att_cid.clone()) });
        let (hash, scope, card) = (c.job_hash, b64u::encode(&c.job_hash), c.card.clone());
        self.jobs.insert(hash, entry);
        self.log_follow_start(&scope);
        if c.q <= 1 {
            // step 3 with q = 1: `opened` at once, then wait for its anchor before announcing
            self.write_opened(io, &hash)?;
        } else {
            // step 2: hand the key to the other instances of replica_set; `opened` follows once q hold it
            self.offer_job_handoffs(io, &hash);
        }
        let _ = card;
        Ok(json!({ "kind": "job_keyed", "epoch": epoch, "job_public_key": b64u::encode(&job_pk), "attestation": b64u::encode(&doc) }))
    }

    /// Replication §2 step 3: `opened` with each holder's purpose-0x02 attestation, then (N > 1) one `handoff` record
    /// per receiver. The announcement waits for the anchor of the last of them.
    pub(crate) fn write_opened(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) -> Result<(), Fail> {
        let j = self.jobs.get_mut(hash).ok_or(("NH_JOB_UNKNOWN", String::new()))?;
        if j.opened {
            return Ok(());
        }
        j.opened = true;
        let mut atts = vec![j.attestation_cid.clone()];
        let formation = std::mem::take(&mut j.formation);
        atts.extend(formation.iter().filter_map(|(_, m, _)| m.attestation.clone()));
        let (scope, card) = (j.job_hash_b64.clone(), j.card.clone());
        self.append_log(io, &scope, &card, "opened", json!({ "attestations": atts })).map_err(|c| (c, String::new()))?;
        for (inst, m, record) in formation {
            self.append_log(io, &scope, &card, "handoff", record).map_err(|c| (c, String::new()))?;
            let j = self.jobs.get_mut(hash).expect("present");
            j.members.insert(inst.clone(), m);
            self.mark_heard(&inst);
        }
        let seq = self.logs.next_seq(&scope).checked_sub(1);
        self.jobs.get_mut(hash).expect("present").announce_after = seq;
        Ok(())
    }

    /// Epoch restart (replication §7, steps 25–26). This enclave keys epoch `e + 1` itself, writes `epoch_started` and
    /// **does not announce until that record is anchored**; then it hands the new key to a fresh replica set.
    fn restart_job(&mut self, io: &mut dyn HostIo, msg: &Value) -> Result<Value, Fail> {
        let e = |c: &'static str, m: &str| (c, m.to_string());
        let job = msg.get("job").cloned().ok_or(e("JOB_MALFORMED", "job missing"))?;
        let typed: objects::NotaryJob = objects::from_value(&job, objects::types::JOB).map_err(|x| ("JOB_MALFORMED", x.message))?;
        let pk = b64u::decode_len(&typed.requester_pubkey, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).map_err(|_| e("JOB_SIGNATURE_INVALID", "requester key"))?;
        if formats::card_pointer(&pk) != typed.requester_card || typed.requester_signature.public_key != typed.requester_pubkey || !notary_crypto::verify_object(&job, "requester_signature", &pk) {
            return Err(e("JOB_SIGNATURE_INVALID", "requester signature does not verify"));
        }
        let hash = jcs::h_bytes(&job).map_err(|x| ("JOB_MALFORMED", x.message))?;
        let scope = b64u::encode(&hash);
        let restart = msg.get("restart").cloned().unwrap_or(Value::Null);
        let (prev_epoch, last_log, reason) = (restart.get("prev_epoch").and_then(Value::as_u64), restart.get("last_log").and_then(Value::as_str), restart.get("reason").and_then(Value::as_str));
        let (Some(prev_epoch), Some(last_log), Some(reason)) = (prev_epoch, last_log, reason) else { return Err(e("JOB_MALFORMED", "restart needs prev_epoch, last_log and reason")) };
        let last_log = last_log.to_string();
        if !["total_loss", "runtime_migration", "key_exposure"].contains(&reason) {
            return Err(e("JOB_MALFORMED", "reason must be total_loss, runtime_migration or key_exposure"));
        }
        let held = self.jobs.contains_key(&hash) && self.logs.has(&scope);
        if held {
            let j = &self.jobs[&hash];
            if matches!(j.state, State::Finalized | State::Aborted) {
                return Err(e("NH_JOB_CLOSED", "the job is finished"));
            }
            if prev_epoch != j.epoch {
                return Err(e("JOB_MALFORMED", "prev_epoch is not this enclave's current epoch"));
            }
            if self.logs.head(&scope).map(|(_, cid)| cid).as_deref() != Some(last_log.as_str()) {
                return Err(e("JOB_MALFORMED", "last_log is not the head of this enclave's job log"));
            }
        }
        // step 25: confirm the reason
        match reason {
            "key_exposure" => {
                self.refresh_lists(io);
                if !self.keys.job_key_exposed(&hash, prev_epoch) && !self.prev_epoch_exposed(io, &restart, &hash, prev_epoch) {
                    return Err(e("JOB_MALFORMED", "key_exposure: this enclave's verified list shows no vulnerable runtime in the epoch's key lineage"));
                }
            }
            "runtime_migration" => {
                let own = self.lists.close_compat(self.keys.pcr0());
                let prev = self.prev_epoch_compat(io, &restart, &hash, prev_epoch);
                if own.is_none() || prev.is_none() || own == prev {
                    return Err(e("JOB_MALFORMED", "runtime_migration: this runtime's close_compat must differ from the previous epoch's"));
                }
            }
            _ => {}
        }
        // step 25: chain time is still before closes_at
        let program = match msg.get("program").and_then(Value::as_str).and_then(|p| b64u::decode(p).ok()) {
            Some(p) => p,
            None => self.jobs.get(&hash).map(|j| j.program.clone()).ok_or(e("JOB_MALFORMED", "program missing"))?,
        };
        let c = self.check_job(io, &job, program, Some(hash))?;
        // Continue the log: a holder from its own head; anyone else from the record at last_log, read by CID and
        // checked to be a record of this job signed by a replica_set card (a host can point at an older one: a fork,
        // which verifiers see as JOB_LOG_FORK; replication step 26).
        if !held {
            let rec = self.fetch_log_record(io, &scope, &last_log, &c.allowed)?;
            let seq = rec.get("seq").and_then(Value::as_u64).ok_or(e("JOB_MALFORMED", "last_log is not a job-log record"))?;
            self.logs.follow_from(&scope, false, Some((seq, last_log.clone())), true);
        }
        let new_epoch = prev_epoch + 1;
        // the old epoch's key (if held) is erased now
        self.keys.erase_job_epoch(&hash, prev_epoch);
        let job_pk = self.keys.create_job_key(&c.admitted, hash, new_epoch).map_err(|x| (x, String::new()))?.public_key().to_vec();
        let (doc, att_cid) = self.attest_job_key(io, &c.card, &c.admitted, hash, new_epoch)?;
        let prev_ann = self.jobs.get(&hash).and_then(|j| j.announcement_cid.clone());
        let transport = msg.get("transport").cloned().or_else(|| self.jobs.get(&hash).map(|j| j.transport.clone())).unwrap_or(json!({ "key_config_url": "", "relay_target_id": "" }));
        let mut entry = self.job_entry(&c, new_epoch, att_cid.clone(), transport, true);
        entry.epoch_reason = Some(reason.to_string());
        entry.announcement_cid = prev_ann;
        entry.opened = true;
        entry.members.insert(self.instance_id(), Member { card: c.card.clone(), attestation: Some(att_cid) });
        self.jobs.insert(hash, entry);
        // step 26: `epoch_started`, then wait for its anchor before announcing
        self.append_log(io, &scope, &c.card, "epoch_started", json!({ "epoch": new_epoch, "epoch_reason": reason })).map_err(|x| (x, String::new()))?;
        let seq = self.logs.head(&scope).map(|(s, _)| s);
        self.jobs.get_mut(&hash).expect("present").announce_after = seq;
        if c.n > 1 {
            self.offer_job_handoffs(io, &hash);
        }
        Ok(json!({ "kind": "job_keyed", "epoch": new_epoch, "job_public_key": b64u::encode(&job_pk), "attestation": b64u::encode(&doc) }))
    }

    /// Reads a job-log record by CID (`fetch ipfs:`, CID-checked) and checks it is a record of this job signed by the
    /// `K_id` of a `replica_set` card and an instance key.
    pub(crate) fn fetch_log_record(&mut self, io: &mut dyn HostIo, scope: &str, cid: &str, cards: &BTreeMap<String, u32>) -> Result<Value, Fail> {
        let bytes = io.fetch(&format!("ipfs:{cid}")).filter(|b| formats::cid_of_bytes(b) == cid).ok_or(("JOB_MALFORMED", "last_log can't be read".to_string()))?;
        let rec = jcs::parse_canonical(&bytes).map_err(|_| ("JOB_MALFORMED", "last_log is not canonical JSON".to_string()))?;
        if rec.get("type").and_then(Value::as_str) != Some(objects::types::JOB_LOG) || rec.get("job_hash").and_then(Value::as_str) != Some(scope) || !crate::replication::record_signed_by(&rec, |c| cards.contains_key(c)) {
            return Err(("JOB_MALFORMED", "last_log is not a signed record of this job".to_string()));
        }
        Ok(rec)
    }

    /// The previous epoch's runtime, from a purpose-0x02 attestation of that epoch the host names
    /// (`restart.prev_attestation`, read by CID and verified): `Some(close_compat)`.
    fn prev_epoch_pcr0(&mut self, io: &mut dyn HostIo, restart: &Value, hash: &[u8; 32], prev_epoch: u64) -> Option<Vec<u8>> {
        let cid = restart.get("prev_attestation").and_then(Value::as_str)?;
        let doc = io.fetch(&format!("ipfs:{cid}")).filter(|b| formats::cid_of_bytes(b) == cid)?;
        let env = self.parse_attestation(&doc)?;
        let ud = UserData::decode(&env.user_data).ok()?;
        (ud.purpose == 0x02 && ud.job_hash == *hash && ud.epoch == prev_epoch).then_some(env.measurement)
    }

    fn prev_epoch_compat(&mut self, io: &mut dyn HostIo, restart: &Value, hash: &[u8; 32], prev_epoch: u64) -> Option<String> {
        if let Some(j) = self.jobs.get(hash).filter(|j| j.epoch == prev_epoch && self.keys.job_key(hash, prev_epoch).is_some()) {
            let _ = j;
            return self.lists.close_compat(self.keys.pcr0());
        }
        let pcr0 = self.prev_epoch_pcr0(io, restart, hash, prev_epoch)?;
        self.lists.close_compat(&pcr0)
    }

    fn prev_epoch_exposed(&mut self, io: &mut dyn HostIo, restart: &Value, hash: &[u8; 32], prev_epoch: u64) -> bool {
        let Some(pcr0) = self.prev_epoch_pcr0(io, restart, hash, prev_epoch) else { return false };
        self.lists.vulnerable_pcr0s().contains(&pcr0)
    }

    /// Continuations that wait for an anchor: the announcement (step 20); key erasure after `notarized` or `aborted`
    /// (step 44).
    pub(crate) fn after_anchor(&mut self, io: &mut dyn HostIo, scope: &str, seq: u64) {
        let Ok(Ok(hash)) = b64u::decode_len(scope, 32).map(<[u8; 32]>::try_from) else { return };
        let Some(job) = self.jobs.get(&hash) else { return };
        if Some(seq) == job.announce_after && !job.announced && job.state == State::Keyed {
            if let Some(ann) = self.sign_announcement(&hash) {
                let ann_cid = formats::cid_of_bytes(&jcs::canonical(&ann).expect("notary JSON"));
                io.send(json!({ "kind": "announce", "req_id": format!("announce-{scope}-{seq}"), "announcement": ann }));
                let j = self.jobs.get_mut(&hash).expect("present");
                j.announcement_cid = Some(ann_cid);
                j.announced = true;
                j.state = State::Open;
            }
        }
        let j = &self.jobs[&hash];
        if matches!(j.state, State::Finalized | State::Aborted) && self.logs.is_settled(scope, seq) {
            self.erase_job_state(&hash);
        }
    }

    /// Step 44: keys, index and buffers erased.
    pub(crate) fn erase_job_state(&mut self, hash: &[u8; 32]) {
        self.keys.erase_job(hash);
        self.workers.stop(hash);
        if let Some(j) = self.jobs.get_mut(hash) {
            j.index.clear();
            j.close_buffer.clear();
            j.program.clear();
            j.pending_inputs.clear();
            j.close = None;
        }
    }

    pub(crate) fn sign_announcement(&self, hash: &[u8; 32]) -> Option<Value> {
        let j = self.jobs.get(hash)?;
        let pk = self.keys.job_key(hash, j.epoch)?.public_key().to_vec();
        let ident = self.keys.identity(&j.card)?;
        // one purpose-0x02 attestation per live replica (§22)
        let mut atts: Vec<String> = vec![j.attestation_cid.clone()];
        for (inst, m) in &j.members {
            if *inst != self.instance_id() && !j.gone.contains(inst) {
                if let Some(a) = &m.attestation {
                    atts.push(a.clone());
                }
            }
        }
        let mut ann = json!({
            "attestations": atts, "epoch": j.epoch, "issued_at": self.now_iso().ok()?, "job": j.job,
            "job_public_key": b64u::encode(&pk), "transport": j.transport, "type": objects::types::ANNOUNCEMENT,
        });
        if let Some(reason) = &j.epoch_reason {
            ann["epoch_reason"] = json!(reason);
        }
        if j.epoch > 0 {
            if let Some(prev) = &j.announcement_cid {
                ann["prev_announcement"] = json!(prev);
            }
        }
        ann["notary_signature"] = ident.id.sign_object(&ann, "notary_signature").ok()?;
        Some(ann)
    }

    pub(crate) fn on_abort(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(|s| b64u::decode_len(s, 32).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
            return error(req_id, "NH_MALFORMED", "job_hash");
        };
        let Some(j) = self.jobs.get_mut(&hash) else { return error(req_id, "NH_JOB_UNKNOWN", "no such job") };
        if !j.state.live() {
            return error(req_id, "NH_JOB_CLOSED", "job already finished");
        }
        j.state = State::Aborted;
        let (scope, card) = (j.job_hash_b64.clone(), j.card.clone());
        let reason = msg.get("reason").and_then(Value::as_str).unwrap_or("operator").chars().take(64).collect::<String>();
        let _ = self.append_log(io, &scope, &card, "aborted", json!({ "reason": reason }));
        let head = self.logs.head(&scope).map(|(seq, cid)| json!({ "seq": seq, "cid": cid })).unwrap_or(Value::Null);
        json!({ "kind": "job_log_record", "req_id": req_id, "record": head })
    }
}

/// Headers that held inputs name (R3): every live job's index entries' `chain_ref` blocks.
pub(crate) fn pinned_blocks(jobs: &BTreeMap<[u8; 32], Job>) -> BTreeSet<[u8; 32]> {
    jobs.values().filter(|j| j.state.live()).flat_map(|j| j.index.values().map(|e| e.block)).collect()
}

pub(crate) fn isolation_byte(a: &Admitted) -> u8 {
    if a.isolation == Isolation::Shared {
        0x01
    } else {
        0x02
    }
}
