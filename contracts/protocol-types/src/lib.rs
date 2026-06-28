//! # protocol-types
//!
//! Pure Rust (no_std) shared type library for the Card Protocol registry contracts.
//!
//! This crate defines all structs, enums, and error codes shared across the three
//! contract crates (storage-contract, logic-contract, verifier-module). It has no
//! Stylus SDK dependency and can be used in tests, scripts, and off-chain tooling
//! in addition to the WASM contracts.
//!
//! ## Error Code Reference (§8 of registry_contract.md v0.6)
//!
//! | Code | Name | Trigger |
//! |------|------|---------|
//! | E-01 | CARD_ALREADY_EXISTS | RegisterCard for an existing card address |
//! | E-02 | CARD_NOT_FOUND | Operation targets an unregistered address |
//! | E-03 | UNRECOGNIZED_POLICY | policy_address not in PolicyAuthorizerKeys |
//! | E-04 | PRESS_NOT_AUTHORIZED | No PressAuthorizations entry for (policy, press) |
//! | E-05 | PRESS_REVOKED | Entry exists but active == false |
//! | E-06 | INVALID_PRESS_SIGNATURE | secp256r1 / RIP-7212 verification failure |
//! | E-07 | SEQUENCE_MISMATCH | Press payload sequence != next_sequence |
//! | E-07G | NONCE_REUSED | Governance payload nonce already used |
//! | E-08 | STALE_PREV_CID | prev_log_cid does not match stored head |
//! | E-09 | POLICY_ALREADY_REGISTERED | RegisterPolicy for an existing policy |
//! | E-10 | SUB_CARD_NOT_FOUND | DeregisterSubCard for unknown address |
//! | E-11 | SUB_CARD_ALREADY_ACTIVE | RegisterSubCard for already-active sub-card |
//! | E-12 | OFFER_EXPIRED | ClaimOpenOffer after expires_at |
//! | E-13 | OFFER_AT_CAPACITY | ClaimOpenOffer when use_count >= max_acceptances |
//! | E-14 | INVALID_ISSUER_SIGNATURE | Press-side only; not an on-chain revert |
//! | E-15 | GOVERNANCE_VERSION_MISMATCH | Payload version != stored keyset version |
//! | E-16 | INVALID_GOVERNANCE_SIGNATURE | Governance sig fails RIP-7212 verification |
//! | E-17 | DUPLICATE_SIGNER | Two governance sigs from the same key |
//! | E-18 | INSUFFICIENT_QUORUM | Valid distinct sigs < quorum threshold |
//! | E-19 | QUORUM_TOO_LOW | RotateGovernanceKeys: new_quorum <= len/2 |
//! | E-20 | KEYSET_TOO_SMALL | RotateGovernanceKeys: fewer than 3 keys |
//! | E-21 | LOG_CID_TOO_LONG | CID bytes exceed 64-byte maximum |
//! | E-22 | INVALID_MASTER_SIGNATURE | Press-side only; not an on-chain revert |
//! | E-23 | KEY_SCHEME_ALREADY_UPGRADED | RotateOnChainKeyScheme for press already on ML-DSA-44 |
//! | E-24 | SCHEME_UPGRADE_NOT_AVAILABLE | RotateOnChainKeyScheme in Phase 1 |
//! | E-25 | ROTATION_PAYLOAD_EXPIRED | deadline_block has passed |
//! | E-26 | MLDSA44_KEY_HASH_MISMATCH | new_mldsa44_pubkey does not hash to stored hash |
//! | E-27 | FORWARD_ALREADY_SET | RegisterAddressForward: old_address.forward_to non-zero |
//! | E-28 | FORWARD_ON_REVOKED_CARD | Press-side only; not an on-chain revert |
//! | E-29 | CALLER_NOT_LOGIC_CONTRACT | Storage setter called by non-logic address |
//! | E-30 | UPGRADE_ALREADY_PENDING | ProposeLogicUpgrade while proposal pending |
//! | E-31 | UPGRADE_TIMELOCK_NOT_ELAPSED | ConfirmLogicUpgrade before 7 days |
//! | E-32 | UPGRADE_ADDRESS_MISMATCH | Confirmation address != pending address |
//! | E-33 | BATCH_SIZE_INVALID | BatchUpdateCardHeads: empty or > 100 items |
//! | E-34 | BATCH_ITEM_INVALID | Duplicate card or cross-policy item in batch |
//! | E-37 | DOMAIN_NOT_FOUND | Operation targets a domain with exists == false |
//! | E-38 | DOMAIN_ALREADY_REGISTERED | RegisterDomain when domain already has active admin |
//! | E-39 | DOMAIN_SUSPENDED | SetPolicyAddress on suspended domain |
//! | E-40 | CARD_NOT_DNS_GOVERNANCE_POLICY | Card not issued under DnsGovernancePolicyAddress |
//! | E-41 | POLICY_CARD_NOT_FOUND | policy_card_address does not exist in CardEntries |
//! | E-42 | DOMAIN_PATH_ENTRY_NOT_FOUND | RemovePolicyAddress on zero entry |
//! | E-43 | INVALID_DNS_PARAMETER | Bad domain string length or inconsistent fraud_risk params |
//! | E-44 | DOMAIN_PATH_SCOPE_VIOLATION | Press-side only; dns_path_scope mismatch |
//! | E-45 | SUB_CARD_NOT_DOMAIN_ADMIN_SUBCARD | sub_card_address not a direct sub-card of admin |
//! | E-46 | ADMIN_CARD_MISMATCH | admin_card_address != DomainRegistrations[domain].admin_card_address |
//! | E-47 | INVALID_ADMIN_CARD_SIGNATURE | RegisterSubCard admin secp256r1 check failed |

