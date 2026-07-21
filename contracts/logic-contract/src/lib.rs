//! # Logic Contract
//!
//! Implements all write operations (§4), authorization checks (§6.1–6.2),
//! and event emission (§7) for the Card Protocol registry.
//!
//! ## Architecture role (§6.3)
//!
//! - **Upgradeable via 7-day timelock (UpgradeLogic).** When a new logic contract
//!   is confirmed, the storage contract's `LogicContract` address is updated and
//!   the old logic contract can no longer call any storage setter.
//! - **Delegates all storage reads/writes** to the storage contract via cross-contract
//!   calls using `sol_interface!`-generated wrappers.
//! - **Delegates all signature verification** to the verifier module.
//! - **Emits all events.** The storage contract emits no events.
//!
//! ## Storage in this contract
//!
//! The logic contract stores two things:
//! 1. `storage_contract`: address of the storage contract (immutable after construction).
//! 2. `verifier_module`: address of the current verifier module (updated via UpgradeVerifier).
//! 3. `pending_verifier_proposed_address` / `pending_verifier_proposed_at` / etc.:
//!    verifier upgrade proposal state (stored locally here, not in the storage contract).
//!
//! ## Module layout
//!
//! - `lib.rs`             — Entry point, contract struct, constructor, wiring.
//! - `card_ops.rs`        — RegisterCard, UpdateCardHead, ClaimOpenOffer, RegisterAddressForward,
//!                          BatchUpdateCardHeads.
//! - `subcard_ops.rs`     — RegisterSubCard, DeregisterSubCard.
//! - `governance_ops.rs`  — RegisterPolicy, DeregisterPolicy, AuthorizePress, RevokePress,
//!                          RotateAuthorizerKey, RotateGovernanceKeys.
//! - `upgrade_ops.rs`     — ProposeLogicUpgrade, ConfirmLogicUpgrade, CancelLogicUpgrade,
//!                          ProposeVerifierUpgrade, ConfirmVerifierUpgrade, CancelVerifierUpgrade.
//! - `key_scheme_ops.rs`  — RotateOnChainKeyScheme.
//! - `write_gate.rs`      — Card write gate (§6.1) and governance quorum verification (§6.2).

#![cfg_attr(not(feature = "export-abi"), no_std)]
#[macro_use]
extern crate alloc;

use alloc::vec::Vec;
#[allow(deprecated)]
pub use stylus_sdk::call::MethodError;
use stylus_sdk::{
    alloy_primitives::{Address, B256},
    block,
    evm,
    msg,
    prelude::*,
    storage::{StorageAddress, StorageBool, StorageString, StorageU64, StorageU8, StorageU32, StorageFixedBytes},
};

pub mod write_gate;
pub mod card_ops;
pub mod subcard_ops;
pub mod governance_ops;
pub mod upgrade_ops;
pub mod key_scheme_ops;
pub mod dns_ops;

use write_gate::WriteGate;

// ─── Cross-contract interfaces (sol_interface!) ───────────────────────────────
//
// These macros generate Rust structs that wrap cross-contract calls to the
// storage contract and verifier module. The storage contract's ABI is expressed
// here; calls to it go via DELEGATECALL-equivalent cross-contract invocations.

