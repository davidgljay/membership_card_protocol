//! Replicas working together (notary_replication_and_recovery.md §3 step 10, §4, §5, §6, §7).
//!
//! - **Following the log.** Only the job leader writes job-log records; every other replica follows them. A host sends
//!   `anchor_receipt { scope_id, seq, tx_receipt, record }` with the record's bytes for records another replica wrote.
//!   The record must be signed by the `K_id` of a `replica_set` card (identity log: the card itself) and its instance
//!   key, and link to this replica's head; records between the head and an anchored record (unanchored kinds) are read
//!   by CID (`fetch ipfs:`). Following is how a handoff receiver sees its own `handoff` record anchored before it serves
//!   (step 10), how a returning replica learns it was counted lost (step 24), how old-epoch replicas stop after an
//!   anchored `epoch_started` (§7), and how keys are erased after `notarized` (step 44).
//! - **Inputs (§4).** The receiving replica checks an input (B1–B11), forwards the same `SealedInput` to every live
//!   member (`input_forward`); each checks it itself, asks its host to store the ciphertext and answers a signed
//!   `input_ack`. When q replicas including the receiver report the same status, the receiver issues the receipt with
//!   `acks` = that count; after 60 s without q it issues none (`INPUT_ACK_TIMEOUT`).
//! - **Close (§5).** Every replica recomputes from the ciphertexts its own host streams. The leader sends the body;
//!   each peer co-signs `H(body)` only if its own counted set, the dropped count and its own run's output hash agree,
//!   and never co-signs two bodies for one job. With q cosignatures the leader signs and finalizes.
use crate::{env::HostIo, host_proto::Broker, jobs::State};
use notary_crypto::{mldsa_verify, SecretBytes};
use notary_types::{b64u, formats, jcs, objects};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// An input waiting for q acknowledgments.
pub struct PendingInput {
    pub req_id: String,
    pub status: &'static str,
    pub reject_reason: Option<&'static str>,
    pub revision: u64,
    pub receipt_key: SecretBytes,
    pub acks: BTreeSet<String>,
    pub started_ms: i64,
}

/// One replica's own close computation.
#[derive(Clone)]
pub struct Computed {
    /// Counted inputs sorted by raw `input_hash`, with their payloads.
    pub counted: Vec<(String, Vec<u8>)>,
    pub supplied: BTreeSet<String>,
    pub dropped: u64,
    pub excluded_at_close: u64,
    pub value: Value,
    pub suppressed: bool,
    pub commitment: [u8; 32],
}

impl Computed {
    pub fn counted_hashes(&self) -> Vec<String> {
        self.counted.iter().map(|(h, _)| h.clone()).collect()
    }
    pub fn counted_bytes(&self) -> Vec<u8> {
        jcs::canonical(&Value::Array(self.counted.iter().map(|(ih, _)| json!(ih)).collect())).expect("strings")
    }
}

pub enum CloseState {
    /// This replica computed its result and waits for (or answered) the leader's body.
    Following { computed: Computed, req_id: String },
    /// This replica leads the close: its body, and the cosignatures received (instance → cosignature entry).
    Leading { computed: Computed, req_id: String, body: Value, digest: [u8; 32], cosigs: BTreeMap<String, Value> },
}

const FOLLOW_BUFFER_SCOPES: usize = 256;
const FOLLOW_BUFFER_PER_SCOPE: usize = 64;
const FOLLOW_FETCH_LIMIT: usize = 64;

/// Whether a log record carries a valid `notary_signature` by a card `card_ok` accepts and a valid `instance_signature`
/// by the instance it names.
pub(crate) fn record_signed_by(rec: &Value, card_ok: impl Fn(&str) -> bool) -> bool {
    let unsigned = match jcs::canonical(&jcs::without_fields(rec, &["notary_signature", "instance_signature"])) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let get = |f: &str| -> Option<(Vec<u8>, Vec<u8>)> {
        let s = rec.get(f)?;
        Some((b64u::decode(s.get("public_key")?.as_str()?).ok()?, b64u::decode(s.get("signature")?.as_str()?).ok()?))
    };
    let (Some((id_pk, id_sig)), Some((inst_pk, inst_sig))) = (get("notary_signature"), get("instance_signature")) else { return false };
    card_ok(&formats::card_pointer(&id_pk))
        && rec.get("instance").and_then(Value::as_str) == Some(b64u::encode(&notary_crypto::sha256(&inst_pk)).as_str())
        && mldsa_verify(&id_pk, &unsigned, &id_sig)
        && mldsa_verify(&inst_pk, &unsigned, &inst_sig)
}

