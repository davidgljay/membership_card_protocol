# mcard:// DNS Resolution — Strategic Plan

**Version:** 0.1 (draft)  
**Date:** 2026-06-25  
**Status:** Draft — awaiting open question resolution before implementation plan

---

## Goals

### 1. Make policy addresses human-readable and domain-portable

`mcard://NYTimes.com/staff/reporter` should unambiguously resolve to the active policy for that credential class. The protocol already has stable policy CIDs and on-chain pointers; this goal is to layer a DNS-like namespace on top so that organizations can publish and update their policy addresses without requiring users to track raw CIDs.

### 2. Establish domain ownership as the root of naming authority

Domain names are already a widely-understood and legally-enforceable form of organizational identity. Rather than building a parallel naming authority from scratch, the protocol anchors the mcard:// namespace to DNS TXT record ownership — a proof mechanism relying parties already trust and that courts can adjudicate.

### 3. Preserve the protocol's trust model across name changes

A domain changing hands should not allow the new owner to inherit the old owner's issued policies without explicit re-verification. The name space must be cleanable: when a domain transfers, the incoming owner can wipe prior admin chains and policy entries and start fresh.

### 4. Protect against typosquat and brand-impersonation fraud

A domain like `nytines.com` could be registered legitimately but used maliciously to mint `mcard://nytines.com/staff/reporter` cards titled "New York Times Reporter." The system needs a fraud-response path that is proportionate, deterministic, and auditable — not purely discretionary.

### 5. Keep governance operations asynchronous and non-blocking

The DNS governance authority verifies and monitors but does not gate card issuance in real time. Press operations proceed normally; the authority audits after the fact and removes unauthorized entries. This preserves liveness and avoids creating a single-point-of-failure in the write path.

---

## Rationale

### Why anchor to DNS TXT records?

DNS TXT verification is the same mechanism used by Google, Let's Encrypt, and countless other services to prove domain ownership without requiring a centralized registrar API or legal review. It's auditable, scriptable, and familiar to any operator who has set up email authentication. Using it as the root of authority for mcard:// domain registration means the governance authority can stay thin and procedural — it runs scripts, it doesn't make judgment calls about whether an organization deserves a domain.

### Why is the governance authority post-hoc rather than a write gate?

Making the DNS authority a required approver on every `PolicyAddresses` update would introduce a single point of failure and a latency dependency for every policy deployment. The protocol already relies on presses as authorized intermediaries and on verifiers for post-hoc compliance checking; the DNS authority fits the same pattern. It's an auditor, not a gatekeeper.

### Why allow the most recent domain admin to deactivate all prior admin chains?

Domain transfers happen. When a domain changes hands, the new owner should not be responsible for credentials issued by the prior owner, and the prior owner's cards should not continue to confer naming authority. The "most recent admin can wipe all prior admin chains" rule is the simplest mechanism that handles both hostile transfers (an adversary who seized a domain) and friendly ones (an acquisition). The audit trail on-chain preserves the full history for dispute resolution.

### Why the fraud-risk escalation path (forced public key registration for suspicious domains)?

Typosquat domains are a real threat — `mcard://nytimes.com/staff/reporter` and `mcard://nytines.com/staff/reporter` look nearly identical in a URL bar. Requiring the DNS authority to hold public keys for all policies under a suspicious domain allows it to scan the policy content for brand impersonation. This is a targeted, proportionate escalation: most domains are never flagged; only domains that match known fraud patterns or receive fraud reports enter the heightened scrutiny regime.

### Why Nitro for the governance scripts?

Nitro (the universal JavaScript server runtime) allows the governance scripts to be deployed to Node.js, Cloudflare Workers, Deno, Vercel, or any edge environment without rewriting. Given that the DNS governance authority needs to be operated reliably and potentially by multiple parties, portability reduces lock-in and makes community-run redundant instances viable.

### On the question of moving scripts to the logic contract

Moving TXT verification on-chain is architecturally attractive (full transparency, no trusted DNS authority operator) but practically blocked by two constraints: (1) DNS TXT lookups require external HTTP calls, which EVM contracts cannot make natively — they require an oracle; (2) the WASM/Stylus execution environment on Arbitrum does not currently support arbitrary network I/O. The plan should document the trade-off clearly and sketch what a future on-chain migration would require, but the immediate implementation will keep verification off-chain and focus on making the trust model of the DNS authority explicit and auditable.

---

## Key Objectives

### Goal 1: Human-readable, domain-portable policy addresses