sol_interface! {
    /// Interface to the storage contract.
    /// Function names must be camelCase to match the storage contract's Stylus ABI dispatch.
    /// Parameter types use uint8[] (not bytes) because Stylus SDK 0.8 maps Vec<u8> → uint8[].
    interface IStorage {
        // ── Getters ──────────────────────────────────────────────────────────
        function getCardEntry(bytes32 card_address)
            external view returns (uint8[], bytes32, bytes32, bytes32, bool);
        function cardExists(bytes32 card_address)
            external view returns (bool);
        function policyExists(bytes32 policy_address)
            external view returns (bool);
        function getPolicyAuthorizer(bytes32 policy_address)
            external view returns (uint8[]);
        function getPressAuthorization(bytes32 policy_address, bytes32 press_address)
            external view returns (uint8[], bytes32, uint8, bool, uint64, uint64, uint64);
        function isPressActive(bytes32 policy_address, bytes32 press_address)
            external view returns (bool);
        function getNextSequence(bytes32 policy_address, bytes32 press_address)
            external view returns (uint64);
        function getSubCardEntry(bytes32 sub_card_address)
            external view returns (bytes32, uint8[], uint8[], bool, uint64, uint64);
        function getOpenOfferCount(bytes32 offer_id)
            external view returns (uint64);
        function getGovernanceKeyset(uint8 body_id)
            external view returns (uint8[], uint8, uint8, uint32, uint8);
        function isNonceUsed(bytes32 nonce)
            external view returns (bool);
        function getLogicContract()
            external view returns (address);
        function getPendingLogicUpgrade()
            external view returns (address, uint64, uint32, bytes32);
        function getKeySchemePhase()
            external view returns (uint8);
        function getPolicyDeleteDisabled()
            external view returns (bool);

        // ── Setters ──────────────────────────────────────────────────────────
        function setCardEntry(
            bytes32 card_address,
            uint8[] log_head_cid,
            bytes32 policy_address,
            bytes32 last_press_address,
            bool exists
        ) external;
        function setForwardTo(bytes32 card_address, bytes32 new_forward_to) external;
        function updateCardHead(bytes32 card_address, uint8[] new_log_cid, bytes32 last_press_address) external;
        function setPressAuthEntry(
            bytes32 policy_address,
            bytes32 press_address,
            uint8[] press_public_key,
            bytes32 mldsa44_key_hash,
            uint8 key_scheme,
            bool active,
            uint64 next_sequence,
            uint64 authorized_at,
            uint64 revoked_at
        ) external;
        function incrementPressSequence(bytes32 policy_address, bytes32 press_address) external;
        function setSubCardEntry(
            bytes32 sub_card_address,
            bytes32 master_card_address,
            uint8[] registration_log_head,
            uint8[] sub_card_doc_cid,
            bool active,
            uint64 registered_at,
            uint64 deregistered_at
        ) external;
        function setOpenOfferCount(bytes32 offer_id, uint64 count) external;
        function setPolicyAuthorizerKey(bytes32 policy_address, uint8[] authorizer_pubkey) external;
        function deletePolicyAuthorizerKey(bytes32 policy_address) external;
        function setGovernanceKeyset(
            uint8 body_id,
            uint8[] keys_flat,
            uint8 key_count,
            uint8 quorum,
            uint32 version,
            uint8 key_scheme
        ) external;
        function markNonceUsed(bytes32 nonce) external;
        function setLogicContract(address new_logic_address) external;
        function setPendingLogicUpgrade(
            address proposed_address,
            uint64 proposed_at,
            uint32 governance_version,
            bytes32 nonce
        ) external;
        function clearPendingLogicUpgrade() external;
        function setKeySchemePhase(uint8 phase) external;
        function disablePolicyDeletePermanently() external;

        // ── DNS resolution getters (§3.8–3.11) ───────────────────────────────
        function getDomainEntry(bytes32 domain_hash)
            external view returns (bytes32, uint64, uint8, uint64, bool);
        function getPolicyAddress(bytes32 key)
            external view returns (bytes32);
        function getDnsAdminCardKey(bytes32 card_address)
            external view returns (uint8[]);
        function getDnsGovernancePolicyAddress()
            external view returns (bytes32);

        // ── DNS resolution setters (§3.8–3.11) ───────────────────────────────
        function setDomainEntry(
            bytes32 domain_hash,
            bytes32 admin_card_address,
            uint64 registered_at,
            uint8 fraud_risk,
            uint64 suspension_expires_at,
            bool exists
        ) external;
        function setPolicyAddress(bytes32 key, bytes32 value) external;
        function setDnsAdminCardKey(bytes32 card_address, uint8[] key_bytes) external;
        function setDnsGovernancePolicyAddress(bytes32 addr) external;
    }

    /// Interface to the verifier module.
    /// verifySecp256R1 is the camelCase ABI name for the Rust fn verify_secp_256_r_1.
    interface IVerifierModule {
        function verifySecp256R1(
            bytes32 message_hash,
            uint8[] signature,
            uint8[] public_key
        ) external view returns (bool);
    }
}

// ─── Events (§7) ─────────────────────────────────────────────────────────────
//
// All events are emitted by this contract. The storage contract emits no events.
// Monitoring infrastructure that subscribes to events MUST update its subscription
// when a logic upgrade takes effect (listen for LogicUpgradeConfirmed).