fn hash32(s: &str) -> Option<[u8; 32]> {
    b64u::decode_len(s, 32).ok().and_then(|b| b.try_into().ok())
}

impl Broker {
    pub(crate) fn log_follow_start(&mut self, scope: &str) {
        if !self.logs.has(scope) {
            self.logs.follow_from(scope, false, None, true);
        }
    }

    // ---- following ---------------------------------------------------------------------------------------------

    /// A record another replica wrote: anchored (`anchor_receipt` with `record`) or just published (`log_record`). An
    /// anchored-kind record that arrives unanchored is adopted but takes effect only when its anchor arrives (step 10).
    pub(crate) fn follow_anchored(&mut self, io: &mut dyn HostIo, scope: &str, seq: u64, bytes: Vec<u8>) {
        self.follow_record(io, scope, seq, bytes, true)
    }

    pub(crate) fn follow_record(&mut self, io: &mut dyn HostIo, scope: &str, seq: u64, bytes: Vec<u8>, anchored: bool) {
        if !self.logs.has(scope) {
            self.watch_template(scope, &bytes);
            let buf = self.follow_buffer.entry(scope.to_string()).or_default();
            if buf.len() < FOLLOW_BUFFER_PER_SCOPE && !buf.iter().any(|(s, _)| *s == seq) {
                buf.push((seq, bytes));
            }
            if self.follow_buffer.len() > FOLLOW_BUFFER_SCOPES {
                let first = self.follow_buffer.keys().next().cloned();
                if let Some(k) = first {
                    self.follow_buffer.remove(&k);
                }
            }
            return;
        }
        let Ok(rec) = jcs::parse_canonical(&bytes) else { return };
        if rec.get("seq").and_then(Value::as_u64) != Some(seq) || !self.record_authentic(scope, &rec) {
            return;
        }
        let next = self.logs.next_seq(scope);
        if seq < next {
            // already adopted unanchored: this is its anchor
            if anchored && self.logs.waiting(scope) == Some(seq) {
                self.settle_deferred(io, scope, seq);
            }
            return;
        }
        // walk back over records this replica hasn't seen (unanchored kinds, or anchors it missed)
        let head = self.logs.head(scope).map(|(_, c)| c);
        let mut chain = vec![(seq, formats::cid_of_bytes(&bytes), rec)];
        while chain.last().map(|(s, _, _)| *s) > Some(next) && chain.len() < FOLLOW_FETCH_LIMIT {
            let Some(prev) = chain.last().and_then(|(_, _, r)| r.get("prev")).and_then(Value::as_str).map(String::from) else { break };
            let Some(b) = io.fetch(&format!("ipfs:{prev}")).filter(|b| formats::cid_of_bytes(b) == prev) else { break };
            let Ok(r) = jcs::parse_canonical(&b) else { break };
            let s = r.get("seq").and_then(Value::as_u64);
            if s != chain.last().map(|(s, _, _)| s - 1) || !self.record_authentic(scope, &r) {
                break;
            }
            chain.push((s.expect("checked"), prev, r));
        }
        let linked = chain.last().is_some_and(|(s, _, r)| *s == next && r.get("prev").and_then(Value::as_str) == head.as_deref());
        if !linked {
            // A fork or a gap. A newer epoch, though, stops this replica even when it doesn't link (stopping only costs
            // availability, which a host controls anyway).
            if let Some((_, _, r)) = chain.first() {
                if r.get("kind").and_then(Value::as_str) == Some("epoch_started") {
                    let r = r.clone();
                    self.apply_followed(io, scope, &r);
                }
            }
            io.send(json!({ "kind": "alert", "req_id": format!("follow-{scope}"), "level": "warn", "code": "JOB_LOG_FORK" }));
            return;
        }
        for (s, cid, r) in chain.into_iter().rev() {
            if !self.logs.adopt(scope, s, r.get("prev").and_then(Value::as_str), &cid) {
                break;
            }
            let anchored_kind = crate::joblog::ANCHORED_KINDS.contains(&r.get("kind").and_then(Value::as_str).unwrap_or_default());
            if s == seq && !anchored && anchored_kind {
                self.logs.mark_waiting(scope, s);
                self.deferred.insert((scope.to_string(), s), r);
            } else {
                self.apply_followed(io, scope, &r);
            }
        }
    }

