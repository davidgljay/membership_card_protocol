# DNS Phase 3 Milestone Summary

**Date:** 2026-06-25  
**Status:** Ready for Phase 3 review  
**Deliverables:**
- `governance/DnsGovernanceBody/mandate.md`
- `specs/process_specs/dns_governance_verifier.md`
- `governance/scripts/txt-verification.ts`
- `governance/scripts/admin-deactivation.ts`
- `governance/scripts/policy-address-verifier.ts`

---

## Review Checklist

**Is every governance body responsibility in the charter backed by a concrete script in the process spec?**  
Yes. The charter's responsibilities table (mandate.md §Responsibilities Table) maps each responsibility to a specific script:
- TXT verification → Script A (`txt-verification`)
- Admin deactivation → Script B (`admin-deactivation`)
- `PolicyAddressSet` verification → Script C (`policy-address-verifier`)
- Brand-name scanning → Script C (integrated into the verification pipeline)
- Fraud suspension → Manual action triggered by Script C's output

The only responsibility without a dedicated script is the `SetDnsGovernancePolicyAddress` escape hatch (§4.24), which is correctly listed as a manual last-resort action with no corresponding script.

**Do the three script stubs implement the interfaces described in the process spec?**  
Yes — `tsc --noEmit` passes with zero errors across all three stubs. TypeScript interfaces match the process spec inputs and outputs:
- `VerificationRequest` / `VerificationResult` (Script A)
- `DeactivationRequest` / `DeactivationResult` (Script B)
- `PolicyAddressSetEvent` / `VerificationRecord` / `VerificationOutcome` (Script C)

**Is the fraud escalation path in the charter specific enough to code against?**  
Yes. The mandate defines:
- Level 0 → Level 1: Exact criteria (Levenshtein distance 1, brand list exact match, ≥1 fraud report substantiated within 72h)
- Level 1 → Level 2: Exact criteria (brand-name scan failure in policy card content, or ≥3 confirmed reports in 12 months)
- Suspension durations: N violations = N years (no ambiguity)
- Brand-name scan match condition: case-insensitive substring; no discretionary judgment
- Fraudulent press threshold: 3 violations in 30 days → submit report to PressRegistryBody

**Is the 24-hour SLA achievable given the event polling model?**  
Yes, with caveats. Script C polls every 60 seconds (configurable via `POLL_INTERVAL_MS`). Events are processed within one polling interval of detection. The practical latency is: block finality (~2s on Arbitrum) + poll interval (≤60s) + processing time (~seconds). Total is well under 24 hours for normal operation. The SLA monitoring function in Script C alerts operators when any event has been pending for more than `SLA_HOURS` hours, providing a backstop.

Caveat: IPFS content fetches (for card document scanning) can be slow or fail. Script C's implementation notes specify that IPFS failures result in a skipped scan (not a removal), to avoid false positives from IPFS unavailability. This is the correct behavior; the entry is re-evaluated on the next polling pass.

**Are there circular dependencies between the governance scripts?**  
No. The three scripts are independent:
- Script A is triggered by applicant HTTPS requests; has no dependency on B or C.
- Script B is triggered by domain admin HTTPS requests; has no dependency on A or C.
- Script C is a background polling process; has no dependency on A or B.

None of the scripts call each other. The only shared resource is the Arbitrum One registry contract (read/write) and IPFS (read-only from scripts).

**Does the governance authority's auditor role create key management obligations not covered in the charter?**  
Yes — and the charter addresses this explicitly in §Auditor Role and Key Management:
- The authority holds public keys (not private keys) in its auditor role. Loss of these keys degrades scanning capability but does not compromise credentials.
- Public keys are indexed by card address in an off-chain database, backed up independently by each operator.
- When cards are deactivated (via Script B or `DeregisterDomain`), corresponding keys are archived.

One gap identified: the charter does not specify a maximum retention period for archived public keys (from deactivated cards). This is a low-priority governance decision that can be deferred to the authority's operational setup phase.

---

## Technical Notes

**viem vs ethers.js:** The implementation plan specified ethers.js, but the project uses viem (^2.30.0) in the press package. The stubs use viem throughout. This is the correct library for this project.

**`defineTask` API:** Nitro 2.x's task API does not export `defineTask` from `nitropack/runtime` at the library level — it is only available in the Nitro server runtime context. The stub uses a local shim that matches the Nitro 2.x task interface shape, ensuring `tsc --noEmit` passes. When deployed as a Nitro task (placed in the `tasks/` directory of a Nitro project), the runtime provides the real `defineTask` equivalent.

**TODO markers:** All three stubs contain `TODO` markers for the specific implementation points:
- DNS TXT query implementation (Script A, Step 4)
- Genesis card document IPFS upload (Script A, Step 5)
- On-chain transaction construction for each governance operation (all scripts)
- ML-DSA-44 signature verification (Script B, Step 3)
- Predecessor chain walking (Script B, Step 4)
- Brand name list HTTP fetch (Script C)
- IPFS card content fetch (Script C)

These are implementation tasks for Phase 4 or a follow-on implementation sprint. The interfaces, control flow, and error paths are fully specified.

---

## Files Created

| File | Status |
|---|---|
| `governance/DnsGovernanceBody/mandate.md` | Complete |
| `specs/process_specs/dns_governance_verifier.md` | Complete |
| `governance/scripts/txt-verification.ts` | Complete (stub) |
| `governance/scripts/admin-deactivation.ts` | Complete (stub) |
| `governance/scripts/policy-address-verifier.ts` | Complete (stub) |
| `governance/scripts/package.json` | Complete |
| `governance/scripts/tsconfig.json` | Complete |
| `plans/milestones/dns-phase-3-summary.md` | This file |