stylus_sdk::alloy_sol_types::sol! {
    event CardRegistered(
        bytes32 indexed card_address,
        bytes32 indexed policy_address,
        bytes32 press_address,
        bytes initial_log_cid,
        uint64 timestamp
    );

    event CardHeadUpdated(
        bytes32 indexed card_address,
        bytes prev_log_cid,
        bytes new_log_cid,
        bytes32 press_address,
        uint64 timestamp
    );

    event SubCardRegistered(
        bytes32 indexed sub_card_address,
        bytes32 indexed master_address,
        bytes sub_card_doc_cid,
        uint64 timestamp
    );

    event SubCardDeregistered(
        bytes32 indexed sub_card_address,
        bytes32 master_address,
        uint64 timestamp
    );

    event OpenOfferClaimed(
        bytes32 indexed offer_id,
        bytes32 indexed card_address,
        uint64 use_count,
        uint64 timestamp
    );

    event PolicyRegistered(
        bytes32 indexed policy_address,
        uint64 timestamp
    );

    event PolicyDeregistered(
        bytes32 indexed policy_address,
        uint64 timestamp
    );

    event PressAuthorized(
        bytes32 indexed policy_address,
        bytes32 indexed press_address,
        uint64 timestamp
    );

    event PressRevoked(
        bytes32 indexed policy_address,
        bytes32 indexed press_address,
        uint64 timestamp
    );

    event AuthorizerKeyRotated(
        bytes32 indexed policy_address,
        uint64 timestamp
    );

    event GovernanceKeysRotated(
        uint8 body_id,
        uint8 new_quorum,
        uint8 key_count,
        uint32 version,
        uint64 timestamp
    );

    event AddressTransition(
        bytes32 indexed old_address,
        bytes32 indexed new_address,
        uint64 timestamp
    );

    event LogicUpgradeProposed(
        address indexed proposed_address,
        uint64 proposed_at,
        uint64 timelock_expires
    );

    event LogicUpgradeConfirmed(
        address indexed new_logic_address,
        uint64 confirmed_at
    );

    event LogicUpgradeCancelled(
        address indexed cancelled_address,
        uint64 cancelled_at
    );

    event VerifierUpgradeProposed(
        address indexed proposed_address,
        uint64 proposed_at,
        uint64 timelock_expires
    );

    event VerifierUpgradeConfirmed(
        address indexed new_verifier_address,
        uint64 confirmed_at
    );

    event VerifierUpgradeCancelled(
        address indexed cancelled_address,
        uint64 cancelled_at
    );

    event OnChainKeySchemeRotated(
        bytes32 indexed policy_address,
        bytes32 indexed press_address,
        bytes new_mldsa44_pubkey
    );

    event PolicyDeletePermanentlyDisabled(
        uint64 timestamp
    );

    // ── DNS resolution events (§7) ────────────────────────────────────────────

    event DomainRegistered(
        bytes domain,
        bytes32 indexed admin_card_address,
        uint64 timestamp
    );

    event DomainDeregistered(
        bytes domain,
        uint64 timestamp
    );

    event PolicyAddressSet(
        bytes domain,
        bytes path,
        bytes32 indexed policy_card_address,
        bytes32 admin_card_address,
        bytes32 sub_card_address,
        bytes32 press_address,
        uint64 timestamp
    );

    event PolicyAddressRemoved(
        bytes domain,
        bytes path,
        uint64 timestamp
    );

    event DomainEntriesCleared(
        bytes domain,
        uint32 paths_cleared,
        uint64 timestamp
    );

    event DomainFraudRiskUpdated(
        bytes domain,
        uint8 fraud_risk,
        uint64 suspension_expires_at,
        uint64 timestamp
    );

    event PolicyAddressGovernanceSet(
        bytes domain,
        bytes path,
        bytes32 policy_card_address,
        bytes32 old_policy_card_address,
        uint64 timestamp
    );

    event DnsGovernancePolicyAddressUpdated(
        bytes32 indexed old_address,
        bytes32 indexed new_address,
        uint64 timestamp
    );

    event ProtocolVersionUpdated(
        string old_version,
        string new_version,
        uint64 timestamp
    );
}

// ─── Error selectors ─────────────────────────────────────────────────────────

pub mod errors {
    // Each constant is the ABI selector (first 4 bytes of keccak256 of the error signature).
    // These are used to build revert data.

    pub const CARD_ALREADY_EXISTS: &[u8] = b"CardAlreadyExists()";
    pub const CARD_NOT_FOUND: &[u8] = b"CardNotFound()";
    pub const UNRECOGNIZED_POLICY: &[u8] = b"UnrecognizedPolicy()";
    pub const PRESS_NOT_AUTHORIZED: &[u8] = b"PressNotAuthorized()";
    pub const PRESS_REVOKED: &[u8] = b"PressRevoked()";
    pub const INVALID_PRESS_SIGNATURE: &[u8] = b"InvalidPressSignature()";
    pub const SEQUENCE_MISMATCH: &[u8] = b"SequenceMismatch()";
    pub const NONCE_REUSED: &[u8] = b"NonceReused()";
    pub const STALE_PREV_CID: &[u8] = b"StalePrevCid()";
    pub const POLICY_ALREADY_REGISTERED: &[u8] = b"PolicyAlreadyRegistered()";
    pub const SUB_CARD_NOT_FOUND: &[u8] = b"SubCardNotFound()";
    pub const SUB_CARD_ALREADY_ACTIVE: &[u8] = b"SubCardAlreadyActive()";
    pub const OFFER_EXPIRED: &[u8] = b"OfferExpired()";
    pub const OFFER_AT_CAPACITY: &[u8] = b"OfferAtCapacity()";
    pub const GOVERNANCE_VERSION_MISMATCH: &[u8] = b"GovernanceVersionMismatch()";
    pub const INVALID_GOVERNANCE_SIGNATURE: &[u8] = b"InvalidGovernanceSignature()";
    pub const DUPLICATE_SIGNER: &[u8] = b"DuplicateSigner()";
    pub const INSUFFICIENT_QUORUM: &[u8] = b"InsufficientQuorum()";
    pub const QUORUM_TOO_LOW: &[u8] = b"QuorumTooLow()";
    pub const KEYSET_TOO_SMALL: &[u8] = b"KeysetTooSmall()";
    pub const LOG_CID_TOO_LONG: &[u8] = b"LogCidTooLong()";
    pub const KEY_SCHEME_ALREADY_UPGRADED: &[u8] = b"KeySchemeAlreadyUpgraded()";
    pub const SCHEME_UPGRADE_NOT_AVAILABLE: &[u8] = b"SchemeUpgradeNotAvailable()";
    pub const ROTATION_PAYLOAD_EXPIRED: &[u8] = b"RotationPayloadExpired()";
    pub const MLDSA44_KEY_HASH_MISMATCH: &[u8] = b"MlDsa44KeyHashMismatch()";
    pub const FORWARD_ALREADY_SET: &[u8] = b"ForwardAlreadySet()";
    pub const UPGRADE_ALREADY_PENDING: &[u8] = b"UpgradeAlreadyPending()";
    pub const UPGRADE_TIMELOCK_NOT_ELAPSED: &[u8] = b"UpgradeTimelockNotElapsed()";
    pub const UPGRADE_ADDRESS_MISMATCH: &[u8] = b"UpgradeAddressMismatch()";
    pub const BATCH_SIZE_INVALID: &[u8] = b"BatchSizeInvalid()";
    pub const BATCH_ITEM_INVALID: &[u8] = b"BatchItemInvalid()";
    pub const POLICY_DELETE_DISABLED: &[u8] = b"PolicyDeleteDisabled()";
    pub const POLICY_DELETE_ALREADY_DISABLED: &[u8] = b"PolicyDeleteAlreadyDisabled()";
    pub const INVALID_PAYLOAD: &[u8] = b"InvalidPayload()";
    pub const NO_UPGRADE_PENDING: &[u8] = b"NoUpgradePending()";
    pub const STALE_REGISTRATION_LOG_HEAD: &[u8] = b"StaleRegistrationLogHead()";