#![no_std]

/// Maximum allowed length in bytes for a log head CID or sub-card doc CID.
/// Accommodates SHA2-256 (34 bytes), SHA3-256 (34 bytes), and BLAKE3 (34 bytes) CIDs.
/// The contract does not validate CID format; this limit is enforced at write time.
pub const MAX_CID_LEN: usize = 64;

/// Maximum number of items in a BatchUpdateCardHeads call (§4.15).
pub const MAX_BATCH_SIZE: usize = 100;

/// Maximum number of paths in a ClearDomainEntries call (§4.21).
pub const MAX_CLEAR_ENTRIES_BATCH: usize = 500;

/// Maximum length in bytes of a DNS path string (§4.19).
pub const MAX_DNS_PATH_LEN: usize = 512;

/// Maximum length in bytes of a domain string (RFC 1035 §2.3.4).
pub const MAX_DOMAIN_LEN: usize = 255;

/// Unix seconds in 7 days — the logic upgrade timelock duration (§4.14).
pub const LOGIC_UPGRADE_TIMELOCK_SECS: u64 = 7 * 24 * 60 * 60;

/// Unix seconds in 48 hours — the verifier upgrade timelock duration (§6.3).
pub const VERIFIER_UPGRADE_TIMELOCK_SECS: u64 = 48 * 60 * 60;

/// Minimum number of keys required in a GovernanceKeyset after rotation (§4.10).
pub const MIN_GOVERNANCE_KEYS: usize = 3;

/// Maximum number of keys in a GovernanceKeyset (on-chain and off-chain representations).
/// The storage contract stores keys as a flat byte array (key_count * 64 bytes) with
/// this as the practical upper bound. The off-chain GovernanceKeyset struct uses a
/// fixed-size array of this length for no_std compatibility.
pub const MAX_GOVERNANCE_KEYS: usize = 50;

/// Governance body identifiers (§3.6).
///
/// Security note: These are stored as u8 values in storage. The discriminant
/// values are fixed and must not be changed — doing so would corrupt existing
/// storage mappings.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum GovernanceBodyId {
    /// Governs: RegisterPolicy, RotateAuthorizerKey, UpgradeLogic, UpgradeVerifier.
    RootPolicyBody = 0,
    /// Governs: AuthorizePress, RevokePress.
    PressRegistryBody = 1,
    /// Governs: RegisterDomain, DeregisterDomain, SetPolicyAddress (governance path),
    /// RemovePolicyAddress (governance path), ClearDomainEntries, FlagDomainFraudRisk,
    /// GovernanceSetPolicyAddress, SetDnsGovernancePolicyAddress.
    DnsGovernanceBody = 2,
}

