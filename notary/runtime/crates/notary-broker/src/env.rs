//! What the broker depends on, injected so the same code runs in production, under the simulator and in tests.
//!
//! - `HostIo`: the host channel (notary_runtime.md §9). `fetch` sends an enclave `fetch` and returns the
//!   `fetch_result` bytes; everything from the host is untrusted and checked by the caller.
//! - `CardOracle`: everything that needs card-chain verification: the policy at a job's `policy_state_cid` (W3, W4,
//!   W10), the requester predicate (W5), the contributor checks B5–B8, and the governance list histories (§12).
//!   Implemented by `notary-cards` (step 5.3a) over evidence bundles and whole-policy snapshots; tests inject fixed
//!   answers.
//! - `Workers`: runs a job's admitted program (runtime §3, §8): in-process for tests, one OS process per job in the
//!   runtime binary.
//! - `Platform`: the attestation backend, the attested clock (the enclave's hardware time, assumption T9) and this image's PCR0.
use crate::lists::ListVersion;
use notary_admission::AdmittedLimits;
use notary_attest::AttestationBackend;
use notary_worker::{RunError, RunOutput};
use serde_json::Value;

pub trait HostIo {
    fn send(&mut self, msg: Value);
    fn fetch(&mut self, what: &str) -> Option<Vec<u8>>;
}

/// The policy as of a job's `policy_state_cid`, from a chain that reaches a trusted root.
#[derive(Debug, Clone, PartialEq)]
pub struct PolicyView {
    pub notary: Value,
    pub approved_notaries: Vec<String>,
}

/// A sub-card a private output can be sent to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientTarget {
    /// `keccak256(sub-card ML-DSA public key)`, the routing `subcard_hash`.
    pub sub_card: String,
    pub kem_public_key: Vec<u8>,
}

/// What B5–B8 established about a presented source card, for a derived-card job (step 6.4): the master card's root key
/// (the `dup_tag` input), the policy it was issued under, and its current field values (what the job may project).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceCard {
    /// The master card's pointer (the input's `contributor_card`) and its current `recipient_pubkey`: a sealed link keeps
    /// both, to read the source card's later log entries (step 6.5).
    pub address: String,
    pub pubkey: Vec<u8>,
    pub root_key: Vec<u8>,
    pub root_key_hash: [u8; 32],
    pub policy_id: String,
    pub fields: serde_json::Map<String, Value>,
}

