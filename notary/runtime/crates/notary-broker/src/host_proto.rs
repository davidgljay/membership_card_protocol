//! The broker and its host-protocol dispatch (notary_runtime.md §9). Everything from the host is untrusted: each
//! message is validated here or by the module that handles it, and the host may drop, delay, reorder or replay
//! anything. A replayed `submit_input` produces the same `input_hash`, so it is idempotent.
use crate::{
    chain::HeaderChain,
    env::{CardOracle, HostIo, Platform, Workers},
    joblog::{JobLogs, Signed, Signers},
    jobs::Job,
    keyring::Keyring,
    lists::{ListKind, Lists, Pins},
};
use notary_types::{b64u, formats, jcs, user_data::UserData};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub struct Broker {
    pub(crate) keys: Keyring,
    pub(crate) lists: Lists,
    pub(crate) chain: HeaderChain,
    pub(crate) logs: JobLogs,
    pub(crate) jobs: BTreeMap<[u8; 32], Job>,
    pub(crate) oracle: Box<dyn CardOracle>,
    pub(crate) workers: Box<dyn Workers>,
    pub(crate) platform: Platform,
    /// Genesis attestations made here: CID → (card, nonce), for countersign check G2.
    pub(crate) genesis: BTreeMap<String, String>,
    /// Live jobs a `shared` runtime holds (runtime §3, §14: 256).
    pub(crate) max_live_jobs: usize,
    // ---- replication (step 6.3) ----
    /// The host's peer directory: an untrusted hint of where to send (instance → hint).
    pub(crate) directory: BTreeMap<String, crate::peer::PeerHint>,
    /// What this enclave has heard from each peer instance (heartbeats, liveness).
    pub(crate) heard: BTreeMap<String, crate::peer::Heard>,
    /// Instances known (from completed identity handoffs) to hold a card's identity.
    pub(crate) instance_cards: BTreeMap<String, String>,
    pub(crate) sends: BTreeMap<String, crate::handoff::SendSession>,
    pub(crate) recvs: BTreeMap<String, crate::handoff::RecvSession>,
    /// Anchored records for logs this enclave doesn't follow yet (a handoff payload may arrive after them).
    pub(crate) follow_buffer: BTreeMap<String, Vec<(u64, Vec<u8>)>>,
    /// Template-scope receivers: sender's card (identity-log scope) → template, until the handoff record is anchored.
    pub(crate) template_watch: BTreeMap<String, String>,
    /// Followed records of anchored kinds that arrived before their anchor: (scope, seq) → record.
    pub(crate) deferred: BTreeMap<(String, u64), Value>,
    /// Peers whose handoff this enclave refused, and when (no new job offer to them for `handoff::MAX_AGE_MS`).
    pub(crate) refused: BTreeMap<String, i64>,
    /// The attested-clock reading of the latest `tick` (Q6).
    pub(crate) tick_ms: Option<i64>,
    pub(crate) last_hb_ms: Option<i64>,
    pub(crate) last_lists_ms: Option<i64>,
    pub(crate) hb_seq: u64,
    pub(crate) peer_seq: u64,
    /// After `shutdown`: this replica serves nothing.
    pub(crate) stopped: bool,
    // ---- derived cards (step 6.4) ----
    /// Per (notary card, template): the issuance pool, the tag history and pending registrations (`derive.rs`).
    pub(crate) derive: BTreeMap<(String, String), crate::derive::Book>,
    /// The registry's protocol version, read once through the host (`fetch protocol_version`).
    pub(crate) protocol_version: Option<String>,
}

pub fn error(req_id: &str, code: &str, message: impl Into<String>) -> Value {
    json!({ "kind": "error", "req_id": req_id, "code": code, "message": message.into() })
}

impl Broker {
    pub fn new(pins: Pins, oracle: Box<dyn CardOracle>, workers: Box<dyn Workers>, platform: Platform) -> Self {
        Self {
            keys: Keyring::new(platform.pcr0.clone()),
            lists: Lists::new(pins),
            chain: HeaderChain::default(),
            logs: JobLogs::default(),
            jobs: BTreeMap::new(),
            oracle,
            workers,
            platform,
            genesis: BTreeMap::new(),
            max_live_jobs: 256,
            directory: BTreeMap::new(),
            heard: BTreeMap::new(),
            instance_cards: BTreeMap::new(),
            sends: BTreeMap::new(),
            recvs: BTreeMap::new(),
            follow_buffer: BTreeMap::new(),
            template_watch: BTreeMap::new(),
            deferred: BTreeMap::new(),
            refused: BTreeMap::new(),
            tick_ms: None,
            last_hb_ms: None,
            last_lists_ms: None,
            hb_seq: 0,
            peer_seq: 0,
            stopped: false,
            derive: BTreeMap::new(),
            protocol_version: None,
        }
    }

