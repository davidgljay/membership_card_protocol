//! # Governance Operations (§4.6–4.10)
//!
//! All operations that modify the governance tables:
//! - RegisterPolicy (§4.6) — RootPolicyBody quorum
//! - DeregisterPolicy stub (OQ-E) — RootPolicyBody quorum, WITH WARNING
//! - AuthorizePress (§4.7) — PressRegistryBody quorum
//! - RevokePress (§4.8) — PressRegistryBody quorum
//! - RotateAuthorizerKey (§4.9) — RootPolicyBody quorum
//! - RotateGovernanceKeys (§4.10) — Self-amending (the body being rotated)
//!
//! ## Security notes for auditors
//!
//! - Every governance operation calls `verify_governance_quorum` (§6.2) before
//!   making any state changes. The quorum check marks the nonce as used.
//! - RotateGovernanceKeys uses the CURRENT keyset to verify signatures, not the
//!   proposed new keyset. This is the critical self-amending property.
//! - After RotateGovernanceKeys increments the version, any pending governance
//!   actions (including pending logic upgrades) that embedded the old version
//!   in their payload are invalidated. The governance_version check in subsequent
//!   operations will fail until those proposals are resubmitted.
//! - DeregisterPolicy is a DESTRUCTIVE operation. See the WARNING comment in that
//!   function. It is governed by RootPolicyBody quorum.

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::B256,
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
use protocol_types::MIN_GOVERNANCE_KEYS;

// Governance body IDs.
const ROOT_POLICY_BODY: u8 = 0;
const PRESS_REGISTRY_BODY: u8 = 1;

// ─── §4.6 RegisterPolicy ─────────────────────────────────────────────────────

