//! # Upgrade Operations (§4.14, §6.3)
//!
//! The three-step logic upgrade lifecycle and verifier upgrade lifecycle.
//!
//! ## Logic upgrade lifecycle (§4.14)
//!
//! 1. `ProposeLogicUpgrade` — Governance submits a proposal. The proposed address
//!    and metadata are written to storage. A 7-day timelock starts.
//! 2. `ConfirmLogicUpgrade` — After 7 days, governance submits a FRESH quorum signature.
//!    The storage contract's LogicContract address is updated. From that point, the
//!    current logic contract (this one) can no longer write to storage.
//! 3. `CancelLogicUpgrade` — Governance cancels a pending proposal at any time.
//!
//! ## Verifier upgrade lifecycle (§6.3)
//!
//! Same three-step pattern, but:
//! - 48-hour timelock (not 7 days).
//! - The verifier address is stored in THIS contract (not the storage contract).
//! - A verifier upgrade does not require a logic upgrade.
//!
//! ## Security notes for auditors
//!
//! - **Fresh signatures required at confirmation.** The nonce in the confirmation payload
//!   must differ from the proposal nonce. Since nonces are marked as used, replaying
//!   the proposal signature as a confirmation signature will fail with E-07G (NONCE_REUSED).
//! - **Version staleness detection.** If the governance keyset is rotated between proposal
//!   and confirmation, the proposal is stale: the governance_version in the confirmation
//!   payload must match the current stored version, which differs from what was embedded
//!   in the pending upgrade record. This triggers E-15.
//! - **After ConfirmLogicUpgrade**, this contract can no longer write to storage.
//!   All storage setters will revert with E-29. The new logic contract takes over.
//! - **No no-op upgrades.** The proposed address must differ from the current LogicContract
//!   and must not be zero.

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{Address, B256},
    call::MethodError,
    evm,
};

use crate::{
    errors,
    IStorage,
    LogicContract,
    mut_call_ctx,
    static_call_ctx,
    current_timestamp,
    write_gate::verify_governance_quorum,
};
use protocol_types::{LOGIC_UPGRADE_TIMELOCK_SECS, VERIFIER_UPGRADE_TIMELOCK_SECS};

// Governance body ID for RootPolicyBody.
const ROOT_POLICY_BODY: u8 = 0;

// ─── §4.14 ProposeLogicUpgrade ───────────────────────────────────────────────