impl GovernanceBodyId {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(GovernanceBodyId::RootPolicyBody),
            1 => Some(GovernanceBodyId::PressRegistryBody),
            2 => Some(GovernanceBodyId::DnsGovernanceBody),
            _ => None,
        }
    }

    pub fn to_u8(self) -> u8 {
        self as u8
    }
}

/// Key scheme identifier for press authorizations and governance keysets (§3.3, §3.6).
///
/// Phase 1 uses secp256r1 exclusively. Phase 2/3 enables ML-DSA-44 via
/// RotateOnChainKeyScheme (§4.11) once key_scheme_phase is advanced to >= 1.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum KeyScheme {
    /// secp256r1 (P-256) via RIP-7212 precompile. Phase 1 default.
    Secp256r1 = 0,
    /// ML-DSA-44 (Dilithium). Phase 3+ only.
    MlDsa44 = 1,
}

impl KeyScheme {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(KeyScheme::Secp256r1),
            1 => Some(KeyScheme::MlDsa44),
            _ => None,
        }
    }
}

/// Error codes for the Card Protocol registry (§8 of spec).
///
/// Each variant corresponds to a specific error defined in the spec.
/// The numeric values are the ABI selector discriminants emitted as
/// custom errors and must not be changed after deployment.
///
/// Security note for auditors: All error codes that are "press-side only"
/// (E-14, E-22, E-28) are NOT enforced on-chain. They document press behavior.
/// The storage contract enforces E-29 unconditionally in every setter.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContractError {
    // Card operation errors
    /// E-01: card_address already exists in CardEntries.
    CardAlreadyExists,
    /// E-02: card_address not found in CardEntries.
    CardNotFound,
    /// E-03: policy_address not in PolicyAuthorizerKeys.
    UnrecognizedPolicy,
    /// E-04: No PressAuthorizations entry for (policy, press).
    PressNotAuthorized,
    /// E-05: PressAuthorizations entry exists but active == false.
    PressRevoked,
    /// E-06: secp256r1 signature verification failed (RIP-7212).
    InvalidPressSignature,
    /// E-07: Press payload sequence != PressAuthEntry.next_sequence.
    SequenceMismatch,
    /// E-07G: Governance payload nonce has already been used.
    NonceReused,
    /// E-08: prev_log_cid does not match stored CardEntries[addr].log_head_cid.
    StalePrevCid,

    // Policy/press governance errors
    /// E-09: RegisterPolicy called for an already-registered policy address.
    PolicyAlreadyRegistered,
    /// E-10: DeregisterSubCard called for unknown sub_card_address.
    SubCardNotFound,
    /// E-11: RegisterSubCard called for an address already in SubCardRegistrations with active=true.
    SubCardAlreadyActive,
    /// E-12: ClaimOpenOffer called after the offer's expires_at timestamp.
    OfferExpired,
    /// E-13: ClaimOpenOffer called when use_count >= max_acceptances.
    OfferAtCapacity,
    // E-14 (INVALID_ISSUER_SIGNATURE) is press-side only — not enforced on-chain.

    // Governance errors
    /// E-15: governance_version in payload != GovernanceKeysets[body_id].version.
    GovernanceVersionMismatch,
    /// E-16: A governance signature fails RIP-7212 secp256r1 verification.
    InvalidGovernanceSignature,
    /// E-17: Two governance signatures from the same key in the keyset.
    DuplicateSigner,
    /// E-18: Valid distinct governance signatures < quorum threshold.
    InsufficientQuorum,
    /// E-19: RotateGovernanceKeys: new_quorum <= len(new_keys) / 2 (majority not satisfied).
    QuorumTooLow,
    /// E-20: RotateGovernanceKeys: len(new_keys) < MIN_GOVERNANCE_KEYS (3).
    KeysetTooSmall,
    /// E-21: CID bytes exceed MAX_CID_LEN (64 bytes).
    LogCidTooLong,
    // E-22 (INVALID_MASTER_SIGNATURE) is press-side only — not enforced on-chain.

    // Key scheme rotation errors
    /// E-23: RotateOnChainKeyScheme called for a press already on ML-DSA-44.
    KeySchemeAlreadyUpgraded,
    /// E-24: RotateOnChainKeyScheme called while key_scheme_phase == 0 (Phase 1).
    SchemeUpgradeNotAvailable,
    /// E-25: RotateOnChainKeyScheme deadline_block has passed.
    RotationPayloadExpired,
    /// E-26: new_mldsa44_pubkey does not hash to the stored mldsa44_key_hash.
    MlDsa44KeyHashMismatch,

    // Address forward errors
    /// E-27: RegisterAddressForward: old_address.forward_to is already non-zero.
    ForwardAlreadySet,
    // E-28 (FORWARD_ON_REVOKED_CARD) is press-side only — not enforced on-chain.

    // Storage access control
    /// E-29: A storage setter was called by an address other than LogicContract.
    /// This is enforced by the storage contract, not the logic contract.
    CallerNotLogicContract,

    // Upgrade lifecycle errors
    /// E-30: ProposeLogicUpgrade called while a prior proposal is still pending.
    UpgradeAlreadyPending,
    /// E-31: ConfirmLogicUpgrade called before 7 days have elapsed.
    UpgradeTimelockNotElapsed,
    /// E-32: proposed_logic_address does not match PendingLogicUpgrade.proposed_address.
    UpgradeAddressMismatch,

    // Batch operation errors
    /// E-33: BatchUpdateCardHeads called with 0 items or > MAX_BATCH_SIZE (100) items.
    BatchSizeInvalid,
    /// E-34: Batch item failed: duplicate card_address or cross-policy card.
    BatchItemInvalid,

    // DNS operation errors (§8, E-37–E-47)
    /// E-37: Domain not found in DomainRegistrations (exists == false).
    DomainNotFound,
    /// E-38: RegisterDomain for a domain that already has a non-zero admin_card_address.
    DomainAlreadyRegistered,
    /// E-39: SetPolicyAddress on a suspended domain (fraud_risk == 2, active suspension).
    DomainSuspended,
    /// E-40: Card not issued under DnsGovernancePolicyAddress, or DnsGovernancePolicyAddress == 0.
    CardNotDnsGovernancePolicy,
    /// E-41: policy_card_address does not exist in CardEntries.
    PolicyCardNotFound,
    /// E-42: RemovePolicyAddress on an entry that is already zero.
    DomainPathEntryNotFound,
    /// E-43: Bad domain string length or inconsistent fraud_risk/suspension_expires_at params.
    InvalidDnsParameter,
    // E-44 (DOMAIN_PATH_SCOPE_VIOLATION) is press-side only — not enforced on-chain.
    /// E-45: sub_card_address is not a registered direct sub-card of admin_card_address.
    SubCardNotDomainAdminSubcard,
    /// E-46: admin_card_address does not match DomainRegistrations[domain].admin_card_address.
    AdminCardMismatch,
    /// E-47: RegisterSubCard admin secp256r1 check failed (missing, mismatched, or invalid sig).
    InvalidAdminCardSignature,

    // Internal errors (not in spec, used for implementation-specific cases)
    /// Payload JSON is malformed or missing required fields.
    InvalidPayload,
    /// New logic address is zero or same as current.
    InvalidUpgradeAddress,
    /// Pending upgrade proposal does not exist.
    NoUpgradePending,
    /// Governance sub-card address is zero.
    InvalidAddress,
    /// registration_log_head does not match master card's current log head.
    StaleRegistrationLogHead,
}

