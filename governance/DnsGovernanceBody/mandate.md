# DnsGovernanceBody — Mandate

**On-chain identifier:** `GovernanceBodyId::DnsGovernanceBody`  
**Quorum:** M-of-N (bootstrapped as 1-of-1; see §Composition below)  
**Status:** Active  
**Last reviewed:** 2026-06-25

---

## Purpose

The DNS Governance Authority operates the `DnsGovernanceBody` — the on-chain governance body that anchors the `mcard://` human-readable namespace to DNS domain ownership. Its role is procedural and narrowly scoped: it runs deterministic verification scripts, not judgment calls.

**What the DNS Governance Authority is responsible for:**
- Verifying DNS TXT record ownership before issuing domain admin cards.
- Issuing and deactivating domain admin cards on-chain.
- Monitoring `PolicyAddressSet` events and verifying that entries conform to the authorization chain.
- Scanning policy card content for brand-name impersonation under the fraud risk escalation process.
- Maintaining the registered brand name list and the fraud audit log.

**What the DNS Governance Authority is NOT responsible for:**
- Judging whether an organization has a legitimate claim to a domain name. That is the domain registrar's function.
- Approving or rejecting the content of policy cards. The authority only checks scope and brand-name impersonation; it does not review policy terms.
- Gatekeeping individual card issuance. Presses issue cards; the authority's role is limited to the domain namespace layer.
- Acting as an arbiter in domain ownership disputes. Such disputes must be resolved at the DNS level; the authority treats DNS TXT record control as conclusive evidence of domain ownership.

---

## On-Chain Powers

Every action listed here requires a valid quorum signature from the active `DnsGovernanceBody` keyset, verified on-chain via the RIP-7212 secp256r1 precompile.

### RegisterDomain — `§4.17`

Creates a domain entry in `DomainRegistrations` after DNS TXT verification succeeds. Sets `admin_card_address` to the newly-issued domain admin card and stores the admin's secp256r1 public key in `DnsAdminCardKeys`.

**Trigger:** Successful completion of the `txt-verification` script. `RegisterDomain` is never called without a verified TXT record.

### DeregisterDomain — `§4.18`

Clears the `admin_card_address` from a domain entry, preventing new `SetPolicyAddress` submissions under that domain. Used during domain handoff and when a domain registration is terminated.

**Note:** `DeregisterDomain` preserves the domain's `fraud_risk` and `suspension_expires_at`. A previously flagged domain that is re-registered does not start with a clean fraud history.

### GovernanceSetPolicyAddress — `§4.23`

Directly writes or clears a `PolicyAddresses` entry. The primary rollback operation — used to restore a legitimate mapping after a fraudulent overwrite, or to clear an unauthorized entry when the legitimate domain admin is unavailable.

**This is a broad power.** It allows the body to write any policy address for any domain. It must only be used in response to confirmed fraud, failed verification, or emergency correction. Every use must be recorded in the fraud audit log with a documented rationale.

### RemovePolicyAddress (governance path) — `§4.20`

Removes a specific domain/path policy address entry via governance quorum. Used when `GovernanceSetPolicyAddress` (with zero value) is not appropriate — for example, when the authority wants to remove an entry without implicitly setting it to "cleared by governance."

### ClearDomainEntries — `§4.21`