/// Propose a new logic contract (7-day timelock, RootPolicyBody quorum).
///
/// Preconditions (§4.14):
/// 1. No pending proposal exists (E-30).
/// 2. new_logic_address != zero AND != current logic contract.
/// 3. Quorum signature check (§6.2, RootPolicyBody).
pub fn propose_logic_upgrade(
    contract: &mut LogicContract,
    new_logic_address: Address,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check 1: No pending proposal (E-30).
    let (pending_addr, _pending_at, _pending_ver, _pending_nonce) = storage
        .get_pending_logic_upgrade(static_call_ctx())
        .map_err(|e| e.encode())?;
    if pending_addr != Address::ZERO {
        return Err(errors::make_error(errors::UPGRADE_ALREADY_PENDING));
    }

    // Pre-check 2: Address validity.
    if new_logic_address == Address::ZERO {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }
    let current_logic = storage
        .get_logic_contract(static_call_ctx())
        .map_err(|e| e.encode())?;
    if new_logic_address == current_logic {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }

    // Pre-check 3: Quorum verification.
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Get current governance version for the proposal record.
    let (_keys, _count, _quorum, governance_version, _scheme) = storage
        .get_governance_keyset(static_call_ctx(), ROOT_POLICY_BODY)
        .map_err(|e| e.encode())?;

    // Extract nonce from payload for the proposal record.
    let nonce_raw = protocol_types::payload_parser::extract_nonce_bytes(&governance_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;
    let nonce_b256 = stylus_sdk::alloy_primitives::keccak256(nonce_raw);

    // Write the pending upgrade proposal.
    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_pending_logic_upgrade(
            mut_call_ctx(),
            new_logic_address,
            ts,
            governance_version,
            nonce_b256,
        )
        .map_err(|e| e.encode())?;

    // Emit LogicUpgradeProposed event (§7).
    let timelock_expires = ts + LOGIC_UPGRADE_TIMELOCK_SECS;
    evm::log(crate::LogicUpgradeProposed {
        proposed_address: new_logic_address,
        proposed_at: ts,
        timelock_expires,
    });

    Ok(())
}

// ─── §4.14 ConfirmLogicUpgrade ───────────────────────────────────────────────

/// Execute the logic upgrade after the 7-day timelock (fresh quorum signatures required).
///
/// Preconditions (§4.14):
/// 1. A pending proposal exists.
/// 2. proposed_logic_address == PendingLogicUpgrade.proposed_address (E-32).
/// 3. block.timestamp >= PendingLogicUpgrade.proposed_at + 7 days (E-31).
/// 4. GovernanceKeysets[RootPolicyBody].version == PendingLogicUpgrade.governance_version (E-15).
/// 5. Fresh quorum signature (different nonce from proposal).
///
/// Security: After this call, the current logic contract can NO longer write to storage.
/// The storage contract's LogicContract is updated to new_logic_address.
pub fn confirm_logic_upgrade(
    contract: &mut LogicContract,
    proposed_logic_address: Address,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check 1 & 2: Pending proposal must exist and address must match (E-32).
    let (pending_addr, pending_at, pending_gov_ver, _pending_nonce) = storage
        .get_pending_logic_upgrade(static_call_ctx())
        .map_err(|e| e.encode())?;
    if pending_addr == Address::ZERO {
        return Err(errors::make_error(errors::NO_UPGRADE_PENDING));
    }
    if proposed_logic_address != pending_addr {
        return Err(errors::make_error(errors::UPGRADE_ADDRESS_MISMATCH));
    }

    // Pre-check 3: Timelock elapsed (E-31).
    let now = current_timestamp();
    if now < pending_at + LOGIC_UPGRADE_TIMELOCK_SECS {
        return Err(errors::make_error(errors::UPGRADE_TIMELOCK_NOT_ELAPSED));
    }

    // Pre-check 4: Governance version must match proposal version (E-15).
    // If the keyset was rotated between proposal and confirmation, this fails.
    let (_keys, _count, _quorum, current_gov_ver, _scheme) = storage
        .get_governance_keyset(static_call_ctx(), ROOT_POLICY_BODY)
        .map_err(|e| e.encode())?;
    if current_gov_ver != pending_gov_ver {
        return Err(errors::make_error(errors::GOVERNANCE_VERSION_MISMATCH));
    }

    // Pre-check 5: Fresh quorum signature verification.
    // The nonce is different from the proposal nonce because:
    // (a) the proposal nonce was already marked as used.
    // (b) the confirmation payload has a different nonce field.
    // The quorum verifier will reject a reused nonce with E-07G.
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // ── State changes ─────────────────────────────────────────────────────────
    let mut storage_mut = IStorage::new(storage_addr);

    // Clear the pending upgrade proposal BEFORE updating LogicContract.
    // Order matters: if we update LogicContract first, this contract can no longer
    // call storage setters (including clear_pending_logic_upgrade).
    storage_mut
        .clear_pending_logic_upgrade(mut_call_ctx())
        .map_err(|e| e.encode())?;

    // Update the LogicContract address.
    // After this call, this contract can NO longer call any storage setter.
    // The new logic contract is now in control.
    storage_mut
        .set_logic_contract(mut_call_ctx(), proposed_logic_address)
        .map_err(|e| e.encode())?;

    // Emit LogicUpgradeConfirmed event (§7).
    evm::log(crate::LogicUpgradeConfirmed {
        new_logic_address: proposed_logic_address,
        confirmed_at: now,
    });

    Ok(())
}

// ─── §4.14 CancelLogicUpgrade ────────────────────────────────────────────────

/// Cancel a pending logic upgrade proposal (RootPolicyBody quorum).
///
/// Preconditions (§4.14):
/// 1. A pending proposal exists.
/// 2. Quorum signature check.
pub fn cancel_logic_upgrade(
    contract: &mut LogicContract,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: Pending proposal must exist.
    let (pending_addr, _at, _ver, _nonce) = storage
        .get_pending_logic_upgrade(static_call_ctx())
        .map_err(|e| e.encode())?;
    if pending_addr == Address::ZERO {
        return Err(errors::make_error(errors::NO_UPGRADE_PENDING));
    }

    // Quorum verification.
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Clear the pending upgrade.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .clear_pending_logic_upgrade(mut_call_ctx())
        .map_err(|e| e.encode())?;

    // Emit LogicUpgradeCancelled event (§7).
    let ts = current_timestamp();
    evm::log(crate::LogicUpgradeCancelled {
        cancelled_address: pending_addr,
        cancelled_at: ts,
    });

    Ok(())
}

// ─── §6.3 ProposeVerifierUpgrade ─────────────────────────────────────────────

/// Propose a new verifier module (48-hour timelock, RootPolicyBody quorum).
///
/// The verifier address is stored in THIS contract (not the storage contract).
/// A verifier upgrade does not require a logic upgrade.
pub fn propose_verifier_upgrade(
    contract: &mut LogicContract,
    new_verifier_address: Address,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    // Pre-check 1: No pending verifier proposal.
    let pending_addr = contract.pending_verifier_proposed_address.get();
    if pending_addr != Address::ZERO {
        return Err(errors::make_error(errors::UPGRADE_ALREADY_PENDING));
    }

    // Pre-check 2: Address validity.
    if new_verifier_address == Address::ZERO {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }
    if new_verifier_address == contract.verifier_module.get() {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }

    // Pre-check 3: Quorum verification.
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Get governance version and nonce.
    let storage = IStorage::new(contract.storage_contract.get());
    let (_keys, _count, _quorum, governance_version, _scheme) = storage
        .get_governance_keyset(static_call_ctx(), ROOT_POLICY_BODY)
        .map_err(|e| e.encode())?;

    let nonce_raw = protocol_types::payload_parser::extract_nonce_bytes(&governance_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;
    let nonce_b256 = stylus_sdk::alloy_primitives::keccak256(nonce_raw);

    // Write proposal state to this contract's storage.
    let ts = current_timestamp();
    contract.pending_verifier_proposed_address.set(new_verifier_address);
    contract.pending_verifier_proposed_at.set(stylus_sdk::alloy_primitives::U64::from(ts));
    contract.pending_verifier_governance_version.set(stylus_sdk::alloy_primitives::U32::from(governance_version));
    contract.pending_verifier_nonce.set(nonce_b256);

    // Emit VerifierUpgradeProposed event.
    let timelock_expires = ts + VERIFIER_UPGRADE_TIMELOCK_SECS;
    evm::log(crate::VerifierUpgradeProposed {
        proposed_address: new_verifier_address,
        proposed_at: ts,
        timelock_expires,
    });

    Ok(())
}

// ─── §6.3 ConfirmVerifierUpgrade ─────────────────────────────────────────────

/// Execute the verifier upgrade after the 48-hour timelock.
pub fn confirm_verifier_upgrade(
    contract: &mut LogicContract,
    proposed_verifier_address: Address,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    // Pre-check 1 & 2: Pending proposal and address match.
    let pending_addr = contract.pending_verifier_proposed_address.get();
    if pending_addr == Address::ZERO {
        return Err(errors::make_error(errors::NO_UPGRADE_PENDING));
    }
    if proposed_verifier_address != pending_addr {
        return Err(errors::make_error(errors::UPGRADE_ADDRESS_MISMATCH));
    }

    // Pre-check 3: Timelock elapsed (48 hours).
    let pending_at = contract.pending_verifier_proposed_at.get().to::<u64>();
    let now = current_timestamp();
    if now < pending_at + VERIFIER_UPGRADE_TIMELOCK_SECS {
        return Err(errors::make_error(errors::UPGRADE_TIMELOCK_NOT_ELAPSED));
    }

    // Pre-check 4: Governance version match.
    let pending_gov_ver = contract.pending_verifier_governance_version.get().to::<u32>();
    let storage = IStorage::new(contract.storage_contract.get());
    let (_keys, _count, _quorum, current_gov_ver, _scheme) = storage
        .get_governance_keyset(static_call_ctx(), ROOT_POLICY_BODY)
        .map_err(|e| e.encode())?;
    if current_gov_ver != pending_gov_ver {
        return Err(errors::make_error(errors::GOVERNANCE_VERSION_MISMATCH));
    }

    // Pre-check 5: Fresh quorum signature.
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Clear proposal state.
    contract.pending_verifier_proposed_address.set(Address::ZERO);
    contract.pending_verifier_proposed_at.set(stylus_sdk::alloy_primitives::U64::from(0u64));
    contract.pending_verifier_governance_version.set(stylus_sdk::alloy_primitives::U32::from(0u32));
    contract.pending_verifier_nonce.set(B256::ZERO);

    // Update verifier module address.
    contract.verifier_module.set(proposed_verifier_address);

    // Emit VerifierUpgradeConfirmed event.
    evm::log(crate::VerifierUpgradeConfirmed {
        new_verifier_address: proposed_verifier_address,
        confirmed_at: now,
    });

    Ok(())
}

// ─── §6.3 CancelVerifierUpgrade ──────────────────────────────────────────────

/// Cancel a pending verifier upgrade proposal.
pub fn cancel_verifier_upgrade(
    contract: &mut LogicContract,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let pending_addr = contract.pending_verifier_proposed_address.get();
    if pending_addr == Address::ZERO {
        return Err(errors::make_error(errors::NO_UPGRADE_PENDING));
    }

    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Clear proposal state.
    contract.pending_verifier_proposed_address.set(Address::ZERO);
    contract.pending_verifier_proposed_at.set(stylus_sdk::alloy_primitives::U64::from(0u64));
    contract.pending_verifier_governance_version.set(stylus_sdk::alloy_primitives::U32::from(0u32));
    contract.pending_verifier_nonce.set(B256::ZERO);

    let ts = current_timestamp();
    evm::log(crate::VerifierUpgradeCancelled {
        cancelled_address: pending_addr,
        cancelled_at: ts,
    });

    Ok(())
}
