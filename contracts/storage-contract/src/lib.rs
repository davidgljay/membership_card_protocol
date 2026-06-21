//! # Storage Contract
//!
//! The immutable-address component of the Card Protocol three-contract architecture.
//! This contract holds all protocol state and enforces unconditional audit-trail
//! invariants that no logic upgrade can override.
//!
//! ## Architecture role (§6.3 of registry_contract.md v0.3)
//!
//! - **Address is permanent.** This contract is never redeployed. Its address is
//!   the stable protocol identifier that presses write to, verifiers read from,
//!   and monitoring infrastructure watches.
//! - **No business logic.** All authorization decisions are in the logic contract.
//!   This contract checks only: is the caller the current logic contract?
//! - **Unconditional invariants (§3.7).** Six invariants are enforced here and
//!   cannot be overridden by any logic upgrade:
//!   1. `CardEntries[addr].exists` is write-once-true.
//!   2. `CardEntries[addr].forward_to` is immutable once non-zero.
//!   3. `delete_policy_authorizer_key` reverts unconditionally when `policy_delete_disabled` is true.
//!   4. `policy_delete_disabled` is write-once-true.
//!   5. `PressAuthorizations[p][a].revoked_at` is write-once-non-zero.
//!   6. `SubCardRegistrations[addr].deregistered_at` is write-once-non-zero.
//!
//! ## Access control
//!
//! Every setter function reverts with `CALLER_NOT_LOGIC_CONTRACT` (E-29) if
//! `msg.sender != self.logic_contract.get()`. Getter functions are public.
//!
//! ## Security notes for auditors
//!
//! - The storage contract emits NO events. All events are emitted by the logic contract.
//! - The constructor initializes both governance keysets with a 1-of-1 key (§3.6 bootstrap).
//!   The deployer is responsible for calling RotateGovernanceKeys to expand governance.
//! - `set_logic_contract` is a setter callable only by the current logic contract.
//!   This enables the logic contract to update its own successor address during UpgradeLogic.
//!   After calling `set_logic_contract(new_addr)`, the current logic contract can NO longer
//!   call any storage setter (they will all revert with E-29).

#![no_std]
extern crate alloc;

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{Address, B256},
    msg,
    prelude::*,
    storage::{StorageAddress, StorageBool, StorageBytes, StorageMap, StorageU64, StorageU8, StorageU32},
};
use protocol_types::{MAX_CID_LEN, MIN_GOVERNANCE_KEYS};

// ─── Error selector constants ────────────────────────────────────────────────
// ABI-encoded custom error selectors for each error code.
// These are 4-byte keccak256 selectors of the error signature strings.
// In Stylus, we return these as raw bytes in the revert data.

/// Selector for CallerNotLogicContract (E-29).
/// keccak256("CallerNotLogicContract()")[0..4]
const E_CALLER_NOT_LOGIC_CONTRACT: &[u8; 4] = b"\x95\x9b\x5d\x08";

/// Selector for CardAlreadyExists (E-01).
const E_CARD_ALREADY_EXISTS: &[u8; 4] = b"\x23\x69\x8a\x5c";

/// Selector for ForwardAlreadySet (E-27).
const E_FORWARD_ALREADY_SET: &[u8; 4] = b"\x5d\x8e\x1e\xab";

/// Selector for RevokedAtAlreadySet (storage invariant for E-05 enforcement).
const E_REVOKED_AT_IMMUTABLE: &[u8; 4] = b"\xd3\x4b\x61\x23";

/// Selector for DeregisteredAtAlreadySet (storage invariant for SubCard).
const E_DEREGISTERED_AT_IMMUTABLE: &[u8; 4] = b"\x7a\x1f\x2c\x99";

/// Selector for InvalidAddress.
const E_INVALID_ADDRESS: &[u8; 4] = b"\xa2\x3f\x91\x7c";

/// Selector for PolicyDeleteDisabled (E-35).
/// TODO: Replace with keccak256("PolicyDeleteDisabled()")[0..4] before deployment.
const E_POLICY_DELETE_DISABLED: &[u8; 4] = b"\x00\x00\x00\x01";

/// Selector for PolicyDeleteAlreadyDisabled (E-36).
/// TODO: Replace with keccak256("PolicyDeleteAlreadyDisabled()")[0..4] before deployment.
const E_POLICY_DELETE_ALREADY_DISABLED: &[u8; 4] = b"\x00\x00\x00\x02";

// ─── Storage structs ──────────────────────────────────────────────────────────