    // DNS operation errors (E-37–E-47)
    pub const DOMAIN_NOT_FOUND: &[u8] = b"DomainNotFound()";
    pub const DOMAIN_ALREADY_REGISTERED: &[u8] = b"DomainAlreadyRegistered()";
    pub const DOMAIN_SUSPENDED: &[u8] = b"DomainSuspended()";
    pub const CARD_NOT_DNS_GOVERNANCE_POLICY: &[u8] = b"CardNotDnsGovernancePolicy()";
    pub const POLICY_CARD_NOT_FOUND: &[u8] = b"PolicyCardNotFound()";
    pub const DOMAIN_PATH_ENTRY_NOT_FOUND: &[u8] = b"DomainPathEntryNotFound()";
    pub const INVALID_DNS_PARAMETER: &[u8] = b"InvalidDnsParameter()";
    pub const SUB_CARD_NOT_DOMAIN_ADMIN_SUBCARD: &[u8] = b"SubCardNotDomainAdminSubcard()";
    pub const ADMIN_CARD_MISMATCH: &[u8] = b"AdminCardMismatch()";
    pub const INVALID_ADMIN_CARD_SIGNATURE: &[u8] = b"InvalidAdminCardSignature()";

    /// Build a revert payload from an error name string.
    /// Uses keccak256 of the error signature as the selector (4 bytes).
    pub fn make_error(name: &[u8]) -> alloc::vec::Vec<u8> {
        use stylus_sdk::alloy_primitives::keccak256;
        let selector = &keccak256(name)[..4];
        let mut out = alloc::vec![0u8; 4];
        out.copy_from_slice(selector);
        out
    }
}

// ─── Logic contract ───────────────────────────────────────────────────────────

/// Storage for the logic contract.
///
/// This stores the two addresses the logic contract needs, plus the
/// pending verifier upgrade state (since the verifier address lives here,
/// not in the storage contract).
#[storage]
#[entrypoint]
pub struct LogicContract {
    /// Address of the storage contract. Set at construction; not updated.
    /// All state reads and writes go through this address.
    pub storage_contract: StorageAddress,

    /// Address of the current verifier module.
    /// Updated via UpgradeVerifier (48-hour timelock, §6.3).
    pub verifier_module: StorageAddress,

    /// Pending verifier upgrade proposal.
    /// Stored here because the verifier address lives in the logic contract.
    pub pending_verifier_proposed_address: StorageAddress,
    pub pending_verifier_proposed_at: StorageU64,
    pub pending_verifier_governance_version: StorageU32,
    pub pending_verifier_nonce: StorageB256,

    /// Current protocol version string (e.g. "0.1").
    ///
    /// Empty string means the contract was deployed before this field existed;
    /// get_protocol_version() returns the hardcoded default "0.1" in that case.
    /// Updated via SetProtocolVersion (RootPolicyBody quorum, §4.17).
    pub protocol_version: StorageString,
}

// ─── StorageB256 (needed in logic contract storage) ──────────────────────────

#[storage]
pub struct StorageB256 {
    inner: StorageFixedBytes<32>,
}

impl StorageB256 {
    pub fn get(&self) -> B256 {
        B256::from(self.inner.get())
    }
    pub fn set(&mut self, val: B256) {
        self.inner.set(val.into());
    }
}

// ─── Helper macros / functions ────────────────────────────────────────────────

/// Get the current block timestamp as u64.
#[allow(deprecated)]
pub fn current_timestamp() -> u64 {
    block::timestamp()
}

/// Get the current block number as u64.
#[allow(deprecated)]
pub fn current_block_number() -> u64 {
    block::number()
}

/// Build a Stylus-compatible call context for cross-contract calls.
///
/// Note: `sol_interface!` view functions issue static calls regardless of the
/// context object passed; this single function covers both read-only and
/// state-modifying call sites.
#[allow(deprecated)]
pub fn static_call_ctx() -> stylus_sdk::call::Call<(), false> {
    stylus_sdk::call::Call::new()
}

