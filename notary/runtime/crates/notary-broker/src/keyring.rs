//! The broker keyring (notary_runtime.md §4, §15).
//!
//! Invariants (tested in `tests/keyring.rs`):
//! - **I1** no key is exported except by the handoff protocol: there is no exporting function here; the secret
//!   accessors on the crypto types are used only by the handoff module (step 6.3).
//! - **I2** no key is imported except by handoff: identities are created only by `create_identity` (genesis) and job
//!   keys only by `create_job_key`; neither takes key material. A host-supplied key is never accepted.
//! - **I3** a key's hash goes into an attestation only if the runtime holds that key: binding values come only from
//!   `job_binding` / `identity_binding`, which read held keys.
//!
//! **No job key before admission:** `create_job_key` requires the `Admitted` value only algorithm A produces.
//! **Key lineage** (runtime §4): every key records the PCR0s it has lived in; `apply_retirements` marks keys whose
//! lineage contains a PCR0 retired as `"vulnerable"`.
use notary_admission::Admitted;
use notary_crypto::{sha256, ChainKey, MlDsaKey, XWingKey};
use notary_types::{b64u, formats};
use std::collections::{BTreeMap, BTreeSet};

pub struct Identity {
    pub card: String,
    pub id: MlDsaKey,
    pub chain: ChainKey,
    pub lineage: BTreeSet<Vec<u8>>,
    /// Set when the lineage contains a vulnerable PCR0: never sign or decrypt with it again.
    pub exposed: bool,
}

pub struct JobKey {
    pub key: XWingKey,
    pub lineage: BTreeSet<Vec<u8>>,
    pub exposed: bool,
}

pub struct Keyring {
    inst: MlDsaKey,
    pcr0: Vec<u8>,
    identities: BTreeMap<String, Identity>,
    jobs: BTreeMap<([u8; 32], u64), JobKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exposed {
    Identity(String),
    Job([u8; 32], u64),
}

impl Keyring {
    /// `K_inst` is generated at boot and never persisted (§4, §15).
    pub fn new(pcr0: Vec<u8>) -> Self {
        Self { inst: MlDsaKey::generate(), pcr0, identities: BTreeMap::new(), jobs: BTreeMap::new() }
    }

    pub fn pcr0(&self) -> &[u8] {
        &self.pcr0
    }
    pub fn inst(&self) -> &MlDsaKey {
        &self.inst
    }
    /// `SHA-256(K_inst)`: the instance id (`JobLogRecord.instance`, host routing).
    pub fn inst_key_hash(&self) -> [u8; 32] {
        sha256(self.inst.public_key())
    }
    pub fn instance_id(&self) -> String {
        b64u::encode(&self.inst_key_hash())
    }

    /// Genesis (lifecycle step 3): a fresh `K_id` and `K_chain`. The card pointer is `keccak256(K_id)`.
    pub fn create_identity(&mut self) -> &Identity {
        let id = MlDsaKey::generate();
        let card = formats::card_pointer(id.public_key());
        let ident = Identity { card: card.clone(), id, chain: ChainKey::generate(), lineage: BTreeSet::from([self.pcr0.clone()]), exposed: false };
        self.identities.entry(card).or_insert(ident)
    }

    /// A usable identity (exposed identities are never returned).
    pub fn identity(&self, card: &str) -> Option<&Identity> {
        self.identities.get(card).filter(|i| !i.exposed)
    }

    pub fn identity_cards(&self) -> Vec<String> {
        self.identities.values().filter(|i| !i.exposed).map(|i| i.card.clone()).collect()
    }

    /// `(id_key_hash, chain_key_hash)` for a held identity (§33: `keccak256(K_id)`, `SHA-256(chain_pubkey)`).
    pub fn identity_binding(&self, card: &str) -> Option<([u8; 32], [u8; 32])> {
        let i = self.identity(card)?;
        Some((notary_crypto::keccak256(i.id.public_key()), sha256(&i.chain.public_key_xy())))
    }

    /// Creates `K_job,e`. Requires the proof of admission (runtime §6: A runs to completion before any job key).
    pub fn create_job_key(&mut self, _admitted: &Admitted, job_hash: [u8; 32], epoch: u64) -> Result<&XWingKey, &'static str> {
        if self.jobs.contains_key(&(job_hash, epoch)) {
            return Err("JOB_KEY_EXISTS");
        }
        let jk = JobKey { key: XWingKey::generate(), lineage: BTreeSet::from([self.pcr0.clone()]), exposed: false };
        Ok(&self.jobs.entry((job_hash, epoch)).or_insert(jk).key)
    }

    /// A usable job key.
    pub fn job_key(&self, job_hash: &[u8; 32], epoch: u64) -> Option<&XWingKey> {
        self.jobs.get(&(*job_hash, epoch)).filter(|k| !k.exposed).map(|k| &k.key)
    }

    /// `SHA-256(job public key)`, the attestation `public_key` for purpose 0x02 (§22, §33).
    pub fn job_binding(&self, job_hash: &[u8; 32], epoch: u64) -> Option<[u8; 32]> {
        self.job_key(job_hash, epoch).map(|k| sha256(k.public_key()))
    }

    /// Erases every key of a job (finalized, aborted, ended). Dropping zeroizes (§15).
    pub fn erase_job(&mut self, job_hash: &[u8; 32]) {
        self.jobs.retain(|(j, _), _| j != job_hash);
    }

    /// Erases one epoch's key (per-input rotation grace window over).
    pub fn erase_job_epoch(&mut self, job_hash: &[u8; 32], epoch: u64) {
        self.jobs.remove(&(*job_hash, epoch));
    }

    pub fn job_epochs(&self, job_hash: &[u8; 32]) -> Vec<u64> {
        self.jobs.keys().filter(|(j, _)| j == job_hash).map(|(_, e)| *e).collect()
    }

    /// Runtime §4 key-lineage check against a newly verified accepted-runtime list.
    pub fn apply_retirements(&mut self, vulnerable: &[Vec<u8>]) -> Vec<Exposed> {
        let hit = |l: &BTreeSet<Vec<u8>>| vulnerable.iter().any(|p| l.contains(p));
        let mut out = vec![];
        for i in self.identities.values_mut() {
            if !i.exposed && hit(&i.lineage) {
                i.exposed = true;
                out.push(Exposed::Identity(i.card.clone()));
            }
        }
        for ((j, e), k) in self.jobs.iter_mut() {
            if !k.exposed && hit(&k.lineage) {
                k.exposed = true;
                out.push(Exposed::Job(*j, *e));
            }
        }
        out
    }
}
