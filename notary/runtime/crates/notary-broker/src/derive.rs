//! Derived cards (step 6.4): `derived_card_revocation_propagation.md` §1, §3, §4 and §5; `notary_lifecycle.md` Phase 5.
//!
//! A standing `per_input` job under a template policy `T` turns each presented source card into a reduced card:
//!
//! 1. **Input** (B1–B9, then D1–D4): the source card is verified from the input's own evidence and the host's whole-policy
//!    snapshot; the `derive` program is run on the values the job projects; the broker checks that the output is exactly
//!    those values, verbatim. A `dup_tag` (HMAC under the template key of the target period) is reserved, so a second card
//!    for the same source card and period is `DERIVE_DUPLICATE`. The reply is the issuer-signed **offer**, inside the
//!    sealed validation receipt, with `issued_at` = the next batch boundary.
//! 2. **Countersign** (`notary.countersign.v1`): the holder signs the offer plus its fresh key `D`. The card enters the
//!    **issuance pool**.
//! 3. **Release** at each `issuance_batch_interval` boundary, on a host `tick`: pooled cards whose group (source policy,
//!    projected values, period) holds at least `min_anonymity_set` cards (counting those already released), and only if
//!    the batch holds at least `min_batch_size`, are shuffled, signed by `K_id` (`press_signature`), encrypted under their
//!    content keys and published, and registered with a `RegisterCard` payload signed by `K_chain`. A card that was not
//!    released by its boundary is **stale**: the holder resubmits the same signed input and gets a fresh offer for the next
//!    boundary (propagation §3 step 8).
//!
//! **Time.** Periods, batch boundaries, renewal windows and key rotation are judged on the enclave's attested clock
//! (Q6): the timers run from the host's `tick` (one clock reading per tick), and D1 reads the clock when an input
//! arrives. Never header or host time.
//!
//! **Scope.** One replica per job (`N = 1`). Step 6.5 adds `sealed_link` (a link per released card, `propagation.rs`) and
//! the state blob the identity leader writes after each batch, so the tag history and the links survive the enclave.
use crate::{
    env::{HostIo, SourceCard},
    host_proto::Broker,
    jobs::State,
};
use notary_crypto::{hmac_sha256, shuffle};
use notary_types::{b64u, formats, jcs};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const DAY_MS: i64 = 86_400_000;
pub const HOUR_MS: i64 = 3_600_000;
/// How long an old epoch's key is kept after a rotation (replication §1: 1 h).
pub const KEY_GRACE_MS: i64 = HOUR_MS;
/// The least a `key_period` may be: the grace window.
pub const MIN_KEY_PERIOD_MS: i64 = HOUR_MS;
/// Registration retries after a failed chain submission.
pub const MAX_REGISTRATION_TRIES: u32 = 3;

/// Headers the cards waiting in a pool name as their `chain_ref`: kept while the card waits (R3).
pub(crate) fn pinned_blocks(derive: &BTreeMap<(String, String), Book>) -> BTreeSet<[u8; 32]> {
    derive.values().flat_map(|b| b.recs.values().filter(|r| r.state != RecState::Released).map(|r| r.block)).collect()
}

/// Fields a derived card may never project: they are protocol fields, and several (keys, signatures, the sub-card list)
/// identify the holder. A job naming one is refused when it is created.
pub const RESERVED_FIELDS: &[&str] = &[
    "active_subcards", "ancestry_pubkeys", "dup_tag", "expires_at", "holder_signature", "issued_at", "issuer_card", "issuer_signature", "past_keys", "policy_id",
    "press_card", "press_signature", "projected", "protocol_version", "recipient_pubkey", "source_policy", "supersedes", "supersession_note",
];

// ---------------------------------------------------------------------------------------------------------------------
// Parameters (§9)

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeriveParams {
    pub period_ms: i64,
    pub renewal_ms: i64,
    pub batch_ms: i64,
    pub min_batch: usize,
    pub min_anon: usize,
}

impl DeriveParams {
    /// `T.notary.derived_card` with the defaults of §9, checked against its bounds.
    pub fn from_notary(notary: &Value) -> Result<Self, String> {
        let d = notary.get("derived_card").cloned().unwrap_or(json!({}));
        let dur = |k: &str, default: &str| formats::parse_duration(d.get(k).and_then(Value::as_str).unwrap_or(default)).map_err(|_| format!("derived_card.{k} is not an ISO 8601 duration"));
        let num = |k: &str, default: u64| d.get(k).map_or(Some(default), Value::as_u64).ok_or(format!("derived_card.{k} must be an integer"));
        let p = Self { period_ms: dur("nullifier_period", "P7D")?, renewal_ms: dur("renewal_window", "P2D")?, batch_ms: dur("issuance_batch_interval", "PT6H")?, min_batch: num("min_batch_size", 5)? as usize, min_anon: num("min_anonymity_set", 10)? as usize };
        if !(DAY_MS..=90 * DAY_MS).contains(&p.period_ms) {
            return Err("nullifier_period must be 1 to 90 days".into());
        }
        if p.renewal_ms < 0 || p.renewal_ms * 2 > p.period_ms {
            return Err("renewal_window must be at most half the nullifier_period".into());
        }
        if !(HOUR_MS..=24 * HOUR_MS).contains(&p.batch_ms) {
            return Err("issuance_batch_interval must be 1 to 24 hours".into());
        }
        if p.min_batch < 2 || p.min_anon < 2 {
            return Err("min_batch_size and min_anonymity_set must be at least 2".into());
        }
        Ok(p)
    }

    pub fn period_of(&self, ms: i64) -> u64 {
        (ms.max(0) / self.period_ms) as u64
    }
    pub fn period_end_ms(&self, p: u64) -> i64 {
        (p as i64 + 1) * self.period_ms
    }
    /// The next batch boundary strictly after `ms`.
    pub fn next_boundary(&self, ms: i64) -> i64 {
        (ms.div_euclid(self.batch_ms) + 1) * self.batch_ms
    }
    pub fn boundary_at(&self, ms: i64) -> i64 {
        ms.div_euclid(self.batch_ms) * self.batch_ms
    }

