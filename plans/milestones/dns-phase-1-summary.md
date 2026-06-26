# DNS Phase 1 Milestone Summary

**Date:** 2026-06-25  
**Status:** Ready for CP-1 review  
**Deliverables:** `specs/dns_resolution.md`, updated `specs/object_specs/registry_contract.md`

---

## Checklist Results

**Does `dns_resolution.md` cover the full resolution algorithm without ambiguity?**  
Yes. §3 specifies a deterministic 6-step algorithm: parse URI, check form (CID vs. domain/path), look up `DomainRegistrations`, check suspension, call `LookupPolicyAddress`, return `CardEntry` address. Ambiguous cases (CID vs. domain with dots) are resolved by checking CID form first. NOT_FOUND and DOMAIN_SUSPENDED return conditions are explicit.

**Are all behaviors in `dns_resolution.md` backed by corresponding contract operations in `registry_contract.md`?**  
Yes, with cross-references verified:

| Behavior in `dns_resolution.md` | Contract operation |
|---|---|
| Domain registration (TXT verification) | §4.17 `RegisterDomain` |
| Domain deregistration (handoff) | §4.18 `DeregisterDomain` |
| Setting a policy address | §4.19 `SetPolicyAddress` |
| Removing a policy address | §4.20 `RemovePolicyAddress` |
| Clearing all entries for a domain | §4.21 `ClearDomainEntries` |
| Fraud risk escalation / suspension | §4.22 `FlagDomainFraudRisk` |
| Resolving a domain/path URI | §5 `LookupPolicyAddress` |
| Reading domain registration state | §5 `GetDomainRegistration` |

**Are the `DomainRegistrations` and `PolicyAddresses` table structures consistent between the two specs?**  
Yes. `dns_resolution.md §4.1` and `registry_contract.md §3.8` define identical `DomainEntry` fields. `dns_resolution.md §4.2` and `registry_contract.md §3.9` use the identical key derivation (`keccak256(domain_bytes || 0x00 || path_bytes)`) and zero-value semantics. `DnsGovernancePolicyAddress` is described in `dns_resolution.md §4.3` and `registry_contract.md §3.10` consistently as a write-once bytes32 global variable.