/// Register a new root policy (RootPolicyBody quorum required).
///
/// Preconditions (§4.6):
/// 1. policy_address must NOT already exist in PolicyAuthorizerKeys (E-09).
/// 2. Quorum signature check (§6.2, RootPolicyBody).
pub fn register_policy(
    contract: &mut LogicContract,
    policy_address: B256,
    authorizer_pubkey: Vec<u8>,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: policy must not already exist (E-09).
    let already_exists = storage
        .policy_exists(static_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;
    if already_exists {
        return Err(errors::make_error(errors::POLICY_ALREADY_REGISTERED));
    }

    // Authorizer pubkey must be 64 bytes (secp256r1 x||y).
    if authorizer_pubkey.len() != 64 {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }

    // Quorum verification (marks nonce as used).
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Write the policy authorizer key.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_policy_authorizer_key(
            mut_call_ctx(),
            policy_address,
            authorizer_pubkey.into(),
        )
        .map_err(|e| e.encode())?;

    // Emit PolicyRegistered event (§7).
    let ts = current_timestamp();
    evm::log(crate::PolicyRegistered {
        policy_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── DeregisterPolicy stub (OQ-E decision) ───────────────────────────────────

/// Deregister a root policy (RootPolicyBody quorum required).
///
/// ⚠️ SECURITY WARNING ⚠️
///
/// This operation is IRREVERSIBLE and DESTRUCTIVE:
/// - After deregistration, ALL presses authorized under this policy lose write authority.
/// - ALL cards issued under this policy become permanently non-writable.
/// - There is no re-registration path — a new policy address must be issued.
///
/// Unlike the unconditional storage invariants protecting card entries and timestamps,
/// PolicyAuthorizerKeys has no unconditional delete protection (OQ-E decision, §3.7).
/// The only protection is the governance quorum gate here.
///
/// This operation should ONLY be called in extreme circumstances (compromised policy key
/// that cannot be rotated, permanent abandonment of a policy). The governance body must
/// have a clear plan for migrating all cards to new policies before calling this.
///
/// OPEN QUESTION OQ-20: Whether policy deregistration should even be supported is
/// still under discussion. This stub exists per the implementation plan but may be
/// disabled in production pending governance charter resolution.
pub fn deregister_policy(
    contract: &mut LogicContract,
    policy_address: B256,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: policy must exist.
    let exists = storage
        .policy_exists(static_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;
    if !exists {
        return Err(errors::make_error(errors::UNRECOGNIZED_POLICY));
    }

    // Quorum verification (marks nonce as used).
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Delete the policy authorizer key.
    // This is the only setter without unconditional invariant protection.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .delete_policy_authorizer_key(mut_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;

    // No event defined in spec for DeregisterPolicy (OQ-20 unresolved).
    // We emit PolicyRegistered is wrong; no event to emit here.
    // TODO: Add PolicyDeregistered event once OQ-20 is resolved.

    Ok(())
}

// ─── §4.7 AuthorizePress ─────────────────────────────────────────────────────

/// Authorize a press to write under a policy (PressRegistryBody quorum).
///
/// Preconditions (§4.7):
/// 1. policy_address must exist in PolicyAuthorizerKeys (E-03).
/// 2. Quorum signature check (§6.2, PressRegistryBody).
///
/// This operation can be called again with the same press_address to rotate
/// the secp256r1 signing key (key rotation per §4.7 note).
/// In that case: press_public_key is overwritten, active is reset to true,
/// next_sequence is reset to 0 (per spec — "Resets to 0 on key rotation").
pub fn authorize_press(
    contract: &mut LogicContract,
    policy_address: B256,
    press_address: B256,
    press_pubkey: Vec<u8>,
    mldsa44_key_hash: B256,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check 1: policy must exist (E-03).
    let policy_exists = storage
        .policy_exists(static_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;
    if !policy_exists {
        return Err(errors::make_error(errors::UNRECOGNIZED_POLICY));
    }

    // Press pubkey must be 64 bytes.
    if press_pubkey.len() != 64 {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }

    // Pre-check 2: Quorum verification (marks nonce as used).
    verify_governance_quorum(contract, PRESS_REGISTRY_BODY, &governance_payload, &governance_sigs)?;

    // Write the press authorization entry.
    // next_sequence = 0 (new authorization or key rotation reset).
    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_press_auth_entry(
            mut_call_ctx(),
            policy_address,
            press_address,
            press_pubkey.into(),
            mldsa44_key_hash,
            0,      // key_scheme = secp256r1 (Phase 1)
            true,   // active = true
            0,      // next_sequence = 0 (reset on authorize/re-authorize)
            ts,     // authorized_at = now
            0,      // revoked_at = 0 (not revoked)
        )
        .map_err(|e| e.encode())?;

    // Emit PressAuthorized event (§7).
    evm::log(crate::PressAuthorized {
        policy_address,
        press_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.8 RevokePress ────────────────────────────────────────────────────────

/// Revoke a press authorization (PressRegistryBody quorum).
///
/// Preconditions (§4.8):
/// 1. PressAuthorizations[policy][press] must exist and active == true (E-04/E-05).
/// 2. Quorum signature check (§6.2, PressRegistryBody).
///
/// The entry is retained with active = false (not deleted) to preserve the audit trail.
/// The revoked_at timestamp is write-once-non-zero (§3.7 storage invariant).
pub fn revoke_press(
    contract: &mut LogicContract,
    policy_address: B256,
    press_address: B256,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: entry must exist and be active.
    let (key_bytes, mldsa_hash, scheme, active, seq, auth_at, _rev_at) = storage
        .get_press_authorization(static_call_ctx(), policy_address, press_address)
        .map_err(|e| e.encode())?;

    if key_bytes.len() != 64 {
        return Err(errors::make_error(errors::PRESS_NOT_AUTHORIZED));
    }
    if !active {
        return Err(errors::make_error(errors::PRESS_REVOKED));
    }

    // Quorum verification.
    verify_governance_quorum(contract, PRESS_REGISTRY_BODY, &governance_payload, &governance_sigs)?;

    // Write the updated entry with active = false and revoked_at = now.
    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_press_auth_entry(
            mut_call_ctx(),
            policy_address,
            press_address,
            key_bytes.into(),
            mldsa_hash,
            scheme,
            false,  // active = false
            seq,    // retain next_sequence
            auth_at,
            ts,     // revoked_at = now (write-once-non-zero after this)
        )
        .map_err(|e| e.encode())?;

    // Emit PressRevoked event (§7).
    evm::log(crate::PressRevoked {
        policy_address,
        press_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.9 RotateAuthorizerKey ────────────────────────────────────────────────

/// Replace the authorizer key for a policy (RootPolicyBody quorum).
///
/// Preconditions (§4.9):
/// 1. policy_address must exist in PolicyAuthorizerKeys (E-03).
/// 2. Quorum signature check (§6.2, RootPolicyBody).
pub fn rotate_authorizer_key(
    contract: &mut LogicContract,
    policy_address: B256,
    new_authorizer_key: Vec<u8>,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check 1: policy must exist (E-03).
    let exists = storage
        .policy_exists(static_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;
    if !exists {
        return Err(errors::make_error(errors::UNRECOGNIZED_POLICY));
    }

    // New key must be 64 bytes (secp256r1).
    if new_authorizer_key.len() != 64 {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }

    // Pre-check 2: Quorum verification.
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Overwrite the policy authorizer key.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_policy_authorizer_key(
            mut_call_ctx(),
            policy_address,
            new_authorizer_key.into(),
        )
        .map_err(|e| e.encode())?;

    // Emit AuthorizerKeyRotated event (§7).
    let ts = current_timestamp();
    evm::log(crate::AuthorizerKeyRotated {
        policy_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.10 RotateGovernanceKeys ──────────────────────────────────────────────

/// Replace the key set for a governance body (self-amending).
///
/// This is the most security-critical governance operation. Key properties:
///
/// - Signatures are from the CURRENT keyset, not the proposed new keys.
/// - `new_quorum > len(new_keys) / 2` (majority requirement, E-19).
/// - `len(new_keys) >= MIN_GOVERNANCE_KEYS` (= 3, E-20).
/// - `version` is incremented after rotation, invalidating any pending
///   governance actions that embedded the old version.
///
/// ## Bootstrap note (§3.6)
/// The initial keyset is 1-of-1 with the deployer's key (quorum=1, len=1).
/// The FIRST RotateGovernanceKeys call must propose at least 3 keys (E-20).
/// This means you cannot go from 1-of-1 to 2-of-2; you must go to N >= 3.
pub fn rotate_governance_keys(
    contract: &mut LogicContract,
    body_id: u8,
    new_keys_flat: Vec<u8>,
    new_key_count: u8,
    new_quorum: u8,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // ── Pre-check 1: Validate new key count (E-20) ────────────────────────────
    let new_count_usize = new_key_count as usize;
    if new_count_usize < MIN_GOVERNANCE_KEYS {
        return Err(errors::make_error(errors::KEYSET_TOO_SMALL));
    }

    // ── Pre-check 2: Validate new quorum (E-19) ───────────────────────────────
    // new_quorum must be > len(new_keys) / 2 (strict majority).
    // For 3 keys: quorum >= 2; for 5 keys: quorum >= 3.
    if (new_quorum as usize) <= new_count_usize / 2 {
        return Err(errors::make_error(errors::QUORUM_TOO_LOW));
    }

    // ── Pre-check 3: keys_flat must be exactly key_count * 64 bytes ───────────
    if new_keys_flat.len() != new_count_usize * 64 {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }

    // ── Pre-check 4: Quorum verification using CURRENT keyset ────────────────
    // Critical: signatures are verified against the current keyset, not the new one.
    verify_governance_quorum(contract, body_id, &governance_payload, &governance_sigs)?;

    // ── Get current version for the increment ─────────────────────────────────
    let (_keys, _count, _quorum, current_version, _scheme) = storage
        .get_governance_keyset(static_call_ctx(), body_id)
        .map_err(|e| e.encode())?;

    let new_version = current_version + 1;

    // ── Write the new keyset ──────────────────────────────────────────────────
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_governance_keyset(
            mut_call_ctx(),
            body_id,
            new_keys_flat.into(),
            new_key_count,
            new_quorum,
            new_version,
            0,  // key_scheme stays secp256r1 in Phase 1
        )
        .map_err(|e| e.encode())?;

    // Emit GovernanceKeysRotated event (§7).
    let ts = current_timestamp();
    evm::log(crate::GovernanceKeysRotated {
        body_id,
        new_quorum,
        key_count: new_key_count,
        version: new_version,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.16 DisablePolicyDeletePermanently ────────────────────────────────────

/// Permanently disable DeregisterPolicy (RootPolicyBody quorum required).
///
/// Preconditions (§4.16):
/// 1. PolicyDeleteDisabled == false (E-36).
/// 2. Quorum signature check (§6.2, RootPolicyBody).
///
/// This is irreversible. Once called, no future logic contract can ever
/// delete a policy authorizer key.
pub fn disable_policy_delete_permanently(
    contract: &mut LogicContract,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: not already disabled (E-36).
    let already_disabled = storage
        .get_policy_delete_disabled(static_call_ctx())
        .map_err(|e| e.encode())?;
    if already_disabled {
        return Err(errors::make_error(errors::POLICY_DELETE_ALREADY_DISABLED));
    }

    // Quorum verification (marks nonce as used).
    verify_governance_quorum(contract, ROOT_POLICY_BODY, &governance_payload, &governance_sigs)?;

    // Set the permanent disable flag in the storage contract.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .disable_policy_delete_permanently(mut_call_ctx())
        .map_err(|e| e.encode())?;

    // Emit event.
    let ts = current_timestamp();
    evm::log(crate::PolicyDeletePermanentlyDisabled { timestamp: ts });

    Ok(())
}
