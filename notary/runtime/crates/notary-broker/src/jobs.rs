//! Jobs (notary_runtime.md §10; lifecycle Phase 2 steps 16–20).
//!
//! `create_job`: the job checks of step 17 (W2–W10 as they apply inside the enclave, plus "this enclave's notary card
//! is in `replica_set`"), then algorithm A, and **only then** `K_job` and the purpose-0x02 attestation. The `opened`
//! job-log record is written next; the announcement is signed and handed to the host only after that record's EAS
//! anchor arrives (step 19–20).
//!
//! Step 5.3 scope: aggregate jobs on a single replica. Per-input jobs (derived cards, 6.4), epochs and restarts (6.2),
//! and multi-replica key sharing (6.3) are refused with `NH_UNSUPPORTED` until those steps land.
use crate::{
    env::HostIo,
    host_proto::{error, Broker},
    inputs::Entry,
};
use notary_admission::{admit, Admitted, Isolation, RuntimeContext};
use notary_types::{b64u, formats, jcs, objects, user_data::UserData};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Keyed,
    Open,
    Closing,
    Finalized,
    Aborted,
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
    pub state: State,
    pub announced: bool,
    /// B10 dedupe index: root-key hash → latest accepted entry. Who has a counted input, not what they chose.
    pub index: BTreeMap<[u8; 32], Entry>,
    pub rejected: u64,
    /// Sealed inputs streamed by the host at close (`close_chunk`).
    pub close_buffer: Vec<Value>,
}

