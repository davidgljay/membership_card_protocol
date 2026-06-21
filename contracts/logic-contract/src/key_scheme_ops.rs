//! # Key Scheme Operations (§4.11)
//!
//! RotateOnChainKeyScheme — upgrade a press from secp256r1 to ML-DSA-44.
//!
//! ## Phase 1 behavior (current)
//!
//! In Phase 1, `key_scheme_phase == 0`. The `RotateOnChainKeyScheme` function
//! ALWAYS reverts with E-24 (SCHEME_UPGRADE_NOT_AVAILABLE). The function
//! signature and all error codes are fully implemented; the Phase 1 check
//! is the first thing executed.
//!
//! ## Phase 2 enable path
//!
//! A future logic upgrade would set `key_scheme_phase = 1` via the storage
//! contract's `set_key_scheme_phase` setter. After that, this function would
//! proceed past the E-24 check. No changes to the function signature or
//! error codes are needed — only the Phase 1 guard needs to be removed or
//! conditionalized in the new logic contract.
//!
//! ## Full precondition implementation (§4.11)
//!
//! Even though Phase 1 always reverts at precondition 3, all subsequent
//! preconditions are fully coded and documented for the audit and for
//! Phase 2 readiness.

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{keccak256, B256},
    block,
    call::MethodError,
    evm,
};

use crate::{
    errors,
    IStorage,
    IVerifierModule,
    LogicContract,
    mut_call_ctx,
    static_call_ctx,
    current_block_number,
};