    pub fn to_json(&self) -> Value {
        json!({ "batch_ms": self.batch_ms, "min_anon": self.min_anon, "min_batch": self.min_batch, "period_ms": self.period_ms, "renewal_ms": self.renewal_ms })
    }
    pub fn from_json(v: &Value) -> Option<Self> {
        let n = |k: &str| v.get(k).and_then(Value::as_i64);
        Some(Self { period_ms: n("period_ms")?, renewal_ms: n("renewal_ms")?, batch_ms: n("batch_ms")?, min_batch: n("min_batch")? as usize, min_anon: n("min_anon")? as usize })
    }
}

/// `dup_tag = HMAC-SHA256(k_T,p, root_source_key || source_policy || p)` with `source_policy` the policy CID's UTF-8 bytes
/// (the registry's "CID bytes" convention, as the press writes them) and `p` 8 bytes big-endian (propagation §1).
pub fn dup_tag(k_t_p: &[u8], root_source_key: &[u8], source_policy: &str, period: u64) -> [u8; 32] {
    let mut m = root_source_key.to_vec();
    m.extend_from_slice(source_policy.as_bytes());
    m.extend_from_slice(&period.to_be_bytes());
    hmac_sha256(k_t_p, &m)
}

// ---------------------------------------------------------------------------------------------------------------------
// State

/// What defines a card's anonymity set (propagation §4): the issuer is the notary card (the book), and the rest is this.
pub type Group = (String, String, u64);

#[derive(Debug, Clone, PartialEq)]
pub enum RecState {
    /// The offer was returned; the holder hasn't countersigned.
    Offered,
    /// Countersigned and waiting in the pool for its `boundary_ms`.
    Pooled { holder_signature: String },
    /// The boundary passed without the card being released: the holder must be offered a new boundary.
    Stale,
    /// Published and submitted for registration.
    Released,
}

/// One accepted input.
#[derive(Debug, Clone)]
pub struct Rec {
    pub job: [u8; 32],
    pub period: u64,
    pub tag: [u8; 32],
    pub d_pub: Vec<u8>,
    pub offer: Value,
    pub offer_hash: String,
    /// The offer's `issued_at`: the batch boundary it can be released at.
    pub boundary_ms: i64,
    pub group: Group,
    pub state: RecState,
    /// The input's `chain_ref` block: its header stays pinned while the card waits, so the wallet can resubmit the same
    /// signed input for a new offer for as long as the period lasts (R3, as for held inputs).
    pub block: [u8; 32],
    /// Under `sealed_link` only: the source card's pointer and `recipient_pubkey`, for the link made at release (§6).
    /// Under `expiry_only` the enclave keeps no link, not even while the card waits (§5 step 1).
    pub source: Option<(String, Vec<u8>)>,
}

/// A registration waiting for the host's `chain_result`.
#[derive(Debug, Clone)]
pub struct Reg {
    pub input: String,
    pub card_address: [u8; 32],
    pub cid: String,
    pub tries: u32,
}

/// Everything one notary card keeps for one template (`D9`: tags are scoped to the template, the source policy and the
/// period, within a notary card). The tag history, the links and the revocation queue go into the state blob after each
/// batch (`propagation.rs`); the pool of cards waiting for release does not, and is lost with the enclave.
#[derive(Default)]
pub struct Book {
    pub params: Option<DeriveParams>,
    pub prop: Option<crate::propagation::PropParams>,
    /// Sealed links by the derived card's pointer (§6).
    pub links: BTreeMap<String, crate::propagation::Link>,
    /// Revocations queued by the watch loop, by the derived card's pointer (§7).
    pub queued: BTreeMap<String, crate::propagation::Queued>,
    pub last_rev_boundary_ms: i64,
    pub batch_seq: u64,
    pub rev_regs: BTreeMap<String, crate::propagation::RevSubmission>,
    /// D2: `SHA-256(D_pub)` of every key that appeared in an accepted input.
    pub seen_d: BTreeSet<[u8; 32]>,
    /// D3: tags reserved or issued, by period.
    pub tags: BTreeMap<u64, BTreeSet<[u8; 32]>>,
    /// Accepted inputs by the digest of the signed input (a resubmission re-sealed under a new epoch has the same digest).
    pub recs: BTreeMap<String, Rec>,
    pub by_offer: BTreeMap<String, String>,
    /// Released cards by group: the distinct tags already in the anonymity set.
    pub released: BTreeMap<Group, BTreeSet<[u8; 32]>>,
    pub last_boundary_ms: i64,
    pub regs: BTreeMap<String, Reg>,
}

/// A rotation waiting for the anchor of its `epoch_started` record.
#[derive(Debug, Clone)]
pub struct Rotation {
    pub epoch: u64,
    pub attestation_cid: String,
    pub anchor_seq: Option<u64>,
}

/// The per-input job's schedule and parameters.
#[derive(Debug, Clone)]
pub struct DeriveJob {
    pub params: DeriveParams,
    pub prop: crate::propagation::PropParams,
    pub template: String,
    pub source_policy: String,
    pub projected_fields: Vec<String>,
    pub key_period_ms: i64,
    pub ends_ms: i64,
    pub next_rotation_ms: i64,
    pub rotation: Option<Rotation>,
    /// Older epochs whose keys are still held, and when they are erased.
    pub grace: BTreeMap<u64, i64>,
}

/// What a derived-card input came to: the receipt's fields.
pub struct Outcome {
    pub status: &'static str,
    pub reason: Option<&'static str>,
    pub revision: u64,
    pub offer: Option<Value>,
}

impl Outcome {
    fn reject(code: &'static str, revision: u64) -> Self {
        Self { status: "rejected", reason: Some(code), revision, offer: None }
    }
}