const MAX_PER_INPUT_SPAN_MS: i64 = 366 * 86_400_000;

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

    fn create_job(&mut self, io: &mut dyn HostIo, msg: &Value) -> Result<Value, (&'static str, String)> {
        let e = |c: &'static str, m: &str| (c, m.to_string());
        if msg.get("restart").is_some() {
            return Err(e("NH_UNSUPPORTED", "epoch restarts arrive in step 6.2"));
        }
        let job = msg.get("job").cloned().ok_or(e("JOB_MALFORMED", "job missing"))?;
        let typed: objects::NotaryJob = objects::from_value(&job, objects::types::JOB).map_err(|x| ("JOB_MALFORMED", x.message))?;
        let program = msg.get("program").and_then(Value::as_str).and_then(|p| b64u::decode(p).ok()).ok_or(e("JOB_MALFORMED", "program missing"))?;

        // W2: requester binding and signature; job_hash = H(complete job)
        let pk = b64u::decode_len(&typed.requester_pubkey, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).map_err(|_| e("JOB_SIGNATURE_INVALID", "requester key"))?;
        if formats::card_pointer(&pk) != typed.requester_card || typed.requester_signature.public_key != typed.requester_pubkey
            || !notary_crypto::verify_object(&job, "requester_signature", &pk)
        {
            return Err(e("JOB_SIGNATURE_INVALID", "requester signature does not verify"));
        }
        let job_hash = jcs::h_bytes(&job).map_err(|x| ("JOB_MALFORMED", x.message))?;
        if self.jobs.contains_key(&job_hash) {
            return Err(e("JOB_MALFORMED", "this enclave already holds the job"));
        }
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
        // Single-operator quorums are enforced by wallets (W7) and verifiers (N), not here: an enclave could read other
        // operators' notary cards only from host-supplied data (lifecycle A.4, erratum E34).
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
            if !self.oracle.requester_allowed(io, &job, pred, read_now) {
                return Err(e("JOB_REQUESTER_NOT_PERMITTED", "requester does not satisfy job_requester_predicate"));
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
        let allowlist = self.lists.allowlist().unwrap_or_default();
        let attested_now = self.attested_now_ms().map_err(|m| ("ATT_UNAVAILABLE", m))?;
        let admitted = admit(&program, &notary, &RuntimeContext { allowlist: Some(&allowlist), now_ms: attested_now, held_jobs: self.jobs.len() })
            .map_err(|a| (a.code, a.detail))?;
        if self.jobs.values().any(|j| j.admitted.isolation == Isolation::Dedicated && !matches!(j.state, State::Finalized | State::Aborted)) {
            return Err(e("ADM_DEDICATED_REQUIRED", "this runtime holds a dedicated job"));
        }

        // K_job,0 and the purpose-0x02 attestation (§33)
        let epoch = 0u64;
        let job_pk = self.keys.create_job_key(&admitted, job_hash, epoch).map_err(|c| (c, String::new()))?.public_key().to_vec();
        let (idh, _) = self.keys.identity_binding(&card).ok_or(e("NOTARY_KEY_EXPOSED", "identity unusable"))?;
        let ud = UserData {
            purpose: 0x02,
            id_key_hash: idh,
            inst_key_hash: self.keys.inst_key_hash(),
            program_hash: admitted.program_hash,
            job_hash,
            epoch,
            isolation: if admitted.isolation == Isolation::Shared { 0x01 } else { 0x02 },
            ..Default::default()
        };
        let (doc, att_cid) = self.attest(ud, Some(notary_crypto::sha256(&job_pk)), job_hash).map_err(|m| ("ATT_UNAVAILABLE", m))?;
        self.publish(io, &doc);
        let job_bytes = jcs::canonical(&job).map_err(|x| ("JOB_MALFORMED", x.message))?;
        self.publish(io, &job_bytes);

        let job_hash_b64 = b64u::encode(&job_hash);
        let params_bytes = jcs::canonical(&typed.parameters).map_err(|x| ("JOB_PARAMETERS_OUT_OF_BOUNDS", x.message))?;
        self.jobs.insert(
            job_hash,
            Job {
                job: job.clone(),
                job_hash,
                job_hash_b64: job_hash_b64.clone(),
                job_cid: formats::cid_of_bytes(&job_bytes),
                notary,
                params_bytes,
                program,
                admitted,
                card: card.clone(),
                epoch,
                attestation_cid: att_cid.clone(),
                transport: msg.get("transport").cloned().unwrap_or(json!({ "key_config_url": "", "relay_target_id": "" })),
                opens_ms,
                closes_ms,
                n,
                q,
                state: State::Keyed,
                announced: false,
                index: BTreeMap::new(),
                rejected: 0,
                close_buffer: vec![],
            },
        );
        // step 19: `opened`, then wait for its anchor before announcing
        self.append_log(io, &job_hash_b64, &card, "opened", json!({ "attestations": [att_cid] })).map_err(|c| (c, String::new()))?;
        Ok(json!({ "kind": "job_keyed", "epoch": epoch, "job_public_key": b64u::encode(&job_pk), "attestation": b64u::encode(&doc) }))
    }

    /// Continuations that wait for an anchor: the announcement after `opened` (step 20); key erasure after `notarized`
    /// or `aborted` (step 44).
    pub(crate) fn after_anchor(&mut self, io: &mut dyn HostIo, scope: &str, seq: u64) {
        let Ok(Ok(hash)) = b64u::decode_len(scope, 32).map(<[u8; 32]>::try_from) else { return };
        let Some(job) = self.jobs.get(&hash) else { return };
        if seq == 0 && !job.announced && job.state == State::Keyed {
            if let Some(ann) = self.sign_announcement(&hash) {
                io.send(json!({ "kind": "announce", "req_id": format!("announce-{scope}"), "announcement": ann }));
                let j = self.jobs.get_mut(&hash).expect("present");
                j.announced = true;
                j.state = State::Open;
            }
        }
        let j = &self.jobs[&hash];
        if matches!(j.state, State::Finalized | State::Aborted) && self.logs.is_settled(scope, seq) {
            self.keys.erase_job(&hash);
            self.workers.stop(&hash);
            let j = self.jobs.get_mut(&hash).expect("present");
            j.index.clear();
            j.close_buffer.clear();
            j.program.clear();
        }
    }

    fn sign_announcement(&self, hash: &[u8; 32]) -> Option<Value> {
        let j = self.jobs.get(hash)?;
        let pk = self.keys.job_key(hash, j.epoch)?.public_key().to_vec();
        let ident = self.keys.identity(&j.card)?;
        let mut ann = json!({
            "attestations": [j.attestation_cid], "epoch": j.epoch, "issued_at": self.now_iso(), "job": j.job,
            "job_public_key": b64u::encode(&pk), "transport": j.transport, "type": objects::types::ANNOUNCEMENT,
        });
        ann["notary_signature"] = ident.id.sign_object(&ann, "notary_signature").ok()?;
        Some(ann)
    }

    pub(crate) fn on_abort(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(|s| b64u::decode_len(s, 32).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
            return error(req_id, "NH_MALFORMED", "job_hash");
        };
        let Some(j) = self.jobs.get_mut(&hash) else { return error(req_id, "NH_JOB_UNKNOWN", "no such job") };
        if matches!(j.state, State::Finalized | State::Aborted) {
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