/// Per-card storage entry (§3.1).
///
/// Fields must match the `CardEntry` struct defined in registry_contract.md §3.1.
/// The `exists` flag is the guard for the write-once-true invariant.
#[storage]
pub struct StorageCardEntry {
    /// Current IPFS log head CID as raw bytes. Max 64 bytes.
    pub log_head_cid: StorageBytes,
    /// Policy card registry address. Immutable after RegisterCard.
    pub policy_address: StorageB256,
    /// Press that last wrote to this card.
    pub last_press_address: StorageB256,
    /// Successor card address. Immutable once non-zero (enforced by set_forward_to).
    pub forward_to: StorageB256,
    /// Write-once-true: once set, cannot be unset. Enforced by set_card_entry.
    pub exists: StorageBool,
}

/// Press authorization entry (§3.3).
///
/// Security: `revoked_at` is write-once-non-zero (enforced by set_press_auth_entry).
/// `next_sequence` must only increase; this is enforced by the logic contract write gate.
#[storage]
pub struct StoragePressAuthEntry {
    /// secp256r1 public key (x||y, 64 bytes) for write authorization.
    pub press_public_key: StorageBytes,
    /// keccak256 of ML-DSA-44 public key (1312 bytes). For Phase 2 upgrade.
    pub mldsa44_key_hash: StorageB256,
    /// 0 = secp256r1, 1 = ML-DSA-44.
    pub key_scheme: StorageU8,
    /// True = press may write; false = revoked.
    pub active: StorageBool,
    /// Monotonically incrementing counter for replay prevention.
    pub next_sequence: StorageU64,
    /// Unix timestamp of most recent AuthorizePress.
    pub authorized_at: StorageU64,
    /// Unix timestamp of RevokePress; 0 if not revoked. Write-once-non-zero.
    pub revoked_at: StorageU64,
}

/// Sub-card registration entry (§3.4).
///
/// Security: `deregistered_at` is write-once-non-zero (enforced by set_sub_card_entry).
#[storage]
pub struct StorageSubCardEntry {
    /// Registry address of the master card.
    pub master_card_address: StorageB256,
    /// Log head CID of master card at registration time (for scope checks).
    pub registration_log_head: StorageBytes,
    /// CID of the SubCardDocument on IPFS. Max 64 bytes.
    pub sub_card_doc_cid: StorageBytes,
    /// True until DeregisterSubCard is called.
    pub active: StorageBool,
    /// Unix timestamp of registration.
    pub registered_at: StorageU64,
    /// Unix timestamp of deregistration; 0 if active. Write-once-non-zero.
    pub deregistered_at: StorageU64,
}

/// Governance keyset entry (§3.6).
///
/// Keys are stored as a flat bytes array (concatenated 64-byte pubkeys).
/// `key_count` tracks the logical count. Maximum 50 keys in this implementation
/// (enough for any realistic governance structure).
#[storage]
pub struct StorageGovernanceKeyset {
    /// Concatenated secp256r1 public keys, 64 bytes each.
    /// Index i's key is at bytes [i*64 .. (i+1)*64].
    pub keys_flat: StorageBytes,
    /// Number of valid keys in keys_flat.
    pub key_count: StorageU8,
    /// Minimum distinct signatures required.
    pub quorum: StorageU8,
    /// Incremented on every rotation. Replay prevention for governance payloads.
    pub version: StorageU32,
    /// 0 = secp256r1, 1 = ML-DSA-44.
    pub key_scheme: StorageU8,
}

/// Pending logic upgrade proposal (§3.7).
#[storage]
pub struct StoragePendingLogicUpgrade {
    /// Proposed new logic address. Zero if no proposal is pending.
    pub proposed_address: StorageAddress,
    /// Block timestamp of the proposal.
    pub proposed_at: StorageU64,
    /// GovernanceKeysets[RootPolicyBody].version at proposal time.
    pub governance_version: StorageU32,
    /// Replay-prevention nonce from the proposal payload.
    pub nonce: StorageB256,
}

/// Pending verifier upgrade proposal (§6.3).
#[storage]
pub struct StoragePendingVerifierUpgrade {
    /// Proposed new verifier address. Zero if no proposal is pending.
    pub proposed_address: StorageAddress,
    /// Block timestamp of the proposal.
    pub proposed_at: StorageU64,
    /// GovernanceKeysets[RootPolicyBody].version at proposal time.
    pub governance_version: StorageU32,
    /// Replay-prevention nonce from the proposal payload.
    pub nonce: StorageB256,
}

// ─── B256 storage wrapper ─────────────────────────────────────────────────────
// Stylus SDK uses B256 for bytes32 storage slots.

/// Thin wrapper so we can use B256 as a storage value in nested maps.
#[storage]
pub struct StorageB256 {
    inner: stylus_sdk::storage::StorageFixedBytes<32>,
}

impl StorageB256 {
    pub fn get(&self) -> B256 {
        B256::from(self.inner.get())
    }