/// Trait that future verifier modules must implement.
///
/// In Phase 1, the secp256r1 verifier module implements this by delegating
/// to the RIP-7212 precompile. In Phase 3, an ML-DSA-44 verifier module
/// would implement this using the new key scheme.
///
/// This trait is defined here so it can be referenced in documentation and
/// tests without importing the Stylus SDK. The actual cross-contract call
/// pattern is implemented via `sol_interface!` in the logic contract.
pub trait IVerifier {
    /// Verify a secp256r1 (P-256) signature.
    ///
    /// # Arguments
    /// * `message_hash` — keccak256 of the signed payload (32 bytes)
    /// * `signature`    — r||s concatenated (64 bytes, NOT DER-encoded)
    /// * `public_key`   — uncompressed x||y (64 bytes, no 0x04 prefix)
    ///
    /// # Returns
    /// `true` if the signature is valid, `false` otherwise.
    /// Does NOT revert on invalid signatures — callers convert `false` to a revert.
    fn verify(&self, message_hash: [u8; 32], signature: [u8; 64], public_key: [u8; 64]) -> bool;
}

// ─── Off-chain type definitions (for documentation and test tooling) ──────────
//
// The following types mirror what is stored in Stylus storage but are expressed
// as plain Rust structs for use in tests and off-chain tooling. The actual
// on-chain storage uses Stylus SDK storage types (StorageAddress, StorageU64,
// StorageBytes, StorageMap, etc.).

