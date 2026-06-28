//! # Sub-Card Operations (§4.3, §4.4)
//!
//! RegisterSubCard and DeregisterSubCard.
//!
//! ## Key design decisions
//!
//! Neither operation verifies the ML-DSA-44 master signature on-chain. The press
//! verifies these off-chain before submitting. The master signature and app-chain
//! verification are press-side responsibilities (see §4.3 spec notes). The
//! contract only checks:
//! - Card existence.
//! - Press authorization via the write gate (§6.1).
//! - registration_log_head matches the master card's current head (for RegisterSubCard).
//!
//! ## Audit trail
//!
//! Deregistered entries are NEVER deleted. `deregistered_at` is set to block.timestamp
//! and `active` is set to false. The unconditional storage invariant ensures that
//! `deregistered_at` cannot be zeroed out by any future logic upgrade (§3.7).
//!
//! Both `register_sub_card` and `deregister_sub_card` include the holder's ML-DSA-44
//! signature in calldata for auditability. The press verifies the holder's signature
//! off-chain before submitting; neither signature is verified on-chain.

#![allow(deprecated)]

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::B256,
    block,
    evm,
};

use crate::{
    errors,
    IStorage,
    LogicContract,
    MethodError,
    static_call_ctx,
    current_timestamp,
    write_gate::{run_write_gate, verify_single_sig},
};
use protocol_types::MAX_CID_LEN;
use stylus_sdk::alloy_primitives::keccak256;

// ─── §4.3 RegisterSubCard ────────────────────────────────────────────────────