    pub fn set(&mut self, val: B256) {
        self.inner.set(val.into());
    }

    pub fn is_zero(&self) -> bool {
        self.get() == B256::ZERO
    }
}

// ─── StorageU32 shim ──────────────────────────────────────────────────────────
// Some Stylus SDK versions may not export StorageU32 directly.
// Using a workaround with StorageU64 if needed, but we assume 0.8 has it.

// ─── Main storage contract ───────────────────────────────────────────────────

/// The Card Protocol storage contract.
///
/// This is the single source of truth for all protocol state.
/// It enforces access control (caller must be logic contract) and
/// unconditional storage invariants (§3.7) on every write.
#[storage]
#[entrypoint]
pub struct StorageContract {
    // ── Core state mappings ──────────────────────────────────────────────────

    /// §3.1 Per-card registry entries. Keyed by card_address (bytes32).
    card_entries: StorageMap<B256, StorageCardEntry>,

    /// §3.2 Policy authorizer keys. Keyed by policy_address (bytes32).
    /// Value is the secp256r1 public key (64 bytes, x||y).
    /// Presence of an entry is what makes an address a recognized policy.
    policy_authorizer_keys: StorageMap<B256, StorageBytes>,

    /// §3.3 Press authorizations. Nested map: policy_address → press_address → entry.
    press_authorizations: StorageMap<B256, StorageMap<B256, StoragePressAuthEntry>>,

    /// §3.4 Sub-card registrations. Keyed by sub_card_address (bytes32).
    sub_card_registrations: StorageMap<B256, StorageSubCardEntry>,

    /// §3.5 Open offer use counts. Keyed by offer_id (bytes32).
    open_offer_use_counts: StorageMap<B256, StorageU64>,

    /// §3.6 Governance keysets. Keyed by body_id (0 = RootPolicyBody, 1 = PressRegistryBody).
    governance_keysets: StorageMap<u8, StorageGovernanceKeyset>,

    /// §6.2 Used governance nonces. Keyed by nonce (bytes32). True = already used.
    used_nonces: StorageMap<B256, StorageBool>,

    // ── Upgrade state ─────────────────────────────────────────────────────────

    /// §3.7 Address of the current logic contract. All setter access is gated on this.
    logic_contract: StorageAddress,

    /// §3.7 Pending logic upgrade proposal.
    pending_logic_upgrade: StoragePendingLogicUpgrade,

    /// §6.3 Pending verifier upgrade proposal.
    pending_verifier_upgrade: StoragePendingVerifierUpgrade,

    /// §4.11 Key scheme phase: 0 = Phase 1 (secp256r1 only), 1+ = Phase 2/3.
    key_scheme_phase: StorageU8,

    /// §3.7 Write-once-true: once true, delete_policy_authorizer_key reverts unconditionally.
    /// Set by disable_policy_delete_permanently (governance-gated via logic contract).
    policy_delete_disabled: StorageBool,
}

// ─── Access control helper ────────────────────────────────────────────────────

impl StorageContract {
    /// Assert that the caller is the currently registered logic contract.
    ///
    /// Security: This is the primary access control check for all setter functions.
    /// Every setter MUST call this before making any state changes.
    /// Error: E-29 (CALLER_NOT_LOGIC_CONTRACT)
    fn require_logic_contract(&self) -> Result<(), Vec<u8>> {
        let current_logic = self.logic_contract.get();
        if msg::sender() != current_logic {
            return Err(E_CALLER_NOT_LOGIC_CONTRACT.to_vec());
        }
        Ok(())
    }

    /// Get a 64-byte pubkey from a flat byte slice at index `idx` (0-based).
    /// Returns None if the index is out of bounds.
    fn get_key_at_index(flat: &[u8], idx: usize) -> Option<[u8; 64]> {
        let start = idx * 64;
        let end = start + 64;
        if end > flat.len() {
            return None;
        }
        let mut key = [0u8; 64];
        key.copy_from_slice(&flat[start..end]);
        Some(key)
    }
}

// ─── Public interface ─────────────────────────────────────────────────────────

#[public]
impl StorageContract {
    // ════════════════════════════════════════════════════════════════════════
    // Constructor
    // ════════════════════════════════════════════════════════════════════════