    pub fn instance_id(&self) -> String {
        self.keys.instance_id()
    }

    /// The public `K_id` of a held, unexposed identity (public information).
    pub fn identity_pubkey_for_tests(&self, card: &str) -> Option<Vec<u8>> {
        self.keys.identity(card).map(|i| i.id.public_key().to_vec())
    }

    /// Epochs for which a job key is held (no key material).
    pub fn job_epochs_for_tests(&self, job_hash: &[u8; 32]) -> Vec<u64> {
        self.keys.job_epochs(job_hash)
    }

    /// Replaces the card oracle (tests: the oracle needs the notary card created by genesis on this broker).
    /// The CID of the newest record in a job's log (tests: the host knows it from the records it pinned).
    pub fn job_log_head_for_tests(&self, job_hash: &[u8; 32]) -> Option<String> {
        self.jobs.get(job_hash).and_then(|j| self.logs.head(&j.job_hash_b64)).map(|(_, cid)| cid)
    }

    /// Seeds a template's `dup_tag` key here, for period 0 (tests of the handoff). The runtime seeds it through the
    /// `seed_template` host message (step 6.4).
    pub fn create_template_key_for_tests(&mut self, template: &str) {
        let _ = self.keys.create_template_key(template, 0);
    }

    /// The newest template-key generation held, usable or exposed (no key material).
    pub fn template_generation_for_tests(&self, template: &str) -> Option<u64> {
        self.keys.template_generation(template)
    }

    /// `SHA-256(k_T,p)` of the usable key chain for period `p`, or `None` if no usable key is held or `p` is before the held
    /// period (erased). A fingerprint, not key material: tests compare chains with it.
    pub fn template_key_fingerprint_for_tests(&self, template: &str, period: u64) -> Option<[u8; 32]> {
        self.keys.template_period_key(template, period).map(|(_, k)| notary_crypto::sha256(k.expose()))
    }

    /// Whether a usable template key is held (no key material).
    pub fn template_ready_for_tests(&self, template: &str) -> bool {
        self.keys.template_key(template).is_some()
    }

    /// Lowers how many recent headers the chain keeps (tests of the retention rule).
    /// 6.5: the identity's state (version, loaded, header CID).
    pub fn state_for_tests(&self, card: &str) -> Option<(u64, bool, Option<String>)> {
        self.keys.identity(card).map(|i| (i.state_version, i.state_loaded, i.state_header_cid.clone()))
    }
    /// 6.5: sealed links and queued revocations this enclave holds for `card`.
    pub fn links_for_tests(&self, card: &str) -> (usize, usize) {
        self.derive.iter().filter(|((c, _), _)| c == card).fold((0, 0), |(l, q), (_, b)| (l + b.links.len(), q + b.queued.len()))
    }
    pub fn is_identity_leader_for_tests(&self, card: &str) -> bool {
        self.is_identity_leader(card)
    }

    pub fn set_header_keep_for_tests(&mut self, n: usize) {
        self.chain.set_keep(n);
    }

    pub fn set_max_live_jobs_for_tests(&mut self, n: usize) {
        self.max_live_jobs = n;
    }

    pub fn set_oracle_for_tests(&mut self, oracle: Box<dyn CardOracle>) {
        self.oracle = oracle;
    }

    /// Chain time if the newest header is known, else `None` (nothing time-dependent is done without headers).
    pub(crate) fn chain_now_ms(&self) -> Option<i64> {
        self.chain.chain_time_ms()
    }

    pub(crate) fn attested_now_ms(&self) -> Result<i64, String> {
        (self.platform.attested_time_ms)().map(|t| t as i64)
    }