/// Off-chain representation of a CardEntry (§3.1).
/// Used in tests and scripts. On-chain storage uses Stylus storage types.
#[derive(Clone, Debug)]
pub struct CardEntry {
    /// Current IPFS log head CID. Max 64 bytes.
    pub log_head_cid: [u8; MAX_CID_LEN],
    pub log_head_cid_len: usize,
    /// Policy card registry address. Immutable after creation.
    pub policy_address: [u8; 32],
    /// Press sub-card address that last wrote to this card.
    pub last_press_address: [u8; 32],
    /// Successor card address (non-zero means address has been forwarded). Immutable once set.
    pub forward_to: [u8; 32],
    /// Write-once-true: once true, cannot be set to false.
    pub exists: bool,
}

/// Off-chain representation of a PressAuthEntry (§3.3).
#[derive(Clone, Debug)]
pub struct PressAuthEntry {
    /// secp256r1 public key (x||y, 64 bytes). Verified via RIP-7212 on writes.
    pub press_public_key: [u8; 64],
    /// keccak256 of the ML-DSA-44 public key (1312 bytes). Stored for Phase 2 upgrade path.
    pub mldsa44_key_hash: [u8; 32],
    /// 0 = secp256r1 (Phase 1), 1 = ML-DSA-44 (Phase 3+).
    pub key_scheme: u8,
    /// True = press may write; false = revoked.
    pub active: bool,
    /// Monotonically incrementing counter for replay prevention.
    pub next_sequence: u64,
    /// Unix timestamp of most recent AuthorizePress call.
    pub authorized_at: u64,
    /// Unix timestamp of RevokePress; 0 if never revoked.
    pub revoked_at: u64,
}

/// Off-chain representation of a SubCardEntry (§3.4).
#[derive(Clone, Debug)]
pub struct SubCardEntry {
    /// Registry address of the master card.
    pub master_card_address: [u8; 32],
    /// Log head CID of master card at registration time (scope check).
    pub registration_log_head: [u8; MAX_CID_LEN],
    pub registration_log_head_len: usize,
    /// CID of the SubCardDocument on IPFS. Max 64 bytes.
    pub sub_card_doc_cid: [u8; MAX_CID_LEN],
    pub sub_card_doc_cid_len: usize,
    /// True until DeregisterSubCard is called.
    pub active: bool,
    /// Unix timestamp of registration.
    pub registered_at: u64,
    /// Unix timestamp of deregistration; 0 if still active. Write-once-non-zero.
    pub deregistered_at: u64,
}

/// Off-chain representation of a GovernanceKeyset (§3.6).
///
/// Security note: `quorum` must always satisfy `quorum > keys.len() / 2`.
/// This is enforced by RotateGovernanceKeys but NOT by the storage contract.
/// The storage contract stores whatever the logic contract writes.
/// After a logic upgrade, the new logic must continue to enforce this.
#[derive(Clone, Debug)]
pub struct GovernanceKeyset {
    /// Active secp256r1 public keys (64 bytes each). Minimum 3 after first rotation.
    pub keys: [[u8; 64]; MAX_GOVERNANCE_KEYS], // Fixed-size array for no_std; actual on-chain uses dynamic storage
    pub key_count: usize,
    /// Minimum number of signatures required from keys[].
    pub quorum: u8,
    /// Incremented on every RotateGovernanceKeys. Included in signed payloads.
    pub version: u32,
    /// 0 = secp256r1, 1 = ML-DSA-44.
    pub key_scheme: u8,
}