    /// Deploy the storage contract.
    ///
    /// # Arguments
    /// * `initial_logic_address`    — Address of the initially deployed logic contract.
    /// * `deployer_secp256r1_pubkey` — 64-byte secp256r1 public key (x||y) of the deployer.
    ///   This key is installed as the sole key in both governance keysets with quorum = 1.
    ///   (§3.6 bootstrap: "Deploy with 1-of-1 governance keyset")
    ///
    /// Security: The deployer key is the initial trust anchor. The governance body
    /// should call RotateGovernanceKeys as soon as additional members are available
    /// to reduce the single-point-of-failure risk of the 1-of-1 bootstrap keyset.
    pub fn initialize(
        &mut self,
        initial_logic_address: Address,
        deployer_secp256r1_pubkey: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        // Prevent re-initialization: if logic_contract is already set, reject.
        let current = self.logic_contract.get();
        if current != Address::ZERO {
            return Err(E_INVALID_ADDRESS.to_vec());
        }
        if initial_logic_address == Address::ZERO {
            return Err(E_INVALID_ADDRESS.to_vec());
        }
        let pubkey_bytes = deployer_secp256r1_pubkey.as_slice();
        if pubkey_bytes.len() != 64 {
            return Err(E_INVALID_ADDRESS.to_vec());
        }

        // Set the logic contract address.
        self.logic_contract.set(initial_logic_address);

        // Bootstrap RootPolicyBody (id=0) with 1-of-1 keyset.
        {
            let mut keyset = self.governance_keysets.setter(0u8);
            // Store the 64-byte key in the flat array.
            // StorageBytes::set_bytes() is called directly (no .setter() needed).
            keyset.keys_flat.set_bytes(pubkey_bytes);
            keyset.key_count.set(U8::from(1u8));
            keyset.quorum.set(U8::from(1u8));
            keyset.version.set(U32::from(0u32));
            keyset.key_scheme.set(U8::from(0u8));
        }

        // Bootstrap PressRegistryBody (id=1) with the same 1-of-1 keyset.
        {
            let mut keyset = self.governance_keysets.setter(1u8);
            keyset.keys_flat.set_bytes(pubkey_bytes);
            keyset.key_count.set(U8::from(1u8));
            keyset.quorum.set(U8::from(1u8));
            keyset.version.set(U32::from(0u32));
            keyset.key_scheme.set(U8::from(0u8));
        }

        // key_scheme_phase starts at 0 (Phase 1).
        self.key_scheme_phase.set(U8::from(0u8));

        Ok(())
    }

    // ════════════════════════════════════════════════════════════════════════
    // Getter functions (§5 — publicly readable, no access control)
    // ════════════════════════════════════════════════════════════════════════

    /// Get the full card entry for a given card address.
    /// Returns all fields; `exists` will be false for unregistered addresses.
    pub fn get_card_entry(
        &self,
        card_address: B256,
    ) -> Result<(Vec<u8>, B256, B256, B256, bool), Vec<u8>> {
        let entry = self.card_entries.getter(card_address);
        let log_head = entry.log_head_cid.get_bytes();
        let policy = entry.policy_address.get();
        let press = entry.last_press_address.get();
        let forward = entry.forward_to.get();
        let exists = entry.exists.get();
        Ok((log_head, policy, press, forward, exists))
    }

    /// Check if a card address exists. Fast path for verifiers.
    pub fn card_exists(&self, card_address: B256) -> Result<bool, Vec<u8>> {
        Ok(self.card_entries.getter(card_address).exists.get())
    }

    /// Get the policy authorizer public key (64 bytes) for a policy address.
    /// Returns empty bytes if the policy is not registered.
    pub fn get_policy_authorizer(&self, policy_address: B256) -> Result<Vec<u8>, Vec<u8>> {
        let key = self.policy_authorizer_keys.getter(policy_address).get_bytes();
        Ok(key)
    }

    /// Check if a policy address is registered (key is 64 bytes non-zero).
    pub fn policy_exists(&self, policy_address: B256) -> Result<bool, Vec<u8>> {
        let key = self.policy_authorizer_keys.getter(policy_address).get_bytes();
        Ok(key.len() == 64)
    }

    /// Get the press authorization entry for a (policy, press) pair.
    pub fn get_press_authorization(
        &self,
        policy_address: B256,
        press_address: B256,
    ) -> Result<(Vec<u8>, B256, u8, bool, u64, u64, u64), Vec<u8>> {
        let entry = self
            .press_authorizations
            .getter(policy_address)
            .getter(press_address);
        let key = entry.press_public_key.get_bytes();
        let mldsa_hash = entry.mldsa44_key_hash.get();
        let scheme = entry.key_scheme.get().to::<u8>();
        let active = entry.active.get();
        let seq = entry.next_sequence.get().to::<u64>();
        let auth_at = entry.authorized_at.get().to::<u64>();
        let rev_at = entry.revoked_at.get().to::<u64>();
        Ok((key, mldsa_hash, scheme, active, seq, auth_at, rev_at))
    }