#[public]
impl LogicContract {
    // ════════════════════════════════════════════════════════════════════════
    // Constructor / initialization
    // ════════════════════════════════════════════════════════════════════════

    /// Initialize the logic contract with the storage and verifier addresses.
    ///
    /// # Arguments
    /// * `storage_address`  — Address of the (already-deployed) storage contract.
    /// * `verifier_address` — Address of the (already-deployed) verifier module.
    ///
    /// Security: This can only be called once (guarded by non-zero check).
    pub fn initialize(
        &mut self,
        storage_address: Address,
        verifier_address: Address,
    ) -> Result<(), Vec<u8>> {
        // Prevent re-initialization.
        if self.storage_contract.get() != Address::ZERO {
            return Err(errors::make_error(b"AlreadyInitialized()"));
        }
        if storage_address == Address::ZERO || verifier_address == Address::ZERO {
            return Err(errors::make_error(b"InvalidAddress()"));
        }
        self.storage_contract.set(storage_address);
        self.verifier_module.set(verifier_address);
        Ok(())
    }

    /// Get the current verifier module address.
    /// This is the read path for the verifier address (§5 — GetVerifierModule).
    pub fn get_verifier_module(&self) -> Result<Address, Vec<u8>> {
        Ok(self.verifier_module.get())
    }

    /// Get the current protocol version string (e.g. "0.1").
    ///
    /// Returns the value stored by SetProtocolVersion, or "0.1" if no version has
    /// been explicitly set (empty storage slot — contracts deployed before §4.17
    /// was added are treated as v0.1).
    pub fn get_protocol_version(&self) -> Result<alloc::string::String, Vec<u8>> {
        let stored = self.protocol_version.get_string();
        if stored.is_empty() {
            Ok(alloc::string::String::from("0.1"))
        } else {
            Ok(stored)
        }
    }