    /// The timestamp written into objects: the attested clock.
    /// Fails when the clock does, rather than writing a made-up time (5.7, Q1).
    pub(crate) fn now_iso(&self) -> Result<String, &'static str> {
        self.attested_now_ms().map(formats::format_timestamp).map_err(|_| "ATT_UNAVAILABLE")
    }

    /// Requests an attestation and returns `(document bytes, CID)`.
    pub(crate) fn attest(&self, ud: UserData, public_key: Option<[u8; 32]>, nonce: [u8; 32]) -> Result<(Vec<u8>, String), String> {
        let doc = self.platform.attest.attest(ud.encode(), public_key, nonce).map_err(|e| e.to_string())?;
        let cid = formats::cid_of_bytes(&doc);
        Ok((doc, cid))
    }

    pub(crate) fn publish(&self, io: &mut dyn HostIo, bytes: &[u8]) {
        io.send(json!({ "kind": "publish", "req_id": format!("pub-{}", formats::cid_of_bytes(bytes)), "object": b64u::encode(bytes), "pin": true }));
    }

    /// Publishes released log records and asks the host to anchor the anchored kinds.
    pub(crate) fn emit_records(&self, io: &mut dyn HostIo, recs: Vec<Signed>) {
        for r in recs {
            self.publish(io, &r.bytes);
            if r.anchored_kind {
                io.send(json!({ "kind": "eas_anchor", "req_id": format!("anchor-{}-{}", r.scope, r.seq), "record_cid": r.cid, "scope_id": r.scope, "seq": r.seq }));
            }
        }
    }

    pub(crate) fn append_log(&mut self, io: &mut dyn HostIo, scope: &str, card: &str, kind: &str, body: Value) -> Result<(), &'static str> {
        let at = self.now_iso()?;
        let id = self.keys.identity(card).ok_or("NOTARY_KEY_EXPOSED")?;
        let recs = self.logs.append(scope, scope == card, kind, body, &at, &Signers { id: &id.id, inst: self.keys.inst() });
        self.emit_records(io, recs);
        Ok(())
    }

    /// Re-reads both governance lists through the oracle and applies algorithm L (runtime §12) and the key-lineage
    /// check (§4). Failures keep the last verified versions and raise an alert.
    pub fn refresh_lists(&mut self, io: &mut dyn HostIo) {
        for (kind, card) in [
            (ListKind::AcceptedRuntimes, self.lists.pins.accepted_runtimes_card.clone()),
            (ListKind::ProgramAllowlist, self.lists.pins.program_allowlist_card.clone()),
        ] {
            let Some(history) = self.oracle.list_history(io, &card) else { continue };
            if let Err(code) = self.lists.update(kind, &history) {
                if !(code == "LIST_VERSION_REGRESSION" && self.lists.versions() != (0, 0) && history.is_empty()) {
                    io.send(json!({ "kind": "alert", "req_id": "alert-list", "level": "warn", "code": code }));
                }
            }
        }
        let exposed = self.keys.apply_retirements(&self.lists.vulnerable_pcr0s());
        if !exposed.is_empty() {
            io.send(json!({ "kind": "alert", "req_id": "alert-exposed", "level": "error", "code": "key_exposed" }));
        }
        // runtime §4: an exposed K_job,e stops receipts for that job until a `key_exposure` epoch is anchored
        for x in &exposed {
            if let crate::keyring::Exposed::Job(h, e) = x {
                if let Some(j) = self.jobs.get_mut(h) {
                    if j.epoch == *e {
                        j.pending_inputs.clear();
                    }
                }
            }
        }
    }

    /// Handles one host message. Replies and enclave requests go out through `io`.
    pub fn handle(&mut self, io: &mut dyn HostIo, msg: &Value) {
        let req_id = msg.get("req_id").and_then(Value::as_str).unwrap_or_default().to_string();
        let kind = msg.get("kind").and_then(Value::as_str).unwrap_or_default();
        if self.stopped && kind != "hello" {
            if !matches!(kind, "tick" | "peer_message" | "anchor_receipt" | "log_record" | "fetch_result" | "chain_result") {
                io.send(error(&req_id, "NH_ENCLAVE_UNAVAILABLE", "this replica has shut down"));
            }
            return;
        }
        let reply = match kind {
            "hello" => Some(self.on_host_hello(&req_id, msg)),
            "chain_headers" => Some(self.on_headers(&req_id, msg)),
            "policy_snapshot" => {
                let p = msg.get("policy_address").and_then(Value::as_str).unwrap_or_default().to_string();
                self.oracle.on_snapshot(&p, msg);
                self.derive_watch_snapshot(&p, msg);
                Some(json!({ "kind": "snapshot_ack", "req_id": req_id }))
            }
            "policy_updates" => {
                let p = msg.get("policy_address").and_then(Value::as_str).unwrap_or_default().to_string();
                self.oracle.on_updates(&p, msg);
                self.derive_watch(&p, msg);
                None
            }
            "genesis" => Some(self.on_genesis(io, &req_id, msg)),
            "countersign_notary_card" => Some(self.on_countersign(io, &req_id, msg)),
            "create_job" => Some(self.on_create_job(io, &req_id, msg)),
            "submit_input" => self.on_submit_input(io, &req_id, msg),
            "close_chunk" => self.on_close_chunk(io, &req_id, msg),
            "anchor_receipt" => {
                self.on_anchor_receipt(io, msg);
                None
            }
            "abort_job" => Some(self.on_abort(io, &req_id, msg)),
            "tick" => {
                self.on_tick(io);
                None
            }
            "peer_directory" => {
                self.on_peer_directory(io, msg);
                None
            }
            "peer_message" => {
                self.on_peer_message(io, msg);
                None
            }
            "log_record" => {
                // a record another replica published (not anchored yet): followed, effects wait for its anchor
                if let (Some(scope), Some(seq), Some(bytes)) = (msg.get("scope_id").and_then(Value::as_str), msg.get("seq").and_then(Value::as_u64), msg.get("record").and_then(Value::as_str).and_then(|b| b64u::decode(b).ok())) {
                    let scope = scope.to_string();
                    self.follow_record(io, &scope, seq, bytes, false);
                }
                None
            }
            "start_handoff" => Some(self.on_start_handoff(io, &req_id, msg)),
            "shutdown" => Some(self.on_shutdown(io, &req_id)),
            "seed_template" => Some(self.on_seed_template(&req_id, msg)),
            "chain_result" => {
                self.on_chain_result(io, msg);
                None
            }
            // fetch_result is consumed by the HostIo
            "fetch_result" => None,
            _ => Some(error(&req_id, "NH_UNKNOWN_KIND", format!("unknown message kind {kind:?}"))),
        };
        if let Some(r) = reply {
            io.send(r);
        }
    }

    fn on_host_hello(&mut self, req_id: &str, msg: &Value) -> Value {
        let Some(challenge) = msg.get("challenge").and_then(Value::as_str).and_then(|c| b64u::decode_len(c, 32).ok()) else {
            return error(req_id, "NH_MALFORMED", "challenge must be 32 bytes, base64url");
        };
        let ud = UserData { purpose: 0x03, inst_key_hash: self.keys.inst_key_hash(), ..Default::default() };
        match self.attest(ud, None, challenge.try_into().expect("32 bytes")) {
            Ok((doc, _)) => json!({ "kind": "hello_ack", "req_id": req_id, "inst_pubkey": b64u::encode(self.keys.inst().public_key()), "attestation": b64u::encode(&doc) }),
            Err(e) => error(req_id, "ATT_UNAVAILABLE", e),
        }
    }

    fn on_headers(&mut self, req_id: &str, msg: &Value) -> Value {
        let headers: Vec<Vec<u8>> = msg
            .get("headers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|h| h.get("header_rlp").and_then(Value::as_str).and_then(|s| b64u::decode(s).ok()))
            .collect();
        let now = self.attested_now_ms().ok();
        let (jobs, derive) = (&self.jobs, &self.derive);
        let newest = self.chain.accept(&headers, now, &|| {
            let mut pins = crate::jobs::pinned_blocks(jobs);
            pins.extend(crate::derive::pinned_blocks(derive));
            pins
        });
        json!({ "kind": "chain_ack", "req_id": req_id, "newest": newest })
    }

    /// The anchor of a record this enclave wrote releases the next one. A record another replica wrote (its bytes in
    /// `record`) is followed (`replication.rs`).
    fn on_anchor_receipt(&mut self, io: &mut dyn HostIo, msg: &Value) {
        let (Some(scope), Some(seq)) = (msg.get("scope_id").and_then(Value::as_str), msg.get("seq").and_then(Value::as_u64)) else { return };
        let scope = scope.to_string();
        if self.deferred.contains_key(&(scope.clone(), seq)) {
            self.settle_deferred(io, &scope, seq);
            return;
        }
        if self.logs.waiting(&scope) != Some(seq) {
            if let Some(bytes) = msg.get("record").and_then(Value::as_str).and_then(|b| b64u::decode(b).ok()) {
                self.follow_anchored(io, &scope, seq, bytes);
            }
            return;
        }
        let Some(card) = self.card_for_scope(&scope) else { return };
        let Some(id) = self.keys.identity(&card) else { return };
        let recs = self.logs.on_anchor(&scope, seq, &Signers { id: &id.id, inst: self.keys.inst() });
        self.emit_records(io, recs);
        self.after_anchor(io, &scope, seq);
    }

    pub(crate) fn card_for_scope(&self, scope: &str) -> Option<String> {
        // an identity log's scope is the notary card address itself
        if self.keys.identity_held(scope).is_some() {
            return Some(scope.to_string());
        }
        let hash: [u8; 32] = b64u::decode_len(scope, 32).ok()?.try_into().ok()?;
        self.jobs.get(&hash).map(|j| j.card.clone())
    }

    /// Lifecycle step 3: K_id and K_chain are created here and never leave; the attestation binds them and
    /// `nonce = H(complete genesis request)`. The completed request is published so later verifiers can fetch it
    /// (erratum E17: `genesis_request` on the notary card).
    fn on_genesis(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        let Some(req) = msg.get("request").cloned() else { return error(req_id, "MISSING_FIELD", "request is required") };
        let mut req = req;
        // The host must not choose the keys: any key fields it sends are replaced (invariant I2).
        let ident = self.keys.create_identity();
        let (id_pub, chain_pub, card) = (ident.id.public_key().to_vec(), ident.chain.public_key_xy(), ident.card.clone());
        req["id_pubkey"] = json!(b64u::encode(&id_pub));
        req["chain_pubkey"] = json!(b64u::encode(&chain_pub));
        if let Err(e) = notary_types::objects::from_value::<notary_types::objects::GenesisRequest>(&req, notary_types::objects::types::GENESIS_REQUEST) {
            return error(req_id, e.code, e.message);
        }
        let platform = self.platform.attest.platform();
        if req["platform"].as_str() != Some(platform) {
            return error(req_id, "NOT_GENESIS_MISMATCH", format!("request platform must be {platform}"));
        }
        let Ok(nonce) = jcs::h_bytes(&req) else { return error(req_id, "JSON_NOT_CANONICAL", "request is not notary JSON") };
        let (idh, chh) = self.keys.identity_binding(&card).expect("just created");
        let ud = UserData { purpose: 0x01, id_key_hash: idh, chain_key_hash: chh, inst_key_hash: self.keys.inst_key_hash(), ..Default::default() };
        match self.attest(ud, None, nonce) {
            Ok((doc, cid)) => {
                self.genesis.insert(cid.clone(), card.clone());
                self.publish(io, &doc);
                self.publish(io, &jcs::canonical(&req).expect("checked"));
                json!({ "kind": "genesis_ready", "req_id": req_id, "id_pubkey": b64u::encode(&id_pub), "chain_pubkey": b64u::encode(&chain_pub),
                        "attestation": b64u::encode(&doc), "request": req, "notary_card": card })
            }
            Err(e) => error(req_id, "ATT_UNAVAILABLE", e),
        }
    }

    /// Lifecycle step 6 (check G2): the offer must name this enclave's own K_id, K_chain and genesis attestation.
    /// Then step 9 (erratum E26): the identity log's `seq` 0 is an `opened` record naming the genesis attestation.
    /// It is written here, the enclave's last genesis step, because the enclave isn't told when the card is
    /// registered; the record doesn't depend on registration. Jobs wait for its anchor (`create_job`).
    fn on_countersign(&mut self, io: &mut dyn HostIo, req_id: &str, msg: &Value) -> Value {
        let Some(mut offer) = msg.get("offer").cloned() else { return error(req_id, "MISSING_FIELD", "offer is required") };
        let att = offer.get("genesis_attestation").and_then(Value::as_str).unwrap_or_default().to_string();
        let Some(card) = self.genesis.get(&att).cloned() else { return error(req_id, "NOT_GENESIS_MISMATCH", "unknown genesis attestation") };
        let Some(ident) = self.keys.identity(&card) else { return error(req_id, "NOT_GENESIS_MISMATCH", "identity not held") };
        let id_ok = offer.get("recipient_pubkey").and_then(Value::as_str) == Some(&b64u::encode(ident.id.public_key()));
        let chain_ok = offer.get("chain_pubkey").and_then(Value::as_str) == Some(&b64u::encode(&ident.chain.public_key_xy()));
        if !id_ok || !chain_ok || offer.get("holder_signature").is_some() || offer.get("press_signature").is_some() {
            return error(req_id, "NOT_GENESIS_MISMATCH", "the offer does not name this enclave's keys and genesis attestation");
        }
        let Ok(bytes) = jcs::canonical(&offer) else { return error(req_id, "NOT_GENESIS_MISMATCH", "offer is not canonical JSON") };
        offer["holder_signature"] = json!(b64u::encode(&ident.id.sign(&bytes)));
        if self.logs.head(&card).is_none() {
            let Ok(at) = self.now_iso() else { return error(req_id, "ATT_UNAVAILABLE", "the attested clock is unavailable") };
            let ident = self.keys.identity(&card).expect("checked above");
            let recs = self.logs.append(&card, true, "opened", json!({ "attestations": [att] }), &at, &Signers { id: &ident.id, inst: self.keys.inst() });
            self.emit_records(io, recs);
        }
        json!({ "kind": "countersigned", "req_id": req_id, "offer": offer })
    }
}