// Manual Default impls required because derive(Default) only covers arrays up to [T; 32].
impl Default for CardEntry {
    fn default() -> Self {
        Self {
            log_head_cid: [0u8; MAX_CID_LEN],
            log_head_cid_len: 0,
            policy_address: [0u8; 32],
            last_press_address: [0u8; 32],
            forward_to: [0u8; 32],
            exists: false,
        }
    }
}

impl Default for PressAuthEntry {
    fn default() -> Self {
        Self {
            press_public_key: [0u8; 64],
            mldsa44_key_hash: [0u8; 32],
            key_scheme: 0,
            active: false,
            next_sequence: 0,
            authorized_at: 0,
            revoked_at: 0,
        }
    }
}

impl Default for SubCardEntry {
    fn default() -> Self {
        Self {
            master_card_address: [0u8; 32],
            registration_log_head: [0u8; MAX_CID_LEN],
            registration_log_head_len: 0,
            sub_card_doc_cid: [0u8; MAX_CID_LEN],
            sub_card_doc_cid_len: 0,
            active: false,
            registered_at: 0,
            deregistered_at: 0,
        }
    }
}

impl Default for GovernanceKeyset {
    fn default() -> Self {
        Self {
            keys: [[0u8; 64]; MAX_GOVERNANCE_KEYS],
            key_count: 0,
            quorum: 0,
            version: 0,
            key_scheme: 0,
        }
    }
}

/// Off-chain representation of a PendingUpgrade (§3.7).
#[derive(Clone, Debug, Default)]
pub struct PendingUpgrade {
    /// New logic contract address proposed. Zero means no proposal pending.
    pub proposed_address: [u8; 20],
    /// Block timestamp when proposal was submitted.
    pub proposed_at: u64,
    /// GovernanceKeysets[RootPolicyBody].version at proposal time.
    pub governance_version: u32,
    /// Replay-prevention nonce from proposal payload.
    pub nonce: [u8; 32],
}

/// Off-chain representation of a pending verifier upgrade.
#[derive(Clone, Debug, Default)]
pub struct PendingVerifierUpgrade {
    /// New verifier module address proposed. Zero means no proposal pending.
    pub proposed_address: [u8; 20],
    /// Block timestamp when proposal was submitted.
    pub proposed_at: u64,
    /// GovernanceKeysets[RootPolicyBody].version at proposal time.
    pub governance_version: u32,
    /// Replay-prevention nonce from proposal payload.
    pub nonce: [u8; 32],
}

/// Off-chain representation of a DomainEntry (§3.8).
/// Used in tests and scripts. On-chain storage uses Stylus storage types.
#[derive(Clone, Debug, Default)]
pub struct DomainEntry {
    /// Registry address of the current active domain admin card.
    pub admin_card_address: [u8; 32],
    /// Unix timestamp of most recent RegisterDomain call.
    pub registered_at: u64,
    /// 0 = normal, 1 = monitored, 2 = suspended.
    pub fraud_risk: u8,
    /// Unix timestamp after which suspension lapses; 0 if not suspended.
    pub suspension_expires_at: u64,
    /// Write-once-true. Once true, cannot be cleared.
    pub exists: bool,
}

/// A single item in a BatchUpdateCardHeads call (§4.15).
#[derive(Clone, Debug)]
pub struct UpdateItem {
    pub card_address: [u8; 32],
    pub prev_log_cid: [u8; MAX_CID_LEN],
    pub prev_log_cid_len: usize,
    pub new_log_cid: [u8; MAX_CID_LEN],
    pub new_log_cid_len: usize,
}

