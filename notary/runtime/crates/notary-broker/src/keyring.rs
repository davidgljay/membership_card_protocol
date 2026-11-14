//! The broker keyring (notary_runtime.md §4, §15).
//!
//! Invariants (tested in `tests/keyring.rs` and `tests/replication.rs`):
//! - **I1** no key is exported except by the handoff protocol: the only exporting functions take a
//!   `handoff::PeerChecked`, which only the handoff module can construct, and only after algorithm P passed on the
//!   receiver and the key was found unexposed (P5).
//! - **I2** no key is imported except by handoff: identities are created only by `create_identity` (genesis), job keys
//!   only by `create_job_key`, template keys only by `create_template_key`; none of them takes key material. The
//!   importing functions take a `handoff::PayloadOpened`, which only the handoff module constructs, after it checked
//!   the sender (algorithm P) and opened the payload sealed to this enclave's ephemeral handoff key. A host-supplied
//!   key is never accepted.
//! - **I3** a key's hash goes into an attestation only if the runtime holds that key: binding values come only from
//!   `job_binding` / `identity_binding`, which read held keys.
//!
//! **No job key before admission:** `create_job_key` and `install_job_key` require the `Admitted` value only algorithm A
//! produces. **Key lineage** (runtime §4): every key records the PCR0s it has lived in; a received key's lineage is the
//! sender's plus this runtime's PCR0. `apply_retirements` marks keys whose lineage contains a PCR0 retired as
//! `"vulnerable"`; such keys are never used or handed on again (P5).
use crate::handoff::{PayloadOpened, PeerChecked};
use notary_admission::Admitted;
use notary_crypto::{sha256, ChainKey, MlDsaKey, SecretBytes, XWingKey};
use notary_types::{b64u, formats};
use std::collections::{BTreeMap, BTreeSet};

pub struct Identity {
    pub card: String,
    pub id: MlDsaKey,
    pub chain: ChainKey,
    pub lineage: BTreeSet<Vec<u8>>,
    /// Set when the lineage contains a vulnerable PCR0: never sign or decrypt with it again.
    pub exposed: bool,
    /// The sealed-link state key (replication §8), created with the identity, moved only by identity handoff.
    pub state_key: SecretBytes,
    pub state_version: u64,
    pub state_hash: String,
    /// A received identity is unusable until its `handoff` record is anchored (replication step 10).
    pub pending_handoff: bool,
}

pub struct JobKey {
    pub key: XWingKey,
    pub lineage: BTreeSet<Vec<u8>>,
    pub exposed: bool,
}

/// The `dup_tag` ratchet key `k_T,p` of a template (derived_card_revocation_propagation.md §1). Step 6.3 builds its
/// transfer (template-scope handoff); its derivation and use are step 6.4.
pub struct TemplateKey {
    pub template: String,
    pub generation: u64,
    pub key: SecretBytes,
    pub lineage: BTreeSet<Vec<u8>>,
    pub exposed: bool,
    /// Received by handoff and not yet usable (its handoff record not yet anchored).
    pub pending: bool,
}

