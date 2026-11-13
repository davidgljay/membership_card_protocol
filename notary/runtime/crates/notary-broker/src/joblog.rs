//! Job logs and identity logs (protocol-objects.md §28; notary_host.md §9).
//!
//! Records are hash-chained (`prev` = CID of the previous record) and signed by `K_id` (`notary_signature`) and
//! `K_inst` (`instance_signature`), both over the RFC 8785 bytes without the two signatures. The enclave refuses to sign
//! record `seq + 1` until it has seen the EAS anchor of record `seq` when `seq` is of an anchored kind, so a host can't
//! skip a record without stopping the log. Records waiting for an anchor are queued here and released by
//! `on_anchor`. CIDs use the `raw` codec (notary conventions).
use notary_crypto::MlDsaKey;
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};

pub const ANCHORED_KINDS: [&str; 7] = ["opened", "epoch_started", "handoff", "replica_lost", "notarized", "issued", "aborted"];

#[derive(Debug, Clone, PartialEq)]
pub struct Signed {
    pub scope: String,
    pub seq: u64,
    pub kind: String,
    pub bytes: Vec<u8>,
    pub cid: String,
    pub anchored_kind: bool,
}

struct Pending {
    kind: String,
    body: Value,
    at: String,
}

#[derive(Default)]
struct Scope {
    next_seq: u64,
    prev: Option<String>,
    /// seq of the last record written, and whether it still waits for an anchor.
    waiting_for: Option<u64>,
    queue: VecDeque<Pending>,
    log_type: &'static str,
}

#[derive(Default)]
pub struct JobLogs {
    scopes: BTreeMap<String, Scope>,
}

pub struct Signers<'a> {
    pub id: &'a MlDsaKey,
    pub inst: &'a MlDsaKey,
}

impl JobLogs {
    /// Appends a record. Returns the records now ready to publish (none if the log waits for an anchor).
    pub fn append(&mut self, scope: &str, identity_log: bool, kind: &str, body: Value, at: &str, s: &Signers<'_>) -> Vec<Signed> {
        let sc = self.scopes.entry(scope.to_string()).or_default();
        sc.log_type = if identity_log { notary_types::objects::types::IDENTITY_LOG } else { notary_types::objects::types::JOB_LOG };
        sc.queue.push_back(Pending { kind: kind.to_string(), body, at: at.to_string() });
        Self::drain(scope, sc, s)
    }

    /// The host's `anchor_receipt` for `(scope, seq)`. Returns records released by it.
    pub fn on_anchor(&mut self, scope: &str, seq: u64, s: &Signers<'_>) -> Vec<Signed> {
        let Some(sc) = self.scopes.get_mut(scope) else { return vec![] };
        if sc.waiting_for == Some(seq) {
            sc.waiting_for = None;
        }
        Self::drain(scope, sc, s)
    }

    /// Whether record `seq` of `scope` has been anchored (or was of an unanchored kind).
    pub fn is_settled(&self, scope: &str, seq: u64) -> bool {
        self.scopes.get(scope).is_some_and(|sc| seq < sc.next_seq && sc.waiting_for != Some(seq))
    }

    pub fn head(&self, scope: &str) -> Option<(u64, String)> {
        let sc = self.scopes.get(scope)?;
        Some((sc.next_seq.checked_sub(1)?, sc.prev.clone()?))
    }

    fn drain(scope: &str, sc: &mut Scope, s: &Signers<'_>) -> Vec<Signed> {
        let mut out = vec![];
        while sc.waiting_for.is_none() {
            let Some(p) = sc.queue.pop_front() else { break };
            let mut rec = json!({
                "at": p.at, "body": p.body, "instance": b64u::encode(&notary_crypto::sha256(s.inst.public_key())),
                "job_hash": scope, "kind": p.kind, "seq": sc.next_seq, "type": sc.log_type,
            });
            if let Some(prev) = &sc.prev {
                rec["prev"] = json!(prev);
            }
            let msg = jcs::canonical(&rec).expect("log record is notary JSON");
            rec["notary_signature"] = json!({ "public_key": b64u::encode(s.id.public_key()), "signature": b64u::encode(&s.id.sign(&msg)) });
            rec["instance_signature"] = json!({ "public_key": b64u::encode(s.inst.public_key()), "signature": b64u::encode(&s.inst.sign(&msg)) });
            let bytes = jcs::canonical(&rec).expect("log record is notary JSON");
            let cid = formats::cid_of_bytes(&bytes);
            let anchored_kind = ANCHORED_KINDS.contains(&p.kind.as_str());
            if anchored_kind {
                sc.waiting_for = Some(sc.next_seq);
            }
            out.push(Signed { scope: scope.to_string(), seq: sc.next_seq, kind: p.kind, bytes, cid: cid.clone(), anchored_kind });
            sc.prev = Some(cid);
            sc.next_seq += 1;
        }
        out
    }
}
