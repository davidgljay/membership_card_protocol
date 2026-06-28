//! # DNS Resolution Operations (§4.17–4.24)
//!
//! All operations that read or write DNS resolution state:
//! - RegisterDomain (§4.17) — DnsGovernanceBody quorum
//! - DeregisterDomain (§4.18) — DnsGovernanceBody quorum
//! - SetPolicyAddress (§4.19) — press under DnsGovernancePolicyAddress
//! - RemovePolicyAddress (§4.20) — press path OR DnsGovernanceBody quorum
//! - ClearDomainEntries (§4.21) — DnsGovernanceBody quorum
//! - FlagDomainFraudRisk (§4.22) — DnsGovernanceBody quorum
//! - GovernanceSetPolicyAddress (§4.23) — DnsGovernanceBody quorum (rollback)
//! - SetDnsGovernancePolicyAddress (§4.24) — DnsGovernanceBody quorum
//!
//! ## Key derivation
//!
//! DomainRegistrations key = keccak256(domain_bytes)
//! PolicyAddresses key     = keccak256(domain_bytes || 0x00 || path_bytes)
//!
//! The logic contract computes these hashes and passes pre-computed keys to the
//! storage contract. All domain bytes must be lowercase-normalised before hashing;
//! normalisation is the caller's responsibility (press enforces this off-chain).
//!
//! ## Security notes for auditors
//!
//! - SetPolicyAddress runs the standard write gate (§6.1) against DnsGovernancePolicyAddress.
//!   The press sequence counter for that policy is incremented on success.
//! - RegisterSubCard on a DNS admin master card requires an additional secp256r1 signature
//!   (AdminAuthorizeSubCardPayload, §4.3 precondition 5). That check lives in subcard_ops.rs.
//! - GovernanceSetPolicyAddress bypasses the suspension check (E-39) intentionally — governance
//!   must be able to correct state even when a domain is suspended.
//! - All governance operations call verify_governance_quorum (§6.2) before any state change.

#![allow(deprecated)]

use alloc::vec::Vec;
use stylus_sdk::{
    alloy_primitives::{keccak256, B256},
    evm,
};

use crate::{
    errors,
    current_timestamp,
    IStorage,
    LogicContract,
    MethodError,
    static_call_ctx,
    write_gate::{run_write_gate, verify_governance_quorum},
};

/// DnsGovernanceBody body_id (§3.6).
const DNS_GOVERNANCE_BODY: u8 = 2;

/// Maximum domain string length per RFC 1035 §3.1.
const MAX_DOMAIN_LEN: usize = 255;

/// Maximum path string length (§4.2 spec).
const MAX_PATH_LEN: usize = 512;

/// Maximum number of paths in a single ClearDomainEntries call (§4.21).
const MAX_CLEAR_ENTRIES_BATCH: usize = 500;

// ─── Key derivation helpers (pub so lib.rs can expose them as read ops) ────────

/// keccak256(domain_bytes) — the DomainRegistrations mapping key.
pub fn domain_hash(domain: &[u8]) -> B256 {
    keccak256(domain)
}

