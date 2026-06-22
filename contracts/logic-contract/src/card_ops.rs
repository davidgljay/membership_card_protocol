//! # Card Write Operations (§4.1, §4.2, §4.5, §4.13, §4.15)
//!
//! All operations that create or update card entries.
//!
//! ## Security notes for auditors
//!
//! - Every card write goes through the write gate (§6.1). The only exception is
//!   RegisterAddressForward, which uses a two-signature model: the holder's ML-DSA-44
//!   signature (verified off-chain by the press) and the press's secp256r1 signature
//!   over keccak256(holder_sig_payload). Any currently-authorized press under the old
//!   card's policy may submit — there is no restriction to the last writer.
//! - BatchUpdateCardHeads is atomic: ALL items are validated before ANY state change.
//!   A single failure reverts the entire batch.
//! - The `op` field check in the write gate prevents cross-operation replay attacks.
//! - All CID lengths are checked against MAX_CID_LEN (64 bytes) before storage writes.
//! - The `prev_log_cid` check in UpdateCardHead is an optimistic concurrency control
//!   mechanism that prevents lost-update races between two presses writing the same card.

#![allow(deprecated)]

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{keccak256, B256},
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
    write_gate::{run_write_gate, validate_write_gate_only, verify_single_sig},
};
use protocol_types::{MAX_CID_LEN, MAX_BATCH_SIZE};

// ─── §4.1 RegisterCard ───────────────────────────────────────────────────────

