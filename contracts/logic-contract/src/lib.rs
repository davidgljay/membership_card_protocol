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
    storage::{StorageAddress, StorageBool, StorageU64, StorageU8, StorageU32, StorageFixedBytes},
};

pub mod write_gate;
pub mod card_ops;
pub mod subcard_ops;
pub mod governance_ops;
pub mod upgrade_ops;
pub mod key_scheme_ops;

use write_gate::WriteGate;

// ─── Cross-contract interfaces (sol_interface!) ───────────────────────────────
//
// These macros generate Rust structs that wrap cross-contract calls to the
// storage contract and verifier module. The storage contract's ABI is expressed
// here; calls to it go via DELEGATECALL-equivalent cross-contract invocations.

sol_interface! {
    /// Interface to the storage contract.
    /// Only the functions the logic contract actually calls are listed here.
    interface IStorage {
        // ── Getters ──────────────────────────────────────────────────────────
        function get_card_entry(bytes32 card_address)
            external view returns (bytes, bytes32, bytes32, bytes32, bool);
        function card_exists(bytes32 card_address)
            external view returns (bool);
        function policy_exists(bytes32 policy_address)
            external view returns (bool);
        function get_policy_authorizer(bytes32 policy_address)
            external view returns (bytes);
        function get_press_authorization(bytes32 policy_address, bytes32 press_address)
            external view returns (bytes, bytes32, uint8, bool, uint64, uint64, uint64);
        function is_press_active(bytes32 policy_address, bytes32 press_address)
            external view returns (bool);
        function get_next_sequence(bytes32 policy_address, bytes32 press_address)
            external view returns (uint64);
        function get_sub_card_entry(bytes32 sub_card_address)
            external view returns (bytes32, bytes, bytes, bool, uint64, uint64);
        function get_open_offer_count(bytes32 offer_id)
            external view returns (uint64);
        function get_governance_keyset(uint8 body_id)
            external view returns (bytes, uint8, uint8, uint32, uint8);
        function is_nonce_used(bytes32 nonce)
            external view returns (bool);
        function get_logic_contract()
            external view returns (address);
        function get_pending_logic_upgrade()
            external view returns (address, uint64, uint32, bytes32);
        function get_key_scheme_phase()
            external view returns (uint8);
        function get_policy_delete_disabled()
            external view returns (bool);

        // ── Setters ──────────────────────────────────────────────────────────
        function set_card_entry(
            bytes32 card_address,
            bytes log_head_cid,
            bytes32 policy_address,
            bytes32 last_press_address,
            bool exists
        ) external;
        function set_forward_to(bytes32 card_address, bytes32 new_forward_to) external;
        function update_card_head(bytes32 card_address, bytes new_log_cid, bytes32 last_press_address) external;
        function set_press_auth_entry(
            bytes32 policy_address,
            bytes32 press_address,
            bytes press_public_key,
            bytes32 mldsa44_key_hash,
            uint8 key_scheme,
            bool active,
            uint64 next_sequence,
            uint64 authorized_at,
            uint64 revoked_at
        ) external;
        function increment_press_sequence(bytes32 policy_address, bytes32 press_address) external;
        function set_sub_card_entry(
            bytes32 sub_card_address,
            bytes32 master_card_address,
            bytes registration_log_head,
            bytes sub_card_doc_cid,
            bool active,
            uint64 registered_at,
            uint64 deregistered_at
        ) external;
        function set_open_offer_count(bytes32 offer_id, uint64 count) external;
        function set_policy_authorizer_key(bytes32 policy_address, bytes authorizer_pubkey) external;
        function delete_policy_authorizer_key(bytes32 policy_address) external;
        function set_governance_keyset(
            uint8 body_id,
            bytes keys_flat,
            uint8 key_count,
            uint8 quorum,
            uint32 version,
            uint8 key_scheme
        ) external;
        function mark_nonce_used(bytes32 nonce) external;
        function set_logic_contract(address new_logic_address) external;
        function set_pending_logic_upgrade(
            address proposed_address,
            uint64 proposed_at,
            uint32 governance_version,
            bytes32 nonce
        ) external;
        function clear_pending_logic_upgrade() external;
        function set_key_scheme_phase(uint8 phase) external;
        function disable_policy_delete_permanently() external;
    }

    /// Interface to the verifier module.
    interface IVerifierModule {
        function verify_secp256r1(
            bytes32 message_hash,
            bytes signature,
            bytes public_key
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
    pub fn register_sub_card(
        &mut self,
        sub_card_address: B256,
        master_card_address: B256,
        registration_log_head: Vec<u8>,
        sub_card_doc_cid: Vec<u8>,
        press_address: B256,
        press_sig_payload: Vec<u8>,
        press_signature: Vec<u8>,
        master_sig_payload: Vec<u8>, // ML-DSA-44 payload (auditable; not verified on-chain)
        master_signature: Vec<u8>,   // ML-DSA-44 signature (auditable; not verified on-chain)
    ) -> Result<(), Vec<u8>> {
        subcard_ops::register_sub_card(self, sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, press_address, press_sig_payload, press_signature)
    }

    /// §4.4 DeregisterSubCard — Mark a sub-card as inactive.
    ///
    /// `sig_payload` and `signature` are the holder's ML-DSA-44 deregistration
    /// authorization. The press verifies the holder's signature off-chain before
    /// submitting. They are included in calldata for auditability but are not
    /// verified on-chain — consistent with the `master_sig_payload` / `master_signature`
    /// pattern in `register_sub_card` (§4.3).
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
}

// ─── ABI type note ───────────────────────────────────────────────────────────
//
// In Stylus SDK 0.8, Vec<u8> implements AbiType and maps to Solidity `bytes`.
// Vec<Vec<u8>> maps to `bytes[]`. No custom Bytes wrapper is needed.