/// Minimal JSON field extractor for press and governance payloads.
///
/// The payload is canonical RFC 8785 JSON (UTF-8). This module provides
/// a zero-dependency parser to extract specific field values without
/// allocating or requiring `std`. It is intentionally minimal — only
/// extracts the fields the contract needs to validate.
///
/// Security note: This parser makes assumptions about the canonical form:
/// - Fields appear in lexicographic order (RFC 8785 requirement).
/// - No nested objects have the same field names as top-level fields.
/// - Numeric fields (sequence, governance_version) are bare integers.
/// - String fields are quoted JSON strings.
///
/// The `op` field check is a critical security invariant: verifying that
/// the `"op"` field matches the expected operation name prevents a press
/// from replaying a valid signature from one operation type in a different
/// operation. For example, a "register_card" payload cannot be accepted
/// as a valid "update_card_head" payload even if all other fields match.
pub mod payload_parser {
    /// Find a JSON field value as a raw byte slice within the payload.
    ///
    /// For string fields, returns the bytes inside the quotes.
    /// For numeric fields, returns the digits.
    ///
    /// Returns `None` if the field is not found.
    pub fn find_field<'a>(payload: &'a [u8], field_name: &[u8]) -> Option<&'a [u8]> {
        // Search for `"<field_name>":`
        let mut i = 0;
        while i + field_name.len() + 3 < payload.len() {
            if payload[i] == b'"' {
                let end = i + 1 + field_name.len();
                if end + 2 <= payload.len()
                    && &payload[i + 1..end] == field_name
                    && payload[end] == b'"'
                    && payload[end + 1] == b':'
                {
                    // Found the key; now find the value start
                    let mut val_start = end + 2;
                    // Skip whitespace (canonical JSON has none, but be safe)
                    while val_start < payload.len() && payload[val_start] == b' ' {
                        val_start += 1;
                    }
                    if val_start >= payload.len() {
                        return None;
                    }

                    if payload[val_start] == b'"' {
                        // String value — return inner bytes
                        val_start += 1;
                        let mut val_end = val_start;
                        while val_end < payload.len() && payload[val_end] != b'"' {
                            // Handle escaped quotes
                            if payload[val_end] == b'\\' {
                                val_end += 1; // skip escape char
                            }
                            val_end += 1;
                        }
                        return Some(&payload[val_start..val_end]);
                    } else {
                        // Numeric or other bare value — find end
                        let val_end_offset = payload[val_start..]
                            .iter()
                            .position(|&b| b == b',' || b == b'}' || b == b' ')
                            .unwrap_or(payload.len() - val_start);
                        return Some(&payload[val_start..val_start + val_end_offset]);
                    }
                }
                i += 1;
            } else {
                i += 1;
            }
        }
        None
    }

    /// Extract the `"sequence"` field as a u64.
    /// Returns `None` if the field is missing or malformed.
    pub fn extract_sequence(payload: &[u8]) -> Option<u64> {
        let bytes = find_field(payload, b"sequence")?;
        parse_u64(bytes)
    }

    /// Extract the `"op"` field as raw bytes.
    pub fn extract_op(payload: &[u8]) -> Option<&[u8]> {
        find_field(payload, b"op")
    }

    /// Extract the `"governance_version"` field as a u32.
    pub fn extract_governance_version(payload: &[u8]) -> Option<u32> {
        let bytes = find_field(payload, b"governance_version")?;
        parse_u64(bytes).map(|v| v as u32)
    }

    /// Extract the `"nonce"` field as bytes (base64url-encoded bytes32 in the payload).
    /// Returns the raw string bytes inside the quotes, NOT the decoded bytes.
    pub fn extract_nonce_bytes(payload: &[u8]) -> Option<&[u8]> {
        find_field(payload, b"nonce")
    }

    /// Extract the `"deadline_block"` field as a u64.
    pub fn extract_deadline_block(payload: &[u8]) -> Option<u64> {
        let bytes = find_field(payload, b"deadline_block")?;
        parse_u64(bytes)
    }

    /// Parse a decimal u64 from ASCII bytes.
    fn parse_u64(bytes: &[u8]) -> Option<u64> {
        if bytes.is_empty() {
            return None;
        }
        let mut val: u64 = 0;
        for &b in bytes {
            if b < b'0' || b > b'9' {
                return None;
            }
            val = val.checked_mul(10)?.checked_add((b - b'0') as u64)?;
        }
        Some(val)
    }

    /// Verify that the `"op"` field matches the expected operation name.
    ///
    /// Security invariant: Every write operation must call this check to prevent
    /// cross-operation replay attacks. A valid press signature on a "register_card"
    /// payload must NOT be accepted for an "update_card_head" operation.
    pub fn verify_op(payload: &[u8], expected_op: &[u8]) -> bool {
        match extract_op(payload) {
            Some(op) => op == expected_op,
            None => false,
        }
    }
}