pub trait CardOracle {
    /// W3/W4: `Err("JOB_POLICY_UNTRUSTED" | "JOB_POLICY_CHANGED")`.
    /// `now_ms` is chain time, for the policy chain's revocation check (algorithm R, R3).
    fn policy(&mut self, io: &mut dyn HostIo, policy_id: &str, state_cid: &str, now_ms: i64) -> Result<PolicyView, &'static str>;
    /// W5: whether the requester satisfies `job_requester_predicate` (resolved parameters).
    fn requester_allowed(&mut self, io: &mut dyn HostIo, job: &Value, predicate: &Value, now_ms: i64) -> bool;
    /// B5–B8 on a decrypted `NotaryInput`. Returns the contributor's root-key hash for dedupe (B10).
    /// `now_ms` is chain time (newest verified header), for `valid_until` and revocation dates.
    fn contributor(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> Result<[u8; 32], &'static str>;
    /// B5–B8 as `contributor`, for a derived-card job: the presented source card in full (step 6.4). Fails closed by default.
    fn source_card(&mut self, _io: &mut dyn HostIo, _input: &Value, _notary: &Value, _params: &Value, _now_ms: i64) -> Result<SourceCard, &'static str> {
        Err("NH_UNSUPPORTED")
    }
    /// The policy card's ML-DSA-44 public key, from the last verified read of `policy_id` (a derived card's `ancestry_pubkeys`
    /// ends with it, protocol-objects §2.2).
    fn policy_public_key(&self, _policy_id: &str) -> Option<Vec<u8>> {
        None
    }
    /// The policy a snapshot or update delivered `card` under (propagation §6, successor rule). `None` if unknown.
    fn card_policy(&self, _card: &str) -> Option<String> {
        None
    }
    /// 6.5a (C): the fields of source policy `policy_id` whose definition has `derivable: false` at the policy's current head
    /// (derived_card_revocation_propagation §3, D5; lifecycle A.7 R6). Read through the host, so unverified (L4); the answer
    /// may be up to `FIELD_CONTROL_REFRESH_MS` old. Fails closed when nothing could be read.
    fn non_derivable_fields(&mut self, _io: &mut dyn HostIo, _policy_id: &str, _now_ms: i64) -> Result<Vec<String>, &'static str> {
        Ok(vec![])
    }
    /// 6.5 E4: reads the certified presses of source policy `policy_id` (`notary_cards::policy::certified_press_keys`),
    /// at most every `PRESS_REFRESH_MS`. Called for every watched source-policy message, whatever is linked, so the reads
    /// never depend on the link set (propagation §6 step 2). `now_ms` is the attested time.
    fn refresh_source_presses(&mut self, _io: &mut dyn HostIo, _policy_id: &str, _now_ms: i64) {}
    /// 6.5 E4: whether a linked source card's new head `entry` (decrypted) is signed by one of `policy_id`'s certified
    /// presses, as last read (`notary_cards::policy::entry_press_signed`). No reads. Fails closed by default.
    fn source_entry_certified(&self, _policy_id: &str, _entry: &Value) -> Result<(), &'static str> {
        Err("NH_UNSUPPORTED")
    }
    /// How many cards the host's whole-policy snapshot lists under `policy` (the second anonymity floor, propagation §4).
    /// `None` without a snapshot.
    fn policy_card_count(&self, _policy: &str) -> Option<usize> {
        None
    }
    /// 6.1, private outputs: the sub-cards of a recipient card, each with its verified ML-KEM-768 public key. `master_pubkey` is
    /// the recipient's ML-DSA-44 key from the signed job (`keccak256` of it is the card pointer). Each sub-card is verified as a
    /// contributor's signing sub-card is (SubCardDocument signatures, active flag, app-card chain); a sub-card with no
    /// `kem_pubkey` is left out. `Err` if the card can't be read.
    fn recipient_targets(&mut self, io: &mut dyn HostIo, master_pubkey: &[u8]) -> Result<Vec<RecipientTarget>, &'static str>;
    /// The full version history of a governance list card (oldest first), for algorithm L.
    fn list_history(&mut self, io: &mut dyn HostIo, list_card: &str) -> Option<Vec<ListVersion>>;
    /// The state this runtime holds for a contributor policy: the policy card's head the snapshot was built against and
    /// the newest block applied (`protocol-objects.md §27`, `contributor_policies`). `None` without a snapshot.
    fn contributor_policy_state(&self, policy: &str) -> Option<(String, u64)>;
    /// 6.0a: whether the contributor's master card and signing sub-card come from a snapshot of one of `policies`
    /// (runtime §9, `fetch`: a contributor's own cards are never read through the per-card fallback).
    fn contributor_from_snapshot(&self, master_card: &str, sub_card: &str, policies: &[String]) -> bool;
    /// Template-scope handoff check P3 (D9, decided by David 2026-11-21) for the peer that proved it holds `id_pubkey`:
    /// its notary card verifies, names `T` as `issuer_card` and is in `T.approved_notaries` at T's current head, and
    /// `AuthorizePress(T, card)` is active with the card's `chain_pubkey`. Read like any registry state (limit L4). Fails
    /// closed by default.
    fn serves_template(&mut self, _io: &mut dyn HostIo, _id_pubkey: &[u8], _template: &str, _now_ms: i64) -> bool {
        false
    }
    /// `policy_snapshot` / `policy_updates` from the host (never filtered; host §8).
    fn on_snapshot(&mut self, policy: &str, msg: &Value);
    fn on_updates(&mut self, policy: &str, msg: &Value);
}

pub trait Workers {
    /// Runs `program` once for `job` with the given limits. The implementation enforces `limits.wall_ms`.
    fn run(&mut self, job: &[u8; 32], program: &[u8], limits: &AdmittedLimits, params: &[u8], inputs: &[Vec<u8>]) -> Result<RunOutput, RunError>;
    /// The job is over: stop its worker.
    fn stop(&mut self, job: &[u8; 32]);
}

pub struct Platform {
    pub attest: Box<dyn AttestationBackend>,
    /// The attested clock in milliseconds (the enclave's hardware time; the simulator's controllable clock).
    pub attested_time_ms: Box<dyn Fn() -> Result<u64, String>>,
    /// This image's PCR0 (read from its own boot attestation).
    pub pcr0: Vec<u8>,
    /// The pinned attestation roots this runtime verifies peers against (handoff check P1, algorithm V).
    pub peer_roots: notary_attest::verify::Config,
}

/// In-process workers (tests and macOS development). No process isolation: the runtime binary uses `ProcessWorkers`.
#[derive(Default)]
pub struct InProcessWorkers {
    loaded: std::collections::BTreeMap<[u8; 32], notary_worker::Program>,
}

impl Workers for InProcessWorkers {
    fn run(&mut self, job: &[u8; 32], program: &[u8], limits: &AdmittedLimits, params: &[u8], inputs: &[Vec<u8>]) -> Result<RunOutput, RunError> {
        if !self.loaded.contains_key(job) {
            let p = notary_worker::Program::load(program).map_err(|_| RunError::Trap)?;
            self.loaded.insert(*job, p);
        }
        let p = &self.loaded[job];
        p.run(params, inputs, notary_worker::RunLimits { fuel: limits.fuel, memory_pages: limits.memory_pages })
    }
    fn stop(&mut self, job: &[u8; 32]) {
        self.loaded.remove(job);
    }
}
