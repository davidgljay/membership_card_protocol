//! # Card Write Gate (§6.1) and Governance Quorum Verification (§6.2)
//!
//! These are the two shared authorization functions called by all write operations.
//!
//! ## Card Write Gate (§6.1)
//!
//! Applied on every call to RegisterCard, UpdateCardHead, ClaimOpenOffer,
//! RegisterSubCard, DeregisterSubCard, BatchUpdateCardHeads.
//!
//! Steps:
//! 1. Confirm policy_address ∈ PolicyAuthorizerKeys → E-03
//! 2. Confirm PressAuthorizations[policy][press] exists → E-04
//! 3. Confirm active == true → E-05
//! 4. Verify press_signature via RIP-7212 → E-06
//! 5. Confirm op field matches expected → E-06 (cross-operation replay prevention)
//! 6. Confirm sequence == next_sequence → E-07
//!    Increment next_sequence by 1 on success.
//!
//! ## Governance Quorum Verification (§6.2)
//!
//! Applied on every governance operation (RegisterPolicy, AuthorizePress, etc.).
//!
//! Steps:
//! 1. Confirm governance_version in payload matches stored version → E-15
//! 2. Confirm nonce not used → E-07G
//! 3. For each sig: verify secp256r1, confirm distinct keys → E-16, E-17
//! 4. Confirm distinct valid sig count >= quorum → E-18

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{keccak256, B256},
    call::MethodError,
};

use crate::{
    errors,
    IStorage,
    IVerifierModule,
    LogicContract,
    current_timestamp,
    mut_call_ctx,
    static_call_ctx,
};
use protocol_types::{payload_parser, MAX_GOVERNANCE_KEYS};

/// Result of running the card write gate.
/// On success, returns the press's current next_sequence (before increment).
pub struct WriteGateResult {
    pub press_public_key: [u8; 64],
    pub sequence_used: u64,
}