    /// Quick check: is a press active for a given policy? Used by verifiers.
    pub fn is_press_active(&self, policy_address: B256, press_address: B256) -> Result<bool, Vec<u8>> {
        let entry = self
            .press_authorizations
            .getter(policy_address)
            .getter(press_address);
        // Must have a key AND be active.
        let key = entry.press_public_key.get_bytes();
        let active = entry.active.get();
        Ok(key.len() == 64 && active)
    }

    /// Get the press's next expected sequence number.
    pub fn get_next_sequence(&self, policy_address: B256, press_address: B256) -> Result<u64, Vec<u8>> {
        let seq = self
            .press_authorizations
            .getter(policy_address)
            .getter(press_address)
            .next_sequence
            .get()
            .to::<u64>();
        Ok(seq)
    }

    /// Get the sub-card registration entry.
    pub fn get_sub_card_entry(
        &self,
        sub_card_address: B256,
    ) -> Result<(B256, Vec<u8>, Vec<u8>, bool, u64, u64), Vec<u8>> {
        let entry = self.sub_card_registrations.getter(sub_card_address);
        let master = entry.master_card_address.get();
        let reg_head = entry.registration_log_head.get_bytes();
        let doc_cid = entry.sub_card_doc_cid.get_bytes();
        let active = entry.active.get();
        let reg_at = entry.registered_at.get().to::<u64>();
        let dereg_at = entry.deregistered_at.get().to::<u64>();
        Ok((master, reg_head, doc_cid, active, reg_at, dereg_at))
    }

    /// Get the current acceptance count for an open offer.
    pub fn get_open_offer_count(&self, offer_id: B256) -> Result<u64, Vec<u8>> {
        Ok(self.open_offer_use_counts.getter(offer_id).get().to::<u64>())
    }

    /// Get the governance keyset for a body.
    /// Returns (keys_flat_bytes, key_count, quorum, version, key_scheme).
    pub fn get_governance_keyset(
        &self,
        body_id: u8,
    ) -> Result<(Vec<u8>, u8, u8, u32, u8), Vec<u8>> {
        let keyset = self.governance_keysets.getter(body_id);
        let keys = keyset.keys_flat.get_bytes();
        let count = keyset.key_count.get().to::<u8>();
        let quorum = keyset.quorum.get().to::<u8>();
        let version = keyset.version.get().to::<u32>();
        let scheme = keyset.key_scheme.get().to::<u8>();
        Ok((keys, count, quorum, version, scheme))
    }

    /// Check if a governance nonce has been used.
    pub fn is_nonce_used(&self, nonce: B256) -> Result<bool, Vec<u8>> {
        Ok(self.used_nonces.getter(nonce).get())
    }

    /// Get the current logic contract address.
    pub fn get_logic_contract(&self) -> Result<Address, Vec<u8>> {
        Ok(self.logic_contract.get())
    }

    /// Get the pending logic upgrade proposal.
    /// Returns (proposed_address, proposed_at, governance_version, nonce).
    /// proposed_address == zero means no proposal is pending.
    pub fn get_pending_logic_upgrade(&self) -> Result<(Address, u64, u32, B256), Vec<u8>> {
        let p = &self.pending_logic_upgrade;
        let addr = p.proposed_address.get();
        let at = p.proposed_at.get().to::<u64>();
        let ver = p.governance_version.get().to::<u32>();
        let nonce = p.nonce.get();
        Ok((addr, at, ver, nonce))
    }

    /// Get the pending verifier upgrade proposal.
    pub fn get_pending_verifier_upgrade(&self) -> Result<(Address, u64, u32, B256), Vec<u8>> {
        let p = &self.pending_verifier_upgrade;
        let addr = p.proposed_address.get();
        let at = p.proposed_at.get().to::<u64>();
        let ver = p.governance_version.get().to::<u32>();
        let nonce = p.nonce.get();
        Ok((addr, at, ver, nonce))
    }

    /// Get the current key scheme phase.
    /// 0 = Phase 1 (secp256r1 only), 1+ = Phase 2/3.
    pub fn get_key_scheme_phase(&self) -> Result<u8, Vec<u8>> {
        Ok(self.key_scheme_phase.get().to::<u8>())
    }

    // ════════════════════════════════════════════════════════════════════════
    // Setter functions (only callable by the current logic contract — E-29)
    // ════════════════════════════════════════════════════════════════════════