Removes all specified `PolicyAddresses` entries for a domain in a single governance action. Used during domain handoff (clearing a prior admin's entries before the new admin re-registers) and as part of the fraud suspension action (removing all entries when a domain is suspended).

### FlagDomainFraudRisk — `§4.22`

Sets the `fraud_risk` level for a domain (`0` = normal, `1` = monitored, `2` = suspended). Used to escalate suspicious domains, suspend confirmed violators, and restore domains after a suspension expires.

### SetDnsGovernancePolicyAddress — `§4.24`

Rotates the global `DnsGovernancePolicyAddress` storage variable to a new policy address. **This is a last-resort escape hatch** — it orphans all existing domain admin cards and requires a full migration. It should only be used if `RotateAuthorizerKey` on the existing policy is insufficient (e.g., the authorizer key is irretrievably lost).

### RotateGovernanceKeys — `§4.10` (self-amending)

Amends the `DnsGovernanceBody` keyset: adds or removes member keys, updates the quorum threshold. Self-amending — the current quorum must approve changes to its own membership.

---

## What the DNS Governance Authority Cannot Do

- **Cannot register or revoke individual presses.** Press authorization (`AuthorizePress`, `RevokePress`) is `PressRegistryBody`'s domain.
- **Cannot write to individual card entries.** Card head updates and registrations are press operations.
- **Cannot register new root policies.** Policy registration is `RootPolicyBody`'s domain.
- **Cannot upgrade the logic contract.** Protocol upgrades belong to `RootPolicyBody`.
- **Cannot judge the legitimacy of an organization's claim to a domain.** DNS TXT record control is the only criterion.

---

## Composition

**Bootstrap:** The contract is deployed with a 1-of-1 `DnsGovernanceBody` keyset (single deployer key, `quorum = 1`). The deployer calls `RotateGovernanceKeys(DnsGovernanceBody, ...)` to expand the keyset as authority operators are onboarded. The first rotation must propose at least 3 keys (enforced by the contract).

**Target composition:** 3–5 operators, majority quorum (e.g., 2-of-3 or 3-of-5). Operators should be geographically distributed and organizationally independent to prevent single-point-of-failure in verification availability.

**Key custody:** Each operator holds their secp256r1 signing key on a hardware security module. Software keys are not permitted for production key holders.

**Operator responsibilities:** Each operator is expected to be capable of running the three governance scripts independently, reviewing fraud reports, and signing governance transactions when contacted by the other operators. Operators must be available to sign time-sensitive actions (fraud suspension, rollback) within 4 hours of notification.

---

## Responsibilities Table

| Responsibility | Script | SLA | On-chain action |
|---|---|---|---|
| Verify DNS TXT record and issue domain admin card | `txt-verification` | Complete within 48 hours of request receipt | `RegisterDomain` |
| Deactivate old admin chain during domain handoff | `admin-deactivation` | Complete within 48 hours of request receipt | `ClearDomainEntries`, `DeregisterDomain`, card deactivation |
| Verify each `PolicyAddressSet` entry | `policy-address-verifier` | Complete within 24 hours of on-chain event | None (if valid); `GovernanceSetPolicyAddress` or `RemovePolicyAddress` (if invalid) |
| Scan policy cards for brand impersonation (monitored domains) | `policy-address-verifier` | Included in the 24-hour verification SLA | `RemovePolicyAddress` (if violation found) |
| Suspend domains with confirmed fraud violations | Manual (triggered by `policy-address-verifier` finding) | Within 4 hours of confirmed violation | `FlagDomainFraudRisk(domain, 2, expiry)`, `ClearDomainEntries` |
| Restore suspended domains after suspension period | Manual (triggered by domain admin request) | Within 7 days of request receipt | `FlagDomainFraudRisk(domain, 0, 0)` |
| Maintain registered brand name list | Manual | Reviewed quarterly or after each brand dispute report | Off-chain only |

---

## Fraud Risk Escalation

### Level 0 → Level 1 (Monitored)

**Automated flagging — triggers immediately on domain registration:**
- The domain string has a Levenshtein edit distance of 1 from any entry in the authority's top-1000 brand domain list (case-insensitive, after stripping TLD suffixes and common subdomain prefixes such as `www.`).
- The domain string is an exact case-insensitive match for a registered brand name in the authority's brand protection list.

**Report-triggered flagging (transitions to Level 1 pending review):**
- A verifier, card holder, or observer submits a fraud report via the authority's reporting endpoint, citing a specific domain and specific `PolicyAddressSet` entries.
- The authority reviews the report within 72 hours:
  - If substantiated → calls `FlagDomainFraudRisk(domain, 1, 0)` (no suspension timer).
  - If unsubstantiated → no action; report is logged for pattern tracking.

**Effect of Level 1 (Monitored):** The domain admin must register their secp256r1 public key with the authority (via a side-channel HTTPS form) before any `SetPolicyAddress` submission is relayed. The `policy-address-verifier` script applies brand-name scanning to all new policy entries under monitored domains.

### Level 1 → Level 2 (Suspended)

**Triggers (any one is sufficient):**
- The `policy-address-verifier` script finds that a policy card's title or credential field values contain a registered brand name that the domain admin has not demonstrated a right to use (i.e., they don't control the brand's own domain or have a documented license).
- A domain accumulates 3 or more confirmed fraud reports within any 12-month period, regardless of whether each individual report crossed the Level 1 threshold.

**Action:** The authority calls `FlagDomainFraudRisk(domain, 2, suspension_expires_at)` and `ClearDomainEntries(domain, all_active_paths)` in the same governance session.

### Suspension Durations

| Violation count | Suspension duration |
|---|---|
| 1st confirmed violation | 1 year from `FlagDomainFraudRisk` call |
| 2nd confirmed violation | 2 years from `FlagDomainFraudRisk` call |
| 3rd confirmed violation | 3 years from `FlagDomainFraudRisk` call |
| N-th confirmed violation | N years from `FlagDomainFraudRisk` call |

The violation count is tracked in the authority's off-chain fraud audit log and in the on-chain `DomainFraudRiskUpdated` event history. The suspension duration is set by computing `block.timestamp + (N * 365 * 24 * 3600)` before signing the governance payload.

---

## Brand-Name Scanning

Brand-name scanning applies to all policy card entries under Level 1 (Monitored) domains, and to all new `PolicyAddressSet` entries for any domain where the policy card title or credential fields match a registered brand name.

**Scan scope:**
- Policy card title field.
- All text-type credential field values (strings, descriptions).

**Match condition:** An exact case-insensitive substring match of any brand name in the registered brand name list. Partial word matches are evaluated in context: `"NewYorkTimesReporter"` and `"nytimes"` both trigger for the brand `"New York Times"`.

**Determinism requirement:** Scanning must produce the same result from any authority operator running the same version of the brand name list. Discretionary judgment is not permitted. If a match is ambiguous, the operator should err toward not removing the entry and instead elevate to a formal fraud report.

**Brand name list governance:** The registered brand name list is maintained as a versioned JSON document in the authority's governance repository. Changes require approval from a quorum of `DnsGovernanceBody` key holders via off-chain deliberation (minimum 14-day notice period before adoption). The list version used for any given scan is recorded in the fraud audit log.

---

## Auditor Role and Key Management

The DNS Governance Authority holds an auditor role on all domain admin cards and their sub-cards. This means:
- The authority is listed in the `auditors` field of domain admin card documents issued through the `txt-verification` script.
- For Level 1 (Monitored) domains, the authority holds the public keys for all active policy admin cards, enabling it to scan policy card content and verify that `SetPolicyAddressIntent` signatures came from the registered key holder.

**Key management obligations:**
- The authority must store and protect the public keys it holds in its auditor role. These are public keys, not private keys — loss means the ability to perform content scans is degraded, not that any credentials are compromised.
- Public keys are indexed by card address in an off-chain database. The database is backed up by each operator independently.
- When a domain admin card is deactivated (via `admin-deactivation` or `DeregisterDomain`), the corresponding public keys are removed from the active auditor key store and archived.

---

## Relationship to RootPolicyBody and PressRegistryBody

`DnsGovernanceBody` operates independently of `RootPolicyBody` and `PressRegistryBody`. Its on-chain keyset is self-amending via `RotateGovernanceKeys(DnsGovernanceBody, ...)`. Neither `RootPolicyBody` nor `PressRegistryBody` co-authorizes `DnsGovernanceBody` key rotations.

The bodies interact in two ways:

1. **`DnsGovernancePolicyAddress` setup.** The DNS governance authority creates its root policy via `RegisterPolicy`, which requires `RootPolicyBody` quorum. This is a one-time setup step. After that, the DNS governance authority operates the policy independently.

2. **Fraudulent press reporting.** When the `policy-address-verifier` script determines that a press submitted a fraudulent `PolicyAddressSet` entry (e.g., the press skipped ML-DSA-44 holder signature verification), the authority reports the press to `PressRegistryBody` for revocation consideration. The authority does not have the power to call `RevokePress` directly — that is `PressRegistryBody`'s domain. The authority submits a signed fraud report to `PressRegistryBody` with the on-chain transaction evidence.

---

## Off-Chain Governance Process

On-chain quorum signatures ratify decisions made through deliberation. Operators do not sign governance transactions without prior discussion and agreement.

**Deliberation commitments:**
- Time-sensitive actions (fraud suspension, rollback): operators must be reachable within 4 hours; signing may proceed without full deliberation if the fraud evidence is clear and documented.
- Routine actions (domain registration, deactivation): completed within SLA windows (see §Responsibilities Table); no deliberation period required for actions that follow directly from a completed script run.
- Policy changes (brand name list updates, SLA changes, fraud criteria changes): minimum 14-day notice period before adoption; recorded in the governance repository.

**Audit log:** Every `DnsGovernanceBody` on-chain action must have a corresponding entry in the authority's fraud audit log (or the domain registration log for non-fraud actions). The log records: the action taken, the script run or fraud report that triggered it, the timestamp, and the operator(s) who signed.
