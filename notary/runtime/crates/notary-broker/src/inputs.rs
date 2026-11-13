//! Input submission (lifecycle Phase 5, steps 30–33; Appendix B checks B1–B11; protocol-objects.md §23–§26).
//!
//! B1 (open with `K_job,epoch`) failures go back to the host as a plain error: no receipt is possible. Every other
//! outcome produces a signed `ValidationReceipt` sealed under the key exported from the input's own HPKE context, so
//! the host can't read whether the input was accepted. Plaintext lives only in `SecretBytes` and is zeroized on drop.
//!
//! The broker keeps, per accepted input, `root_key_hash → { revision, input_hash, epoch }` (plus the digest of the
//! signed input, to tell a resubmission from a conflict): who has a counted input, not what they chose.
//!
//! Step 5.3 scope: a single replica (`acks` = 1). Quorum acknowledgment across replicas is step 6.3.
use crate::{env::HostIo, host_proto::{error, Broker}, jobs::State};
use notary_crypto::{sealed_input_info_aad, seal_receipt};
use notary_types::{b64u, jcs, objects};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub revision: u64,
    pub input_hash: String,
    pub epoch: u64,
    pub input_digest: [u8; 32],
}

/// The outcome of B2–B11 for one decrypted input.
pub(crate) enum Verdict {
    Accepted { root: [u8; 32], entry: Entry },
    Superseded { revision: u64 },
    Rejected { code: &'static str, revision: u64 },
}

impl Broker {
    pub(crate) fn on_submit_input(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        let Some(sealed) = msg.get("sealed_input").cloned() else { return error(req_id, "INPUT_MALFORMED", "sealed_input missing") };
        let Ok(typed) = objects::from_value::<objects::SealedInput>(&sealed, objects::types::SEALED_INPUT) else {
            return error(req_id, "INPUT_MALFORMED", "not a SealedInput");
        };
        let Some(hash) = b64u::decode_len(&typed.job_hash, 32).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
            return error(req_id, "INPUT_MALFORMED", "job_hash");
        };
        if msg.get("job_hash").and_then(Value::as_str) != Some(typed.job_hash.as_str()) {
            return error(req_id, "INPUT_WRONG_JOB", "sealed input is for another job");
        }
        let Some(job) = self.jobs.get(&hash) else { return error(req_id, "NH_JOB_UNKNOWN", "no such job here") };
        if job.state != State::Open {
            return error(req_id, "NH_JOB_CLOSED", "the job is not open for inputs");
        }
        if typed.epoch != job.epoch || typed.kem != notary_crypto::KEM_ID {
            return error(req_id, "INPUT_UNDECRYPTABLE", "wrong epoch or kem");
        }
        let Ok(input_hash) = jcs::h(&sealed) else { return error(req_id, "INPUT_MALFORMED", "not notary JSON") };
        let Some(opened) = self.open_sealed(&hash, &typed) else { return error(req_id, "INPUT_UNDECRYPTABLE", "B1: cannot open with the job key") };

        let verdict = self.check_input(io, &hash, opened.plaintext.expose(), &input_hash, typed.epoch, false);
        let job = self.jobs.get_mut(&hash).expect("present");
        let (status, reject_reason, revision) = match verdict {
            Verdict::Accepted { root, entry } => {
                let rev = entry.revision;
                job.index.insert(root, entry);
                ("accepted", None, rev)
            }
            Verdict::Superseded { revision } => ("superseded", None, revision),
            Verdict::Rejected { code, revision } => {
                job.rejected += 1;
                ("rejected", Some(code), revision)
            }
        };
        let (epoch, card, scope) = (job.epoch, job.card.clone(), job.job_hash_b64.clone());
        let Some(ident) = self.keys.identity(&card) else { return error(req_id, "NOTARY_KEY_EXPOSED", "identity unusable") };
        let mut receipt = json!({
            "acks": 1, "epoch": epoch, "input_hash": input_hash, "instance": self.keys.instance_id(), "job_hash": scope,
            "processed_at": self.now_iso(), "revision": revision, "status": status, "type": objects::types::VALIDATION_RECEIPT,
        });
        if let Some(r) = reject_reason {
            receipt["reject_reason"] = json!(r);
        }
        receipt["notary_signature"] = match ident.id.sign_object(&receipt, "notary_signature") {
            Ok(s) => s,
            Err(_) => return error(req_id, "INPUT_MALFORMED", "receipt"),
        };
        let bytes = jcs::canonical(&receipt).expect("receipt is notary JSON");
        match seal_receipt(&opened.receipt_key, &input_hash, &scope, &bytes) {
            Ok(sealed) => json!({ "kind": "input_result", "req_id": req_id, "input_hash": input_hash, "receipt_sealed": b64u::encode(&sealed) }),
            Err(_) => error(req_id, "INPUT_UNDECRYPTABLE", "receipt sealing failed"),
        }
    }