pub struct Keyring {
    inst: MlDsaKey,
    pcr0: Vec<u8>,
    identities: BTreeMap<String, Identity>,
    jobs: BTreeMap<([u8; 32], u64), JobKey>,
    templates: BTreeMap<String, TemplateKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exposed {
    Identity(String),
    Job([u8; 32], u64),
    Template(String),
}

/// Key material leaving in a handoff payload (sealed to the receiver's handoff key at once). Zeroized on drop.
pub struct Exported {
    pub secret: SecretBytes,
    pub lineage: BTreeSet<Vec<u8>>,
}

/// An identity leaving in an identity-scope handoff.
pub struct ExportedIdentity {
    pub id_seed: SecretBytes,
    pub chain_secret: SecretBytes,
    pub state_key: SecretBytes,
    pub state_version: u64,
    pub state_hash: String,
    pub lineage: BTreeSet<Vec<u8>>,
}

fn hits(l: &BTreeSet<Vec<u8>>, vulnerable: &[Vec<u8>]) -> bool {
    vulnerable.iter().any(|p| l.contains(p))
}

impl Keyring {
    /// `K_inst` is generated at boot and never persisted (§4, §15).
    pub fn new(pcr0: Vec<u8>) -> Self {
        Self { inst: MlDsaKey::generate(), pcr0, identities: BTreeMap::new(), jobs: BTreeMap::new(), templates: BTreeMap::new() }
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

    /// Genesis (lifecycle step 3): a fresh `K_id` and `K_chain`, and a fresh sealed-link state key. The card pointer is
    /// `keccak256(K_id)`.
    pub fn create_identity(&mut self) -> &Identity {
        let id = MlDsaKey::generate();
        let card = formats::card_pointer(id.public_key());
        let ident = Identity {
            card: card.clone(),
            id,
            chain: ChainKey::generate(),
            lineage: BTreeSet::from([self.pcr0.clone()]),
            exposed: false,
            state_key: SecretBytes::random(32),
            state_version: 0,
            state_hash: b64u::encode(&sha256(b"")),
            pending_handoff: false,
        };
        self.identities.entry(card).or_insert(ident)
    }

    /// A usable identity: held, not exposed, and (if received by handoff) its handoff record anchored.
    pub fn identity(&self, card: &str) -> Option<&Identity> {
        self.identities.get(card).filter(|i| !i.exposed && !i.pending_handoff)
    }

    /// Any held identity, including one exposed or waiting for its handoff anchor (state and lineage reads only).
    pub fn identity_held(&self, card: &str) -> Option<&Identity> {
        self.identities.get(card)
    }

    pub fn identity_cards(&self) -> Vec<String> {
        self.identities.values().filter(|i| !i.exposed && !i.pending_handoff).map(|i| i.card.clone()).collect()
    }

    /// The identity-log handoff record naming this enclave is anchored: the identity becomes usable.
    pub fn activate_identity(&mut self, card: &str) -> bool {
        match self.identities.get_mut(card) {
            Some(i) if i.pending_handoff => {
                i.pending_handoff = false;
                true
            }
            _ => false,
        }
    }

    /// The template-scope handoff record naming this enclave is anchored: the template key becomes usable.
    pub fn activate_template(&mut self, template: &str) -> bool {
        match self.templates.get_mut(template) {
            Some(t) if t.pending => {
                t.pending = false;
                true
            }
            _ => false,
        }
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

    /// Whether this enclave holds `K_job,e` but its lineage is exposed (replication §7, `key_exposure`).
    pub fn job_key_exposed(&self, job_hash: &[u8; 32], epoch: u64) -> bool {
        self.jobs.get(&(*job_hash, epoch)).is_some_and(|k| k.exposed)
    }

    /// `SHA-256(job public key)`, the attestation `public_key` for purpose 0x02 (§22, §33).
    pub fn job_binding(&self, job_hash: &[u8; 32], epoch: u64) -> Option<[u8; 32]> {
        self.job_key(job_hash, epoch).map(|k| sha256(k.public_key()))
    }

    /// Erases every key of a job (finalized, aborted, ended). Dropping zeroizes (§15).
    pub fn erase_job(&mut self, job_hash: &[u8; 32]) {
        self.jobs.retain(|(j, _), _| j != job_hash);
    }

    /// Erases one epoch's key (per-input rotation grace window over; a new epoch anchored).
    pub fn erase_job_epoch(&mut self, job_hash: &[u8; 32], epoch: u64) {
        self.jobs.remove(&(*job_hash, epoch));
    }

    pub fn job_epochs(&self, job_hash: &[u8; 32]) -> Vec<u64> {
        self.jobs.keys().filter(|(j, _)| j == job_hash).map(|(_, e)| *e).collect()
    }

    /// The first template enclave seeds `k_T` (generation 0). Step 6.4 calls this; 6.3 only moves it.
    pub fn create_template_key(&mut self, template: &str) -> &TemplateKey {
        let tk = TemplateKey { template: template.into(), generation: 0, key: SecretBytes::random(32), lineage: BTreeSet::from([self.pcr0.clone()]), exposed: false, pending: false };
        self.templates.entry(template.into()).or_insert(tk)
    }

    pub fn template_key(&self, template: &str) -> Option<&TemplateKey> {
        self.templates.get(template).filter(|t| !t.exposed && !t.pending)
    }

    // ---- handoff only (I1, I2) ------------------------------------------------------------------------------------

    /// Lineage of a key named for transfer (P5 reads it before anything is exported).
    pub fn job_lineage(&self, job_hash: &[u8; 32], epoch: u64) -> Option<&BTreeSet<Vec<u8>>> {
        self.jobs.get(&(*job_hash, epoch)).map(|k| &k.lineage)
    }

    /// I1: `K_job,e` leaves only for a checked peer, and never when exposed (P5).
    pub fn export_job_key(&self, _p: &PeerChecked, job_hash: &[u8; 32], epoch: u64) -> Option<Exported> {
        let k = self.jobs.get(&(*job_hash, epoch)).filter(|k| !k.exposed)?;
        Some(Exported { secret: SecretBytes::from_vec(k.key.secret().expose().to_vec()), lineage: k.lineage.clone() })
    }

    /// I1: the identity (`K_id`, `K_chain`, state key) leaves only for a checked peer, and never when exposed (P5).
    pub fn export_identity(&self, _p: &PeerChecked, card: &str) -> Option<ExportedIdentity> {
        let i = self.identities.get(card).filter(|i| !i.exposed && !i.pending_handoff)?;
        Some(ExportedIdentity {
            id_seed: SecretBytes::from_vec(i.id.seed().expose().to_vec()),
            chain_secret: i.chain.secret(),
            state_key: SecretBytes::from_vec(i.state_key.expose().to_vec()),
            state_version: i.state_version,
            state_hash: i.state_hash.clone(),
            lineage: i.lineage.clone(),
        })
    }

    /// I1: `k_T` leaves only for a checked peer, and never when exposed (P5).
    pub fn export_template_key(&self, _p: &PeerChecked, template: &str) -> Option<(Exported, u64)> {
        let t = self.templates.get(template).filter(|t| !t.exposed && !t.pending)?;
        Some((Exported { secret: SecretBytes::from_vec(t.key.expose().to_vec()), lineage: t.lineage.clone() }, t.generation))
    }

    /// I2: installs a received `K_job,e`. Needs the opened payload and this enclave's own admission of the program.
    pub fn install_job_key(&mut self, _p: &PayloadOpened, _admitted: &Admitted, job_hash: [u8; 32], epoch: u64, secret: SecretBytes, lineage: BTreeSet<Vec<u8>>) -> Result<&XWingKey, &'static str> {
        if self.jobs.contains_key(&(job_hash, epoch)) {
            return Err("JOB_KEY_EXISTS");
        }
        let key = XWingKey::from_secret(secret).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
        let mut lineage = lineage;
        lineage.insert(self.pcr0.clone());
        Ok(&self.jobs.entry((job_hash, epoch)).or_insert(JobKey { key, lineage, exposed: false }).key)
    }

    /// I2: installs a received identity, unusable until its handoff record (identity-log `seq`) is anchored.
    pub fn install_identity(&mut self, _p: &PayloadOpened, card: &str, x: ExportedIdentity) -> Result<(), &'static str> {
        if self.identities.contains_key(card) {
            return Err("HANDOFF_ALREADY_HELD");
        }
        let id = MlDsaKey::from_seed(x.id_seed).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
        if formats::card_pointer(id.public_key()) != card {
            return Err("HANDOFF_PAYLOAD_INVALID");
        }
        let chain = ChainKey::from_secret(&x.chain_secret).map_err(|_| "HANDOFF_PAYLOAD_INVALID")?;
        let mut lineage = x.lineage;
        lineage.insert(self.pcr0.clone());
        self.identities.insert(
            card.into(),
            Identity { card: card.into(), id, chain, lineage, exposed: false, state_key: x.state_key, state_version: x.state_version, state_hash: x.state_hash, pending_handoff: true },
        );
        Ok(())
    }

