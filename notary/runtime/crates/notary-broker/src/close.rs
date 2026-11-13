//! Close and the notarization (lifecycle Phase 6–7, steps 36–44; replication §5; protocol-objects.md §27).
//!
//! Close happens only when **both** the newest verified header and a fresh attested-clock timestamp are ≥ `closes_at`
//! (assumption T9): a host can delay close but can't bring it forward. The host streams every stored `SealedInput` of
//! the final epoch (`close_chunk`); the broker re-opens each one, re-runs B2–B10 against the closing chain state, keeps
//! the highest revision per contributor root key, counts accepted inputs the host did not supply as
//! `dropped_after_acceptance`, applies `k_min`, runs the program once on the payloads sorted by `input_hash`, applies the
//! output checks, and signs the notarization.
//!
//! Step 5.3 scope: a single replica (N = 1, q = 1, the closing replica's own cosignature) and public outputs. The
//! multi-replica cosigning quorum is step 6.3; private `notary_output` delivery is step 6.1.
use crate::{
    env::HostIo,
    host_proto::{error, Broker},
    inputs::Verdict,
    jobs::State,
    transforms,
};
use notary_types::{b64u, formats, jcs, merkle, objects};
use serde_json::{json, Value};
use std::collections::BTreeMap;

impl Broker {
    pub(crate) fn on_close_chunk(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Option<Value> {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(|s| b64u::decode_len(s, 32).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
            return Some(error(req_id, "NH_MALFORMED", "job_hash"));
        };
        let Some(job) = self.jobs.get_mut(&hash) else { return Some(error(req_id, "NH_JOB_UNKNOWN", "no such job here")) };
        if !matches!(job.state, State::Open | State::Closing) {
            return Some(error(req_id, "NH_JOB_CLOSED", "job is not closing"));
        }
        if msg.get("seq").and_then(Value::as_u64) == Some(0) {
            job.close_buffer.clear();
        }
        for s in msg.get("sealed_inputs").and_then(Value::as_array).into_iter().flatten() {
            job.close_buffer.push(s.clone());
        }
        if msg.get("last").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        Some(match self.close(io, &hash) {
            Ok(v) => {
                let mut v = v;
                v["req_id"] = json!(req_id);
                v
            }
            Err((code, m)) => error(req_id, code, m),
        })
    }

    fn close(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) -> Result<Value, (&'static str, String)> {
        let closes_ms = self.jobs[hash].closes_ms;
        // step 36: chain time AND attested time
        let chain_ok = self.chain.chain_time_ms().is_some_and(|t| t >= closes_ms);
        let attested_ok = self.attested_now_ms().is_ok_and(|t| t >= closes_ms);
        if !chain_ok || !attested_ok {
            self.jobs.get_mut(hash).expect("present").close_buffer.clear();
            return Err(("CLOSE_NOT_DUE", format!("chain time due: {chain_ok}; attested time due: {attested_ok}")));
        }
        self.jobs.get_mut(hash).expect("present").state = State::Closing;
        let buffer = std::mem::take(&mut self.jobs.get_mut(hash).expect("present").close_buffer);
        let final_epoch = self.jobs[hash].epoch;

        // steps 38.1–38.2: re-open, re-check, keep the highest revision per root key
        let mut best: BTreeMap<[u8; 32], (u64, String, Vec<u8>)> = BTreeMap::new(); // root → (revision, input_hash, payload bytes)
        let mut supplied = std::collections::BTreeSet::new();
        let mut excluded_at_close = 0u64;
        for s in buffer {
            let Ok(typed) = objects::from_value::<objects::SealedInput>(&s, objects::types::SEALED_INPUT) else { continue };
            if typed.job_hash != self.jobs[hash].job_hash_b64 || typed.epoch != final_epoch {
                continue;
            }
            let Ok(ih) = jcs::h(&s) else { continue };
            if !supplied.insert(ih.clone()) {
                continue;
            }
            let Some(opened) = self.open_sealed(hash, &typed) else { continue };
            let payload = jcs::parse_canonical(opened.plaintext.expose()).ok().and_then(|v| jcs::canonical(&v["payload"]).ok());
            match (self.check_input(io, hash, opened.plaintext.expose(), &ih, final_epoch, true), payload) {
                (Verdict::Accepted { root, entry }, Some(p)) => {
                    let keep = match best.get(&root) {
                        None => true,
                        Some((r, prev_ih, _)) => entry.revision > *r || (entry.revision == *r && b64u::decode(&ih).ok() < b64u::decode(prev_ih).ok()),
                    };
                    if keep {
                        best.insert(root, (entry.revision, ih, p));
                    }
                }
                (Verdict::Rejected { .. }, _) => {
                    if self.jobs[hash].index.values().any(|e| e.input_hash == ih) {
                        excluded_at_close += 1;
                    }
                }
                _ => {}
            }
        }
        // step 38.3: accepted inputs the host didn't supply
        let job = &self.jobs[hash];
        let dropped = job.index.iter().filter(|(root, e)| e.epoch == final_epoch && !supplied.contains(&e.input_hash) && !best.contains_key(*root)).count() as u64;

        // sorted by the raw 32-byte input_hash (the order of input_commitment and counted_inputs; runtime §7 run order)
        let raw = |ih: &str| -> [u8; 32] { b64u::decode_len(ih, 32).expect("H").try_into().expect("32") };
        let mut counted: Vec<(String, Vec<u8>)> = best.into_values().map(|(_, ih, p)| (ih, p)).collect();
        counted.sort_by(|a, b| raw(&a.0).cmp(&raw(&b.0)));
        let hashes: Vec<[u8; 32]> = counted.iter().map(|(ih, _)| raw(ih)).collect();
        let commitment = merkle::input_commitment(&hashes).map_err(|e| ("CLOSE_FAILED", e.message))?;
        let accepted = counted.len() as u64;
        let k_min = job.notary.pointer("/privacy/k_min").and_then(Value::as_u64).unwrap_or(1);
        let suppressed = accepted < k_min;

        // steps 38.4–38.6
        let value = if suppressed {
            transforms::insufficient_participation_output()
        } else {
            let inputs: Vec<Vec<u8>> = counted.iter().map(|(_, p)| p.clone()).collect();
            let (program, limits, params) = (job.program.clone(), job.admitted.limits, job.params_bytes.clone());
            let run = self.workers.run(hash, &program, &limits, &params, &inputs);
            let schema = self.jobs[hash].notary.get("output_schema").cloned().unwrap_or(Value::Null);
            match run.map_err(|e| e.reason()).and_then(|o| transforms::apply(&o.bytes, &schema).map_err(String::from)) {
                Ok(v) => v,
                Err(reason) => {
                    let (scope, card) = (self.jobs[hash].job_hash_b64.clone(), self.jobs[hash].card.clone());
                    self.jobs.get_mut(hash).expect("present").state = State::Aborted;
                    let _ = self.append_log(io, &scope, &card, "aborted", json!({ "reason": "OUTPUT_SCHEMA_VIOLATION" }));
                    return Err(("OUTPUT_SCHEMA_VIOLATION", reason));
                }
            }
        };

        // step 41: the notarization
        let job = &self.jobs[hash];
        let header = self.chain.newest_header().expect("chain_ok").clone();
        let closed_at = formats::format_timestamp(header.timestamp as i64 * 1000);
        let counted_bytes = jcs::canonical(&Value::Array(counted.iter().map(|(ih, _)| json!(ih)).collect())).expect("strings");
        let counted_cid = formats::cid_of_bytes(&counted_bytes);
        let (scope, card) = (job.job_hash_b64.clone(), job.card.clone());
        let log_head = self.logs.head(&scope).map(|(_, cid)| cid).ok_or(("CLOSE_FAILED", "job log has no head".to_string()))?;
        let output = json!({ "public": value });
        let mut n = json!({
            "accepted": accepted,
            "attestation": job.attestation_cid,
            "chain_state": { "block_hash": b64u::encode(&header.hash), "block_number": header.number, "block_timestamp": closed_at, "state_root": b64u::encode(&header.state_root) },
            "close_quorum": job.q,
            "closed_at": closed_at,
            "counted_inputs": counted_cid,
            "dropped_after_acceptance": dropped,
            "final_epoch": final_epoch,
            "input_commitment": b64u::encode(&commitment),
            "job_cid": job.job_cid,
            "job_hash": scope,
            "job_log_head": log_head,
            "notary_card": card,
            "output": output,
            "output_hash": jcs::h(&value).expect("output is notary JSON"),
            "platform": job.notary.get("platform").cloned().unwrap_or(json!("")),
            "policy_id": job.job["policy_id"],
            "policy_state_cid": job.job["policy_state_cid"],
            "program_cid": job.notary["program_cid"],
            "rejected": job.rejected + excluded_at_close,
            "suppressed": suppressed,
            "type": objects::types::NOTARIZATION,
        });
        // cosignature over the 32 raw bytes of H(body) (E6); body = without cosignatures and notary_signature
        let digest = jcs::h_bytes(&n).expect("notary JSON");
        let inst = self.keys.inst();
        n["cosignatures"] = json!([{ "attestation": job.attestation_cid,
            "instance_signature": { "public_key": b64u::encode(inst.public_key()), "signature": b64u::encode(&inst.sign(&digest)) } }]);
        let ident = self.keys.identity(&card).ok_or(("NOTARY_KEY_EXPOSED", String::new()))?;
        n["notary_signature"] = ident.id.sign_object(&n, "notary_signature").map_err(|_| ("CLOSE_FAILED", String::new()))?;
        let n_bytes = jcs::canonical(&n).expect("notary JSON");
        let n_cid = formats::cid_of_bytes(&n_bytes);
        self.publish(io, &counted_bytes);
        self.publish(io, &n_bytes);
        let input_commitment = n["input_commitment"].clone();
        self.jobs.get_mut(hash).expect("present").state = State::Finalized;
        // step 42
        self.append_log(io, &scope, &card, "notarized", json!({ "notarization": n_cid, "accepted": accepted, "rejected": n["rejected"], "input_commitment": input_commitment }))
            .map_err(|c| (c, String::new()))?;
        let record = self.logs.head(&scope).map(|(seq, cid)| json!({ "seq": seq, "cid": cid })).unwrap_or(Value::Null);
        Ok(json!({ "kind": "job_closed", "notarization": n, "record": record, "outputs": [] }))
    }
}