/// Run the 6-step card write gate (§6.1).
///
/// # Arguments
/// * `contract`          — The logic contract (used to access storage/verifier addresses).
/// * `policy_address`    — The policy to check authorization against.
/// * `press_address`     — The press claiming to write.
/// * `press_sig_payload` — The raw JSON payload bytes signed by the press.
/// * `press_signature`   — The 64-byte secp256r1 signature (r||s).
/// * `expected_op`       — The expected value of the "op" JSON field (e.g., b"register_card").
///                         This prevents cross-operation replay.
///
/// # Mutates
/// On success, increments `PressAuthorizations[policy][press].next_sequence` by 1.
///
/// # Returns
/// `Ok(WriteGateResult)` on success, `Err(revert_data)` on any failure.
pub fn run_write_gate(
    contract: &mut LogicContract,
    policy_address: B256,
    press_address: B256,
    press_sig_payload: &[u8],
    press_signature: &[u8],
    expected_op: &[u8],
) -> Result<WriteGateResult, Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let verifier_addr = contract.verifier_module.get();
    let storage = IStorage::new(storage_addr);
    let verifier = IVerifierModule::new(verifier_addr);

    // ── Step 1: Confirm policy exists (E-03) ─────────────────────────────────
    let policy_exists = storage
        .policy_exists(static_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;
    if !policy_exists {
        return Err(errors::make_error(errors::UNRECOGNIZED_POLICY));
    }

    // ── Step 2 & 3: Get press authorization entry, check existence & active (E-04, E-05) ──────
    let (press_key_bytes, _mldsa_hash, _key_scheme, active, next_sequence, _auth_at, _rev_at) = storage
        .get_press_authorization(static_call_ctx(), policy_address, press_address)
        .map_err(|e| e.encode())?;

    // press_key_bytes empty means no entry exists.
    if press_key_bytes.len() != 64 {
        return Err(errors::make_error(errors::PRESS_NOT_AUTHORIZED));
    }
    if !active {
        return Err(errors::make_error(errors::PRESS_REVOKED));
    }

    let mut press_public_key = [0u8; 64];
    press_public_key.copy_from_slice(&press_key_bytes);

    // ── Step 4: Verify press signature via RIP-7212 (E-06) ───────────────────
    let msg_hash = keccak256(press_sig_payload);
    let sig_valid = verifier
        .verify_secp_256_r_1(
            static_call_ctx(),
            msg_hash,
            press_signature.to_vec().into(),
            press_key_bytes.clone().into(),
        )
        .map_err(|e| e.encode())?;
    if !sig_valid {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // ── Step 5: Verify op field matches expected operation (E-06, cross-op replay prevention) ──
    // Security: This check prevents a valid signature on a "register_card" payload from
    // being replayed as an "update_card_head" payload (or any other cross-operation substitution).
    if !payload_parser::verify_op(press_sig_payload, expected_op) {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // ── Step 6: Verify sequence and increment (E-07) ─────────────────────────
    let payload_sequence = payload_parser::extract_sequence(press_sig_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;

    if payload_sequence != next_sequence {
        return Err(errors::make_error(errors::SEQUENCE_MISMATCH));
    }

    // Increment the sequence counter. This must succeed; storage contract enforces
    // caller is the logic contract (E-29).
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .increment_press_sequence(mut_call_ctx(), policy_address, press_address)
        .map_err(|e| e.encode())?;

    Ok(WriteGateResult {
        press_public_key,
        sequence_used: payload_sequence,
    })
}

/// Run the write gate but WITHOUT incrementing the sequence.
/// Used for batch validation passes where we want to validate all items
/// before making any state changes.
///
/// Security note: This function is used in the FIRST PASS of batch validation.
/// The sequence is only incremented once (in the single-pass write gate call
/// before the batch items are processed). BatchUpdateCardHeads increments
/// next_sequence by exactly 1 for the whole batch (spec §4.15).
pub fn validate_write_gate_only(
    contract: &LogicContract,
    policy_address: B256,
    press_address: B256,
    press_sig_payload: &[u8],
    press_signature: &[u8],
    expected_op: &[u8],
) -> Result<WriteGateResult, Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let verifier_addr = contract.verifier_module.get();
    let storage = IStorage::new(storage_addr);
    let verifier = IVerifierModule::new(verifier_addr);

    // Step 1: Policy exists.
    let policy_exists = storage
        .policy_exists(static_call_ctx(), policy_address)
        .map_err(|e| e.encode())?;
    if !policy_exists {
        return Err(errors::make_error(errors::UNRECOGNIZED_POLICY));
    }

    // Steps 2 & 3: Press auth entry.
    let (press_key_bytes, _mldsa_hash, _key_scheme, active, next_sequence, _auth_at, _rev_at) = storage
        .get_press_authorization(static_call_ctx(), policy_address, press_address)
        .map_err(|e| e.encode())?;
    if press_key_bytes.len() != 64 {
        return Err(errors::make_error(errors::PRESS_NOT_AUTHORIZED));
    }
    if !active {
        return Err(errors::make_error(errors::PRESS_REVOKED));
    }

    let mut press_public_key = [0u8; 64];
    press_public_key.copy_from_slice(&press_key_bytes);

    // Step 4: Signature.
    let msg_hash = keccak256(press_sig_payload);
    let sig_valid = verifier
        .verify_secp_256_r_1(
            static_call_ctx(),
            msg_hash,
            press_signature.to_vec().into(),
            press_key_bytes.clone().into(),
        )
        .map_err(|e| e.encode())?;
    if !sig_valid {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // Step 5: Op check.
    if !payload_parser::verify_op(press_sig_payload, expected_op) {
        return Err(errors::make_error(errors::INVALID_PRESS_SIGNATURE));
    }

    // Step 6: Sequence (read only, no increment).
    let payload_sequence = payload_parser::extract_sequence(press_sig_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;
    if payload_sequence != next_sequence {
        return Err(errors::make_error(errors::SEQUENCE_MISMATCH));
    }

    Ok(WriteGateResult {
        press_public_key,
        sequence_used: payload_sequence,
    })
}

/// Run governance quorum verification (§6.2).
///
/// # Arguments
/// * `contract`           — The logic contract.
/// * `body_id`            — Which governance body (0 = Root, 1 = PressRegistry).
/// * `governance_payload` — The raw JSON payload bytes.
/// * `governance_sigs`    — Array of secp256r1 signatures (r||s, 64 bytes each).
///
/// # Mutates
/// On success, marks the nonce from the payload as used.
///
/// # Returns
/// `Ok(())` on valid quorum, `Err(revert_data)` on any failure.
pub fn verify_governance_quorum(
    contract: &mut LogicContract,
    body_id: u8,
    governance_payload: &[u8],
    governance_sigs: &[Vec<u8>],
) -> Result<(), Vec<u8>> {
    let storage_addr = contract.storage_contract.get();
    let verifier_addr = contract.verifier_module.get();
    let storage = IStorage::new(storage_addr);
    let verifier = IVerifierModule::new(verifier_addr);

    // ── Step 1: Confirm governance_version in payload matches stored version (E-15) ──
    let (keys_flat, key_count, quorum, stored_version, _key_scheme) = storage
        .get_governance_keyset(static_call_ctx(), body_id)
        .map_err(|e| e.encode())?;

    let payload_version = payload_parser::extract_governance_version(governance_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;

    if payload_version != stored_version {
        return Err(errors::make_error(errors::GOVERNANCE_VERSION_MISMATCH));
    }

    // ── Step 2: Confirm nonce has not been used (E-07G) ──────────────────────
    // The nonce is a base64url-encoded 32-byte value in the JSON payload.
    // We use keccak256 of the raw nonce string bytes as the on-chain nonce key.
    let nonce_raw = payload_parser::extract_nonce_bytes(governance_payload)
        .ok_or_else(|| errors::make_error(errors::INVALID_PAYLOAD))?;
    let nonce_b256 = keccak256(nonce_raw);

    let already_used = storage
        .is_nonce_used(static_call_ctx(), nonce_b256)
        .map_err(|e| e.encode())?;
    if already_used {
        return Err(errors::make_error(errors::NONCE_REUSED));
    }

    // ── Step 3: Verify each signature against a distinct key in the keyset ───
    // keys_flat is key_count * 64 bytes of concatenated secp256r1 pubkeys.
    let keys_bytes: &[u8] = keys_flat.as_ref();
    let key_count_usize = key_count as usize;
    let msg_hash = keccak256(governance_payload);

    // Track which key indices have already been used (to detect duplicates).
    // Using a bitmap for O(1) lookup; max MAX_GOVERNANCE_KEYS keys.
    let mut used_key_indices = [false; MAX_GOVERNANCE_KEYS];
    let mut valid_sig_count: usize = 0;

    for sig_bytes in governance_sigs {
        if sig_bytes.len() != 64 {
            return Err(errors::make_error(errors::INVALID_GOVERNANCE_SIGNATURE));
        }

        // Find which key in the keyset verifies this signature.
        let mut found_key_idx: Option<usize> = None;
        for key_idx in 0..key_count_usize {
            let start = key_idx * 64;
            let end = start + 64;
            if end > keys_bytes.len() {
                break;
            }
            let pubkey_slice = &keys_bytes[start..end];

            let sig_valid = verifier
                .verify_secp_256_r_1(
                    static_call_ctx(),
                    msg_hash,
                    sig_bytes.clone().into(),
                    pubkey_slice.to_vec().into(),
                )
                .map_err(|e| e.encode())?;

            if sig_valid {
                found_key_idx = Some(key_idx);
                break;
            }
        }

        match found_key_idx {
            None => {
                // Signature didn't verify against any key.
                return Err(errors::make_error(errors::INVALID_GOVERNANCE_SIGNATURE));
            }
            Some(idx) => {
                // Check for duplicate signer (E-17).
                if used_key_indices[idx] {
                    return Err(errors::make_error(errors::DUPLICATE_SIGNER));
                }
                used_key_indices[idx] = true;
                valid_sig_count += 1;
            }
        }
    }

    // ── Step 4: Confirm distinct valid sig count >= quorum (E-18) ────────────
    if valid_sig_count < quorum as usize {
        return Err(errors::make_error(errors::INSUFFICIENT_QUORUM));
    }

    // ── Mark nonce as used ───────────────────────────────────────────────────
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .mark_nonce_used(mut_call_ctx(), nonce_b256)
        .map_err(|e| e.encode())?;

    Ok(())
}

/// Verify a single secp256r1 signature without accessing storage.
/// Used by RegisterAddressForward which has its own auth logic.
pub fn verify_single_sig(
    contract: &LogicContract,
    message_hash: B256,
    signature: &[u8],
    public_key: &[u8],
) -> Result<bool, Vec<u8>> {
    if signature.len() != 64 || public_key.len() != 64 {
        return Ok(false);
    }

    let verifier = IVerifierModule::new(contract.verifier_module.get());
    verifier
        .verify_secp_256_r_1(
            static_call_ctx(),
            message_hash,
            signature.to_vec().into(),
            public_key.to_vec().into(),
        )
        .map_err(|e| e.encode())
}

// ─── Extension methods ────────────────────────────────────────────────────────

/// Marker trait implemented by "both storage and verifier" accessors.
pub trait WriteGate {
    fn storage_contract_addr(&self) -> stylus_sdk::alloy_primitives::Address;
    fn verifier_module_addr(&self) -> stylus_sdk::alloy_primitives::Address;
}

impl WriteGate for LogicContract {
    fn storage_contract_addr(&self) -> stylus_sdk::alloy_primitives::Address {
        self.storage_contract.get()
    }
    fn verifier_module_addr(&self) -> stylus_sdk::alloy_primitives::Address {
        self.verifier_module.get()
    }
}
