# mcard:// DNS Resolution — Implementation Plan

**Version:** 0.1 (draft)  
**Date:** 2026-06-25  
**Status:** Draft  
**Strategic plan:** [dns-strategic-plan.md](dns-strategic-plan.md)

---

## Resolved design decisions

Before reading the steps below, note these decisions made during strategic planning:

- **Governance body:** `DnsGovernanceBody` added as a third `GovernanceBodyId` variant alongside `RootPolicyBody` and `PressRegistryBody`.
- **Nitro runtime:** unjs.io Nitro (deployable to Node.js, Cloudflare Workers, Deno, Bun, etc.).
- **Policy pointer type:** `PolicyAddresses` entries point to the policy card's on-chain `CardEntry` address — the same stable `bytes32` address already used throughout the registry. Callers then call `GetCardEntry` to get the policy card's log head CID.
- **Sub-path regex storage:** Lives only in the domain admin card document on IPFS. Presses fetch the card from IPFS to verify scope before relaying a `SetPolicyAddress` call.
- **Press for policy address updates:** Any press authorized for the policy under which the domain admin card was issued can relay `SetPolicyAddress` and `RemovePolicyAddress` on behalf of the card holder.
- **On-chain migration analysis:** Full feasibility analysis with Chainlink cost estimates is included in the DNS spec.
- **Governance folder:** `/governance/` top-level directory (new).

---

## Clarification checkpoints

The following are explicit pause points. Do not proceed past them without David's explicit approval.

**CP-1 (end of Phase 1):** Before writing any contract code, confirm the specs are correct and the on-chain migration analysis recommendation is accepted.

**CP-2 (end of Phase 2):** Before proceeding to governance documentation, confirm all contract changes compile, pass tests, and match the spec. No governance scripts should reference contract interfaces that haven't been finalized.

**CP-3 (before mainnet deployment in Phase 4):** Before deploying updated contracts to Arbitrum One mainnet, present the migration plan (Step 4.3) and wait for explicit approval. The storage contract redeploy affects all existing state; this cannot be undone.

---

## Phase 1: Specification

### Step 1.1 — Write `specs/dns_resolution.md`

**What:** Full DNS resolution spec covering:
- Address schema: two forms — `mcard://<raw-CID>` (direct reference, no DNS needed) and `mcard://<domain>/<path>` (DNS resolution via on-chain table lookup)
- `DomainRegistrations` table structure: key is the domain string, value includes active admin card address, registration timestamp, fraud risk level (0 = normal / 1 = monitored / 2 = suspended), suspension expiry
- `PolicyAddresses` table structure: key is `keccak256(domain || "\x00" || path)`, value is the policy card's `CardEntry` address (`bytes32`)
- Resolution algorithm: parse → check form → if domain/path, call `LookupPolicyAddress(domain, path)` → return `CardEntry` address (zero = not found)
- Domain admin card structure: a card issued by the DNS governance authority conferring the right to call `SetPolicyAddress` for a given domain; sub-path-scoped admin cards have a regex in their IPFS card document restricting which paths they may update
- Sub-path scoped delegation: a domain admin can issue sub-cards with path-scope constraints stored in the card document; the press fetches the card from IPFS to verify scope before accepting a `SetPolicyAddress` submission
- Full write authorization chain: domain admin signs a `SetPolicyAddressIntent`, submits to a press authorized under the DNS governance policy; press verifies card is active and scope allows the path; press calls `SetPolicyAddress` on-chain; DNS governance authority verifies the on-chain entry asynchronously
- Fraud risk escalation path: flagging criteria, "monitored" mode (public key registration required), suspension durations (first violation = 1 year + 1 year per additional violation), brand-name scanning requirement under monitored mode
- On-chain migration analysis (§On-Chain Governance — Feasibility): architecture for moving TXT verification on-chain via Chainlink Functions; cost estimate (current Chainlink Functions pricing × frequency of domain registrations); latency implications; recommendation to defer with named preconditions (Chainlink Functions maturity on Arbitrum, gas cost acceptability)

