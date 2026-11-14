//! Close and the notarization (lifecycle Phase 6–7, steps 36–44; replication §5; protocol-objects.md §27).
//!
//! Close happens only when **both** the newest verified header and a fresh attested-clock timestamp are ≥ `closes_at`
//! (assumption T9): a host can delay close but can't bring it forward. Each host streams every stored `SealedInput` of
//! the final epoch to its own replica (`close_chunk`); each replica re-opens every one, re-runs B2–B10 against the
//! closing chain state, keeps the highest revision per contributor root key, counts accepted inputs its host did not
//! supply as `dropped_after_acceptance`, applies `k_min`, runs the program once on the payloads sorted by
//! `input_hash`, and applies the output checks (`compute`).
//!
//! The job leader builds the body and co-signs it itself. With q = 1 it finalizes at once (`job_closed` answers the
//! `close_chunk`). Otherwise it answers `close_pending`, sends the body to every live member, and finalizes when q
//! cosignatures are in (`job_closed` is then sent on its own, with the `close_chunk`'s `req_id`). A follower answers
//! `close_pending`, checks the leader's body against its own result and co-signs (`replication.rs`).
use crate::{
    env::HostIo,
    host_proto::{error, Broker},
    inputs::Verdict,
    jobs::State,
    replication::{CloseState, Computed},
    transforms,
};
use notary_types::{b64u, formats, jcs, merkle, objects};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