    /// The anchor of a record adopted earlier: its effects apply now.
    pub(crate) fn settle_deferred(&mut self, io: &mut dyn HostIo, scope: &str, seq: u64) {
        let card = self.card_for_scope(scope);
        if let Some(id) = card.as_deref().and_then(|c| self.keys.identity(c)) {
            let recs = self.logs.on_anchor(scope, seq, &crate::joblog::Signers { id: &id.id, inst: self.keys.inst() });
            self.emit_records(io, recs);
        } else {
            self.logs.clear_waiting(scope, seq);
        }
        if let Some(r) = self.deferred.remove(&(scope.to_string(), seq)) {
            self.apply_followed(io, scope, &r);
        }
        self.after_anchor(io, scope, seq);
    }

    fn record_authentic(&self, scope: &str, rec: &Value) -> bool {
        let t = rec.get("type").and_then(Value::as_str);
        if rec.get("job_hash").and_then(Value::as_str) != Some(scope) {
            return false;
        }
        if t == Some(objects::types::IDENTITY_LOG) {
            return record_signed_by(rec, |c| c == scope);
        }
        let Some(j) = hash32(scope).and_then(|h| self.jobs.get(&h)) else { return false };
        t == Some(objects::types::JOB_LOG) && record_signed_by(rec, |c| j.allowed.contains_key(c))
    }

    pub(crate) fn drain_follow_buffer(&mut self, io: &mut dyn HostIo, scope: &str) {
        let Some(mut buf) = self.follow_buffer.remove(scope) else { return };
        buf.sort_by_key(|(s, _)| *s);
        for (s, b) in buf {
            self.follow_anchored(io, scope, s, b);
        }
    }

    /// A template-scope receiver watches the sender's identity log for its own `handoff` record (step 10).
    fn watch_template(&mut self, scope: &str, bytes: &[u8]) {
        let Some(template) = self.template_watch.get(scope).cloned() else { return };
        let Ok(rec) = jcs::parse_canonical(bytes) else { return };
        let me = self.instance_id();
        if rec.get("type").and_then(Value::as_str) == Some(objects::types::IDENTITY_LOG)
            && rec.get("job_hash").and_then(Value::as_str) == Some(scope)
            && rec.get("kind").and_then(Value::as_str) == Some("handoff")
            && rec.pointer("/body/scope").and_then(Value::as_str) == Some("template")
            && rec.pointer("/body/to_instance").and_then(Value::as_str) == Some(me.as_str())
            && record_signed_by(&rec, |c| c == scope)
        {
            self.keys.activate_template(&template);
            self.template_watch.remove(scope);
        }
    }

