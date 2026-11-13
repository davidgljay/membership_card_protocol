//! Typed notary objects (protocol-objects.md §20–§34). Every struct rejects unknown fields (Q6);
//! absent optional fields are omitted, never `null`. Hashes and signatures are always taken over
//! the raw canonical bytes of the received object (`jcs::parse_canonical`), never over a
//! re-serialized struct; the structs are for reading fields once bytes are verified.
//!
//! Strings carry base64url, CIDs, card pointers and timestamps as received; the validators in
//! `b64u` and `formats` check them where the checks of lifecycle Appendix A/B call for it.
//! `CardDocument`, `LogEntry` and `SubCardDocument` are not defined here (notary-cards, step 5.3a).
use serde::{Deserialize, Serialize};
use serde_json::Value;

macro_rules! obj {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* pub $f:ident : $t:ty),* $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name { $($(#[$fm])* pub $f: $t),* }
    };
}

fn is_none<T>(o: &Option<T>) -> bool { o.is_none() }

obj! { pub struct SignatureEntry { pub public_key: String, pub signature: String } }
obj! { pub struct ReplicaSetEntry { pub instances: u32, pub notary_card: String } }
obj! { pub struct Transport { pub key_config_url: String, pub relay_target_id: String } }
obj! { pub struct ChainRef { pub block_hash: String, pub block_number: u64 } }
obj! { pub struct EvidenceItem { pub bytes: String, pub cid: String } }
obj! { pub struct ChainState { pub block_hash: String, pub block_number: u64, pub block_timestamp: String, pub state_root: String } }
obj! { pub struct Cosignature { pub attestation: String, pub instance_signature: SignatureEntry } }
obj! { pub struct ChainHead { pub block_hash: String, pub block_number: u64 } }
obj! { pub struct PeerJob { pub epoch: u64, pub job_hash: String, pub state_version: u64 } }
obj! { pub struct ListVersions { pub accepted_runtimes: u64, pub program_allowlist: u64 } }
obj! { pub struct PropagationEntry { pub card_address: String, pub log_entry_cid: String, pub prev_log_cid: String } }
obj! { pub struct ListSignature { pub key_index: u32, pub signature: String } }

obj! {
    /// §20 genesis request
    pub struct GenesisRequest {
        pub chain_pubkey: String, pub id_pubkey: String, pub nonce: String, pub operator_card: String,
        pub operator_host_pubkey: String, pub platform: String, pub policy_id: String, pub requested_at: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §21 NotaryJob
    pub struct NotaryJob {
        #[serde(default, skip_serializing_if = "is_none")] pub closes_at: Option<String>,
        pub created_at: String,
        #[serde(default, skip_serializing_if = "is_none")] pub ends_at: Option<String>,
        #[serde(default, skip_serializing_if = "is_none")] pub key_period: Option<String>,
        pub kem: String, pub min_live: u32, pub nonce: String, pub opens_at: String, pub parameters: Value,
        pub policy_id: String, pub policy_state_cid: String, pub replica_set: Vec<ReplicaSetEntry>,
        pub requester_card: String, pub requester_pubkey: String, pub requester_signature: SignatureEntry,
        #[serde(default, skip_serializing_if = "is_none")] pub requester_text: Option<String>,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §22 JobAnnouncement
    pub struct JobAnnouncement {
        pub attestations: Vec<String>, pub epoch: u64,
        #[serde(default, skip_serializing_if = "is_none")] pub epoch_reason: Option<String>,
        pub issued_at: String, pub job: NotaryJob, pub job_public_key: String, pub notary_signature: SignatureEntry,
        #[serde(default, skip_serializing_if = "is_none")] pub prev_announcement: Option<String>,
        pub transport: Transport,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §23 NotaryInput
    pub struct NotaryInput {
        pub chain_ref: ChainRef, pub contributor_card: String, pub contributor_card_pubkey: String,
        pub contributor_signature: SignatureEntry, pub evidence: Vec<EvidenceItem>, pub job_hash: String,
        pub payload: Value, pub revision: u64, pub signed_at: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §23.1 NotaryCountersign
    pub struct NotaryCountersign {
        pub holder_signature: String, pub job_hash: String, pub offer_hash: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §24 SealedInput
    pub struct SealedInput {
        pub ct: String, pub enc: String, pub epoch: u64, pub job_hash: String, pub kem: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §25 HostReceipt
    pub struct HostReceipt {
        pub epoch: u64, pub host_signature: SignatureEntry, pub input_hash: String, pub job_hash: String,
        pub notary_card: String, pub received_at: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §26 ValidationReceipt
    pub struct ValidationReceipt {
        pub acks: u32,
        #[serde(default, skip_serializing_if = "is_none")] pub derived_offer: Option<Value>,
        pub epoch: u64, pub input_hash: String, pub instance: String, pub job_hash: String,
        pub notary_signature: SignatureEntry, pub processed_at: String,
        #[serde(default, skip_serializing_if = "is_none")] pub reject_reason: Option<String>,
        pub revision: u64, pub status: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §27 Notarization
    pub struct Notarization {
        pub accepted: u64, pub attestation: String, pub chain_state: ChainState, pub close_quorum: u32,
        pub closed_at: String, pub cosignatures: Vec<Cosignature>, pub counted_inputs: String,
        pub dropped_after_acceptance: u64, pub final_epoch: u64, pub input_commitment: String, pub job_cid: String,
        pub job_hash: String, pub job_log_head: String, pub notary_card: String, pub notary_signature: SignatureEntry,
        pub output: Value, pub output_hash: String, pub platform: String, pub policy_id: String,
        pub policy_state_cid: String, pub program_cid: String, pub rejected: u64, pub suppressed: bool,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §28 JobLogRecord (`type` is `notary.job_log.v1` or `notary.identity_log.v1`)
    pub struct JobLogRecord {
        pub at: String, pub body: Value, pub instance: String, pub instance_signature: SignatureEntry,
        pub job_hash: String, pub kind: String, pub notary_signature: SignatureEntry,
        #[serde(default, skip_serializing_if = "is_none")] pub prev: Option<String>,
        pub seq: u64,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §29 HandoffRecord
    pub struct HandoffRecord {
        pub at: String,
        #[serde(default, skip_serializing_if = "is_none")] pub epoch: Option<u64>,
        pub from_attestation: String, pub from_instance: String,
        #[serde(default, skip_serializing_if = "is_none")] pub job_hash: Option<String>,
        #[serde(default, skip_serializing_if = "is_none")] pub key_generation: Option<u64>,
        pub pcr0_from: String, pub pcr0_to: String, pub receiver_signature: SignatureEntry, pub scope: String,
        pub state_hash: String, pub state_version: u64, pub to_attestation: String, pub to_instance: String,
        pub to_notary_card: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §30 Heartbeat
    pub struct Heartbeat {
        pub chain_head: ChainHead,
        #[serde(default, skip_serializing_if = "is_none")] pub identity_state_version: Option<u64>,
        pub instance: String, pub instance_signature: SignatureEntry, pub jobs: Vec<PeerJob>,
        pub list_versions: ListVersions, pub peers_seen: Vec<String>, pub seq: u64,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §31 StateBlobHeader
    pub struct StateBlobHeader {
        pub at: String, pub body_cid: String, pub body_hash: String, pub notary_card: String,
        pub notary_signature: SignatureEntry,
        #[serde(default, skip_serializing_if = "is_none")] pub prev_hash: Option<String>,
        #[serde(rename = "type")] pub type_: String,
        pub version: u64,
    }
}

obj! {
    /// §32 PropagationBatch
    pub struct PropagationBatch {
        pub batch_seq: u64, pub chain_payload: Value, pub chain_signature: String,
        pub entries: Vec<PropagationEntry>, pub notary_card: String, pub policy_id: String,
        pub release_not_before: String,
        #[serde(rename = "type")] pub type_: String,
    }
}

obj! {
    /// §34 list_approval
    pub struct ListApproval {
        pub governance_version: u32, pub kind: String, pub list: String, pub list_card: String, pub list_hash: String,
        pub list_version: u64,
        #[serde(default, skip_serializing_if = "is_none")] pub prev_list_hash: Option<String>,
        pub signatures: Vec<ListSignature>,
        /// Program allowlist only; absent means "allowed" (§34, 2026-11-12).
        #[serde(default, skip_serializing_if = "is_none")] pub single_operator_quorums: Option<String>,
        #[serde(rename = "type")] pub type_: String,
    }
}

/// The `type` strings of the versioned objects above, for domain-separation checks.
pub mod types {
    pub const GENESIS_REQUEST: &str = "notary.genesis_request.v1";
    pub const JOB: &str = "notary.job.v1";
    pub const ANNOUNCEMENT: &str = "notary.announcement.v1";
    pub const INPUT: &str = "notary.input.v1";
    pub const COUNTERSIGN: &str = "notary.countersign.v1";
    pub const SEALED_INPUT: &str = "notary.sealed_input.v1";
    pub const HOST_RECEIPT: &str = "notary.host_receipt.v1";
    pub const VALIDATION_RECEIPT: &str = "notary.validation_receipt.v1";
    pub const NOTARIZATION: &str = "notary.notarization.v1";
    pub const JOB_LOG: &str = "notary.job_log.v1";
    pub const IDENTITY_LOG: &str = "notary.identity_log.v1";
    pub const HANDOFF: &str = "notary.handoff.v1";
    pub const HEARTBEAT: &str = "notary.heartbeat.v1";
    pub const STATE_BLOB: &str = "notary.state_blob.v1";
    pub const PROPAGATION_BATCH: &str = "notary.propagation_batch.v1";
    pub const LIST_APPROVAL: &str = "notary_list_approval";
}

/// Deserialize a typed notary object from a JSON value, mapping serde's strictness failures to the
/// same codes the TypeScript field table raises (`UNKNOWN_FIELD`, `MISSING_FIELD`), and checking `type`.
pub fn from_value<T: serde::de::DeserializeOwned>(v: &Value, expected_type: &str) -> crate::error::Result<T> {
    use crate::error::NotaryError;
    match v.get("type").and_then(Value::as_str) {
        Some(t) if t == expected_type => {}
        _ => return Err(NotaryError::new("TYPE_MISMATCH", format!("expected {expected_type}"))),
    }
    serde_json::from_value(v.clone()).map_err(|e| {
        let m = e.to_string();
        if m.contains("unknown field") {
            NotaryError::new("UNKNOWN_FIELD", m)
        } else if m.contains("missing field") {
            NotaryError::new("MISSING_FIELD", m)
        } else {
            NotaryError::new("OBJECT_INVALID", m)
        }
    })
}