- A client submitting `mcard://NYTimes.com/staff/reporter` receives the current policy card address within one on-chain read and zero trusted intermediaries.
- The schema spec clearly distinguishes between `mcard://<raw-CID>` (direct policy reference, no DNS resolution needed) and `mcard://<domain>/<path>` (DNS resolution required).
- The `PolicyAddresses` table on-chain stores the canonical association and is queryable via the storage contract's standard read interface.

### Goal 2: DNS ownership as naming root

- A domain admin card is issued only to parties who have completed DNS TXT verification via the governance authority's script.
- The on-chain `DomainRegistrations` table is write-protected: only the DNS governance authority (via its governance keyset) can add or remove entries.
- Domain admin cards confer exactly the right to add policy address entries for that domain (full domain) or a regex-scoped subset (sub-path-scoped sub-cards).

### Goal 3: Clean domain handoff

- The most recently verified domain admin can deactivate all prior admin cards and their delegated sub-cards via a single governance operation.
- All policy entries associated with the prior admin chain can be cleared.
- The deactivation is recorded on-chain with full audit trail; prior cards issued under old policies remain verifiable from IPFS (the policies themselves are content-addressed and don't disappear).

### Goal 4: Typosquat and brand-impersonation defense

- The DNS governance authority has a defined escalation path: a domain flagged as fraud-risk enters "public key registration required" mode.
- Policy public keys registered under a flagged domain are scanned for brand-name impersonation; violating policies are deregistered.
- After multiple violations, the domain is suspended from the registry for a period that grows with repeat offenses.
- The fraud-risk flagging criteria, escalation thresholds, and suspension durations are specified in the DNS governance body charter.

### Goal 5: Non-blocking, asynchronous governance

- No press operation waits on DNS governance authority approval.
- The governance authority monitors `PolicyAddresses` update events and verifies each within a defined SLA (to be specified in the governance charter).
- Unauthorized entries are removed by the governance authority, not by the original press.
- A deregistered entry emits an on-chain event that presses and verifiers can observe.

---

## Open Questions

**OQ-DNS-1 — Governance body structure:** Should the DNS Governance Authority be added as a third `GovernanceBodyId` in the existing `GovernanceKeysets` mapping (alongside `RootPolicyBody` and `PressRegistryBody`), or should it be an entirely separate authority with its own on-chain keyset outside the current governance model? The first option reuses existing infrastructure; the second option keeps the DNS authority's scope cleanly separated from core protocol governance.

**OQ-DNS-2 — Nitro runtime assumption:** Confirming "Nitro" refers to the [Nitro universal JavaScript server runtime](https://nitro.unjs.io/) (used by Nuxt, H3, etc.) rather than Arbitrum Nitro (the rollup engine) or AWS Nitro Enclaves. The governance scripts will be authored as Nitro handlers deployable to Node.js, Cloudflare Workers, Deno, Bun, etc.

**OQ-DNS-3 — Policy address mutability:** The spec says the `policy_address` table "links to a mutable pointer for a policy." Should this be: (a) an IPFS IPNS name, (b) the on-chain card mutable pointer (registry address in `CardEntries`), or (c) a new dedicated mutable pointer type? This affects how updates to the policy itself are propagated to resolvers.

**OQ-DNS-4 — On-chain migration cost/complexity:** Before drafting the implementation plan, how deeply should the analysis of moving governance scripts to the logic contract go? Specifically: should the plan include a full feasibility analysis with oracle cost estimates (e.g., Chainlink per-call pricing), or a lighter-weight architectural sketch with an explicit "defer to Phase N" recommendation?

**OQ-DNS-5 — `governance/` folder location:** Should the DNS governance body document live at `/governance/dns_governance_authority.md` (creating a new top-level `/governance/` directory) or somewhere else in the existing spec hierarchy (e.g., `specs/governance/dns_governance_authority.md`)? No `/governance/` directory currently exists in the repo.

**OQ-DNS-6 — Sub-path scoping regex:** The spec describes sub-path-scoped admin cards (e.g., "must start with /volunteer"). Should these regex patterns be stored in the card document on IPFS (subject to standard card update/revocation machinery) or also mirrored on-chain in the `DomainRegistrations` table for efficient enforcement by the press without an IPFS fetch?

**OQ-DNS-7 — Press role in policy address updates:** The spec says "a card holder signs an association between an address and a policy and submits it to an authorized press. The press confirms that the card requesting the update is active and is authorized to make the update for that domain and directory structure. If so, it submits the update." Does this mean any existing authorized press (under any policy) can relay these submissions, or does the DNS governance authority designate specific presses for this purpose?