    /// Create or update the main fields of a card entry.
    ///
    /// Unconditional invariant: If `exists` is currently true, it CANNOT be set to false.
    /// (§3.7: "CardEntries[addr].exists is write-once: once true, no setter may set it false.")
    ///
    /// Called by: RegisterCard, UpdateCardHead, ClaimOpenOffer, BatchUpdateCardHeads.
    pub fn set_card_entry(
        &mut self,
        card_address: B256,
        log_head_cid: Vec<u8>,
        policy_address: B256,
        last_press_address: B256,
        new_exists: bool,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        // Enforce write-once-true invariant on `exists`.
        let current_exists = self.card_entries.getter(card_address).exists.get();
        if current_exists && !new_exists {
            // Cannot unset exists once true.
            return Err(E_CARD_ALREADY_EXISTS.to_vec());
        }

        // Enforce CID length limit.
        let cid_bytes = log_head_cid.as_slice();
        if cid_bytes.len() > MAX_CID_LEN {
            return Err(b"CidTooLong".to_vec());
        }

        let mut entry = self.card_entries.setter(card_address);
        entry.log_head_cid.set_bytes(cid_bytes);
        entry.policy_address.set(policy_address);
        entry.last_press_address.set(last_press_address);
        entry.exists.set(new_exists);
        Ok(())
    }

    /// Set the forward_to field on a card entry.
    ///
    /// Unconditional invariant: If `forward_to` is currently non-zero,
    /// this setter REVERTS. A forward can only be set once. (§3.7)
    ///
    /// Called by: RegisterAddressForward.
    pub fn set_forward_to(
        &mut self,
        card_address: B256,
        new_forward_to: B256,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        // Enforce immutability: if already set, revert.
        let current_forward = self.card_entries.getter(card_address).forward_to.get();
        if current_forward != B256::ZERO {
            return Err(E_FORWARD_ALREADY_SET.to_vec());
        }

        self.card_entries.setter(card_address).forward_to.set(new_forward_to);
        Ok(())
    }

    /// Update only the log_head_cid and last_press_address of an existing card.
    ///
    /// Lighter-weight than set_card_entry for UpdateCardHead operations.
    /// Does not touch policy_address or exists flag.
    ///
    /// Called by: UpdateCardHead, BatchUpdateCardHeads.
    pub fn update_card_head(
        &mut self,
        card_address: B256,
        new_log_cid: Vec<u8>,
        last_press_address: B256,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let cid_bytes = new_log_cid.as_slice();
        if cid_bytes.len() > MAX_CID_LEN {
            return Err(b"CidTooLong".to_vec());
        }

        let mut entry = self.card_entries.setter(card_address);
        entry.log_head_cid.set_bytes(cid_bytes);
        entry.last_press_address.set(last_press_address);
        Ok(())
    }

    /// Create or update a press authorization entry.
    ///
    /// Unconditional invariant: If `revoked_at` is currently non-zero,
    /// no update may zero it out. (§3.7 — write-once-non-zero)
    ///
    /// Called by: AuthorizePress, RevokePress.
    pub fn set_press_auth_entry(
        &mut self,
        policy_address: B256,
        press_address: B256,
        press_public_key: Vec<u8>,
        mldsa44_key_hash: B256,
        key_scheme: u8,
        active: bool,
        next_sequence: u64,
        authorized_at: u64,
        revoked_at: u64,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        // Enforce revoked_at write-once-non-zero invariant.
        let current_revoked_at = self
            .press_authorizations
            .getter(policy_address)
            .getter(press_address)
            .revoked_at
            .get()
            .to::<u64>();
        if current_revoked_at != 0 && revoked_at == 0 {
            // Cannot zero out revoked_at once set.
            return Err(E_REVOKED_AT_IMMUTABLE.to_vec());
        }

        let key_bytes = press_public_key.as_slice();
        let mut entry = self
            .press_authorizations
            .setter(policy_address)
            .setter(press_address);
        entry.press_public_key.set_bytes(key_bytes);
        entry.mldsa44_key_hash.set(mldsa44_key_hash);
        entry.key_scheme.set(U8::from(key_scheme));
        entry.active.set(active);
        entry.next_sequence.set(U64::from(next_sequence));
        entry.authorized_at.set(U64::from(authorized_at));
        entry.revoked_at.set(U64::from(revoked_at));
        Ok(())
    }

    /// Increment the next_sequence for a press authorization.
    ///
    /// Separate setter to minimize the data written during card operations.
    /// Called by: write_gate after sequence check passes.
    pub fn increment_press_sequence(
        &mut self,
        policy_address: B256,
        press_address: B256,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let current = self
            .press_authorizations
            .getter(policy_address)
            .getter(press_address)
            .next_sequence
            .get()
            .to::<u64>();
        self.press_authorizations
            .setter(policy_address)
            .setter(press_address)
            .next_sequence
            .set(U64::from(current + 1));
        Ok(())
    }