    /// §4.17 SetProtocolVersion — Update the protocol version string.
    ///
    /// Requires RootPolicyBody quorum. Emits ProtocolVersionUpdated.
    pub fn set_protocol_version(
        &mut self,
        new_version: alloc::string::String,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::set_protocol_version(self, new_version, governance_payload, governance_sigs)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Card write operations (§4.1, §4.2, §4.5, §4.13, §4.15)
    // See card_ops.rs for implementation details
    // ════════════════════════════════════════════════════════════════════════

    /// §4.1 RegisterCard — Create the initial registry entry for a new card.
    pub fn register_card(
        &mut self,
        card_address: B256,
        initial_log_cid: Vec<u8>,
        policy_address: B256,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        card_ops::register_card(self, card_address, initial_log_cid, policy_address, press_address, press_sig_payload, press_signature)
    }

    /// §4.2 UpdateCardHead — Advance a card's log head to a new CID.
    pub fn update_card_head(
        &mut self,
        card_address: B256,
        new_log_cid: Vec<u8>,
        prev_log_cid: Vec<u8>,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        card_ops::update_card_head(self, card_address, new_log_cid, prev_log_cid, press_address, press_sig_payload, press_signature)
    }

    /// §4.5 ClaimOpenOffer — Atomically claim an open offer and register a card.
    pub fn claim_open_offer(
        &mut self,
        offer_id: B256,
        max_acceptances: u64,
        expires_at: u64,
        card_address: B256,
        initial_log_cid: Vec<u8>,
        policy_address: B256,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        card_ops::claim_open_offer(self, offer_id, max_acceptances, expires_at, card_address, initial_log_cid, policy_address, press_address, press_sig_payload, press_signature)
    }

    /// §4.13 RegisterAddressForward — Set a forward pointer from an old card to a new card.
    ///
    /// The press verifies `holder_signature` (ML-DSA-44) off-chain against the holder's old card
    /// pubkey before submitting. The contract accepts `holder_signature` in calldata for auditability
    /// but does not re-verify it on-chain — same pattern as ML-DSA-44 params in deregister_sub_card.
    /// `secp256r1_sig` signs over keccak256(holder_sig_payload), so the press co-signs the exact
    /// payload the holder authorized. Any currently-authorized press under the old card's policy
    /// may submit on the holder's behalf.
    pub fn register_address_forward(
        &mut self,
        old_address: B256,
        new_address: B256,
        press_address: B256,
        holder_sig_payload: Vec<u8>, // ML-DSA-44 payload (auditable; not verified on-chain)
        holder_signature: Vec<u8>,   // ML-DSA-44 signature (auditable; not verified on-chain)
        secp256r1_sig: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        card_ops::register_address_forward(self, old_address, new_address, press_address, holder_sig_payload, secp256r1_sig)
    }

    /// §4.15 BatchUpdateCardHeads — Update multiple card heads atomically.
    pub fn batch_update_card_heads(
        &mut self,
        policy_address: B256,
        press_address: B256,
        card_addresses: Vec<B256>,
        prev_log_cids: Vec<Vec<u8>>,
        new_log_cids: Vec<Vec<u8>>,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        card_ops::batch_update_card_heads(self, policy_address, press_address, card_addresses, prev_log_cids, new_log_cids, press_sig_payload, press_signature)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Sub-card operations (§4.3, §4.4)
    // ════════════════════════════════════════════════════════════════════════

    /// §4.3 RegisterSubCard — Register a new sub-card under a master card.
    ///
    /// When `master_card_address` is a DNS admin card (`DnsAdminCardKeys[master]` is non-zero),
    /// `admin_secp_payload` and `admin_secp_signature` are required and verified on-chain (E-47).
    /// For non-DNS-admin master cards, both must be empty/zero.
    ///
    /// No holder ML-DSA-44 signature is carried in calldata — matching `RegisterCard`/
    /// `UpdateCardHead`/`ClaimOpenOffer`, none of which carry a holder/issuer ML-DSA-44
    /// signature either. The holder's authorization already lives in the `SubCardDocument`
    /// pinned at `sub_card_doc_cid`; that CID is itself a content-addressed, tamper-evident
    /// commitment to it, so a second on-chain copy added nothing an off-chain reader
    /// couldn't already verify — while costing ~88KB of `uint8[]`-encoded calldata per call
    /// (ML-DSA-44 signatures are large, and Stylus's function-dispatch ABI encodes `Vec<u8>`
    /// as `uint8[]`, 32 bytes per element). A prior version of this function accepted
    /// `master_sig_payload`/`master_signature` for this purpose; removed 2026-07-21 (see
    /// registry_contract.md §4.3's changelog).
    pub fn register_sub_card(
        &mut self,
        sub_card_address: B256,
        master_card_address: B256,
        registration_log_head: Vec<u8>,
        sub_card_doc_cid: Vec<u8>,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
        admin_secp_payload: Vec<u8>,    // AdminAuthorizeSubCardPayload; required for DNS admin masters
        admin_secp_signature: Vec<u8>,  // secp256r1 sig; required for DNS admin masters (E-47)
    ) -> Result<(), Vec<u8>> {
        subcard_ops::register_sub_card(self, sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, press_address, press_sig_payload, press_signature, admin_secp_payload, admin_secp_signature)
    }

    /// §4.4 DeregisterSubCard — Mark a sub-card as inactive.
    ///
    /// `sig_payload` and `signature` are the holder's ML-DSA-44 deregistration
    /// authorization. The press verifies the holder's signature off-chain before
    /// submitting. They are included in calldata for auditability but are not
    /// verified on-chain.
    pub fn deregister_sub_card(
        &mut self,
        sub_card_address: B256,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
        sig_payload: Vec<u8>,   // ML-DSA-44 payload (auditable; not verified on-chain)
        signature: Vec<u8>,     // ML-DSA-44 signature (auditable; not verified on-chain)
    ) -> Result<(), Vec<u8>> {
        subcard_ops::deregister_sub_card(self, sub_card_address, press_address, press_sig_payload, press_signature, sig_payload, signature)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Governance operations (§4.6–4.10)
    // ════════════════════════════════════════════════════════════════════════

    /// §4.6 RegisterPolicy — Register a new root policy (RootPolicyBody quorum).
    pub fn register_policy(
        &mut self,
        policy_address: B256,
        authorizer_pubkey: Vec<u8>,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::register_policy(self, policy_address, authorizer_pubkey, governance_payload, governance_sigs)
    }

    /// DeregisterPolicy stub (OQ-E decision) — governed by RootPolicyBody quorum.
    ///
    /// SECURITY WARNING: Deregistering a policy makes ALL presses and cards under it
    /// permanently non-writable. This operation is irreversible on the storage contract
    /// because the delete is not protected by an unconditional invariant (§3.7 note).
    /// The governance body must exercise extreme caution before signing this operation.
    pub fn deregister_policy(
        &mut self,
        policy_address: B256,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::deregister_policy(self, policy_address, governance_payload, governance_sigs)
    }

    /// §4.16 DisablePolicyDeletePermanently — permanently brick delete_policy_authorizer_key
    /// at the storage contract level (RootPolicyBody quorum).
    pub fn disable_policy_delete_permanently(
        &mut self,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::disable_policy_delete_permanently(self, governance_payload, governance_sigs)
    }

    /// §4.7 AuthorizePress — Authorize a press to write under a policy (PressRegistryBody quorum).
    pub fn authorize_press(
        &mut self,
        policy_address: B256,
        press_address: B256,
        press_pubkey: Vec<u8>,
        mldsa44_key_hash: B256,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::authorize_press(self, policy_address, press_address, press_pubkey, mldsa44_key_hash, governance_payload, governance_sigs)
    }

    /// §4.8 RevokePress — Revoke a press authorization (PressRegistryBody quorum).
    pub fn revoke_press(
        &mut self,
        policy_address: B256,
        press_address: B256,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::revoke_press(self, policy_address, press_address, governance_payload, governance_sigs)
    }

    /// §4.9 RotateAuthorizerKey — Replace the authorizer key for a policy (RootPolicyBody quorum).
    pub fn rotate_authorizer_key(
        &mut self,
        policy_address: B256,
        new_authorizer_key: Vec<u8>,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::rotate_authorizer_key(self, policy_address, new_authorizer_key, governance_payload, governance_sigs)
    }

    /// §4.10 RotateGovernanceKeys — Replace the key set for a governance body (self-amending).
    pub fn rotate_governance_keys(
        &mut self,
        body_id: u8,
        new_keys_flat: Vec<u8>,
        new_key_count: u8,
        new_quorum: u8,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        governance_ops::rotate_governance_keys(self, body_id, new_keys_flat, new_key_count, new_quorum, governance_payload, governance_sigs)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Upgrade operations (§4.14, §6.3)
    // ════════════════════════════════════════════════════════════════════════

    /// §4.14 ProposeLogicUpgrade — Propose a new logic contract (RootPolicyBody quorum, 7-day timelock).
    pub fn propose_logic_upgrade(
        &mut self,
        new_logic_address: Address,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        upgrade_ops::propose_logic_upgrade(self, new_logic_address, governance_payload, governance_sigs)
    }

    /// §4.14 ConfirmLogicUpgrade — Execute the upgrade after 7 days (RootPolicyBody quorum, fresh sigs).
    pub fn confirm_logic_upgrade(
        &mut self,
        proposed_logic_address: Address,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        upgrade_ops::confirm_logic_upgrade(self, proposed_logic_address, governance_payload, governance_sigs)
    }

    /// §4.14 CancelLogicUpgrade — Cancel a pending proposal (RootPolicyBody quorum).
    pub fn cancel_logic_upgrade(
        &mut self,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        upgrade_ops::cancel_logic_upgrade(self, governance_payload, governance_sigs)
    }

    /// §6.3 ProposeVerifierUpgrade — Propose a new verifier module (RootPolicyBody quorum, 48h timelock).
    pub fn propose_verifier_upgrade(
        &mut self,
        new_verifier_address: Address,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        upgrade_ops::propose_verifier_upgrade(self, new_verifier_address, governance_payload, governance_sigs)
    }

    /// §6.3 ConfirmVerifierUpgrade — Execute the verifier upgrade after 48 hours.
    pub fn confirm_verifier_upgrade(
        &mut self,
        proposed_verifier_address: Address,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        upgrade_ops::confirm_verifier_upgrade(self, proposed_verifier_address, governance_payload, governance_sigs)
    }

    /// §6.3 CancelVerifierUpgrade — Cancel a pending verifier upgrade proposal.
    pub fn cancel_verifier_upgrade(
        &mut self,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        upgrade_ops::cancel_verifier_upgrade(self, governance_payload, governance_sigs)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Key scheme operations (§4.11)
    // ════════════════════════════════════════════════════════════════════════

    /// §4.11 RotateOnChainKeyScheme — Upgrade a press from secp256r1 to ML-DSA-44.
    /// Always reverts E-24 in Phase 1 (key_scheme_phase == 0).
    pub fn rotate_on_chain_key_scheme(
        &mut self,
        policy_address: B256,
        press_address: B256,
        new_mldsa44_pubkey: Vec<u8>,
        rotation_payload: Vec<u8>,
        secp256r1_sig: Vec<u8>,
        mldsa44_sig: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        key_scheme_ops::rotate_on_chain_key_scheme(self, policy_address, press_address, new_mldsa44_pubkey, rotation_payload, secp256r1_sig, mldsa44_sig)
    }

    // ════════════════════════════════════════════════════════════════════════
    // Pass-through read operations (§5)
    // These delegate to the storage contract for read consistency.
    // ════════════════════════════════════════════════════════════════════════

    pub fn get_card_entry(
        &self,
        card_address: B256,
    ) -> Result<(Vec<u8>, B256, B256, B256, bool), Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .get_card_entry(static_call_ctx(), card_address)
            .map_err(|e| e.encode())
            .map(|(cid, policy, press, fwd, ex)| (cid.to_vec(), policy, press, fwd, ex))
    }

    pub fn card_exists(&self, card_address: B256) -> Result<bool, Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .card_exists(static_call_ctx(), card_address)
            .map_err(|e| e.encode())
    }

    pub fn get_press_authorization(
        &self,
        policy_address: B256,
        press_address: B256,
    ) -> Result<(Vec<u8>, B256, u8, bool, u64, u64, u64), Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .get_press_authorization(static_call_ctx(), policy_address, press_address)
            .map_err(|e| e.encode())
            .map(|(k, h, s, a, seq, at, rev)| (k.to_vec(), h, s, a, seq, at, rev))
    }

    pub fn get_governance_keyset(
        &self,
        body_id: u8,
    ) -> Result<(Vec<u8>, u8, u8, u32, u8), Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .get_governance_keyset(static_call_ctx(), body_id)
            .map_err(|e| e.encode())
            .map(|(k, c, q, v, s)| (k.to_vec(), c, q, v, s))
    }

    pub fn get_logic_contract(&self) -> Result<Address, Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .get_logic_contract(static_call_ctx())
            .map_err(|e| e.encode())
    }