/// keccak256(domain_bytes || 0x00 || path_bytes) — the PolicyAddresses mapping key.
pub fn policy_address_key(domain: &[u8], path: &[u8]) -> B256 {
    let mut buf = Vec::with_capacity(domain.len() + 1 + path.len());
    buf.extend_from_slice(domain);
    buf.push(0x00u8);
    buf.extend_from_slice(path);
    keccak256(&buf)
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/// Fetch a domain entry and fail with E-37 if it does not exist.
/// Returns (admin_card_address, registered_at, fraud_risk, suspension_expires_at, exists).
fn require_domain_exists(
    storage_addr: stylus_sdk::alloy_primitives::Address,
    domain_hash: B256,
) -> Result<(B256, u64, u8, u64, bool), Vec<u8>> {
    let storage = IStorage::new(storage_addr);
    let (admin, reg_at, fr, sus, exists) = storage
        .get_domain_entry(static_call_ctx(), domain_hash)
        .map_err(|e| e.encode())?;
    if !exists {
        return Err(errors::make_error(errors::DOMAIN_NOT_FOUND));
    }
    Ok((admin, reg_at, fr, sus, exists))
}

/// Validate a domain byte string: non-empty, ≤ MAX_DOMAIN_LEN bytes.
fn validate_domain(domain: &[u8]) -> Result<(), Vec<u8>> {
    if domain.is_empty() || domain.len() > MAX_DOMAIN_LEN {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }
    Ok(())
}

// ─── §4.17 RegisterDomain ─────────────────────────────────────────────────────

/// Register a domain admin card after DNS TXT verification.
///
/// Preconditions (§4.17):
/// 1. domain: non-empty, ≤ 255 bytes (E-43).
/// 2. admin_secp256r1_key: exactly 64 bytes (E-43).
/// 3. DnsGovernancePolicyAddress != zero (E-40).
/// 4. admin_card_address exists in CardEntries (E-02).
/// 5. CardEntries[admin_card_address].policy_address == DnsGovernancePolicyAddress (E-40).
/// 6. DomainRegistrations[domain].admin_card_address == zero OR domain not yet exists (E-38).
/// 7. DnsGovernanceBody quorum (§6.2).
pub fn register_domain(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    admin_card_address: B256,
    admin_secp256r1_key: Vec<u8>,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;

    if admin_secp256r1_key.len() != 64 {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }

    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Check DnsGovernancePolicyAddress is initialized (E-40).
    let dns_policy = storage
        .get_dns_governance_policy_address(static_call_ctx())
        .map_err(|e| e.encode())?;
    if dns_policy == B256::ZERO {
        return Err(errors::make_error(errors::CARD_NOT_DNS_GOVERNANCE_POLICY));
    }

    // Check admin_card_address exists (E-02).
    let (_cid, card_policy, _press, _fwd, card_exists) = storage
        .get_card_entry(static_call_ctx(), admin_card_address)
        .map_err(|e| e.encode())?;
    if !card_exists {
        return Err(errors::make_error(errors::CARD_NOT_FOUND));
    }

    // Check card was issued under DnsGovernancePolicyAddress (E-40).
    if card_policy != dns_policy {
        return Err(errors::make_error(errors::CARD_NOT_DNS_GOVERNANCE_POLICY));
    }

    // Check domain is not already registered with an active admin (E-38).
    let d_hash = domain_hash(&domain);
    let (existing_admin, _reg_at, _fr, _sus, already_exists) = storage
        .get_domain_entry(static_call_ctx(), d_hash)
        .map_err(|e| e.encode())?;
    if already_exists && existing_admin != B256::ZERO {
        return Err(errors::make_error(errors::DOMAIN_ALREADY_REGISTERED));
    }

    // Quorum verification (marks nonce as used).
    verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;

    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);

    // Write domain entry. RegisterDomain always resets fraud_risk to 0 (§4.17 spec).
    storage_mut
        .set_domain_entry(
            static_call_ctx(),
            d_hash,
            admin_card_address,
            ts,
            0,  // fraud_risk = 0 (clean slate on registration)
            0,  // suspension_expires_at = 0
            true,
        )
        .map_err(|e| e.encode())?;

    // Store admin's secp256r1 key for on-chain sub-card authorization (§3.11).
    storage_mut
        .set_dns_admin_card_key(
            static_call_ctx(),
            admin_card_address,
            admin_secp256r1_key.into(),
        )
        .map_err(|e| e.encode())?;

    evm::log(crate::DomainRegistered {
        domain: domain.into(),
        admin_card_address,
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.18 DeregisterDomain ───────────────────────────────────────────────────

/// Clear the active admin card for a domain, preventing new SetPolicyAddress submissions.
///
/// Preconditions (§4.18):
/// 1. Domain exists (E-37).
/// 2. DnsGovernanceBody quorum.
///
/// State changes:
/// - Sets admin_card_address = zero.
/// - Clears DnsAdminCardKeys[old_admin] (secp256r1 key zeroed).
/// - Preserves exists, registered_at, fraud_risk, suspension_expires_at.
pub fn deregister_domain(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;

    let storage_addr = contract.storage_contract.get();
    let d_hash = domain_hash(&domain);

    // E-37: domain must exist.
    let (old_admin, reg_at, fraud_risk, sus_exp, _) =
        require_domain_exists(storage_addr, d_hash)?;

    // Quorum verification.
    verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;

    let ts = current_timestamp();
    let mut storage_mut = IStorage::new(storage_addr);

    // Clear admin_card_address; preserve fraud status and exists.
    storage_mut
        .set_domain_entry(
            static_call_ctx(),
            d_hash,
            B256::ZERO,   // admin_card_address = zero
            reg_at,
            fraud_risk,
            sus_exp,
            true,         // exists remains true (write-once invariant)
        )
        .map_err(|e| e.encode())?;

    // Clear the admin card's secp256r1 key (empty vec = zero).
    if old_admin != B256::ZERO {
        storage_mut
            .set_dns_admin_card_key(
                static_call_ctx(),
                old_admin,
                alloc::vec![].into(),
            )
            .map_err(|e| e.encode())?;
    }

    evm::log(crate::DomainDeregistered {
        domain: domain.into(),
        timestamp: ts,
    });

    Ok(())
}

// ─── §4.19 SetPolicyAddress ───────────────────────────────────────────────────

/// Register or update the policy card address at a domain/path.
///
/// Preconditions (§4.19):
/// 1. DnsGovernancePolicyAddress != zero (E-40).
/// 2. Domain exists (E-37).
/// 3. Domain not currently suspended (E-39).
/// 4. admin_card_address == DomainRegistrations[domain].admin_card_address (E-46).
/// 5. If sub_card_address != zero:
///      SubCardRegistrations[sub_card_address].active == true
///      AND master_card_address == admin_card_address (E-45).
/// 6. Press authorized under DnsGovernancePolicyAddress (write gate, §6.1).
/// 7. policy_card_address exists in CardEntries (E-41).
#[allow(clippy::too_many_arguments)]
pub fn set_policy_address(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    path: Vec<u8>,
    policy_card_address: B256,
    admin_card_address: B256,
    sub_card_address: B256,
    press_address: B256,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;
    if path.len() > MAX_PATH_LEN {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }

    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // Check 1: DnsGovernancePolicyAddress initialized (E-40).
    let dns_policy = storage
        .get_dns_governance_policy_address(static_call_ctx())
        .map_err(|e| e.encode())?;
    if dns_policy == B256::ZERO {
        return Err(errors::make_error(errors::CARD_NOT_DNS_GOVERNANCE_POLICY));
    }

    // Check 2: domain exists (E-37).
    let d_hash = domain_hash(&domain);
    let (registered_admin, _reg_at, fraud_risk, sus_exp, _) =
        require_domain_exists(storage_addr, d_hash)?;

    // Check 3: domain not suspended (E-39).
    if fraud_risk == 2 {
        let ts = current_timestamp();
        if ts < sus_exp {
            return Err(errors::make_error(errors::DOMAIN_SUSPENDED));
        }
    }

    // Check 4: admin_card_address binding (E-46).
    if admin_card_address != registered_admin {
        return Err(errors::make_error(errors::ADMIN_CARD_MISMATCH));
    }

    // Check 5: sub-card binding (E-45) — one-hop only.
    if sub_card_address != B256::ZERO {
        let (master, _reg_head, _doc, sc_active, _reg_at, _dereg_at) = storage
            .get_sub_card_entry(static_call_ctx(), sub_card_address)
            .map_err(|e| e.encode())?;
        if !sc_active || master != admin_card_address {
            return Err(errors::make_error(errors::SUB_CARD_NOT_DOMAIN_ADMIN_SUBCARD));
        }
    }

    // Check 6: press write gate against DnsGovernancePolicyAddress.
    run_write_gate(
        contract,
        dns_policy,
        press_address,
        &press_sig_payload,
        &press_signature,
        b"set_policy_address",
    )?;

    // Check 7: policy_card_address must exist (E-41).
    let policy_exists = {
        let storage2 = IStorage::new(storage_addr);
        storage2
            .card_exists(static_call_ctx(), policy_card_address)
            .map_err(|e| e.encode())?
    };
    if !policy_exists {
        return Err(errors::make_error(errors::POLICY_CARD_NOT_FOUND));
    }

    // Write.
    let key = policy_address_key(&domain, &path);
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_policy_address(static_call_ctx(), key, policy_card_address)
        .map_err(|e| e.encode())?;

    evm::log(crate::PolicyAddressSet {
        domain: domain.into(),
        path: path.into(),
        policy_card_address,
        admin_card_address,
        sub_card_address,
        press_address,
        timestamp: current_timestamp(),
    });

    Ok(())
}

// ─── §4.20 RemovePolicyAddress ────────────────────────────────────────────────

/// Remove a PolicyAddresses entry.
///
/// Two authorization paths:
/// - Path A (press): card_address != zero → press write gate under DnsGovernancePolicyAddress.
/// - Path B (governance): card_address == zero, governance_sigs non-empty → DnsGovernanceBody quorum.
///
/// Shared preconditions:
/// 1. Domain exists (E-37).
/// 2. PolicyAddresses[key] != zero (E-42).
#[allow(clippy::too_many_arguments)]
pub fn remove_policy_address(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    path: Vec<u8>,
    card_address: B256,       // non-zero = press path; zero = governance path
    press_address: B256,
    press_sig_payload: Vec<u8>,
    press_signature: Vec<u8>,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;

    let storage_addr = contract.storage_contract.get();

    // Check 1: domain exists (E-37).
    let d_hash = domain_hash(&domain);
    require_domain_exists(storage_addr, d_hash)?;

    // Check 2: entry is non-zero (E-42).
    let key = policy_address_key(&domain, &path);
    let current_value = {
        let storage = IStorage::new(storage_addr);
        storage
            .get_policy_address(static_call_ctx(), key)
            .map_err(|e| e.encode())?
    };
    if current_value == B256::ZERO {
        return Err(errors::make_error(errors::DOMAIN_PATH_ENTRY_NOT_FOUND));
    }

    // Authorization.
    if card_address != B256::ZERO {
        // Path A: press authorization.
        let storage = IStorage::new(storage_addr);
        let dns_policy = storage
            .get_dns_governance_policy_address(static_call_ctx())
            .map_err(|e| e.encode())?;
        if dns_policy == B256::ZERO {
            return Err(errors::make_error(errors::CARD_NOT_DNS_GOVERNANCE_POLICY));
        }

        // Verify card was issued under DnsGovernancePolicyAddress.
        let (_cid, card_policy, _press, _fwd, card_exists) = storage
            .get_card_entry(static_call_ctx(), card_address)
            .map_err(|e| e.encode())?;
        if !card_exists {
            return Err(errors::make_error(errors::CARD_NOT_FOUND));
        }
        if card_policy != dns_policy {
            return Err(errors::make_error(errors::CARD_NOT_DNS_GOVERNANCE_POLICY));
        }

        run_write_gate(
            contract,
            dns_policy,
            press_address,
            &press_sig_payload,
            &press_signature,
            b"remove_policy_address",
        )?;
    } else {
        // Path B: governance quorum.
        verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;
    }

    // Write: zero the entry.
    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_policy_address(static_call_ctx(), key, B256::ZERO)
        .map_err(|e| e.encode())?;

    evm::log(crate::PolicyAddressRemoved {
        domain: domain.into(),
        path: path.into(),
        timestamp: current_timestamp(),
    });

    Ok(())
}

// ─── §4.21 ClearDomainEntries ─────────────────────────────────────────────────

/// Remove all specified PolicyAddresses entries for a domain.
///
/// Preconditions (§4.21):
/// 1. Domain exists (E-37).
/// 2. 1 <= len(paths) <= MAX_CLEAR_ENTRIES_BATCH (E-33).
/// 3. DnsGovernanceBody quorum.
pub fn clear_domain_entries(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    paths: Vec<Vec<u8>>,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;

    // E-33: batch size.
    if paths.is_empty() || paths.len() > MAX_CLEAR_ENTRIES_BATCH {
        return Err(errors::make_error(errors::BATCH_SIZE_INVALID));
    }

    let storage_addr = contract.storage_contract.get();
    let d_hash = domain_hash(&domain);

    // E-37: domain must exist.
    require_domain_exists(storage_addr, d_hash)?;

    // Quorum verification.
    verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;

    let mut paths_cleared: u32 = 0;
    let mut storage_mut = IStorage::new(storage_addr);

    for path in &paths {
        let key = policy_address_key(&domain, path);
        // Read current value; skip if already zero.
        let current = {
            let storage_rd = IStorage::new(storage_addr);
            storage_rd
                .get_policy_address(static_call_ctx(), key)
                .map_err(|e| e.encode())?
        };
        if current != B256::ZERO {
            storage_mut
                .set_policy_address(static_call_ctx(), key, B256::ZERO)
                .map_err(|e| e.encode())?;
            paths_cleared += 1;
        }
    }

    evm::log(crate::DomainEntriesCleared {
        domain: domain.into(),
        paths_cleared,
        timestamp: current_timestamp(),
    });

    Ok(())
}

// ─── §4.22 FlagDomainFraudRisk ────────────────────────────────────────────────

/// Set the fraud risk level for a domain.
///
/// Preconditions (§4.22):
/// 1. Domain exists (E-37).
/// 2. fraud_risk <= 2 (E-43).
/// 3. If fraud_risk == 2: suspension_expires_at > block.timestamp (E-43).
///    If fraud_risk != 2: suspension_expires_at == 0 (E-43).
/// 4. DnsGovernanceBody quorum.
pub fn flag_domain_fraud_risk(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    fraud_risk: u8,
    suspension_expires_at: u64,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;

    // Validate fraud_risk value and suspension_expires_at consistency.
    if fraud_risk > 2 {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }
    if fraud_risk == 2 {
        let ts = current_timestamp();
        if suspension_expires_at == 0 || suspension_expires_at <= ts {
            return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
        }
    } else if suspension_expires_at != 0 {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }

    let storage_addr = contract.storage_contract.get();
    let d_hash = domain_hash(&domain);

    // E-37: domain must exist; read current entry to preserve other fields.
    let (admin, reg_at, _old_fr, _old_sus, _) =
        require_domain_exists(storage_addr, d_hash)?;

    // Quorum verification.
    verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;

    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_domain_entry(
            static_call_ctx(),
            d_hash,
            admin,
            reg_at,
            fraud_risk,
            suspension_expires_at,
            true,
        )
        .map_err(|e| e.encode())?;

    evm::log(crate::DomainFraudRiskUpdated {
        domain: domain.into(),
        fraud_risk,
        suspension_expires_at,
        timestamp: current_timestamp(),
    });

    Ok(())
}

// ─── §4.23 GovernanceSetPolicyAddress ────────────────────────────────────────

/// Directly write or clear a PolicyAddresses entry — the governance rollback primitive.
///
/// Preconditions (§4.23):
/// 1. Domain exists (E-37).
/// 2. If policy_card_address != zero: must exist in CardEntries (E-41).
/// 3. DnsGovernanceBody quorum.
///
/// Note: No suspension check. Governance can write to any registered domain.
pub fn governance_set_policy_address(
    contract: &mut LogicContract,
    domain: Vec<u8>,
    path: Vec<u8>,
    policy_card_address: B256,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    validate_domain(&domain)?;

    let storage_addr = contract.storage_contract.get();
    let d_hash = domain_hash(&domain);

    // E-37: domain must exist.
    require_domain_exists(storage_addr, d_hash)?;

    // E-41: if non-zero value, policy card must exist.
    if policy_card_address != B256::ZERO {
        let storage = IStorage::new(storage_addr);
        let exists = storage
            .card_exists(static_call_ctx(), policy_card_address)
            .map_err(|e| e.encode())?;
        if !exists {
            return Err(errors::make_error(errors::POLICY_CARD_NOT_FOUND));
        }
    }

    // Quorum verification.
    verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;

    let key = policy_address_key(&domain, &path);

    // Read old value for the event.
    let old_value = {
        let storage = IStorage::new(storage_addr);
        storage
            .get_policy_address(static_call_ctx(), key)
            .map_err(|e| e.encode())?
    };

    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_policy_address(static_call_ctx(), key, policy_card_address)
        .map_err(|e| e.encode())?;

    evm::log(crate::PolicyAddressGovernanceSet {
        domain: domain.into(),
        path: path.into(),
        policy_card_address,
        old_policy_card_address: old_value,
        timestamp: current_timestamp(),
    });

    Ok(())
}

// ─── §4.24 SetDnsGovernancePolicyAddress ─────────────────────────────────────

/// Rotate the global DNS governance policy address.
///
/// ⚠ Breaking change: orphans all existing domain admin cards.
///
/// Preconditions (§4.24):
/// 1. new_policy_address != zero (E-43).
/// 2. new_policy_address exists in PolicyAuthorizerKeys (E-03).
/// 3. new_policy_address != current DnsGovernancePolicyAddress (E-43 no-op guard).
/// 4. DnsGovernanceBody quorum.
pub fn set_dns_governance_policy_address(
    contract: &mut LogicContract,
    new_policy_address: B256,
    governance_payload: Vec<u8>,
    governance_sigs: Vec<Vec<u8>>,
) -> Result<(), Vec<u8>> {
    if new_policy_address == B256::ZERO {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }

    let storage_addr = contract.storage_contract.get();
    let storage = IStorage::new(storage_addr);

    // E-03: new policy must be registered.
    let policy_registered = storage
        .policy_exists(static_call_ctx(), new_policy_address)
        .map_err(|e| e.encode())?;
    if !policy_registered {
        return Err(errors::make_error(errors::UNRECOGNIZED_POLICY));
    }

    // E-43 no-op guard.
    let current = storage
        .get_dns_governance_policy_address(static_call_ctx())
        .map_err(|e| e.encode())?;
    if new_policy_address == current {
        return Err(errors::make_error(errors::INVALID_DNS_PARAMETER));
    }

    // Quorum verification.
    verify_governance_quorum(contract, DNS_GOVERNANCE_BODY, &governance_payload, &governance_sigs)?;

    let mut storage_mut = IStorage::new(storage_addr);
    storage_mut
        .set_dns_governance_policy_address(static_call_ctx(), new_policy_address)
        .map_err(|e| e.encode())?;

    evm::log(crate::DnsGovernancePolicyAddressUpdated {
        old_address: current,
        new_address: new_policy_address,
        timestamp: current_timestamp(),
    });

    Ok(())
}
