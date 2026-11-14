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

pub trait CardOracle {
    /// W3/W4: `Err("JOB_POLICY_UNTRUSTED" | "JOB_POLICY_CHANGED")`.
    /// `now_ms` is chain time, for the policy chain's revocation check (algorithm R, R3).
    fn policy(&mut self, io: &mut dyn HostIo, policy_id: &str, state_cid: &str, now_ms: i64) -> Result<PolicyView, &'static str>;
    /// W5: whether the requester satisfies `job_requester_predicate` (resolved parameters).
    fn requester_allowed(&mut self, io: &mut dyn HostIo, job: &Value, predicate: &Value, now_ms: i64) -> bool;
    /// B5–B8 on a decrypted `NotaryInput`. Returns the contributor's root-key hash for dedupe (B10).
    /// `now_ms` is chain time (newest verified header), for `valid_until` and revocation dates.
    fn contributor(&mut self, io: &mut dyn HostIo, input: &Value, notary: &Value, params: &Value, now_ms: i64) -> Result<[u8; 32], &'static str>;
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