    pub fn get_pending_logic_upgrade(&self) -> Result<(Address, u64, u32, B256), Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .get_pending_logic_upgrade(static_call_ctx())
            .map_err(|e| e.encode())
    }

    pub fn get_storage_contract(&self) -> Result<Address, Vec<u8>> {
        Ok(self.storage_contract.get())
    }

    // ════════════════════════════════════════════════════════════════════════
    // DNS resolution operations (§4.17–4.24)
    // See dns_ops.rs for implementation details
    // ════════════════════════════════════════════════════════════════════════

    /// §4.17 RegisterDomain — Register a domain after TXT verification (DnsGovernanceBody quorum).
    pub fn register_domain(
        &mut self,
        domain: Vec<u8>,
        admin_card_address: B256,
        admin_secp256r1_key: Vec<u8>,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::register_domain(self, domain, admin_card_address, admin_secp256r1_key, governance_payload, governance_sigs)
    }

    /// §4.18 DeregisterDomain — Remove the active admin card for a domain (DnsGovernanceBody quorum).
    pub fn deregister_domain(
        &mut self,
        domain: Vec<u8>,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::deregister_domain(self, domain, governance_payload, governance_sigs)
    }

    /// §4.19 SetPolicyAddress — Register a policy card address at a domain/path.
    /// Authorized by press under DnsGovernancePolicyAddress on behalf of domain admin (or sub-card).
    pub fn set_policy_address(
        &mut self,
        domain: Vec<u8>,
        path: Vec<u8>,
        policy_card_address: B256,
        admin_card_address: B256,
        sub_card_address: B256,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::set_policy_address(self, domain, path, policy_card_address, admin_card_address, sub_card_address, press_address, press_sig_payload, press_signature)
    }

    /// §4.20 RemovePolicyAddress — Remove a policy address entry.
    /// Two authorization paths: press (card_address non-zero) or DnsGovernanceBody quorum.
    pub fn remove_policy_address(
        &mut self,
        domain: Vec<u8>,
        path: Vec<u8>,
        card_address: B256,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::remove_policy_address(self, domain, path, card_address, press_address, press_sig_payload, press_signature, governance_payload, governance_sigs)
    }

    /// §4.21 ClearDomainEntries — Remove all PolicyAddresses entries for a domain (DnsGovernanceBody quorum).
    pub fn clear_domain_entries(
        &mut self,
        domain: Vec<u8>,
        paths: Vec<Vec<u8>>,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::clear_domain_entries(self, domain, paths, governance_payload, governance_sigs)
    }

    /// §4.22 FlagDomainFraudRisk — Set the fraud risk level for a domain (DnsGovernanceBody quorum).
    pub fn flag_domain_fraud_risk(
        &mut self,
        domain: Vec<u8>,
        fraud_risk: u8,
        suspension_expires_at: u64,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::flag_domain_fraud_risk(self, domain, fraud_risk, suspension_expires_at, governance_payload, governance_sigs)
    }

    /// §4.23 GovernanceSetPolicyAddress — Directly write or clear a PolicyAddresses entry (DnsGovernanceBody quorum).
    /// Primary rollback primitive. Works on suspended domains. Zero policy_card_address clears the entry.
    pub fn governance_set_policy_address(
        &mut self,
        domain: Vec<u8>,
        path: Vec<u8>,
        policy_card_address: B256,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::governance_set_policy_address(self, domain, path, policy_card_address, governance_payload, governance_sigs)
    }

    /// §4.24 SetDnsGovernancePolicyAddress — Rotate the global DNS governance policy address (DnsGovernanceBody quorum).
    /// Breaking change: orphans all existing domain admin cards. Last-resort escape hatch.
    pub fn set_dns_governance_policy_address(
        &mut self,
        new_policy_address: B256,
        governance_payload: Vec<u8>,
        governance_sigs: Vec<Vec<u8>>,
    ) -> Result<(), Vec<u8>> {
        dns_ops::set_dns_governance_policy_address(self, new_policy_address, governance_payload, governance_sigs)
    }

    // DNS pass-through reads (§5)

    pub fn lookup_policy_address(
        &self,
        domain: Vec<u8>,
        path: Vec<u8>,
    ) -> Result<B256, Vec<u8>> {
        let key = dns_ops::policy_address_key(&domain, &path);
        let storage = IStorage::new(self.storage_contract.get());
        storage.get_policy_address(static_call_ctx(), key).map_err(|e| e.encode())
    }

    pub fn get_domain_registration(
        &self,
        domain: Vec<u8>,
    ) -> Result<(B256, u64, u8, u64, bool), Vec<u8>> {
        let domain_hash = dns_ops::domain_hash(&domain);
        let storage = IStorage::new(self.storage_contract.get());
        storage.get_domain_entry(static_call_ctx(), domain_hash).map_err(|e| e.encode())
    }

    pub fn get_dns_admin_card_key(&self, card_address: B256) -> Result<Vec<u8>, Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage
            .get_dns_admin_card_key(static_call_ctx(), card_address)
            .map_err(|e| e.encode())
            .map(|k| k.to_vec())
    }

    pub fn get_dns_governance_policy_address(&self) -> Result<B256, Vec<u8>> {
        let storage = IStorage::new(self.storage_contract.get());
        storage.get_dns_governance_policy_address(static_call_ctx()).map_err(|e| e.encode())
    }
}

// ─── ABI type note ───────────────────────────────────────────────────────────
//
// In Stylus SDK 0.8, Vec<u8> implements AbiType and maps to Solidity `bytes`.
// Vec<Vec<u8>> maps to `bytes[]`. No custom Bytes wrapper is needed.