type Fail = (&'static str, String);

fn text_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// The values a job projects, in the form the program reads: `{ field: value }`, scalars only (text, integer, boolean).
fn projected_input(fields: &Map<String, Value>, names: &[String]) -> Option<Value> {
    let mut m = Map::new();
    for n in names {
        let v = fields.get(n)?;
        let scalar = v.is_string() || v.is_boolean() || v.as_i64().is_some();
        if !scalar {
            return None;
        }
        m.insert(n.clone(), v.clone());
    }
    Some(Value::Object(m))
}

impl Broker {
    /// The derived-card parts of the job checks (`check_job`): the template's parameters and the job's own fields.
    pub(crate) fn derive_job_checks(&mut self, typed: &notary_types::objects::NotaryJob, notary: &Value, opens_ms: i64, n: u32) -> Result<DeriveJob, Fail> {
        let e = |c: &'static str, m: &str| (c, m.to_string());
        if notary.get("output_action").and_then(Value::as_str) != Some("card") {
            return Err(e("NH_UNSUPPORTED", "a per-input job that doesn't issue cards isn't specified"));
        }
        if n > 1 {
            return Err(e("NH_UNSUPPORTED", "replicated derived-card jobs need the state blob (step 6.5)"));
        }
        let params = DeriveParams::from_notary(notary).map_err(|m| ("JOB_MALFORMED", m))?;
        // the tag history and the links are the identity's state, written only by its leader (replication §1, §8): a
        // derived-card job runs where that state is written
        let card = typed.replica_set.first().map(|r| r.notary_card.clone()).unwrap_or_default();
        if self.other_holder_serves_derived(&card) || !self.state_loaded(&card) {
            return Err(e("NH_NOT_IDENTITY_LEADER", "another live holder of this notary card serves its derived-card jobs, or this one hasn't loaded the card's state"));
        }
        if self.oracle.policy_public_key(&typed.policy_id).is_none() {
            return Err(e("JOB_POLICY_UNTRUSTED", "the template policy's key is unknown"));
        }
        if self.keys.template_key(&typed.policy_id).is_none() {
            return Err(e("TEMPLATE_KEY_MISSING", "this enclave holds no dup_tag key for the template: seed it or hand it over first"));
        }
        // escrowed_link is refused by algorithm A (`ADM_FEATURE_UNSUPPORTED`), which runs next
        if notary.pointer("/revocation_propagation/mode").and_then(Value::as_str) == Some("escrowed_link") {
            return Err(e("ADM_FEATURE_UNSUPPORTED", "escrowed_link is specified, not implemented in v1"));
        }
        let prop = crate::propagation::PropParams::from_notary(notary).map_err(|m| ("JOB_MALFORMED", m))?;
        let ts = |s: &str| formats::parse_timestamp(s).map_err(|_| e("JOB_MALFORMED", "bad timestamp"));
        let key_period = typed.key_period.as_deref().ok_or(e("JOB_MALFORMED", "key_period is required"))?;
        let key_period_ms = formats::parse_duration(key_period).map_err(|_| e("JOB_MALFORMED", "key_period is not a duration"))?;
        if !(MIN_KEY_PERIOD_MS..=366 * DAY_MS).contains(&key_period_ms) {
            return Err(e("JOB_MALFORMED", "key_period must be 1 hour to 366 days"));
        }
        let ends_ms = ts(typed.ends_at.as_deref().ok_or(e("JOB_MALFORMED", "ends_at is required"))?)?;
        let source_policy = text_field(&typed.parameters, "source_policy").ok_or(e("JOB_PARAMETERS_OUT_OF_BOUNDS", "source_policy is required"))?.to_string();
        let fields: Vec<String> = typed.parameters.get("projected_fields").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        if fields.is_empty() || fields.iter().any(|f| RESERVED_FIELDS.contains(&f.as_str())) {
            return Err(e("JOB_PARAMETERS_OUT_OF_BOUNDS", "projected_fields must name policy-defined fields of the source card, never protocol fields"));
        }
        Ok(DeriveJob { params, prop, template: typed.policy_id.clone(), source_policy, projected_fields: fields, key_period_ms, ends_ms, next_rotation_ms: opens_ms + key_period_ms, rotation: None, grace: BTreeMap::new() })
    }

    pub(crate) fn derive_book(&mut self, card: &str, template: &str, params: &DeriveParams) -> &mut Book {
        let b = self.derive.entry((card.to_string(), template.to_string())).or_default();
        b.params.get_or_insert_with(|| params.clone());
        b
    }

    /// The template's propagation parameters, from the job (a template's `notary` section is the same for every job).
    fn set_book_prop(&mut self, card: &str, template: &str, prop: &crate::propagation::PropParams) {
        if let Some(b) = self.derive.get_mut(&(card.to_string(), template.to_string())) {
            b.prop = Some(prop.clone());
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Template key

    /// Host → enclave `seed_template`: the first enclave serving `T` seeds `k_T` (generation 0) for the current period.
    /// Refused if a key is held (a second seed would split the tags across operators). The others receive it by
    /// template-scope handoff. The host names the card and template; the key is random and never leaves except by handoff.
    pub(crate) fn on_seed_template(&mut self, req_id: &str, msg: &Value) -> Value {
        use crate::host_proto::error;
        let (Some(template), Some(card), Some(period_ms)) = (text_field(msg, "template"), text_field(msg, "notary_card"), msg.get("nullifier_period").and_then(Value::as_str).and_then(|s| formats::parse_duration(s).ok())) else {
            return error(req_id, "NH_MALFORMED", "template, notary_card and nullifier_period are required");
        };
        if self.keys.identity(card).is_none() {
            return error(req_id, "NOTARY_KEY_EXPOSED", "this enclave holds no usable identity for that card");
        }
        if !(DAY_MS..=90 * DAY_MS).contains(&period_ms) {
            return error(req_id, "NH_MALFORMED", "nullifier_period must be 1 to 90 days");
        }
        let Ok(now) = self.attested_now_ms() else { return error(req_id, "ATT_UNAVAILABLE", "the attested clock is unavailable") };
        let period = (now / period_ms) as u64;
        match self.keys.create_template_key(template, period) {
            Ok(k) => json!({ "kind": "template_seeded", "req_id": req_id, "template": template, "generation": k.generation, "period": k.period }),
            Err(c) => error(req_id, c, "this enclave already holds a key for the template"),
        }
    }

    /// Ratchet housekeeping on a tick: erase period keys that are no longer needed (a period's key is kept until the
    /// period plus `renewal_window` has passed), and re-seed an exposed chain (propagation §1).
    fn derive_key_upkeep(&mut self, io: &mut dyn HostIo, now: i64) {
        let books: Vec<((String, String), DeriveParams)> = self.derive.iter().filter_map(|(k, b)| b.params.clone().map(|p| (k.clone(), p))).collect();
        let vulnerable = self.lists.vulnerable_pcr0s();
        for ((_, template), p) in books {
            // D1 only admits the current period and the next, so the oldest key still needed is that of the period whose
            // end plus the renewal window is still ahead
            let min = ((now - p.renewal_ms).div_euclid(p.period_ms)).max(0) as u64;
            self.keys.advance_template(&template, min, now);
            if self.keys.template_exposed(&template) {
                let pc = p.period_of(now);
                match self.keys.reseed_template(&template, pc, p.period_end_ms(pc), &vulnerable) {
                    Ok(g) => {
                        io.send(json!({ "kind": "alert", "req_id": format!("reseed-{template}-{g}"), "level": "warn", "code": "template_reseeded" }));
                    }
                    Err(_) => io.send(json!({ "kind": "alert", "req_id": "reseed-blocked", "level": "error", "code": "template_key_exposed" })),
                }
            }
        }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Input and countersign

    /// B2–B9 and D1–D4 for one decrypted input of a derived-card job, or the countersign of an offer. Returns what the
    /// receipt says.
    pub(crate) fn derive_submit(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], plaintext: &[u8], input_hash: &str, epoch: u64) -> Outcome {
        let Ok(v) = jcs::parse_canonical(plaintext) else { return Outcome::reject("INPUT_MALFORMED", 0) };
        match v.get("type").and_then(Value::as_str) {
            Some(t) if t == notary_types::objects::types::COUNTERSIGN => self.derive_countersign(hash, &v),
            _ => self.derive_input(io, hash, plaintext, input_hash, epoch),
        }
    }

    fn derive_input(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], plaintext: &[u8], input_hash: &str, epoch: u64) -> Outcome {
        let core = match self.check_core(io, hash, plaintext, input_hash, epoch, false) {
            Ok(c) => c,
            Err(crate::inputs::Verdict::Rejected { code, revision }) => return Outcome::reject(code, revision),
            Err(_) => return Outcome::reject("INPUT_MALFORMED", 0),
        };
        let rev = core.revision;
        let Some(src) = core.source else { return Outcome::reject("INPUT_NOT_ELIGIBLE", rev) };
        match self.derive_checks(hash, &core.input, &core.digest, core.block, src) {
            Ok(offer) => Outcome { status: "accepted", reason: None, revision: rev, offer: Some(offer) },
            Err(code) => Outcome::reject(code, rev),
        }
    }

    /// The input is valid as a contributor's (B1–B9). D1–D4 and the offer.
    fn derive_checks(&mut self, hash: &[u8; 32], input: &Value, digest: &[u8; 32], block: [u8; 32], src: SourceCard) -> Result<Value, &'static str> {
        let job = &self.jobs[hash];
        let dj = job.derive.clone().expect("derive job");
        let (card, template) = (job.card.clone(), dj.template.clone());
        let now = self.attested_now_ms().map_err(|_| "ATT_UNAVAILABLE")?;
        let digest_b64 = b64u::encode(digest);
        self.derive_book(&card, &template, &dj.params);
        self.set_book_prop(&card, &template, &dj.prop);

        // a resubmission of an input already accepted: the same offer, or a fresh one if its boundary has passed
        if self.derive[&(card.clone(), template.clone())].recs.contains_key(&digest_b64) {
            return self.derive_reoffer(&card, &template, &digest_b64, now);
        }
        if input.get("revision").and_then(Value::as_u64) != Some(0) {
            return Err("INPUT_REVISION_INVALID");
        }
        // the payload (B9 checked its shape)
        let payload = input.get("payload").cloned().unwrap_or(Value::Null);
        let d_pub = text_field(&payload, "derived_recipient_pubkey").and_then(|k| b64u::decode_len(k, notary_crypto::MLDSA44_PUBLIC_KEY_LEN).ok()).ok_or("INPUT_SCHEMA_INVALID")?;
        let target = payload.get("target_period").and_then(Value::as_u64).ok_or("INPUT_SCHEMA_INVALID")?;
        let p = &dj.params;
        // D1: the current period, or the next one inside the renewal window
        let pc = p.period_of(now);
        let in_window = now >= p.period_end_ms(pc) - p.renewal_ms;
        if !(target == pc || (target == pc + 1 && in_window)) {
            return Err("DERIVE_PERIOD_INVALID");
        }
        // the presented card is of the job's source policy, and carries every projected field
        if src.policy_id != dj.source_policy {
            return Err("INPUT_NOT_ELIGIBLE");
        }
        let projected_in = projected_input(&src.fields, &dj.projected_fields).ok_or("INPUT_NOT_ELIGIBLE")?;
        // D2
        let d_hash = notary_crypto::sha256(&d_pub);
        if self.derive[&(card.clone(), template.clone())].seen_d.contains(&d_hash) {
            return Err("DERIVE_KEY_REUSED");
        }
        // D3: the tag under the newest generation, and under any exposed older generation kept for this period
        let Some((_, k)) = self.keys.template_period_key(&template, target) else { return Err("NH_ENCLAVE_UNAVAILABLE") };
        let tag = dup_tag(k.expose(), &src.root_key, &dj.source_policy, target);
        let mut seen = vec![tag];
        for (_, old) in self.keys.template_retired_keys(&template, target) {
            seen.push(dup_tag(old.expose(), &src.root_key, &dj.source_policy, target));
        }
        let used = self.derive[&(card.clone(), template.clone())].tags.get(&target);
        if used.is_some_and(|u| seen.iter().any(|t| u.contains(t))) {
            return Err("DERIVE_DUPLICATE");
        }
        // B11 for a standing job: tags reserved in open periods are what `max_inputs` bounds
        let open: usize = self.derive[&(card.clone(), template.clone())].tags.values().map(BTreeSet::len).sum();
        if open as u64 >= self.jobs[hash].admitted.limits.max_inputs {
            return Err("INPUT_CAPACITY");
        }
        // D4: the program runs on the projected values; its output must be exactly those values, verbatim
        let input_bytes = jcs::canonical(&projected_in).map_err(|_| "OUTPUT_SCHEMA_VIOLATION")?;
        let (program, limits, params) = (self.jobs[hash].program.clone(), self.jobs[hash].admitted.limits, self.jobs[hash].params_bytes.clone());
        let run = self.workers.run(hash, &program, &limits, &params, &[input_bytes]);
        let out = run.map_err(|_| "OUTPUT_SCHEMA_VIOLATION")?;
        let projected = check_projection(&out.bytes, &projected_in).ok_or("OUTPUT_SCHEMA_VIOLATION")?;
        // the offer
        let boundary = p.next_boundary(now);
        let offer = self.build_offer(&card, &template, &dj.source_policy, &projected, tag, p.period_end_ms(target), boundary).ok_or("NOTARY_KEY_EXPOSED")?;
        let offer_hash = jcs::h(&offer).map_err(|_| "OUTPUT_SCHEMA_VIOLATION")?;
        let source = dj.prop.sealed.then(|| (src.address.clone(), src.pubkey.clone()));
        let rec = Rec { job: *hash, period: target, tag, d_pub, offer: offer.clone(), offer_hash: offer_hash.clone(), boundary_ms: boundary, group: (dj.source_policy.clone(), projected, target), state: RecState::Offered, block, source };
        let book = self.derive.get_mut(&(card, template)).expect("book");
        book.seen_d.insert(d_hash);
        book.tags.entry(target).or_default().extend(seen);
        book.by_offer.insert(offer_hash, digest_b64.clone());
        book.recs.insert(digest_b64, rec);
        Ok(offer)
    }

    /// A resubmitted input: the card is still wanted. If its offer's boundary has passed, a new offer for the next one.
    fn derive_reoffer(&mut self, card: &str, template: &str, digest: &str, now: i64) -> Result<Value, &'static str> {
        let key = (card.to_string(), template.to_string());
        let params = self.derive[&key].params.clone().expect("params");
        let rec = self.derive[&key].recs[digest].clone();
        if rec.state == RecState::Released {
            return Ok(rec.offer);
        }
        if params.period_end_ms(rec.period) <= now {
            return Err("DERIVE_PERIOD_INVALID");
        }
        if rec.boundary_ms > now && matches!(rec.state, RecState::Offered | RecState::Pooled { .. }) {
            return Ok(rec.offer);
        }
        // stale: re-offer for the next boundary (the group and tag are unchanged)
        let source_policy = rec.group.0.clone();
        let boundary = params.next_boundary(now);
        let offer = self.build_offer(card, template, &source_policy, &rec.group.1, rec.tag, params.period_end_ms(rec.period), boundary).ok_or("NOTARY_KEY_EXPOSED")?;
        let offer_hash = jcs::h(&offer).map_err(|_| "OUTPUT_SCHEMA_VIOLATION")?;
        let book = self.derive.get_mut(&key).expect("book");
        book.by_offer.remove(&rec.offer_hash);
        book.by_offer.insert(offer_hash.clone(), digest.to_string());
        let r = book.recs.get_mut(digest).expect("rec");
        r.offer = offer.clone();
        r.offer_hash = offer_hash;
        r.boundary_ms = boundary;
        r.state = RecState::Offered;
        Ok(offer)
    }

    /// The offer-phase derived `CardDocument` (protocol-objects §2.2), signed by `K_id`.
    #[allow(clippy::too_many_arguments)]
    fn build_offer(&self, card: &str, template: &str, source_policy: &str, projected: &str, tag: [u8; 32], expires_ms: i64, issued_ms: i64) -> Option<Value> {
        let ident = self.keys.identity(card)?;
        let t_pub = self.oracle.policy_public_key(template)?;
        let mut offer = json!({
            "ancestry_pubkeys": [b64u::encode(ident.id.public_key()), b64u::encode(&t_pub)],
            "dup_tag": b64u::encode(&tag), "expires_at": formats::format_timestamp(expires_ms), "issued_at": formats::format_timestamp(issued_ms),
            "issuer_card": card, "policy_id": template, "press_card": card, "projected": projected, "source_policy": source_policy,
        });
        let sig = ident.id.sign(&jcs::canonical(&offer).ok()?);
        offer["issuer_signature"] = json!(b64u::encode(&sig));
        Some(offer)
    }

    /// `notary.countersign.v1`: the holder's signature over the offer plus `D`.
    fn derive_countersign(&mut self, hash: &[u8; 32], v: &Value) -> Outcome {
        let reject = |c: &'static str| Outcome::reject(c, 0);
        let Ok(typed) = notary_types::objects::from_value::<notary_types::objects::NotaryCountersign>(v, notary_types::objects::types::COUNTERSIGN) else { return reject("INPUT_MALFORMED") };
        let job = &self.jobs[hash];
        if typed.job_hash != job.job_hash_b64 {
            return reject("INPUT_WRONG_JOB");
        }
        let (card, template) = (job.card.clone(), job.derive.as_ref().expect("derive job").template.clone());
        let Some(book) = self.derive.get(&(card.clone(), template.clone())) else { return reject("DERIVE_OFFER_UNKNOWN") };
        let Some(digest) = book.by_offer.get(&typed.offer_hash).cloned() else { return reject("DERIVE_OFFER_UNKNOWN") };
        let rec = &book.recs[&digest];
        if rec.job != *hash {
            return reject("DERIVE_OFFER_UNKNOWN");
        }
        let Ok(now) = self.attested_now_ms() else { return reject("ATT_UNAVAILABLE") };
        let params = book.params.clone().expect("params");
        // an offer whose boundary has passed, or whose period has ended, can't be released
        if rec.boundary_ms <= now || params.period_end_ms(rec.period) <= now {
            return reject("DERIVE_OFFER_STALE");
        }
        match &rec.state {
            RecState::Offered => {}
            RecState::Pooled { holder_signature } if *holder_signature == typed.holder_signature => return Outcome { status: "accepted", reason: None, revision: 0, offer: None },
            _ => return reject("DERIVE_OFFER_STALE"),
        }
        // the holder signs the offer plus `recipient_pubkey = D`, with D's key (the one given in the input)
        let mut signed = rec.offer.clone();
        signed["recipient_pubkey"] = json!(b64u::encode(&rec.d_pub));
        let ok = jcs::canonical(&signed).is_ok_and(|m| b64u::decode_len(&typed.holder_signature, notary_crypto::MLDSA44_SIGNATURE_LEN).is_ok_and(|s| notary_crypto::mldsa_verify(&rec.d_pub, &m, &s)));
        if !ok {
            return reject("DERIVE_COUNTERSIGN_INVALID");
        }
        let r = self.derive.get_mut(&(card, template)).expect("book").recs.get_mut(&digest).expect("rec");
        r.state = RecState::Pooled { holder_signature: typed.holder_signature };
        Outcome { status: "accepted", reason: None, revision: 0, offer: None }
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Timers

    /// Runs from `tick` with the tick's single clock reading: key rotation and erasure, the end of jobs, the issuance
    /// pool, key upkeep.
    pub(crate) fn derive_tick(&mut self, io: &mut dyn HostIo, now: i64) {
        if self.derive.is_empty() && !self.jobs.values().any(|j| j.derive.is_some()) {
            return;
        }
        self.derive_key_upkeep(io, now);
        let hashes: Vec<[u8; 32]> = self.jobs.iter().filter(|(_, j)| j.derive.is_some() && j.state.live()).map(|(h, _)| *h).collect();
        for h in hashes {
            self.derive_job_timers(io, &h, now);
        }
        let keys: Vec<(String, String)> = self.derive.keys().cloned().collect();
        let mut changed: BTreeSet<String> = BTreeSet::new();
        for k in keys {
            if self.derive_pool_tick(io, &k, now) | self.propagation_tick(io, &k, now) {
                changed.insert(k.0.clone());
            }
        }
        // replication step 30: a new state blob after each issuance or propagation batch
        for card in changed {
            self.write_state_blob(io, &card);
        }
    }

    fn derive_job_timers(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], now: i64) {
        let j = self.jobs.get_mut(hash).expect("job");
        let dj = j.derive.as_mut().expect("derive");
        // old epochs' keys are erased an hour after the rotation
        let expired: Vec<u64> = dj.grace.iter().filter(|(_, until)| now >= **until).map(|(e, _)| *e).collect();
        for e in expired {
            dj.grace.remove(&e);
            self.keys.erase_job_epoch(hash, e);
        }
        let j = self.jobs.get_mut(hash).expect("job");
        let dj = j.derive.as_mut().expect("derive");
        // the job ends: every key is erased, and cards still waiting for release are dropped with it
        if now >= dj.ends_ms {
            j.state = State::Finalized;
            let (card, template) = (j.card.clone(), dj.template.clone());
            self.erase_job_state(hash);
            if let Some(b) = self.derive.get_mut(&(card, template)) {
                b.recs.retain(|_, r| r.job != *hash || r.state == RecState::Released);
            }
            return;
        }
        if dj.rotation.is_none() && j.serving && now >= dj.next_rotation_ms && j.opened {
            self.rotate_job_key(io, hash);
        }
    }

    /// Replication §7 / lifecycle step 40: a new epoch at each `key_period`. `K_job,e+1` and its attestation are made now;
    /// the epoch is announced only once its `epoch_started` record is anchored, and `K_job,e` is kept an hour more.
    fn rotate_job_key(&mut self, io: &mut dyn HostIo, hash: &[u8; 32]) {
        let (admitted, card, epoch, scope) = {
            let j = &self.jobs[hash];
            (j.admitted.clone(), j.card.clone(), j.epoch, j.job_hash_b64.clone())
        };
        let new_epoch = epoch + 1;
        if self.keys.create_job_key(&admitted, *hash, new_epoch).is_err() {
            return;
        }
        let Ok((_, att_cid)) = self.attest_job_key(io, &card, &admitted, *hash, new_epoch) else {
            self.keys.erase_job_epoch(hash, new_epoch);
            return;
        };
        if self.append_log(io, &scope, &card, "epoch_started", json!({ "epoch": new_epoch, "epoch_reason": "key_period" })).is_err() {
            self.keys.erase_job_epoch(hash, new_epoch);
            return;
        }
        let seq = self.logs.head(&scope).map(|(s, _)| s);
        let dj = self.jobs.get_mut(hash).expect("job").derive.as_mut().expect("derive");
        dj.rotation = Some(Rotation { epoch: new_epoch, attestation_cid: att_cid, anchor_seq: seq });
    }

    /// The anchor of an `epoch_started` record written by `rotate_job_key`: the new epoch is announced and takes inputs.
    pub(crate) fn derive_after_anchor(&mut self, io: &mut dyn HostIo, hash: &[u8; 32], seq: u64) {
        let Some(job) = self.jobs.get(hash) else { return };
        let Some(rot) = job.derive.as_ref().and_then(|d| d.rotation.clone()) else { return };
        if rot.anchor_seq != Some(seq) || !job.state.live() {
            return;
        }
        let Ok(now) = self.attested_now_ms() else { return };
        let prev = job.announcement_cid.clone();
        let (old_epoch, key_period) = (job.epoch, job.derive.as_ref().expect("derive").key_period_ms);
        {
            let j = self.jobs.get_mut(hash).expect("job");
            j.epoch = rot.epoch;
            j.attestation_cid = rot.attestation_cid.clone();
            j.epoch_reason = Some("key_period".into());
            j.members.insert(self.keys.instance_id(), crate::jobs::Member { card: j.card.clone(), attestation: Some(rot.attestation_cid) });
            let dj = j.derive.as_mut().expect("derive");
            dj.grace.insert(old_epoch, now + KEY_GRACE_MS);
            dj.next_rotation_ms += key_period;
            dj.rotation = None;
        }
        if let Some(ann) = self.sign_announcement(hash) {
            let cid = formats::cid_of_bytes(&jcs::canonical(&ann).expect("notary JSON"));
            io.send(json!({ "kind": "announce", "req_id": format!("announce-{}-{seq}", b64u::encode(hash)), "announcement": ann }));
            let j = self.jobs.get_mut(hash).expect("job");
            j.announcement_cid = Some(cid);
        }
        let _ = prev;
    }

    // -----------------------------------------------------------------------------------------------------------------
    // The issuance pool

    /// Returns whether a batch was released.
    fn derive_pool_tick(&mut self, io: &mut dyn HostIo, key: &(String, String), now: i64) -> bool {
        let Some(params) = self.derive.get(key).and_then(|b| b.params.clone()) else { return false };
        // periods that ended: cards not released are dropped, and their tags are released with them (§3 step 10)
        {
            let book = self.derive.get_mut(key).expect("book");
            let ended: Vec<u64> = book.tags.keys().copied().filter(|p| params.period_end_ms(*p) <= now).collect();
            for p in ended {
                book.recs.retain(|_, r| r.period != p);
                let live: BTreeSet<String> = book.recs.keys().cloned().collect();
                book.by_offer.retain(|_, d| live.contains(d));
                book.tags.remove(&p);
                book.released.retain(|g, _| g.2 != p);
            }
        }
        let boundary = params.boundary_at(now);
        if boundary <= self.derive[key].last_boundary_ms {
            return false;
        }
        // the batch of this boundary: pooled cards whose offer names it
        let book = &self.derive[key];
        let mut by_group: BTreeMap<Group, Vec<String>> = BTreeMap::new();
        for (digest, r) in &book.recs {
            if matches!(r.state, RecState::Pooled { .. }) && r.boundary_ms == boundary {
                by_group.entry(r.group.clone()).or_default().push(digest.clone());
            }
        }
        let mut release: Vec<String> = vec![];
        for (g, members) in &by_group {
            // §4: at least `min_anonymity_set` distinct tags in the group, counting those released before; and the
            // source-policy snapshot lists at least that many cards (the second floor)
            let have = book.released.get(g).map_or(0, BTreeSet::len) + members.len();
            let floor = self.oracle.policy_card_count(&g.0).is_some_and(|n| n >= params.min_anon);
            if have >= params.min_anon && floor {
                release.extend(members.iter().cloned());
            }
        }
        // the batch must hold `min_batch_size` cards, or everything waits for the next boundary
        if release.len() < params.min_batch {
            release.clear();
        }
        // the clock reading, the protocol version and the next registry sequence come from the host; without them nothing
        // is released at this boundary (the cards go stale and are offered the next one)
        let ready = if release.is_empty() { None } else { self.release_inputs(io, key, &release) };
        if release.is_empty() || ready.is_some() {
            self.derive.get_mut(key).expect("book").last_boundary_ms = boundary;
        } else {
            return false;
        }
        // every pooled card of this boundary or an older one that wasn't released is stale
        {
            let book = self.derive.get_mut(key).expect("book");
            for (digest, r) in book.recs.iter_mut() {
                if matches!(r.state, RecState::Pooled { .. } | RecState::Offered) && r.boundary_ms <= boundary && !release.contains(digest) {
                    r.state = RecState::Stale;
                }
            }
        }
        if let Some((version, sequence, policy_address)) = ready {
            self.release_batch(io, key, release, boundary, &version, sequence, &policy_address, now);
            return true;
        }
        false
    }

    /// What a release needs from the host: the protocol version and the press's next sequence under `T`.
    fn release_inputs(&mut self, io: &mut dyn HostIo, key: &(String, String), _release: &[String]) -> Option<(String, u64, String)> {
        let (card, template) = key;
        let version = match &self.protocol_version {
            Some(v) => v.clone(),
            None => {
                let v = io.fetch("protocol_version").and_then(|b| String::from_utf8(b).ok()).filter(|v| !v.is_empty() && v.len() < 32)?;
                self.protocol_version = Some(v.clone());
                v
            }
        };
        let policy_address = formats::card_pointer(&self.oracle.policy_public_key(template)?);
        let sequence = self.next_sequence(io, &policy_address, card)?;
        Some((version, sequence, policy_address))
    }

    /// `PressAuthorizations[policy][press].next_sequence`, read through the host (an untrusted read: a wrong number only
    /// makes the registration fail).
    fn next_sequence(&self, io: &mut dyn HostIo, policy_address: &str, press: &str) -> Option<u64> {
        let b = io.fetch(&format!("press_auth:{policy_address},{press}"))?;
        serde_json::from_slice::<Value>(&b).ok()?.get("next_sequence")?.as_u64()
    }

    /// Releases one batch (§3 step 7): shuffled, each card signed by `K_id`, encrypted under its content key and published,
    /// and one `RegisterCard` payload per card signed by `K_chain`; then an `issued` record per job and period.
    #[allow(clippy::too_many_arguments)]
    fn release_batch(&mut self, io: &mut dyn HostIo, key: &(String, String), mut release: Vec<String>, boundary: i64, version: &str, mut sequence: u64, policy_address: &str, now: i64) {
        shuffle(&mut release);
        let (card, _template) = key;
        let mut counts: BTreeMap<([u8; 32], u64), u64> = BTreeMap::new();
        for digest in release {
            let rec = self.derive[key].recs[&digest].clone();
            let RecState::Pooled { holder_signature } = &rec.state else { continue };
            let Some(final_card) = self.finish_card(card, &rec, holder_signature, version) else { continue };
            let Ok(plain) = jcs::canonical(&final_card) else { continue };
            let enc = notary_cards::support::aes_gcm_encrypt(&notary_cards::support::content_key(&rec.d_pub), &plain);
            let cid = formats::cid_of_bytes(&enc);
            let cid_for_link = cid.clone();
            self.publish(io, &enc);
            let address = notary_crypto::keccak256(&rec.d_pub);
            let reg = Reg { input: digest.clone(), card_address: address, cid, tries: 0 };
            self.submit_registration(io, key, reg, policy_address, sequence, now);
            sequence += 1;
            let book = self.derive.get_mut(key).expect("book");
            book.released.entry(rec.group.clone()).or_default().insert(rec.tag);
            book.recs.get_mut(&digest).expect("rec").state = RecState::Released;
            // §6: the sealed link, made when the card is released (a card never released needs none)
            if let Some((source, source_pubkey)) = rec.source.clone() {
                let card_state = json!({ "dup_tag": final_card["dup_tag"], "projected": final_card["projected"], "source_policy": final_card["source_policy"] });
                let link = crate::propagation::Link {
                    d_pub: rec.d_pub.clone(), source, source_pubkey, source_policy: rec.group.0.clone(), expires_ms: book.params.as_ref().map_or(0, |p| p.period_end_ms(rec.period)),
                    head_cid: cid_for_link.clone(), card_state, successor: None,
                };
                book.links.insert(formats::card_pointer(&rec.d_pub), link);
            }
            *counts.entry((rec.job, rec.period)).or_default() += 1;
        }
        for ((job, period), count) in counts {
            let (scope, jcard) = (b64u::encode(&job), card.clone());
            let _ = self.append_log(io, &scope, &jcard, "issued", json!({ "batch_boundary": formats::format_timestamp(boundary), "count": count, "period": period }));
        }
    }

    /// The registered card: the countersigned offer, `protocol_version`, and `press_signature` by `K_id` over everything else.
    fn finish_card(&self, card: &str, rec: &Rec, holder_signature: &str, version: &str) -> Option<Value> {
        let ident = self.keys.identity(card)?;
        let mut c = rec.offer.clone();
        c["recipient_pubkey"] = json!(b64u::encode(&rec.d_pub));
        c["holder_signature"] = json!(holder_signature);
        c["protocol_version"] = json!(version);
        let sig = ident.id.sign(&jcs::canonical(&c).ok()?);
        c["press_signature"] = json!(b64u::encode(&sig));
        Some(c)
    }

    /// Signs `RegisterCardPayload` (registry_contract §4.1) with `K_chain` and asks the host to submit it with the calldata
    /// the payload names. Every field is unpadded base64url, which is what the write gate compares (§6.1 step 8).
    fn submit_registration(&mut self, io: &mut dyn HostIo, key: &(String, String), reg: Reg, policy_address: &str, sequence: u64, now: i64) {
        let card = &key.0;
        let Some(ident) = self.keys.identity(card) else { return };
        let Ok(policy_bytes) = hex_to_32(policy_address) else { return };
        let Ok(press_bytes) = hex_to_32(card) else { return };
        let b = |x: &[u8]| b64u::encode(x);
        let payload = json!({
            "card_address": b(&reg.card_address), "initial_log_cid": b(reg.cid.as_bytes()), "op": "register_card", "policy_address": b(&policy_bytes),
            "press_address": b(&press_bytes), "sequence": sequence, "timestamp": formats::format_timestamp(now),
        });
        let Ok(bytes) = jcs::canonical(&payload) else { return };
        let Ok(sig) = ident.chain.sign_digest(&notary_crypto::keccak256(&bytes)) else { return };
        let req_id = format!("reg-{}-{}", b(&reg.card_address), reg.tries);
        io.send(json!({
            "kind": "chain_submit", "req_id": req_id, "op": "register_card", "payload": payload, "signature": b(&sig),
            "calldata": { "card_address": b(&reg.card_address), "initial_log_cid": b(reg.cid.as_bytes()), "policy_address": b(&policy_bytes), "press_address": b(&press_bytes) },
        }));
        self.derive.get_mut(key).expect("book").regs.insert(req_id, reg);
    }

    /// The host's answer to a `chain_submit`: a failed registration is signed again with a fresh sequence, a few times.
    pub(crate) fn on_chain_result(&mut self, io: &mut dyn HostIo, msg: &Value) {
        let Some(req_id) = msg.get("req_id").and_then(Value::as_str) else { return };
        if self.on_revocation_result(io, msg, req_id) {
            return;
        }
        let Some(key) = self.derive.iter().find(|(_, b)| b.regs.contains_key(req_id)).map(|(k, _)| k.clone()) else { return };
        let reg = self.derive.get_mut(&key).expect("book").regs.remove(req_id).expect("reg");
        if msg.get("failed").is_none() {
            return;
        }
        if reg.tries + 1 >= MAX_REGISTRATION_TRIES {
            io.send(json!({ "kind": "alert", "req_id": "registration-failed", "level": "error", "code": "registration_failed" }));
            return;
        }
        let Some(policy_address) = self.oracle.policy_public_key(&key.1).map(|k| formats::card_pointer(&k)) else { return };
        let Some(sequence) = self.next_sequence(io, &policy_address, &key.0) else { return };
        let Ok(now) = self.attested_now_ms() else { return };
        self.submit_registration(io, &key, Reg { tries: reg.tries + 1, ..reg }, &policy_address, sequence, now);
    }
}

/// D4: the program's output must be the projected values and nothing else, verbatim. Returns the `projected` text (the
/// output's RFC 8785 form).
fn check_projection(raw: &[u8], expected: &Value) -> Option<String> {
    let out = jcs::parse_canonical(raw).ok()?;
    (out == *expected).then(|| String::from_utf8(jcs::canonical(&out).ok()?).ok()).flatten()
}

pub(crate) fn hex_to_32(s: &str) -> Result<[u8; 32], ()> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 {
        return Err(());
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| ())?;
    }
    Ok(out)
}