**Who:** Claude  
**Context needed:** `specs/object_specs/registry_contract.md`, `specs/card_protocol_spec.md`, `plans/dns-strategic-plan.md` §Goals and §Open Questions resolutions  
**Done when:** Spec is internally consistent; covers every behavior described in the strategic plan; acceptance criteria are written for each behavior; on-chain analysis section includes concrete per-call cost estimates with source citations (Chainlink docs).

---

### Step 1.2 — Update `specs/object_specs/registry_contract.md`

**What:** Add the following to the existing registry contract spec:

In §3 (Storage Layout):
- **§3.8 DomainRegistrations** — `mapping (string → DomainEntry)` where `DomainEntry` holds `admin_card_address bytes32`, `registered_at uint64`, `fraud_risk uint8`, `suspension_expires_at uint64`, `exists bool`
- **§3.9 PolicyAddresses** — `mapping (bytes32 → bytes32)` keyed by `keccak256(domain || "\x00" || path)`, value is the policy `CardEntry` address; zero value = not registered

In §3.6 (GovernanceKeysets):
- Add `DnsGovernanceBody` to the `GovernanceBodyId` enum
- Document which operations it governs: `RegisterDomain`, `DeregisterDomain`, `ClearDomainEntries`, `FlagDomainFraudRisk`

In §4 (Write Operations), add:
- **§4.17 RegisterDomain** — DNS governance body quorum required; creates `DomainRegistrations[domain]`; idempotent on the same admin card, errors if domain already has an active admin
- **§4.18 DeregisterDomain** — DNS governance body quorum required; clears `DomainRegistrations[domain]`
- **§4.19 SetPolicyAddress** — called by press authorized under the DNS governance policy on behalf of a domain admin card holder; verifies card is active and authorized for the domain/path; sets `PolicyAddresses[key]`; emits event for DNS governance authority to verify
- **§4.20 RemovePolicyAddress** — same authorization as SetPolicyAddress; removes an entry; authorized card must have scope covering that path
- **§4.21 ClearDomainEntries** — DNS governance body quorum required; removes all `PolicyAddresses` entries for a given domain; used during domain handoff and after fraud violations
- **§4.22 FlagDomainFraudRisk** — DNS governance body quorum required; sets `fraud_risk` level and optionally `suspension_expires_at`

In §5 (Read Operations), add:
- `LookupPolicyAddress(domain string, path string) → bytes32` — view; returns `PolicyAddresses[keccak256(domain||"\x00"||path)]`
- `GetDomainRegistration(domain string) → DomainEntry` — view; returns full entry

In §7 (Events), add:
- `DomainRegistered(domain, admin_card_address, timestamp)`
- `DomainDeregistered(domain, timestamp)`
- `PolicyAddressSet(domain, path, policy_card_address, setter_card_address, timestamp)`
- `PolicyAddressRemoved(domain, path, timestamp)`
- `DomainEntriesCleared(domain, timestamp)`
- `DomainFraudRiskUpdated(domain, fraud_risk, suspension_expires_at, timestamp)`

In §8 (Error Codes), add E-37 through E-44 for DNS-specific error conditions (domain not found, domain already registered, unauthorized domain path, policy card does not exist, domain suspended, etc.).

**Who:** Claude  
**Context needed:** `specs/object_specs/registry_contract.md` (full existing spec), `specs/dns_resolution.md` (from Step 1.1), `plans/dns-strategic-plan.md` §Open Questions resolutions  
**Done when:** All new storage sections, write operations, and read operations have complete function signatures, payloads, preconditions, state changes, and acceptance criteria matching the structure of existing operations (§4.1–§4.16).

---

### Step 1.3 — Phase 1 Milestone Review