type Fail = (&'static str, String);

impl Broker {
    pub(crate) fn on_close_chunk(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Option<Value> {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(|s| b64u::decode_len(s, 32).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
            return Some(error(req_id, "NH_MALFORMED", "job_hash"));
        };
        let Some(job) = self.jobs.get_mut(&hash) else { return Some(error(req_id, "NH_JOB_UNKNOWN", "no such job here")) };
        if !matches!(job.state, State::Open | State::Closing) {
            return Some(error(req_id, "NH_JOB_CLOSED", "job is not closing"));
        }
        if !job.serving {
            return Some(error(req_id, "NH_ENCLAVE_UNAVAILABLE", "this replica does not serve the job yet"));
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
        Some(match self.close(io, &hash, req_id) {
            Ok(v) => {
                let mut v = v;
                v["req_id"] = json!(req_id);
                v
            }
            Err((code, m)) => error(req_id, code, m),
        })
    }

    fn close(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], req_id: &str) -> Result<Value, Fail> {
        let closes_ms = self.jobs[hash].closes_ms;
        // step 36: chain time AND attested time
        let chain_ok = self.chain.chain_time_ms().is_some_and(|t| t >= closes_ms);
        let attested_ok = self.attested_now_ms().is_ok_and(|t| t >= closes_ms);
        if !chain_ok || !attested_ok {
            self.jobs.get_mut(hash).expect("present").close_buffer.clear();
            return Err(("CLOSE_NOT_DUE", format!("chain time due: {chain_ok}; attested time due: {attested_ok}")));
        }
        // a leader that already sent its body keeps the cosignatures it collected (a host re-streaming changes nothing)
        if matches!(self.jobs[hash].close, Some(CloseState::Leading { .. })) {
            self.jobs.get_mut(hash).expect("present").close_buffer.clear();
            return Ok(json!({ "kind": "close_pending" }));
        }
        self.jobs.get_mut(hash).expect("present").state = State::Closing;
        let computed = self.compute(io, hash)?;
        let q = self.jobs[hash].q;
        if q <= 1 {
            let (body, digest) = self.build_body(hash, &computed)?;
            let own = self.own_cosignature(hash, &digest);
            let cosigs = BTreeMap::from([(self.instance_id(), own)]);
            return self.finalize(io, hash, body, cosigs, &computed);
        }
        self.jobs.get_mut(hash).expect("present").close = Some(CloseState::Following { computed, req_id: req_id.to_string() });
        if self.is_leader(hash) {
            self.lead_close(io, hash);
        } else {
            self.evaluate_close_body(io, hash);
        }
        Ok(json!({ "kind": "close_pending" }))
    }

    /// Steps 38.1–38.6 on this replica's own ciphertexts.
    pub(crate) fn compute(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) -> Result<Computed, Fail> {
        let buffer = std::mem::take(&mut self.jobs.get_mut(hash).expect("present").close_buffer);
        let final_epoch = self.jobs[hash].epoch;
        // steps 38.1–38.2: re-open, re-check, keep the highest revision per root key
        let mut best: BTreeMap<[u8; 32], (u64, String, Vec<u8>)> = BTreeMap::new(); // root → (revision, input_hash, payload bytes)
        let mut supplied = BTreeSet::new();
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
        let k_min = job.notary.pointer("/privacy/k_min").and_then(Value::as_u64).unwrap_or(1);
        let suppressed = (counted.len() as u64) < k_min;
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
                    // the leader aborts; a follower's failure is its own (it simply doesn't co-sign)
                    if self.is_leader(hash) {
                        let (scope, card) = (self.jobs[hash].job_hash_b64.clone(), self.jobs[hash].card.clone());
                        self.jobs.get_mut(hash).expect("present").state = State::Aborted;
                        let _ = self.append_log(io, &scope, &card, "aborted", json!({ "reason": "OUTPUT_SCHEMA_VIOLATION" }));
                    }
                    return Err(("OUTPUT_SCHEMA_VIOLATION", reason));
                }
            }
        };
        Ok(Computed { counted, supplied, dropped, excluded_at_close, value, suppressed, commitment })
    }

    /// Step 16: the notarization body (everything except `cosignatures` and `notary_signature`) and `H(body)`.
    pub(crate) fn build_body(&mut self, hash: &[u8; 32], c: &Computed) -> Result<(Value, [u8; 32]), Fail> {
        // 6.0a: the policies counted, and the state each was read at (protocol-objects.md §27)
        let job = &self.jobs[hash];
        let predicate = job.notary.get("contributor_predicate").cloned().unwrap_or(Value::Null);
        let policies = notary_types::policy_set::policy_set(&predicate, &job.job["parameters"]).ok_or(("CLOSE_FAILED", "the contributor predicate names no closed policy set".to_string()))?;
        let mut contributor_policies = vec![];
        for p in &policies {
            let Some((state_cid, snapshot_block)) = self.oracle.contributor_policy_state(p) else {
                return Err(("CLOSE_FAILED", format!("no snapshot of contributor policy {p}; the host sends one before close")));
            };
            contributor_policies.push(json!({ "policy_id": p, "snapshot_block": snapshot_block, "state_cid": state_cid }));
        }
        let header = self.chain.newest_header().ok_or(("CLOSE_NOT_DUE", String::new()))?.clone();
        let closed_at = formats::format_timestamp(header.timestamp as i64 * 1000);
        let counted_cid = formats::cid_of_bytes(&c.counted_bytes());
        let (scope, card) = (job.job_hash_b64.clone(), job.card.clone());
        let log_head = self.logs.head(&scope).map(|(_, cid)| cid).ok_or(("CLOSE_FAILED", "job log has no head".to_string()))?;
        // private output (6.1): the notarization names the recipients; the value goes to each as a `notary_output` message
        let public = job.notary.pointer("/output_recipients/public").and_then(Value::as_bool).unwrap_or(true);
        let recipients: Vec<String> = job.notary.pointer("/output_recipients/cards").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
        let output = if public { json!({ "public": c.value }) } else { json!({ "recipients": recipients }) };
        let body = json!({
            "accepted": c.counted.len() as u64,
            "attestation": job.attestation_cid,
            "chain_state": { "block_hash": b64u::encode(&header.hash), "block_number": header.number, "block_timestamp": closed_at, "state_root": b64u::encode(&header.state_root) },
            "close_quorum": job.q,
            "closed_at": closed_at,
            "contributor_policies": contributor_policies,
            "counted_inputs": counted_cid,
            "dropped_after_acceptance": c.dropped,
            "final_epoch": job.epoch,
            "input_commitment": b64u::encode(&c.commitment),
            "job_cid": job.job_cid,
            "job_hash": scope,
            "job_log_head": log_head,
            "notary_card": card,
            "output": output,
            "output_hash": jcs::h(&c.value).expect("output is notary JSON"),
            "platform": job.notary.get("platform").cloned().unwrap_or(json!("")),
            "policy_id": job.job["policy_id"],
            "policy_state_cid": job.job["policy_state_cid"],
            "program_cid": job.notary["program_cid"],
            "rejected": job.rejected + c.excluded_at_close,
            "suppressed": c.suppressed,
            "type": objects::types::NOTARIZATION,
        });
        let digest = jcs::h_bytes(&body).expect("notary JSON");
        Ok((body, digest))
    }

    /// This replica's cosignature over the 32 raw bytes of `H(body)` (E6).
    fn own_cosignature(&self, hash: &[u8; 32], digest: &[u8; 32]) -> Value {
        let inst = self.keys.inst();
        json!({ "attestation": self.jobs[hash].attestation_cid,
            "instance_signature": { "public_key": b64u::encode(inst.public_key()), "signature": b64u::encode(&inst.sign(digest)) } })
    }

    /// Step 16–17 (leader): its body (or, if it already co-signed another leader's body, that same body: it never
    /// co-signs two), its own cosignature, and the body to every live member.
    pub(crate) fn lead_close(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) {
        let Some(CloseState::Following { computed, req_id }) = self.jobs.get_mut(hash).and_then(|j| j.close.take()) else { return };
        let built = match (self.jobs[hash].cosigned, self.jobs[hash].cosigned_body.clone()) {
            (Some(d), Some(b)) => Ok((b, d)),
            _ => self.build_body(hash, &computed),
        };
        let (body, digest) = match built {
            Ok(x) => x,
            Err((code, _)) => {
                io.send(json!({ "kind": "alert", "req_id": "close", "level": "error", "code": code }));
                self.jobs.get_mut(hash).expect("present").close = Some(CloseState::Following { computed, req_id });
                return;
            }
        };
        let me = self.instance_id();
        let own = self.own_cosignature(hash, &digest);
        let msg = json!({ "body": body, "counted": computed.counted_hashes(), "job_hash": self.jobs[hash].job_hash_b64 });
        let peers: Vec<String> = self.live_members(hash).into_iter().filter(|p| *p != me).collect();
        let j = self.jobs.get_mut(hash).expect("present");
        j.cosigned = Some(digest);
        j.cosigned_body = Some(body.clone());
        j.close = Some(CloseState::Leading { computed, req_id, body, digest, cosigs: BTreeMap::from([(me, own)]) });
        for p in peers {
            self.send_peer(io, &p, "close_body", msg.clone());
        }
    }

    /// Step 18 (leader, with q cosignatures): finalizes and sends `job_closed` on its own.
    pub(crate) fn finalize_leading(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) {
        let Some(CloseState::Leading { computed, req_id, body, cosigs, .. }) = self.jobs.get_mut(hash).and_then(|j| j.close.take()) else { return };
        match self.finalize(io, hash, body, cosigs, &computed) {
            Ok(mut v) => {
                v["req_id"] = json!(req_id);
                io.send(v);
            }
            Err((code, m)) => io.send(error(&req_id, code, m)),
        }
    }

    /// Steps 18, 41–43: cosignatures and `close_quorum`, `notary_signature`, private outputs, publication, `notarized`.
    fn finalize(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], body: Value, cosigs: BTreeMap<String, Value>, c: &Computed) -> Result<Value, Fail> {
        let mut n = body;
        let card = n["notary_card"].as_str().unwrap_or_default().to_string();
        let scope = self.jobs[hash].job_hash_b64.clone();
        n["cosignatures"] = json!(cosigs.into_values().collect::<Vec<_>>());
        let ident = self.keys.identity(&card).ok_or(("NOTARY_KEY_EXPOSED", "the body names a notary card this replica can't sign for".to_string()))?;
        n["notary_signature"] = ident.id.sign_object(&n, "notary_signature").map_err(|_| ("CLOSE_FAILED", String::new()))?;
        let n_bytes = jcs::canonical(&n).expect("notary JSON");
        let n_cid = formats::cid_of_bytes(&n_bytes);
        let closed_at = n["closed_at"].as_str().unwrap_or_default().to_string();
        // Build every message before anything is finalized: if a recipient can't be reached the close fails and can be retried.
        let mut outputs: Vec<Value> = vec![];
        let public = n.pointer("/output/public").is_some();
        if !public {
            let keys = self.jobs[hash].job.get("output_recipient_keys").cloned().unwrap_or(Value::Null);
            let recipients: Vec<String> = n.pointer("/output/recipients").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
            for pointer in &recipients {
                let pk = keys.get(pointer).and_then(Value::as_str).and_then(|k| b64u::decode(k).ok()).ok_or(("CLOSE_FAILED", format!("no key for recipient {pointer}")))?;
                let targets = self.oracle.recipient_targets(io, &pk).map_err(|x| ("CLOSE_FAILED", format!("recipient {pointer}: {x}")))?;
                if targets.is_empty() {
                    return Err(("CLOSE_FAILED", format!("recipient {pointer} has no sub-card with a kem_pubkey")));
                }
                let payload = notary_messaging::output_payload(&scope, &n_cid, &c.value, n["output_hash"].as_str().unwrap_or_default(), std::slice::from_ref(pointer), &card, &closed_at);
                let ident = self.keys.identity(&card).ok_or(("NOTARY_KEY_EXPOSED", String::new()))?;
                let envelope = notary_messaging::sign_envelope(payload, &ident.id).map_err(|_| ("CLOSE_FAILED", "message payload".to_string()))?;
                let subs: Vec<(String, Vec<u8>)> = targets.into_iter().map(|t| (t.sub_card, t.kem_public_key)).collect();
                outputs.extend(notary_messaging::routing_envelopes(&envelope, pointer, &subs).map_err(|_| ("CLOSE_FAILED", "message encryption".to_string()))?);
            }
        }
        self.publish(io, &c.counted_bytes());
        self.publish(io, &n_bytes);
        let input_commitment = n["input_commitment"].clone();
        self.jobs.get_mut(hash).expect("present").state = State::Finalized;
        // step 42
        let my_card = self.jobs[hash].card.clone();
        self.append_log(io, &scope, &my_card, "notarized", json!({ "notarization": n_cid, "accepted": n["accepted"], "rejected": n["rejected"], "input_commitment": input_commitment }))
            .map_err(|x| (x, String::new()))?;
        let record = self.logs.head(&scope).map(|(seq, cid)| json!({ "seq": seq, "cid": cid })).unwrap_or(Value::Null);
        Ok(json!({ "kind": "job_closed", "notarization": n, "record": record, "outputs": outputs }))
    }
}