    fn apply_followed(&mut self, _io: &mut dyn HostIo, scope: &str, rec: &Value) {
        let me = self.instance_id();
        let kind = rec.get("kind").and_then(Value::as_str).unwrap_or_default();
        let body = rec.get("body").cloned().unwrap_or(Value::Null);
        if rec.get("type").and_then(Value::as_str) == Some(objects::types::IDENTITY_LOG) {
            if kind == "handoff" && body.get("to_instance").and_then(Value::as_str) == Some(me.as_str()) {
                match body.get("scope").and_then(Value::as_str) {
                    Some("identity") => {
                        self.keys.activate_identity(scope);
                    }
                    Some("template") => {
                        if let Some(t) = self.template_watch.remove(scope) {
                            self.keys.activate_template(&t);
                        }
                    }
                    _ => {}
                }
            }
            return;
        }
        let Some(hash) = hash32(scope) else { return };
        let writer = rec.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();
        let writer_card = rec.pointer("/notary_signature/public_key").and_then(Value::as_str).and_then(|k| b64u::decode(k).ok()).map(|k| formats::card_pointer(&k)).unwrap_or_default();
        let mut erase = false;
        let mut heard = vec![];
        if let Some(j) = self.jobs.get_mut(&hash) {
            match kind {
                "opened" => {
                    j.opened = true;
                    j.members.entry(writer.clone()).or_insert(crate::jobs::Member { card: writer_card, attestation: None });
                    heard.push(writer);
                }
                "handoff" => {
                    if let (Some(to), Some(card)) = (body.get("to_instance").and_then(Value::as_str), body.get("to_notary_card").and_then(Value::as_str)) {
                        if body.get("epoch").and_then(Value::as_u64) == Some(j.epoch) {
                            j.members.entry(to.to_string()).or_insert(crate::jobs::Member { card: card.into(), attestation: None });
                            if to == me && j.state.live() {
                                // step 10: this replica's own handoff record is anchored; it serves from now on
                                j.serving = true;
                                j.opened = true;
                                if j.state == State::Keyed {
                                    j.state = State::Open;
                                }
                                heard.extend(j.members.keys().cloned());
                            } else {
                                heard.push(to.to_string());
                            }
                        }
                    }
                }
                "replicated" => {
                    if let Some(i) = body.get("instance").and_then(Value::as_str) {
                        heard.push(i.to_string());
                    }
                }
                "replica_lost" => {
                    let i = body.get("instance").and_then(Value::as_str).unwrap_or_default();
                    j.lost_this_epoch = true;
                    j.members.remove(i);
                    j.gone.remove(i);
                    if i == me {
                        // step 24: counted down; rejoin only through a fresh handoff, so keys and state go now
                        j.state = State::Superseded;
                        j.serving = false;
                        erase = true;
                    }
                }
                "epoch_started" => {
                    if body.get("epoch").and_then(Value::as_u64).is_some_and(|e| e > j.epoch) {
                        // §7: an old-epoch replica stops issuing receipts and erases K_job,e
                        j.state = State::Superseded;
                        j.serving = false;
                        j.members.clear();
                        erase = true;
                    }
                }
                "notarized" => {
                    j.state = State::Finalized;
                    erase = true;
                }
                "aborted" => {
                    j.state = State::Aborted;
                    erase = true;
                }
                _ => {}
            }
        }
        for i in heard {
            if i != me {
                self.mark_heard(&i);
            }
        }
        if erase {
            self.erase_job_state(&hash);
        }
    }

    // ---- inputs (§4) -------------------------------------------------------------------------------------------