**Context needed:** `specs/dns_resolution.md` (Step 1.1), updated `specs/object_specs/registry_contract.md` (Step 1.2)

**Review checklist:**
- Does `dns_resolution.md` cover the full resolution algorithm without ambiguity?
- Are all behaviors in `dns_resolution.md` backed by corresponding contract operations in the updated `registry_contract.md`?
- Are the `DomainRegistrations` and `PolicyAddresses` table structures consistent between the two specs?
- Does the on-chain analysis include cost estimates with source citations?
- Are there any contradictions with existing registry contract operations (§4.1–§4.16)?
- Does the `DnsGovernanceBody` quorum model mirror the existing `RootPolicyBody` pattern exactly, or deviate intentionally?

**Done when:** Checklist passes with no unresolved contradictions; summary written to `plans/milestones/dns-phase-1-summary.md`; David approves to proceed (**CP-1**).

---

## Phase 2: Contract Implementation

### Step 2.1 — Add `DnsGovernanceBody` to GovernanceBodyId enum

**What:** Find the `GovernanceBodyId` enum definition in the contracts (likely `contracts/protocol-types/src/`) and add `DnsGovernanceBody`. Update all exhaustive pattern matches. Confirm existing tests still compile and pass.

**Who:** Claude  
**Context needed:** `contracts/protocol-types/src/`, `contracts/storage-contract/src/`, `contracts/logic-contract/src/`, updated `registry_contract.md §3.6`  
**Done when:** Enum compiles with new variant; all existing Forge tests (`cargo test` or `forge test`) pass without modification.

---

### Step 2.2 — Add `DomainRegistrations` and `PolicyAddresses` to storage contract

**What:** Add the two new mappings to `contracts/storage-contract/src/`. Add setter functions (`set_domain_entry`, `clear_domain_entries`, `set_policy_address`, `remove_policy_address`), getter functions (`get_domain_entry`, `get_policy_address`), and the standard `CALLER_NOT_LOGIC_CONTRACT` guard on all setters. Add the `DnsGovernanceBody` keyset to `GovernanceKeysets` initialization (bootstrapped as 1-of-1 like the other bodies).

**Who:** Claude  
**Context needed:** `contracts/storage-contract/src/` (existing structure), updated `registry_contract.md §3.8-3.9`  
**Done when:** New mappings compile; setters revert with E-29 if called by anything other than `LogicContract`; getter view functions return zero-values for unregistered entries.

---

### Step 2.3 — Implement DNS write operations in logic contract