    /// Create or update a sub-card registration entry.
    ///
    /// Unconditional invariant: If `deregistered_at` is currently non-zero,
    /// no update may zero it out. (§3.7 — write-once-non-zero)
    ///
    /// Called by: RegisterSubCard, DeregisterSubCard.
    pub fn set_sub_card_entry(
        &mut self,
        sub_card_address: B256,
        master_card_address: B256,
        registration_log_head: Vec<u8>,
        sub_card_doc_cid: Vec<u8>,
        active: bool,
        registered_at: u64,
        deregistered_at: u64,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        // Enforce deregistered_at write-once-non-zero invariant.
        let current_dereg = self
            .sub_card_registrations
            .getter(sub_card_address)
            .deregistered_at
            .get()
            .to::<u64>();
        if current_dereg != 0 && deregistered_at == 0 {
            return Err(E_DEREGISTERED_AT_IMMUTABLE.to_vec());
        }

        let reg_head_bytes = registration_log_head.as_slice();
        let doc_cid_bytes = sub_card_doc_cid.as_slice();
        if reg_head_bytes.len() > MAX_CID_LEN || doc_cid_bytes.len() > MAX_CID_LEN {
            return Err(b"CidTooLong".to_vec());
        }

        let mut entry = self.sub_card_registrations.setter(sub_card_address);
        entry.master_card_address.set(master_card_address);
        entry.registration_log_head.set_bytes(reg_head_bytes);
        entry.sub_card_doc_cid.set_bytes(doc_cid_bytes);
        entry.active.set(active);
        entry.registered_at.set(U64::from(registered_at));
        entry.deregistered_at.set(U64::from(deregistered_at));
        Ok(())
    }