    /// Signs and seals the ValidationReceipt for an input whose quorum is reached.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn issue_receipt(&self, hash: &[u8; 32], input_hash: &str, status: &str, reject_reason: Option<&str>, revision: u64, acks: u64, receipt_key: &SecretBytes) -> Result<String, &'static str> {
        let j = self.jobs.get(hash).ok_or("NH_JOB_UNKNOWN")?;
        let processed_at = self.now_iso()?;
        let ident = self.keys.identity(&j.card).ok_or("NOTARY_KEY_EXPOSED")?;
        let mut receipt = json!({
            "acks": acks, "epoch": j.epoch, "input_hash": input_hash, "instance": self.keys.instance_id(), "job_hash": j.job_hash_b64,
            "processed_at": processed_at, "revision": revision, "status": status, "type": objects::types::VALIDATION_RECEIPT,
        });
        if let Some(r) = reject_reason {
            receipt["reject_reason"] = json!(r);
        }
        receipt["notary_signature"] = ident.id.sign_object(&receipt, "notary_signature").map_err(|_| "INPUT_MALFORMED")?;
        let bytes = jcs::canonical(&receipt).expect("receipt is notary JSON");
        let sealed = notary_crypto::seal_receipt(receipt_key, input_hash, &j.job_hash_b64, &bytes).map_err(|_| "INPUT_UNDECRYPTABLE")?;
        Ok(b64u::encode(&sealed))
    }

    /// Step 12 (receiver): forwards the input to every live member and waits for q matching acknowledgments.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_quorum(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], req_id: &str, sealed: &Value, input_hash: &str, status: &'static str, reject_reason: Option<&'static str>, revision: u64, receipt_key: SecretBytes) {
        let me = self.instance_id();
        let now = self.clock_ms();
        let peers: Vec<String> = self.live_members(hash).into_iter().filter(|i| *i != me).collect();
        let j = self.jobs.get_mut(hash).expect("present");
        let scope = j.job_hash_b64.clone();
        j.pending_inputs.insert(input_hash.to_string(), PendingInput { req_id: req_id.into(), status, reject_reason, revision, receipt_key, acks: BTreeSet::from([me]), started_ms: now });
        for p in peers {
            self.send_peer(io, &p, "input_forward", json!({ "job_hash": scope, "sealed_input": sealed }));
        }
    }

    /// Step 12 (peer): checks the forwarded input itself, has its host store the ciphertext, and acknowledges.
    pub(crate) fn on_input_forward(&mut self, io: &mut dyn HostIo, from: &str, body: &Value) {
        let Some(hash) = body.get("job_hash").and_then(Value::as_str).and_then(hash32) else { return };
        let Some(j) = self.jobs.get(&hash) else { return };
        if !j.serving || j.state != State::Open || !j.members.contains_key(from) {
            return;
        }
        let sealed = body.get("sealed_input").cloned().unwrap_or(Value::Null);
        let Ok(typed) = objects::from_value::<objects::SealedInput>(&sealed, objects::types::SEALED_INPUT) else { return };
        if typed.job_hash != j.job_hash_b64 || typed.epoch != j.epoch {
            return;
        }
        let Ok(input_hash) = jcs::h(&sealed) else { return };
        let Some(opened) = self.open_sealed(&hash, &typed) else { return };
        let verdict = self.check_input(io, &hash, opened.plaintext.expose(), &input_hash, typed.epoch, false);
        drop(opened);
        let (status, revision) = self.apply_verdict(&hash, verdict);
        let j = &self.jobs[&hash];
        let (scope, epoch) = (j.job_hash_b64.clone(), j.epoch);
        io.send(json!({ "kind": "store_input", "req_id": format!("store-{input_hash}"), "job_hash": scope, "epoch": epoch, "input_hash": input_hash, "sealed_input": sealed }));
        let me = self.instance_id();
        self.send_peer(io, from, "input_ack", json!({ "input_hash": input_hash, "instance": me, "job_hash": scope, "revision": revision, "status": status.0 }));
    }

    /// Updates the index for a verdict; returns `((status, reject_reason), revision)`.
    pub(crate) fn apply_verdict(&mut self, hash: &[u8; 32], verdict: crate::inputs::Verdict) -> ((&'static str, Option<&'static str>), u64) {
        let job = self.jobs.get_mut(hash).expect("present");
        match verdict {
            crate::inputs::Verdict::Accepted { root, entry } => {
                let rev = entry.revision;
                if job.index.get(&root) != Some(&entry) {
                    job.state_version += 1;
                }
                job.index.insert(root, entry);
                (("accepted", None), rev)
            }
            crate::inputs::Verdict::Superseded { revision } => (("superseded", None), revision),
            crate::inputs::Verdict::Rejected { code, revision } => {
                job.rejected += 1;
                (("rejected", Some(code)), revision)
            }
        }
    }

    /// Step 13 (receiver): a peer's acknowledgment; with q matching (itself included) the receipt goes out.
    pub(crate) fn on_input_ack(&mut self, io: &mut dyn HostIo, from: &str, body: &Value) {
        let Some(hash) = body.get("job_hash").and_then(Value::as_str).and_then(hash32) else { return };
        let Some(ih) = body.get("input_hash").and_then(Value::as_str).map(String::from) else { return };
        let Some(j) = self.jobs.get_mut(&hash) else { return };
        if !j.members.contains_key(from) || body.get("instance").and_then(Value::as_str) != Some(from) {
            return;
        }
        let q = j.q as usize;
        let Some(p) = j.pending_inputs.get_mut(&ih) else { return };
        if body.get("status").and_then(Value::as_str) != Some(p.status) || body.get("revision").and_then(Value::as_u64) != Some(p.revision) {
            return;
        }
        p.acks.insert(from.to_string());
        if p.acks.len() < q {
            return;
        }
        let p = j.pending_inputs.remove(&ih).expect("present");
        match self.issue_receipt(&hash, &ih, p.status, p.reject_reason, p.revision, p.acks.len() as u64, &p.receipt_key) {
            Ok(sealed) => io.send(json!({ "kind": "input_result", "req_id": p.req_id, "input_hash": ih, "receipt_sealed": sealed })),
            Err(c) => io.send(crate::host_proto::error(&p.req_id, c, "receipt")),
        }
    }

    /// Step 13: no quorum within 60 s, no receipt.
    pub(crate) fn expire_pending_inputs(&mut self, io: &mut dyn HostIo, now: i64) {
        for j in self.jobs.values_mut() {
            let expired: Vec<String> = j.pending_inputs.iter().filter(|(_, p)| now - p.started_ms > crate::peer::ACK_TIMEOUT_MS).map(|(k, _)| k.clone()).collect();
            for ih in expired {
                let p = j.pending_inputs.remove(&ih).expect("present");
                io.send(crate::host_proto::error(&p.req_id, "INPUT_ACK_TIMEOUT", "fewer than q replicas acknowledged the input within 60 s; no receipt"));
            }
        }
    }

    // ---- close (§5) --------------------------------------------------------------------------------------------

    /// Step 17 (peer): the leader's body. Co-signs only if this replica's own recomputation agrees.
    pub(crate) fn on_close_body(&mut self, io: &mut dyn HostIo, from: &str, msg: &Value) {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(hash32) else { return };
        let Some(j) = self.jobs.get_mut(&hash) else { return };
        if !j.members.contains_key(from) || !j.serving || matches!(j.state, State::Finalized | State::Aborted | State::Superseded) {
            return;
        }
        j.pending_body = Some((from.to_string(), msg.clone()));
        self.evaluate_close_body(io, &hash);
    }

    pub(crate) fn evaluate_close_body(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) {
        let Some(j) = self.jobs.get(hash) else { return };
        let Some((from, msg)) = j.pending_body.clone() else { return };
        let Some(CloseState::Following { computed, .. }) = &j.close else { return }; // waits for this replica's own close_chunk
        let computed = computed.clone();
        let body = msg.get("body").cloned().unwrap_or(Value::Null);
        let counted: Vec<String> = msg.get("counted").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
        let Ok(digest) = jcs::h_bytes(&body) else { return };
        let own = computed.counted_hashes();
        let counted_cid = formats::cid_of_bytes(&jcs::canonical(&json!(counted)).expect("strings"));
        let own_index: Vec<&String> = j.index.values().filter(|e| e.epoch == j.epoch).map(|e| &e.input_hash).collect();
        let outside = own_index.iter().filter(|h| !counted.contains(h)).count() as u64;
        let agrees = body.get("counted_inputs").and_then(Value::as_str) == Some(counted_cid.as_str())
            && own == counted
            && outside <= body.get("dropped_after_acceptance").and_then(Value::as_u64).unwrap_or(0)
            && body.get("output_hash").and_then(Value::as_str) == jcs::h(&computed.value).ok().as_deref()
            && body.get("job_hash").and_then(Value::as_str) == Some(j.job_hash_b64.as_str())
            && body.get("final_epoch").and_then(Value::as_u64) == Some(j.epoch)
            && body.get("accepted").and_then(Value::as_u64) == Some(own.len() as u64)
            && body.get("close_quorum").and_then(Value::as_u64) == Some(j.q as u64)
            && body.get("type").and_then(Value::as_str) == Some(objects::types::NOTARIZATION)
            && body.get("cosignatures").is_none()
            && body.get("notary_signature").is_none();
        let (scope, epoch, cosigned, att) = (j.job_hash_b64.clone(), j.epoch, j.cosigned, j.attestation_cid.clone());
        if !agrees {
            // step 19: say so, and ask this host for any counted ciphertext it never supplied
            let missing: Vec<String> = counted.iter().filter(|h| !computed.supplied.contains(*h)).cloned().collect();
            let counted_hash = jcs::h(&json!(own)).expect("strings");
            self.send_peer(io, &from, "close_mismatch", json!({ "counted_hash": counted_hash, "job_hash": scope }));
            io.send(json!({ "kind": "alert", "req_id": format!("mismatch-{scope}"), "level": "error", "code": "close_mismatch" }));
            if !missing.is_empty() {
                io.send(json!({ "kind": "need_inputs", "req_id": format!("need-{scope}"), "job_hash": scope, "epoch": epoch, "hashes": missing }));
            }
            return;
        }
        if cosigned.is_some_and(|d| d != digest) {
            // never two bodies for one job
            io.send(json!({ "kind": "alert", "req_id": format!("cosign-{scope}"), "level": "error", "code": "close_conflicting_body" }));
            return;
        }
        let sig = self.keys.inst().sign(&digest);
        let j = self.jobs.get_mut(hash).expect("present");
        j.cosigned = Some(digest);
        j.cosigned_body = Some(body);
        self.send_peer(io, &from, "close_cosign", json!({ "attestation": att, "body_hash": b64u::encode(&digest), "job_hash": scope, "signature": b64u::encode(&sig) }));
    }

    /// Step 18 (leader): a cosignature; with q (its own included) the notarization is finalized.
    pub(crate) fn on_close_cosign(&mut self, io: &mut dyn HostIo, from: &str, pk: &[u8], msg: &Value) {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(hash32) else { return };
        let Some(j) = self.jobs.get_mut(&hash) else { return };
        if !j.members.contains_key(from) {
            return;
        }
        let q = j.q as usize;
        let Some(CloseState::Leading { digest, cosigs, .. }) = &mut j.close else { return };
        let Some(sig) = msg.get("signature").and_then(Value::as_str).and_then(|s| b64u::decode(s).ok()) else { return };
        if msg.get("body_hash").and_then(Value::as_str) != Some(b64u::encode(digest.as_slice()).as_str()) || !mldsa_verify(pk, digest.as_slice(), &sig) {
            return;
        }
        let att = msg.get("attestation").and_then(Value::as_str).unwrap_or_default();
        cosigs.insert(from.to_string(), json!({ "attestation": att, "instance_signature": { "public_key": b64u::encode(pk), "signature": b64u::encode(&sig) } }));
        if cosigs.len() >= q {
            self.finalize_leading(io, &hash);
        }
    }

    pub(crate) fn on_close_mismatch(&mut self, io: &mut dyn HostIo, from: &str, msg: &Value) {
        let Some(hash) = msg.get("job_hash").and_then(Value::as_str).and_then(hash32) else { return };
        if self.jobs.get(&hash).is_some_and(|j| j.members.contains_key(from)) {
            io.send(json!({ "kind": "alert", "req_id": format!("mismatch-{}", b64u::encode(&hash)), "level": "error", "code": "close_mismatch" }));
        }
    }

    /// Heartbeat timer: the leader re-sends its body to members that haven't co-signed; a follower that became leader
    /// (the old one stopped) takes the close over.
    pub(crate) fn resend_close_bodies(&mut self, io: &mut dyn HostIo) {
        let me = self.instance_id();
        let hashes: Vec<[u8; 32]> = self.jobs.keys().copied().collect();
        for h in hashes {
            if self.jobs[&h].state != State::Closing || !self.is_leader(&h) {
                continue;
            }
            if matches!(self.jobs[&h].close, Some(CloseState::Following { .. })) {
                self.lead_close(io, &h);
                continue;
            }
            let peers = self.live_members(&h);
            let j = &self.jobs[&h];
            let Some(CloseState::Leading { body, cosigs, computed, .. }) = &j.close else { continue };
            let msg = json!({ "body": body, "counted": computed.counted_hashes(), "job_hash": j.job_hash_b64 });
            let todo: Vec<String> = peers.into_iter().filter(|p| *p != me && !cosigs.contains_key(p)).collect();
            for p in todo {
                self.send_peer(io, &p, "close_body", msg.clone());
            }
        }
    }
}