**What:** Implement the six new write operations in `contracts/logic-contract/src/`. Each must:
- For `RegisterDomain`, `DeregisterDomain`, `ClearDomainEntries`, `FlagDomainFraudRisk`: require `DnsGovernanceBody` quorum (reuse existing `verify_governance_quorum` pattern)
- For `SetPolicyAddress`, `RemovePolicyAddress`: verify that `press_address` is authorized under the DNS governance policy (i.e., `PressAuthorizations[dns_governance_policy_address][press_address].active == true`); verify that `card_address` is active in `CardEntries`; verify that `CardEntries[card_address].policy_address == dns_governance_policy_address` (the card was issued under the DNS governance authority's policy); emit the appropriate event so the DNS governance verifier script can pick it up

**Who:** Claude  
**Context needed:** `contracts/logic-contract/src/`, updated `registry_contract.md §4.17-4.22`, `contracts/storage-contract/src/` (post Step 2.2)  
**Done when:** All six operations compile; existing logic contract tests unaffected; each operation emits the correct event on success.

---

### Step 2.4 — Write Forge tests for DNS operations

**What:** Create `contracts/tests/src/DnsOps.t.sol` (or equivalent Rust test module) covering:
- `RegisterDomain` happy path: valid quorum + unused domain → entry created, event emitted
- `RegisterDomain` failure: domain already has active admin → E-38
- `SetPolicyAddress` happy path: active admin card + authorized press + valid path → entry set, `PolicyAddressSet` event emitted
- `SetPolicyAddress` failure: unauthorized press → PRESS_NOT_AUTHORIZED
- `SetPolicyAddress` failure: card not issued under DNS governance policy → E-40
- `RemovePolicyAddress`: authorized card → entry removed, event emitted
- `ClearDomainEntries`: DNS governance quorum → all entries for domain cleared
- `FlagDomainFraudRisk`: DNS governance quorum → `fraud_risk` set
- `LookupPolicyAddress` before/after `SetPolicyAddress` and `RemovePolicyAddress`
- `GetDomainRegistration` before/after `RegisterDomain` and `DeregisterDomain`
- `DnsGovernanceBody` quorum enforcement: insufficient sigs → INSUFFICIENT_QUORUM; wrong body → INVALID_GOVERNANCE_SIGNATURE

**Who:** Claude  
**Context needed:** `contracts/tests/src/` (existing test structure, e.g., `GovernanceOps.t.sol`, `CardOps.t.sol`), updated `registry_contract.md §acceptance criteria` for new operations, `contracts/tests/MANUAL_TESTING.md`  
**Done when:** All new tests pass; `forge test` (or `cargo test`) shows zero failures; acceptance criteria items from `registry_contract.md` Steps 4.17–4.22 are each covered by at least one test.

---

### Step 2.5 — Phase 2 Milestone Review

**Context needed:** `contracts/storage-contract/src/`, `contracts/logic-contract/src/`, `contracts/tests/src/DnsOps.t.sol`, updated `registry_contract.md §4.17-4.22`

**Review checklist:**
- Does `forge test` pass with zero failures?
- Do the six new write operations match the spec's precondition and state-change descriptions exactly?
- Do error codes match what's defined in `registry_contract.md §8`?
- Are events emitted with the correct parameters in the correct order?
- Are there any storage mutation paths that bypass the `CALLER_NOT_LOGIC_CONTRACT` guard?
- Does the `DnsGovernanceBody` quorum check reuse the exact same code path as `RootPolicyBody` and `PressRegistryBody`?

**Done when:** Checklist passes; summary written to `plans/milestones/dns-phase-2-summary.md`; David approves to proceed (**CP-2**).

---

## Phase 3: Governance Documentation

### Step 3.1 — Create `/governance/dns_governance_authority.md`

**What:** Charter document for the DNS Governance Authority covering:
- **Mandate:** The authority's role, what it is and isn't responsible for (is: TXT verification, domain card issuance, fraud monitoring, policy verification; isn't: judging organizational legitimacy, approving policy content, gatekeeping card issuance)
- **Composition:** Governance key holders, initial quorum (M-of-N), key rotation procedure via `RotateGovernanceKeys(DnsGovernanceBody, ...)`
- **Responsibilities table:** Each responsibility mapped to the script that implements it and the SLA (e.g., "verify policy address updates within 24 hours of on-chain event")
- **Fraud-risk escalation criteria:** What triggers a `FlagDomainFraudRisk` call (fraud reports received, visually similar domain within edit distance 1 of top-1000 domains, pattern of prior violations)
- **Suspension escalation table:** First violation = 1 year suspension; each additional violation adds 1 year
- **Brand scanning requirement:** Under fraud_risk level 1 (monitored), all public keys for policies at that domain must be registered with the authority before `SetPolicyAddress` is accepted; the authority scans policy card titles/content for protected brand names
- **Auditor registration:** The DNS governance authority is listed as an auditor on all domain admin cards and their sub-cards, enabling it to hold public keys for all cards in the chain
- **Relationship to RootPolicyBody and PressRegistryBody:** DNS governance operates independently; its keyset is rotated via `RotateGovernanceKeys(DnsGovernanceBody, ...)` authorized by the existing `DnsGovernanceBody` quorum

**Who:** Claude  
**Context needed:** `plans/dns-strategic-plan.md`, updated `registry_contract.md §3.6 (DnsGovernanceBody)`, `specs/dns_resolution.md`  
**Done when:** Charter covers all operational requirements referenced in `dns_resolution.md`; fraud escalation criteria are specific enough to be implemented as code; suspension table is unambiguous.

---

### Step 3.2 — Write `specs/process_specs/dns_governance_verifier.md`

**What:** Process spec for three Nitro governance scripts, following the structure of existing process specs (Actors, Preconditions, Steps, Acceptance Criteria). Each script:

**Script A — TXT Verification (`txt-verification`)**
- Actors: Domain applicant, DNS governance authority operator, Arbitrum One registry
- Preconditions: Applicant has a wallet address and public key; their domain is publicly registered with a DNS registrar; a valid `mcard-verify=<card_address>.<pubkey_fingerprint>` TXT record is set at `_mcard.<domain>`
- Steps: Receive verification request (domain, applicant card address, public key) → resolve `_mcard.<domain>` TXT records via standard DNS → confirm expected record is present → DNS governance authority issues domain admin card to applicant → calls `RegisterDomain` with DnsGovernanceBody quorum → returns card address to applicant
- Acceptance criteria covering: correct TXT record format, handling of propagation delay (retry with backoff), handling of multiple TXT records, failure path (no matching record)

**Script B — Admin Deactivation (`admin-deactivation`)**
- Actors: Current domain admin (requester), DNS governance authority, Arbitrum One registry
- Preconditions: Requester holds the current active domain admin card; old admin card addresses are known
- Steps: Receive deactivation request (domain, list of old admin cards to deactivate) → verify requester is the current active admin (on-chain `DomainRegistrations[domain].admin_card_address` matches requester's card) → verify each card in deactivation list is a child of the old admin chain (IPFS card walk) → authority calls `ClearDomainEntries` with DnsGovernanceBody quorum → authority deactivates listed cards → returns confirmation
- Acceptance criteria covering: requester must match current on-chain admin; deactivation is all-or-nothing; cleared entries emit events

**Script C — Policy Address Update Verification (`policy-address-verifier`)**
- Actors: DNS governance authority (monitoring), Arbitrum One registry, IPFS
- Preconditions: Authority is subscribed to `PolicyAddressSet` events on-chain; authority holds public keys for all admin cards in its auditor role
- Steps: Receive `PolicyAddressSet` event → fetch setter card document from IPFS → verify card's scope regex covers the posted path → verify policy card at the pointed address exists and is active on-chain → if domain is fraud_risk level 1 (monitored): verify policy card title/content for brand-name impersonation → if verification passes: retain entry, no action → if verification fails: authority calls `RemovePolicyAddress` with DnsGovernanceBody quorum, calls `RevokePress` if press submitted fraudulent entry, emits on-chain report
- Acceptance criteria covering: verification completes within 24-hour SLA; fraudulent press is reported via `RevokePress`; brand-name scanning is deterministic (uses registered brand name list, not discretionary judgment)

Include: Nitro-specific notes (how to create an event listener with `nitro`/H3, how to handle retries, recommended deployment targets, environment variable configuration for RPC endpoint and governance private keys).

**Who:** Claude  
**Context needed:** `specs/process_specs/open_offer_creation.md` (format reference), `/governance/dns_governance_authority.md` (Step 3.1), updated `registry_contract.md §4.17-4.22 and §7`, `specs/dns_resolution.md`  
**Done when:** All three scripts are fully described; acceptance criteria cover every happy path and key failure mode enumerated in `dns_resolution.md`; Nitro deployment notes are actionable.

---

### Step 3.3 — Create Nitro script stubs

**What:** Create `governance/scripts/` directory with three TypeScript files that compile cleanly and serve as implementation starting points:

- `governance/scripts/txt-verification.ts` — Nitro event handler for TXT verification requests; TypeScript interfaces for `VerificationRequest` and `VerificationResult`; placeholder DNS query logic with TODO markers; placeholder `RegisterDomain` calldata construction
- `governance/scripts/admin-deactivation.ts` — Nitro event handler for deactivation requests; TypeScript interfaces for `DeactivationRequest` and `DeactivationResult`; placeholder on-chain admin check; placeholder `ClearDomainEntries` calldata construction
- `governance/scripts/policy-address-verifier.ts` — Nitro polling/event handler for `PolicyAddressSet` events; TypeScript interfaces for the event payload; placeholder IPFS card fetch; placeholder brand-name scan; placeholder `RemovePolicyAddress` calldata construction

Each file imports from ethers.js (already a project dependency in `membership_card_verifier`) for contract calls and uses the storage contract ABI. Each file includes a `nitro.config.ts` example for the script's handler route.

**Who:** Claude  
**Context needed:** `specs/process_specs/dns_governance_verifier.md` (Step 3.2), `membership_card_verifier/packages/verifier/src/` (existing TypeScript patterns), ethers.js version in use  
**Done when:** All three stubs compile with `tsc --noEmit`; TypeScript interfaces match the inputs/outputs described in the process spec; no runtime dependencies added beyond ethers.js and the existing project stack.

---

### Step 3.4 — Phase 3 Milestone Review

**Context needed:** `/governance/dns_governance_authority.md`, `specs/process_specs/dns_governance_verifier.md`, `governance/scripts/` (three stubs), updated `registry_contract.md`, `specs/dns_resolution.md`

**Review checklist:**
- Is every governance body responsibility in the charter backed by a concrete script in the process spec?
- Do the three script stubs implement the interfaces described in the process spec (TypeScript type check)?
- Is the fraud escalation path in the charter specific enough to code against (no discretionary judgment calls)?
- Is the SLA in the charter (24-hour verification) achievable given the event polling model described in Script C?
- Are there any circular dependencies between the governance scripts (e.g., deactivation script calling verification script)?
- Does the governance authority's auditor role (holding public keys) create any key management obligations not covered in the charter?

**Done when:** Checklist passes with no unresolved gaps; summary written to `plans/milestones/dns-phase-3-summary.md`; David approves to proceed.

---

## Phase 4: Deployment

### Step 4.1 — Update deployment scripts

**What:** Update `contracts/scripts/` to redeploy the storage contract (new tables `DomainRegistrations` and `PolicyAddresses` require new contract bytecode; the storage contract address will change, which is a protocol migration — document this explicitly). Update the logic contract deployment to reference the new storage contract address. Update `contracts/deployments/README.md` with the new contract addresses and migration context.

**Who:** Claude  
**Context needed:** `contracts/scripts/`, `contracts/deployments/README.md`, updated `contracts/storage-contract/src/` and `contracts/logic-contract/src/` (from Phase 2)  
**Done when:** Deployment scripts run successfully against a local Arbitrum development environment (Anvil or equivalent); new contract addresses are recorded; the README notes that this deployment supersedes the previous storage contract.

---

### Step 4.2 — Deploy to Arbitrum Sepolia testnet

**What:** Run updated deployment scripts against Arbitrum Sepolia. Record new contract addresses. Run end-to-end manual test: (1) register a test domain, (2) set a policy address entry, (3) call `LookupPolicyAddress` and confirm it returns the correct `CardEntry` address, (4) remove the entry and confirm lookup returns zero.

**Who:** David (testnet wallet/key required)  
**Context needed:** `contracts/scripts/` (Step 4.1), `contracts/tests/MANUAL_TESTING.md`, Arbitrum Sepolia RPC endpoint  
**Done when:** Contracts deployed; `LookupPolicyAddress` returns correct result for a test domain; Forge tests pass against testnet deployment via `ARBITRUM_SEPOLIA_RPC_URL=... forge test --fork-url ...`.

---

### Step 4.3 — Mainnet migration plan

**What:** Document the mainnet deployment decision. The storage contract redeploy is a protocol migration: any existing `CardEntries`, `PolicyAuthorizerKeys`, `PressAuthorizations`, and `SubCardRegistrations` in the current storage contract must either be migrated to the new contract or the current contract sunset with the new one as the successor. Write a brief migration addendum covering: (a) current state of mainnet deployment (live or pre-launch?), (b) if pre-launch: simple redeploy with no migration needed, (c) if post-launch: migration script to copy state from old storage to new storage; update logic contract to point to new storage. This addendum is a decision document, not an implementation — David approves the approach before any mainnet action is taken.

**Who:** Claude (drafts), David (decides)  
**Context needed:** `contracts/deployments/README.md` (current deployment state), `plans/dns-strategic-plan.md`  
**Done when:** Addendum is written; migration approach is clearly documented; David has read it.

---

> **⚠ CP-3 — HARD STOP:** Do not proceed with mainnet deployment (Step 4.4) until David explicitly approves the mainnet migration plan from Step 4.3. This cannot be undone.

---

### Step 4.4 — Mainnet deployment

**What:** Execute the approved migration plan. Deploy updated contracts to Arbitrum One. Record new addresses. Verify `LookupPolicyAddress` works on mainnet with a test domain entry.

**Who:** David (mainnet wallet/key required)  
**Context needed:** Approved migration plan (Step 4.3), deployment scripts (Step 4.1), Arbitrum One RPC endpoint  
**Done when:** New contracts live on Arbitrum One; addresses recorded in `contracts/deployments/`; test verification passes.

---

### Step 4.5 — Phase 4 Milestone Review

**Context needed:** `contracts/deployments/` (Sepolia + mainnet deployment records), testnet test results, migration plan addendum

**Review checklist:**
- Are all new contract addresses recorded and consistent between deployment scripts and README?
- Does the testnet end-to-end test log confirm `LookupPolicyAddress` round-trips correctly?
- Is the old storage contract address documented as deprecated if a migration occurred?
- Are the Nitro script stubs updated with the new storage contract address?

**Done when:** Checklist passes; summary written to `plans/milestones/dns-phase-4-summary.md`; plan considered complete.

---

## File index

All files created or modified by this plan:

| File | Action |
|---|---|
| `specs/dns_resolution.md` | Create (Step 1.1) |
| `specs/object_specs/registry_contract.md` | Update — add §3.8, §3.9, §4.17–4.22, read ops, events, error codes (Step 1.2) |
| `plans/milestones/dns-phase-1-summary.md` | Create (Step 1.3) |
| `contracts/protocol-types/src/` | Update — add DnsGovernanceBody (Step 2.1) |
| `contracts/storage-contract/src/` | Update — add DomainRegistrations, PolicyAddresses, setters/getters (Step 2.2) |
| `contracts/logic-contract/src/` | Update — add six DNS write operations (Step 2.3) |
| `contracts/tests/src/DnsOps.t.sol` (or equivalent) | Create (Step 2.4) |
| `plans/milestones/dns-phase-2-summary.md` | Create (Step 2.5) |
| `/governance/dns_governance_authority.md` | Create — new directory (Step 3.1) |
| `specs/process_specs/dns_governance_verifier.md` | Create (Step 3.2) |
| `governance/scripts/txt-verification.ts` | Create (Step 3.3) |
| `governance/scripts/admin-deactivation.ts` | Create (Step 3.3) |
| `governance/scripts/policy-address-verifier.ts` | Create (Step 3.3) |
| `plans/milestones/dns-phase-3-summary.md` | Create (Step 3.4) |
| `contracts/scripts/` | Update — new deployment scripts (Step 4.1) |
| `contracts/deployments/README.md` | Update — new contract addresses (Steps 4.1, 4.4) |
| `plans/milestones/dns-phase-4-summary.md` | Create (Step 4.5) |