**Does the on-chain analysis include cost estimates with source citations?**  
Yes. `dns_resolution.md §9` includes:
- Per-request Chainlink Functions fee: ~0.2 LINK (~$4.00 USD at 2025 prices)
- Arbitrum One callback gas: ~300,000 gas (~$0.02)
- Total per domain registration: ~$4.02
- Source: Chainlink Functions documentation (https://docs.chain.link/chainlink-functions/resources/billing)
- Four named preconditions for deferred migration are listed explicitly.

**Are there any contradictions with existing registry contract operations (§4.1–§4.16)?**  
None found. The DNS operations:
- Reuse existing press authorization tables (`PressAuthorizations`) without modification.
- Reuse the existing `CardEntries` table for both admin cards and policy cards without modification.
- Reuse the existing `SubCardRegistrations` table for sub-path-scoped admin sub-cards.
- Reuse error codes E-02, E-03, E-04, E-05, E-06, E-07 where applicable rather than defining new codes.
- Follow the same governance payload / quorum verification pattern (§6.2) used by §4.6–§4.10.
- The `DnsGovernanceBody` keyset is a new `GovernanceBodyId` variant; the enum extension does not affect existing operations.

**Does the `DnsGovernanceBody` quorum model mirror the existing `RootPolicyBody` pattern exactly, or deviate intentionally?**  
Mirrors exactly. `DnsGovernanceBody` uses the same `GovernanceKeyset` structure, the same `RotateGovernanceKeys` operation, the same §6.2 quorum verification logic, and the same 1-of-1 bootstrap pattern. No intentional deviation. One intentional structural difference: `DnsGovernanceBody` is self-amending (its key rotation is authorized by its own quorum) without supervisory oversight from `RootPolicyBody`, unlike `PressRegistryBody` which has dual-authorization requirements for key rotation. This is intentional — DNS governance is an independent domain distinct from core protocol governance, as described in `dns-strategic-plan.md §Rationale`.

---

## Design Decisions — Resolved

The following decisions from initial spec writing were reviewed and resolved:

1. **`DnsGovernancePolicyAddress` is mutable via `DnsGovernanceBody` quorum** (§4.24, `SetDnsGovernancePolicyAddress`). Not write-once. The escape hatch is needed for policy authorizer key compromise recovery. Changing the value is a breaking migration (all existing domain admin cards are orphaned) and carries an explicit spec warning. Decided 2026-06-25.

2. **`DeregisterDomain` preserves `fraud_risk`.** A deregistered-then-reregistered domain inherits its prior fraud risk level. Explicit `FlagDomainFraudRisk(domain, 0, 0)` required to restore normal status. This prevents fraud status clearing via deregister/re-register cycle. Confirmed 2026-06-25.

3. **`exists` is write-once-true on `DomainEntry`.** `DeregisterDomain` does not clear `exists`. Consistent with existing protocol patterns (`CardEntry.exists`). Confirmed 2026-06-25.

4. **`RemovePolicyAddress` has two authorization paths.** Press path (card holder) and governance quorum path (fraud response). Both paths confirmed as desired. Confirmed 2026-06-25.

5. **`ClearDomainEntries` path limit of 500.** Precautionary cap matching the batch operation pattern (§4.15 MAX_BATCH_SIZE = 100, scaled up for domain management). 500 paths × ~5,000 gas each ≈ 2.5M gas — safe for Arbitrum One. Limit is raisable via logic upgrade. Confirmed 2026-06-25.

## Design Decisions — Added Post-Review

The following decisions were added after review of the authorization model:

6. **`SetPolicyAddress` has explicit domain-card binding check** (§4.19). `admin_card_address` must match `DomainRegistrations[domain].admin_card_address` (E-46). `sub_card_address`, if non-zero, must be a direct sub-card of the admin card in `SubCardRegistrations` (one-hop, E-45). Sub-sub-cards (depth > 1) are not recognized on-chain. Press verifies sub-card ML-DSA-44 holder signature and `dns_path_scope` regex off-chain. Decided 2026-06-25.

7. **Governance rollback via `GovernanceSetPolicyAddress`** (§4.23). New operation allowing `DnsGovernanceBody` quorum to directly write or clear any `PolicyAddresses` entry without press or card-holder involvement. Works on suspended domains. Primary use case: rollback after a compromised press writes fraudulent entries. Tradeoff: expands governance body blast radius to include writes (not just deletions), which was accepted given M-of-N quorum requirement and immediate on-chain event visibility. Decided 2026-06-25.

8. **Compromised press is the correct threat model for fraudulent `SetPolicyAddress` calls**, not "attacker finds admin card addresses." An attacker cannot register a fraudulent sub-card without the domain admin's ML-DSA-44 signature (enforced press-side at `RegisterSubCard`) — unless the press is compromised and skips that check. The on-chain binding check (decision 6) limits blast radius; `GovernanceSetPolicyAddress` (decision 7) provides rollback; `RevokePress` stops further damage. Confirmed 2026-06-25.

---

## Files Modified

| File | Action | Status |
|---|---|---|
| `specs/dns_resolution.md` | Created; updated §4.3, §6.2, added §6.3 | Complete |
| `specs/object_specs/registry_contract.md` | Updated v0.4→v0.5: §3.6, §3.10, §4.19 rewritten, §4.23–4.24 added, §7 events updated, §8 E-45–E-46 added | Complete |
| `plans/milestones/dns-phase-1-summary.md` | Created; design decisions updated post-review | This file |

---

## CP-1 Approval Required

Before proceeding to Phase 2 (contract implementation), David's explicit approval of this milestone is required per the implementation plan. Phase 2 will add `DnsGovernanceBody` to the `GovernanceBodyId` enum in contracts, implement the storage tables and write operations in Rust, and write Forge tests.