/// Register a new card.
///
/// Preconditions (from spec §4.1):
/// 1. card_address does not already exist in CardEntries.
/// 2. policy_address exists in PolicyAuthorizerKeys.
/// 3. PressAuthorizations[policy][press] exists and active == true.
/// 4. press_signature verifies against press_public_key over press_sig_payload.
/// 5. sequence in press_sig_payload == next_sequence. Increment on success.
///
/// State changes:
/// - Creates CardEntries[card_address] = { log_head_cid: initial_log_cid,
///   policy_address, last_press_address: press_address, exists: true }.
pub fn register_card(
    contract: &mut LogicContract,
    card_address: B256,
    initial_log_cid: Vec<u8>,
    policy_address: B256,
    press_address: B256,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: card must not already exist (E-01).
    let exists = storage
        .card_exists(static_call_ctx(), card_address)
        .map_err(|e| e.encode())?;
    if exists {
        return Err(errors::make_error(errors::CARD_ALREADY_EXISTS));
    }

    // CID length check (E-21).
    if initial_log_cid.len() > MAX_CID_LEN {
        return Err(errors::make_error(errors::LOG_CID_TOO_LONG));
    }

    // Run write gate (E-03, E-04, E-05, E-06, op check, E-07).
    // This also increments next_sequence on success.
    run_write_gate(
        contract,
        policy_address,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"register_card",
    )?;

    // Write the card entry.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_card_entry(
            static_call_ctx(),
            card_address,
            initial_log_cid.clone().into(),
            policy_address,
            press_address,
            true,
        )
        .map_err(|e| e.encode())?;

    // Emit CardRegistered event (§7).
    let ts = current_timestamp();
    evm::log(crate::CardRegistered {
        card_address,
        policy_address,
        press_address,
        initial_log_cid: initial_log_cid.into(),
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.2 UpdateCardHead ─────────────────────────────────────────────────────

/// Advance a card's log head to a new CID.
///
/// Additional precondition beyond the write gate:
/// - card_address must exist (E-02).
/// - prev_log_cid must match the current stored head (E-08, optimistic concurrency).
pub fn update_card_head(
    contract: &mut LogicContract,
    card_address: B256,
    new_log_cid: Vec<u8>,
    prev_log_cid: Vec<u8>,
    press_address: B256,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check: card must exist (E-02).
    let (stored_cid, policy_address, _last_press, _fwd, exists) = storage
        .get_card_entry(static_call_ctx(), card_address)
        .map_err(|e| e.encode())?;
    if !exists {
        return Err(errors::make_error(errors::CARD_NOT_FOUND));
    }

    // CID length checks (E-21).
    if new_log_cid.len() > MAX_CID_LEN {
        return Err(errors::make_error(errors::LOG_CID_TOO_LONG));
    }

    // Run write gate (E-03 through E-07).
    run_write_gate(
        contract,
        policy_address,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"update_card_head",
    )?;

    // Step 7 (UpdateCardHead-specific): prev_log_cid must match stored head (E-08).
    // Although the write gate incremented next_sequence via a cross-contract call before
    // this check runs, a revert here rolls back ALL state changes in the call stack —
    // including that increment. No sequence number is consumed on E-08 failure.
    // The optimistic concurrency check is done here to prevent a press from writing
    // on top of a stale view of the card.
    if stored_cid.as_ref() != prev_log_cid.as_slice() {
        return Err(errors::make_error(errors::STALE_PREV_CID));
    }

    // Write the updated head.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .update_card_head(
            static_call_ctx(),
            card_address,
            new_log_cid.clone().into(),
            press_address,
        )
        .map_err(|e| e.encode())?;

    // Emit CardHeadUpdated event (§7).
    let ts = current_timestamp();
    evm::log(crate::CardHeadUpdated {
        card_address,
        prev_log_cid: prev_log_cid.into(),
        new_log_cid: new_log_cid.into(),
        press_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.5 ClaimOpenOffer ─────────────────────────────────────────────────────

/// Atomically claim an open offer and register a new card.
///
/// All preconditions are checked before any state change:
/// - expires_at == 0 OR block.timestamp < expires_at (E-12).
/// - max_acceptances == u64::MAX OR OpenOfferUseCounts[offer_id] < max_acceptances (E-13).
/// - Press authorization (write gate, E-03 through E-07).
/// - card_address does not exist (E-01).
pub fn claim_open_offer(
    contract: &mut LogicContract,
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
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // ── Check 1: Offer not expired (E-12) ────────────────────────────────────
    // expires_at == 0 means unconstrained (no expiry).
    let now = current_timestamp();
    if expires_at != 0 && now >= expires_at {
        return Err(errors::make_error(errors::OFFER_EXPIRED));
    }

    // ── Check 2: Offer not at capacity (E-13) ────────────────────────────────
    // max_acceptances == u64::MAX means unconstrained.
    let current_count = storage
        .get_open_offer_count(static_call_ctx(), offer_id)
        .map_err(|e| e.encode())?;
    if max_acceptances != u64::MAX && current_count >= max_acceptances {
        return Err(errors::make_error(errors::OFFER_AT_CAPACITY));
    }

    // ── Check 3: Card does not already exist (E-01) ───────────────────────────
    let exists = storage
        .card_exists(static_call_ctx(), card_address)
        .map_err(|e| e.encode())?;
    if exists {
        return Err(errors::make_error(errors::CARD_ALREADY_EXISTS));
    }

    // ── Check 4: CID length (E-21) ────────────────────────────────────────────
    if initial_log_cid.len() > MAX_CID_LEN {
        return Err(errors::make_error(errors::LOG_CID_TOO_LONG));
    }

    // ── Check 5: Press authorization (write gate, E-03 through E-07) ─────────
    // The write gate increments next_sequence. All checks above are done first
    // so that if any non-auth check fails, we don't consume the sequence number.
    run_write_gate(
        contract,
        policy_address,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"claim_open_offer",
    )?;

    // ── State changes (all atomic after all checks pass) ──────────────────────
    let mut storage_mut = IStorage::new(storage_addr);

    // Increment offer use count.
    storage_mut
        .set_open_offer_count(static_call_ctx(), offer_id, current_count + 1)
        .map_err(|e| e.encode())?;

    // Create card entry.
    storage_mut
        .set_card_entry(
            static_call_ctx(),
            card_address,
            initial_log_cid.clone().into(),
            policy_address,
            press_address,
            true,
        )
        .map_err(|e| e.encode())?;

    // Emit events (§7).
    let ts = current_timestamp();
    evm::log(crate::OpenOfferClaimed {
        offer_id,
        card_address,
        use_count: current_count + 1,
        timestamp: ts,
    });
    evm::log(crate::CardRegistered {
        card_address,
        policy_address,
        press_address,
        initial_log_cid: initial_log_cid.into(),
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.13 RegisterAddressForward ────────────────────────────────────────────

/// Set a forward pointer from an old card to a new card.
///
/// Authorization: two-signature model (§4.13).
///
/// - `holder_sig_payload`: canonical RFC 8785 JSON of the RegisterAddressForwardPayload,
///   signed off-chain by the holder using their old ML-DSA-44 key. The press verifies
///   this before submitting; the contract accepts it for auditability only and does NOT
///   re-verify the ML-DSA-44 signature on-chain. A press submitting without a valid
///   holder signature is detectable by observers and constitutes a press policy violation
///   (press-side error E-22).
/// - `secp256r1_sig`: press co-signature over keccak256(holder_sig_payload), verified
///   on-chain against PressAuthorizations for the old card's policy. Any currently-
///   authorized press under the old card's policy may submit on the holder's behalf —
///   there is no restriction to the last writer.
///
/// Preconditions (§4.13):
/// 1. old_address must exist in CardEntries.
/// 2. new_address must exist in CardEntries.
/// 3. old_address.forward_to must be zero (E-27).
/// 4. secp256r1_sig must verify against the press's key for old_address's policy.
/// (E-28 is press-side only — the press checks for revocation before submitting.)
pub fn register_address_forward(
    contract: &mut LogicContract,
    old_address: B256,
    new_address: B256,
    press_address: B256,
    holder_sig_payload: Vec<u8>, // The press's secp256r1_sig signs over keccak256 of this
    secp256r1_sig: Vec<u8>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Pre-check 1: old_address must exist (E-02).
    let (_old_cid, old_policy, _old_last_press, old_forward, old_exists) = storage
        .get_card_entry(static_call_ctx(), old_address)
        .map_err(|e| e.encode())?;
    if !old_exists {
        return Err(errors::make_error(errors::CARD_NOT_FOUND));
    }

    // Pre-check 2: new_address must exist (E-02).
    let (_new_cid, _new_policy, _new_last_press, _new_forward, new_exists) = storage
        .get_card_entry(static_call_ctx(), new_address)
        .map_err(|e| e.encode())?;
    if !new_exists {
        return Err(errors::make_error(errors::CARD_NOT_FOUND));
    }

    // Pre-check 3: forward_to must be zero (E-27).
    // The storage contract also enforces this as an unconditional invariant,
    // but we check here to give a cleaner error before the storage call.
    if old_forward != B256::ZERO {
        return Err(errors::make_error(errors::FORWARD_ALREADY_SET));
    }

    // Pre-check 4: Verify the secp256r1 signature against the press's registered key.
    // The press key is looked up from PressAuthorizations for the old card's policy.
    // Any currently-authorized press under the old card's policy may submit (§4.13 step 6).
    let (press_key_bytes, _mldsa_hash, _scheme, press_active, _seq, _auth_at, _rev_at) = storage
        .get_press_authorization(static_call_ctx(), old_policy, press_address)
        .map_err(|e| e.encode())?;

    if press_key_bytes.len() != 64 {
        return Err(errors::make_error(errors::PRESS_NOT_AUTHORIZED));
    }
    if !press_active {
        return Err(errors::make_error(errors::PRESS_REVOKED));
    }

    // Verify op field in the holder_sig_payload before computing the message hash.
    if !protocol_types::payload_parser::verify_op(&holder_sig_payload, b"register_address_forward") {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // The press signs over keccak256(holder_sig_payload) — the same document the holder signed.
    let msg_hash_b256 = keccak256(&holder_sig_payload);
    let sig_valid = verify_single_sig(contract, msg_hash_b256, &secp256r1_sig, &press_key_bytes)?;
    if !sig_valid {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // Write the forward.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_forward_to(static_call_ctx(), old_address, new_address)
        .map_err(|e| e.encode())?;

    // Emit AddressTransition event (§7).
    let ts = current_timestamp();
    evm::log(crate::AddressTransition {
        old_address,
        new_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.15 BatchUpdateCardHeads ──────────────────────────────────────────────

/// Update multiple card heads atomically.
///
/// Security properties guaranteed:
/// - ALL preconditions validated before ANY state change (atomic).
/// - next_sequence incremented by exactly 1 (not by item count).
/// - No duplicate card_address values within the batch (E-34).
/// - All cards must belong to policy_address (E-34).
/// - MAX_BATCH_SIZE = 100 items.
///
/// The card_addresses, prev_log_cids, and new_log_cids are parallel arrays
/// to avoid the Solidity ABI overhead of passing a struct array.
pub fn batch_update_card_heads(
    contract: &mut LogicContract,
    policy_address: B256,
    press_address: B256,
    card_addresses: Vec<B256>,
    prev_log_cids: Vec<Vec<u8>>,
    new_log_cids: Vec<Vec<u8>>,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // ── Check: batch size (E-33) ──────────────────────────────────────────────
    let n = card_addresses.len();
    if n == 0 || n > MAX_BATCH_SIZE {
        return Err(errors::make_error(errors::BATCH_SIZE_INVALID));
    }
    if prev_log_cids.len() != n || new_log_cids.len() != n {
        return Err(errors::make_error(errors::BATCH_SIZE_INVALID));
    }

    // ── Validate press authorization (write gate WITHOUT incrementing sequence yet) ──
    // We validate the signature and check the sequence, but the sequence increment
    // happens after all item-level validation passes.
    // Then we re-run the full write gate (with increment) once all items are valid.
    validate_write_gate_only(
        contract,
        policy_address,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"batch_update_card_heads",
    )?;

    // ── Validate all items before any state change ────────────────────────────
    // This is the critical safety property: ALL items must be valid before we
    // write anything. A single invalid item rolls back the entire batch.

    // Track seen card addresses for duplicate detection (E-34).
    // Using a simple O(n^2) scan since batch size is bounded to 100.
    for i in 0..n {
        // Duplicate check.
        for j in (i + 1)..n {
            if card_addresses[i] == card_addresses[j] {
                return Err(errors::make_error(errors::BATCH_ITEM_INVALID));
            }
        }

        // CID length checks.
        if new_log_cids[i].len() > MAX_CID_LEN {
            return Err(errors::make_error(errors::LOG_CID_TOO_LONG));
        }

        // Card must exist (E-02).
        let (stored_cid, card_policy, _last_press, _fwd, exists) = storage
            .get_card_entry(static_call_ctx(), card_addresses[i])
            .map_err(|e| e.encode())?;
        if !exists {
            return Err(errors::make_error(errors::CARD_NOT_FOUND));
        }

        // Card must belong to the stated policy (E-34).
        if card_policy != policy_address {
            return Err(errors::make_error(errors::BATCH_ITEM_INVALID));
        }

        // prev_log_cid must match current head (E-08).
        if stored_cid.as_ref() != prev_log_cids[i].as_slice() {
            return Err(errors::make_error(errors::STALE_PREV_CID));
        }
    }

    // ── All checks passed — now increment the sequence (exactly 1) ───────────
    // We do this by running the full write gate (which increments the sequence).
    // Since validate_write_gate_only already confirmed the sig/sequence are valid,
    // we just need the increment side effect.
    // Increment press sequence.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .increment_press_sequence(static_call_ctx(), policy_address, press_address)
        .map_err(|e| e.encode())?;

    // ── Apply all state changes ───────────────────────────────────────────────
    let ts = current_timestamp();
    for i in 0..n {
        storage_mut
            .update_card_head(
                static_call_ctx(),
                card_addresses[i],
                new_log_cids[i].clone().into(),
                press_address,
            )
            .map_err(|e| e.encode())?;

        // Emit one CardHeadUpdated event per item (§4.15: "Emits one CardHeadUpdated per item").
        evm::log(crate::CardHeadUpdated {
            card_address: card_addresses[i],
            prev_log_cid: prev_log_cids[i].clone().into(),
            new_log_cid: new_log_cids[i].clone().into(),
            press_address,
            timestamp: ts,
        });
    }

    Ok(())
}