    /// I2: installs a received template key.
    pub fn install_template_key(&mut self, _p: &PayloadOpened, template: &str, generation: u64, key: SecretBytes, lineage: BTreeSet<Vec<u8>>) -> Result<(), &'static str> {
        if self.templates.get(template).is_some_and(|t| t.generation >= generation) {
            return Err("HANDOFF_ALREADY_HELD");
        }
        let mut lineage = lineage;
        lineage.insert(self.pcr0.clone());
        self.templates.insert(template.into(), TemplateKey { template: template.into(), generation, key, lineage, exposed: false, pending: true });
        Ok(())
    }

    /// Runtime §4 key-lineage check against a newly verified accepted-runtime list.
    pub fn apply_retirements(&mut self, vulnerable: &[Vec<u8>]) -> Vec<Exposed> {
        let mut out = vec![];
        for i in self.identities.values_mut() {
            if !i.exposed && hits(&i.lineage, vulnerable) {
                i.exposed = true;
                out.push(Exposed::Identity(i.card.clone()));
            }
        }
        for ((j, e), k) in self.jobs.iter_mut() {
            if !k.exposed && hits(&k.lineage, vulnerable) {
                k.exposed = true;
                out.push(Exposed::Job(*j, *e));
            }
        }
        for t in self.templates.values_mut() {
            if !t.exposed && hits(&t.lineage, vulnerable) {
                t.exposed = true;
                out.push(Exposed::Template(t.template.clone()));
            }
        }
        out
    }
}