    pub(crate) fn open_sealed(&self, hash: &[u8; 32], s: &objects::SealedInput) -> Option<notary_crypto::Opened> {
        let key = self.keys.job_key(hash, s.epoch)?;
        let (info, aad) = sealed_input_info_aad(hash, s.epoch);
        let enc = b64u::decode(&s.enc).ok()?;
        let ct = b64u::decode(&s.ct).ok()?;
        key.open(&enc, &ct, &info, &aad).ok()
    }

    /// B2–B11 on a decrypted input. `at_close` re-runs against the closing chain state and skips B10/B11 updates
    /// (close recomputes the counted set itself).
    pub(crate) fn check_input(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], plaintext: &[u8], input_hash: &str, epoch: u64, at_close: bool) -> Verdict {
        let reject = |code, revision| Verdict::Rejected { code, revision };
        // B2
        let Ok(input) = jcs::parse_canonical(plaintext) else { return reject("INPUT_MALFORMED", 0) };
        let Ok(typed) = objects::from_value::<objects::NotaryInput>(&input, objects::types::INPUT) else { return reject("INPUT_MALFORMED", 0) };
        let rev = typed.revision;
        let job = &self.jobs[hash];
        if typed.job_hash != job.job_hash_b64 {
            return reject("INPUT_WRONG_JOB", rev);
        }
        // B3
        let Some(bh) = b64u::decode_len(&typed.chain_ref.block_hash, 32).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
            return reject("INPUT_CHAIN_REF_UNKNOWN", rev);
        };
        let header_ms = match self.chain.lookup(&bh, typed.chain_ref.block_number) {
            Ok(h) => h.timestamp as i64 * 1000,
            Err(c) => return reject(c, rev),
        };
        // B4
        if header_ms < job.opens_ms {
            return reject("INPUT_TOO_EARLY", rev);
        }
        if header_ms >= job.closes_ms {
            return reject("INPUT_LATE", rev);
        }
        let (notary, params) = (job.notary.clone(), job.job["parameters"].clone());
        // B5–B8: card chain, binding, trust, revocation, eligibility (notary-cards)
        let now = self.chain.chain_time_ms().unwrap_or(header_ms);
        let root = match self.oracle.contributor(io, &input, &notary, &params, now) {
            Ok(r) => r,
            Err(c) => return reject(c, rev),
        };
        // B9
        if crate::params::check(&typed.payload, notary.get("input_schema")).is_err() {
            return reject("INPUT_SCHEMA_INVALID", rev);
        }
        let digest = jcs::h_bytes(&input).expect("parsed canonical");
        if !at_close {
            self.chain.raise_floor(typed.chain_ref.block_number);
        }
        // B10
        let job = &self.jobs[hash];
        let latest_wins = notary.get("input_replacement").and_then(Value::as_str) == Some("latest_wins");
        let entry = Entry { revision: rev, input_hash: input_hash.to_string(), epoch, input_digest: digest };
        match job.index.get(&root) {
            None => {
                if !latest_wins && rev != 0 {
                    return reject("INPUT_REVISION_INVALID", rev);
                }
                // B11
                let max = job.admitted.limits.max_inputs as usize;
                if !at_close && job.index.len() >= max {
                    return reject("INPUT_CAPACITY", rev);
                }
                Verdict::Accepted { root, entry }
            }
            Some(prev) => {
                if prev.input_digest == digest {
                    return Verdict::Accepted { root, entry }; // a resubmission of the same signed input
                }
                if !latest_wins {
                    return reject(if rev != 0 { "INPUT_REVISION_INVALID" } else { "INPUT_DUPLICATE" }, rev);
                }
                match rev.cmp(&prev.revision) {
                    std::cmp::Ordering::Less => Verdict::Superseded { revision: rev },
                    std::cmp::Ordering::Equal => reject("REVISION_CONFLICT", rev),
                    std::cmp::Ordering::Greater => Verdict::Accepted { root, entry },
                }
            }
        }
    }
}