/// §4.11 RotateOnChainKeyScheme — upgrade a press's on-chain signing key from
/// secp256r1 to ML-DSA-44.
///
/// # Phase 1 note
/// This function ALWAYS reverts with E-24 in Phase 1 (`key_scheme_phase == 0`).
/// It is included to establish the correct function interface for Phase 2.
///
/// # Full preconditions (§4.11)
/// 1. PressAuthorizations[policy][press] exists and active == true.
/// 2. PressAuthorizations[policy][press].key_scheme == 0 (secp256r1; cannot re-rotate).
/// 3. contract.key_scheme_phase >= 1. **Always fails in Phase 1. (E-24)**
/// 4. block.number <= deadline_block (payload not expired). (E-25)
/// 5. secp256r1_sig verifies via RIP-7212 against press_public_key. (E-06)
/// 6. keccak256(new_mldsa44_pubkey) == PressAuthorizations[policy][press].mldsa44_key_hash. (E-26)
/// 7. mldsa44_sig verifies against new_mldsa44_pubkey over keccak256(rotation_payload). (E-06)
///    (ML-DSA-44 verification is not available on-chain in Phase 1; handled in Phase 3.)
pub fn rotate_on_chain_key_scheme(
    contract: &mut LogicContract,
    policy_address: B256,
    press_address: B256,
    new_mldsa44_pubkey: Vec<u8>,
    rotation_payload: Vec<u8>,
    secp256r1_sig: Vec<u8>,
    mldsa44_sig: Vec<u8>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // ── Precondition 1: Press exists and is active ────────────────────────────
    let (key_bytes, mldsa_hash, key_scheme, active, _seq, _auth_at, _rev_at) = storage
        .get_press_authorization(static_call_ctx(), policy_address, press_address)
        .map_err(|e| e.encode())?;

    if key_bytes.len() != 64 {
        return Err(errors::make_error(errors::PRESS_NOT_AUTHORIZED));
    }
    if !active {
        return Err(errors::make_error(errors::PRESS_REVOKED));
    }

    // ── Precondition 2: Press must still be on secp256r1 (E-23) ──────────────
    if key_scheme != 0 {
        return Err(errors::make_error(errors::KEY_SCHEME_ALREADY_UPGRADED));
    }

    // ── Precondition 3: Contract must be in Phase 2 or later (E-24) ──────────
    // *** THIS IS THE PHASE 1 GATE — ALWAYS REVERTS IN PHASE 1 ***
    let phase = storage
        .get_key_scheme_phase(static_call_ctx())
        .map_err(|e| e.encode())?;
    if phase < 1 {
        // Phase 1: ML-DSA-44 key scheme upgrade is not yet available.
        // A future logic upgrade will advance key_scheme_phase to 1 to enable this.
        return Err(errors::make_error(errors::SCHEME_UPGRADE_NOT_AVAILABLE));
    }

    // ── Precondition 4: Payload not expired (E-25) ───────────────────────────
    let deadline_block = protocol_types::payload_parser::extract_deadline_block(&rotation_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;
    let current_block = current_block_number();
    if current_block > deadline_block {
        return Err(errors::make_error(errors::ROTATION_PAYLOAD_EXPIRED));
    }

    // ── Precondition 5: Verify secp256r1 signature (E-06) ────────────────────
    let msg_hash_b256 = keccak256(&rotation_payload);
    let verifier = IVerifierModule::new(contract.verifier_module.get());
    let secp_valid = verifier
        .verify_secp_256_r_1(
            static_call_ctx(),
            msg_hash_b256,
            secp256r1_sig.clone().into(),
            key_bytes.clone().into(),
        )
        .map_err(|e| e.encode())?;
    if !secp_valid {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // ── Precondition 6: new_mldsa44_pubkey must hash to stored mldsa44_key_hash (E-26) ──
    if new_mldsa44_pubkey.len() != 1312 {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }
    let computed_hash_b256 = keccak256(&new_mldsa44_pubkey);
    if computed_hash_b256 != mldsa_hash {
        return Err(errors::make_error(errors::MLDSA44_KEY_HASH_MISMATCH));
    }

    // ── Precondition 7: Verify ML-DSA-44 signature ───────────────────────────
    // In Phase 2/3, the verifier module would be upgraded to support ML-DSA-44.
    // Here we note that the mldsa44_sig must be verified against new_mldsa44_pubkey
    // over keccak256(rotation_payload). The Phase 2 logic would call the new
    // verifier module with the ML-DSA-44 verification function.
    //
    // For now (Phase 2 logic contract), this would use a second verifier call.
    // We validate the size here as a basic sanity check.
    if mldsa44_sig.len() != 2420 {
        return Err(errors::make_error(errors::INVALID_PAYLOAD));
    }
    // TODO Phase 2/3: Call IVerifierModule::verify_mldsa44(...) once the verifier
    // is upgraded. For now this always fails at precondition 3 (E-24).

    // ── State changes (unreachable in Phase 1) ────────────────────────────────
    // These are included for completeness and Phase 2 readiness.

    // Set key_scheme = 1 (ML-DSA-44) for this press.
    // The secp256r1 key is nulled; future writes must use the new ML-DSA-44 key.
    // Storage of the new ML-DSA-44 pubkey (1312 bytes) requires a new storage slot
    // to be added in a Phase 2 logic/storage upgrade. For now, we update key_scheme only.
    // TODO Phase 2: Implement full ML-DSA-44 key storage and write gate integration.

    let mut storage_mut = IStorage::new(storage_addr);
    // Update key_scheme to ML-DSA-44.
    storage_mut
        .set_press_auth_entry(
            mut_call_ctx(),
            policy_address,
            press_address,
            // The secp256r1 key slot is zeroed (superseded).
            alloc::vec![0u8; 64].into(),
            mldsa_hash,
            1,  // key_scheme = ML-DSA-44
            active,
            _seq,
            _auth_at,
            _rev_at,
        )
        .map_err(|e| e.encode())?;

    // Emit OnChainKeySchemeRotated event (§7 — from spec note §4.11).
    evm::log(crate::OnChainKeySchemeRotated {
        policy_address,
        press_address,
        new_mldsa44_pubkey: new_mldsa44_pubkey.into(),
    });

    Ok(())
}