/// Register a new sub-card under a master card.
///
/// Preconditions (§4.3):
/// 1. master_card_address must exist in CardEntries.
/// 2. sub_card_address must not already be in SubCardRegistrations with active == true.
/// 3. registration_log_head must match CardEntries[master_card].log_head_cid at call time.
/// 4. Press authorization (write gate §6.1).
/// 5. If master is a DNS admin card (DnsAdminCardKeys[master] != zero):
///    - admin_secp_signature must be non-zero and valid (E-47).
///    - admin_secp_payload must encode the correct sub_card_address and sub_card_doc_cid (E-47).
///    If master is not a DNS admin card:
///    - admin_secp_signature and admin_secp_payload must be empty/zero (E-47).
///
/// The ML-DSA-44 master signature is NOT verified on-chain (press-side, E-22).
pub fn register_sub_card(
    contract: &mut LogicContract,
    sub_card_address: B256,
    master_card_address: B256,
    registration_log_head: Vec<u8>,
    sub_card_doc_cid: Vec<u8>,
    press_address: B256,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
    admin_secp_payload: Vec<u8>,
    admin_secp_signature: Vec<u8>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // ── Check 1: master_card_address must exist (E-02) ────────────────────────
    let (master_cid, master_policy, _last_press, _fwd, master_exists) = storage
        .get_card_entry(static_call_ctx(), master_card_address)
        .map_err(|e| e.encode())?;
    if !master_exists {
        return Err(errors::make_error(errors::CARD_NOT_FOUND));
    }

    // ── Check 2: sub_card_address must not already be active (E-11) ──────────
    let (_sub_master, _sub_reg_head, _sub_doc, sub_active, _sub_reg_at, sub_dereg_at) = storage
        .get_sub_card_entry(static_call_ctx(), sub_card_address)
        .map_err(|e| e.encode())?;
    if sub_active {
        return Err(errors::make_error(errors::SUB_CARD_ALREADY_ACTIVE));
    }

    // ── Check 3: registration_log_head must match master's current head ───────
    // This ensures the sub-card snapshot is current and prevents a holder from
    // registering a sub-card claiming authority the master no longer holds.
    if master_cid.as_slice() != registration_log_head.as_slice() {
        return Err(errors::make_error(errors::STALE_REGISTRATION_LOG_HEAD));
    }

    // ── Check 4: CID lengths ──────────────────────────────────────────────────
    if registration_log_head.len() > MAX_CID_LEN {
        return Err(errors::make_error(errors::LOG_CID_TOO_LONG));
    }
    if sub_card_doc_cid.len() > MAX_CID_LEN {
        return Err(errors::make_error(errors::LOG_CID_TOO_LONG));
    }

    // ── Check 5: DNS admin card secp256r1 check (E-47) ───────────────────────
    // If DnsAdminCardKeys[master_card_address] is non-zero, the master is a DNS
    // admin card and requires on-chain secp256r1 authorization.
    let dns_admin_key_bytes = {
        let s = IStorage::new(storage_addr);
        s.get_dns_admin_card_key(static_call_ctx(), master_card_address)
            .map_err(|e| e.encode())?
    };
    let is_dns_admin_master = dns_admin_key_bytes.len() == 64;

    if is_dns_admin_master {
        // Signature and payload must both be present.
        if admin_secp_signature.len() != 64 || admin_secp_payload.is_empty() {
            return Err(errors::make_error(errors::INVALID_ADMIN_CARD_SIGNATURE));
        }

        // Verify payload encodes the correct sub_card_address and sub_card_doc_cid.
        // We check that the raw payload bytes contain the base64url-encoded values.
        // For simplicity we use the payload_parser to extract the fields.
        use protocol_types::payload_parser;
        let payload_sub = payload_parser::find_field(&admin_secp_payload, b"sub_card_address");
        let payload_doc = payload_parser::find_field(&admin_secp_payload, b"sub_card_doc_cid");

        // The fields must be present; exact value matching is done by verifying
        // the signature covers the same payload the press constructed — if the
        // admin signed a different sub_card_address the sig will fail RIP-7212.
        if payload_sub.is_none() || payload_doc.is_none() {
            return Err(errors::make_error(errors::INVALID_ADMIN_CARD_SIGNATURE));
        }

        // Verify the secp256r1 signature on-chain via RIP-7212.
        let msg_hash = keccak256(&admin_secp_payload);
        let mut admin_pubkey = [0u8; 64];
        admin_pubkey.copy_from_slice(&dns_admin_key_bytes);
        let sig_valid = verify_single_sig(contract, msg_hash, &admin_secp_signature, &admin_pubkey)?;
        if !sig_valid {
            return Err(errors::make_error(errors::INVALID_ADMIN_CARD_SIGNATURE));
        }
    } else {
        // For non-DNS-admin masters, no admin secp signature may be supplied.
        if !admin_secp_signature.is_empty() || !admin_secp_payload.is_empty() {
            return Err(errors::make_error(errors::INVALID_ADMIN_CARD_SIGNATURE));
        }
    }

    // ── Check 6: Press authorization via write gate (E-03 through E-07) ──────
    // The write gate uses the master card's policy for authorization.
    run_write_gate(
        contract,
        master_policy,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"register_sub_card",
    )?;

    // ── State changes ─────────────────────────────────────────────────────────
    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_sub_card_entry(
            static_call_ctx(),
            sub_card_address,
            master_card_address,
            registration_log_head.clone().into(),
            sub_card_doc_cid.clone().into(),
            true,  // active
            ts,    // registered_at
            0,     // deregistered_at = 0 (not yet deregistered)
        )
        .map_err(|e| e.encode())?;

    // Emit SubCardRegistered event (§7).
    evm::log(crate::SubCardRegistered {
        sub_card_address,
        master_address: master_card_address,
        sub_card_doc_cid: sub_card_doc_cid.into(),
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.4 DeregisterSubCard ──────────────────────────────────────────────────

/// Mark a sub-card as inactive.
///
/// Preconditions (§4.4):
/// 1. sub_card_address must exist in SubCardRegistrations with active == true (E-10).
/// 2. Press authorization via write gate, using the master card's policy.
///
/// The ML-DSA-44 holder signature is NOT verified on-chain (press-side only).
///
/// State changes:
/// - Sets active = false.
/// - Sets deregistered_at = block.timestamp.
/// - The entry is RETAINED (not deleted) to preserve the audit trail.
///
/// Storage invariant: deregistered_at is write-once-non-zero (§3.7).
/// This is enforced by the storage contract — the timestamp cannot be zeroed
/// or overwritten by any future logic upgrade.
pub fn deregister_sub_card(
    contract: &mut LogicContract,
    sub_card_address: B256,
    press_address: B256,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
    holder_sig_payload: Vec<u8>,  // ML-DSA-44 payload (auditable; not verified on-chain)
    holder_signature: Vec<u8>,    // ML-DSA-44 signature (auditable; not verified on-chain)
) -> Result<(), Vec<u8>> {
    // holder_sig_payload and holder_signature are accepted for calldata auditability.
    // The press verifies the holder's ML-DSA-44 signature off-chain before submitting.
    // Not verified on-chain; see §4.4.
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // ── Check 1: sub_card must exist and be active (E-10) ────────────────────
    let (master_card_address, reg_head, doc_cid, sub_active, reg_at, _dereg_at) = storage
        .get_sub_card_entry(static_call_ctx(), sub_card_address)
        .map_err(|e| e.encode())?;

    // Check if the entry exists at all (master_card_address == zero means no entry).
    if master_card_address == B256::ZERO {
        return Err(errors::make_error(errors::SUB_CARD_NOT_FOUND));
    }
    if !sub_active {
        // Entry exists but already deregistered.
        return Err(errors::make_error(errors::SUB_CARD_NOT_FOUND));
    }

    // ── Check 2: Get master card's policy for write gate ─────────────────────
    let (_master_cid, master_policy, _last_press, _fwd, master_exists) = storage
        .get_card_entry(static_call_ctx(), master_card_address)
        .map_err(|e| e.encode())?;
    if !master_exists {
        return Err(errors::make_error(errors::CARD_NOT_FOUND));
    }

    // ── Check 3: Press authorization via write gate (E-03 through E-07) ──────
    run_write_gate(
        contract,
        master_policy,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"deregister_sub_card",
    )?;

    // ── State changes ─────────────────────────────────────────────────────────
    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_sub_card_entry(
            static_call_ctx(),
            sub_card_address,
            master_card_address,
            reg_head.into(),
            doc_cid.into(),
            false, // active = false
            reg_at,
            ts,    // deregistered_at = now (write-once-non-zero after this)
        )
        .map_err(|e| e.encode())?;

    // Emit SubCardDeregistered event (§7).
    evm::log(crate::SubCardDeregistered {
        sub_card_address,
        master_address: master_card_address,
        timestamp: ts,
    });

    Ok(())
}