    /// Set the open offer use count. Typically called with count + 1.
    ///
    /// Called by: ClaimOpenOffer.
    pub fn set_open_offer_count(&mut self, offer_id: B256, count: u64) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;
        self.open_offer_use_counts.setter(offer_id).set(U64::from(count));
        Ok(())
    }

    /// Set the policy authorizer key. Creates the entry (RegisterPolicy) or
    /// overwrites it (RotateAuthorizerKey).
    ///
    /// Called by: RegisterPolicy, RotateAuthorizerKey.
    pub fn set_policy_authorizer_key(
        &mut self,
        policy_address: B256,
        authorizer_pubkey: Vec<u8>,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let key_bytes = authorizer_pubkey.as_slice();
        // Must be exactly 64 bytes (secp256r1 x||y).
        if key_bytes.len() != 64 {
            return Err(b"InvalidKeyLength".to_vec());
        }

        self.policy_authorizer_keys
            .setter(policy_address)
            .set_bytes(key_bytes.to_vec());
        Ok(())
    }

    /// Delete the policy authorizer key (DeregisterPolicy stub).
    ///
    /// Unconditional invariant: if policy_delete_disabled is true, this setter
    /// reverts unconditionally regardless of caller (E-35). Once disabled via
    /// disable_policy_delete_permanently, no future logic contract can ever
    /// delete a policy authorizer key.
    ///
    /// Called by: DeregisterPolicy (governance-gated).
    pub fn delete_policy_authorizer_key(
        &mut self,
        policy_address: B256,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;
        if self.policy_delete_disabled.get() {
            return Err(E_POLICY_DELETE_DISABLED.to_vec());
        }
        // Clear by setting empty bytes.
        self.policy_authorizer_keys
            .setter(policy_address)
            .set_bytes(alloc::vec![]);
        Ok(())
    }

    /// Set (replace) the governance keyset for a body.
    ///
    /// The keys are provided as a flat byte array (concatenated 64-byte pubkeys).
    /// Called by: RotateGovernanceKeys, and implicitly by the constructor.
    pub fn set_governance_keyset(
        &mut self,
        body_id: u8,
        keys_flat: Vec<u8>,
        key_count: u8,
        quorum: u8,
        version: u32,
        key_scheme: u8,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let keys_bytes = keys_flat.as_slice();
        // Sanity check: keys_flat length must equal key_count * 64.
        if keys_bytes.len() != (key_count as usize) * 64 {
            return Err(b"InvalidKeysFlat".to_vec());
        }

        let mut keyset = self.governance_keysets.setter(body_id);
        keyset.keys_flat.set_bytes(keys_bytes);
        keyset.key_count.set(U8::from(key_count));
        keyset.quorum.set(U8::from(quorum));
        keyset.version.set(U32::from(version));
        keyset.key_scheme.set(U8::from(key_scheme));
        Ok(())
    }

    /// Mark a governance nonce as used.
    ///
    /// Called by: verify_governance_quorum in the logic contract.
    pub fn mark_nonce_used(&mut self, nonce: B256) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;
        self.used_nonces.setter(nonce).set(true);
        Ok(())
    }

    /// Update the logic contract address.
    ///
    /// Security critical: After this call, the caller (old logic contract) can
    /// NO longer call any storage setter — they will all revert with E-29.
    /// This is intentional: the old logic contract is replaced by the new one.
    ///
    /// Called by: ConfirmLogicUpgrade in the logic contract (§4.14).
    pub fn set_logic_contract(&mut self, new_logic_address: Address) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        if new_logic_address == Address::ZERO {
            return Err(E_INVALID_ADDRESS.to_vec());
        }
        self.logic_contract.set(new_logic_address);
        Ok(())
    }

    /// Set the pending logic upgrade proposal.
    ///
    /// Called by: ProposeLogicUpgrade in the logic contract.
    pub fn set_pending_logic_upgrade(
        &mut self,
        proposed_address: Address,
        proposed_at: u64,
        governance_version: u32,
        nonce: B256,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let mut p = &mut self.pending_logic_upgrade;
        p.proposed_address.set(proposed_address);
        p.proposed_at.set(U64::from(proposed_at));
        p.governance_version.set(U32::from(governance_version));
        p.nonce.set(nonce);
        Ok(())
    }

    /// Clear the pending logic upgrade proposal (set all fields to zero).
    ///
    /// Called by: ConfirmLogicUpgrade or CancelLogicUpgrade in the logic contract.
    pub fn clear_pending_logic_upgrade(&mut self) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let mut p = &mut self.pending_logic_upgrade;
        p.proposed_address.set(Address::ZERO);
        p.proposed_at.set(U64::from(0u64));
        p.governance_version.set(U32::from(0u32));
        p.nonce.set(B256::ZERO);
        Ok(())
    }

    /// Set the pending verifier upgrade proposal.
    ///
    /// Called by: ProposeVerifierUpgrade in the logic contract.
    pub fn set_pending_verifier_upgrade(
        &mut self,
        proposed_address: Address,
        proposed_at: u64,
        governance_version: u32,
        nonce: B256,
    ) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let mut p = &mut self.pending_verifier_upgrade;
        p.proposed_address.set(proposed_address);
        p.proposed_at.set(U64::from(proposed_at));
        p.governance_version.set(U32::from(governance_version));
        p.nonce.set(nonce);
        Ok(())
    }

    /// Clear the pending verifier upgrade proposal.
    pub fn clear_pending_verifier_upgrade(&mut self) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;

        let mut p = &mut self.pending_verifier_upgrade;
        p.proposed_address.set(Address::ZERO);
        p.proposed_at.set(U64::from(0u64));
        p.governance_version.set(U32::from(0u32));
        p.nonce.set(B256::ZERO);
        Ok(())
    }

    /// Set the key scheme phase.
    ///
    /// Called by: RotateOnChainKeyScheme (when Phase 2 is enacted via logic upgrade).
    pub fn set_key_scheme_phase(&mut self, phase: u8) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;
        self.key_scheme_phase.set(U8::from(phase));
        Ok(())
    }

    /// Permanently disable delete_policy_authorizer_key.
    ///
    /// Unconditional invariant: policy_delete_disabled is write-once-true.
    /// Once set, this contract will never allow delete_policy_authorizer_key
    /// to execute, regardless of which logic contract calls it.
    ///
    /// Called by: DisablePolicyDeletePermanently in the logic contract (RootPolicyBody quorum).
    pub fn disable_policy_delete_permanently(&mut self) -> Result<(), Vec<u8>> {
        self.require_logic_contract()?;
        if self.policy_delete_disabled.get() {
            return Err(E_POLICY_DELETE_ALREADY_DISABLED.to_vec());
        }
        self.policy_delete_disabled.set(true);
        Ok(())
    }

    /// Get the current value of policy_delete_disabled.
    pub fn get_policy_delete_disabled(&self) -> Result<bool, Vec<u8>> {
        Ok(self.policy_delete_disabled.get())
    }
}

// ─── Type aliases for Stylus primitives ──────────────────────────────────────

use stylus_sdk::alloy_primitives::{U8, U32, U64 as U64Prim};
type U64 = U64Prim;

// ─── ABI type note ───────────────────────────────────────────────────────────
//
// In Stylus SDK 0.8, Vec<u8> implements AbiType and maps to Solidity `bytes`.
// We use Vec<u8> directly for all `bytes` parameters and return values.
// No custom Bytes wrapper is needed.

// ─── Note on StorageBytes API ────────────────────────────────────────────────
//
// In Stylus SDK 0.8, StorageBytes provides native `get_bytes()` and `set_bytes()`
// methods directly on the struct. No extension trait is needed.
//
// API reference (stylus-sdk 0.8):
//   StorageBytes::get_bytes(&self) -> Vec<u8>
//   StorageBytes::set_bytes(&mut self, bytes: impl AsRef<[u8]>)
