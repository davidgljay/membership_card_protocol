# mcard:// DNS Resolution Spec

**Version:** 0.1 (draft)  
**Date:** 2026-06-25  
**Status:** Draft — pending CP-1 approval  
**Contract spec:** [registry_contract.md](object_specs/registry_contract.md) §3.6, §3.8–3.9, §4.17–4.22  
**Implementation plan:** [dns-implementation-plan.md](../plans/dns-implementation-plan.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Address Schema](#2-address-schema)
3. [Resolution Algorithm](#3-resolution-algorithm)
4. [On-Chain Tables](#4-on-chain-tables)
   - 4.1 [DomainRegistrations](#41-domainregistrations)
   - 4.2 [PolicyAddresses](#42-policyaddresses)
   - 4.3 [DnsGovernancePolicyAddress](#43-dnsgovernancepolicyaddress)
5. [Domain Admin Cards](#5-domain-admin-cards)
   - 5.1 [Full-Domain Admin Cards](#51-full-domain-admin-cards)
   - 5.2 [Sub-Path-Scoped Admin Cards](#52-sub-path-scoped-admin-cards)
6. [Write Authorization Chain](#6-write-authorization-chain)
   - 6.1 [Domain Registration Flow](#61-domain-registration-flow)
   - 6.2 [SetPolicyAddress Flow](#62-setpolicyaddress-flow)
7. [Fraud Risk and Suspension](#7-fraud-risk-and-suspension)
   - 7.1 [Fraud Risk Levels](#71-fraud-risk-levels)
   - 7.2 [Escalation Path](#72-escalation-path)
   - 7.3 [Suspension Durations](#73-suspension-durations)
   - 7.4 [Brand-Name Scanning](#74-brand-name-scanning)
8. [Domain Handoff](#8-domain-handoff)
9. [On-Chain Governance — Feasibility Analysis](#9-on-chain-governance--feasibility-analysis)
10. [Acceptance Criteria Summary](#10-acceptance-criteria-summary)

---

## 1. Overview

`mcard://` URIs currently resolve in two ways: a raw CID points directly to card content on IPFS; a domain/path URI (`mcard://example.com/staff/reporter`) requires a DNS resolution step to find the current policy card. This document specifies the second form — how domain names are anchored to on-chain policy pointers, who has write authority over those pointers, and how the protocol responds to fraud.

The design rests on three principles:

1. **DNS ownership as naming root.** Domain names are already a widely-understood and legally enforceable form of identity. The protocol anchors the `mcard://` namespace to DNS TXT record ownership rather than building a parallel naming authority. This makes the governance authority's job procedural rather than discretionary: it runs verification scripts, not judgment calls.

2. **Post-hoc governance, not write gating.** The DNS governance authority does not approve every `PolicyAddresses` update in real time. Presses write; the authority audits after the fact and removes unauthorized entries. This preserves protocol liveness and avoids a single point of failure.

3. **Clean domain handoff.** When a domain changes hands, the new owner can wipe all prior admin chains and policy entries without inheriting responsibility for credentials issued by the old owner.

---

## 2. Address Schema

A valid `mcard://` URI takes one of two forms:

### Form A — Direct CID Reference

```
mcard://<raw-CID>
```

- `<raw-CID>` is a base58btc or base32 multihash-encoded CIDv0 or CIDv1 (e.g., `Qm...` or `bafyrei...`).
- No DNS resolution is required. The CID is a self-describing content address; the client fetches the content directly from IPFS.
- A CID in this position references the policy card's IPFS content directly. This form does not use the on-chain `PolicyAddresses` table.
- This form is stable and human-unfriendly: changing the policy card content changes the CID.

**Identifying this form:** The segment immediately after `mcard://` does not contain a dot (`.`) and begins with a character consistent with a CID encoding (`Q`, `b`, `z`, or `f`).

### Form B — Domain/Path Reference

```
mcard://<domain>/<path>
```

- `<domain>` is a valid DNS domain name as defined by RFC 1123, lowercase-normalized, with no trailing dot. Examples: `nytimes.com`, `volunteer.example.org`.
- `<path>` is a slash-separated path string with at least one segment. Paths are case-sensitive and must not be empty. The leading slash is not included in the path value stored on-chain (i.e., `mcard://nytimes.com/staff/reporter` has domain `nytimes.com` and path `staff/reporter`). Maximum path length: 512 bytes.
- Resolution requires an on-chain read (see §3).

**Identifying this form:** The segment immediately after `mcard://` contains at least one dot (`.`) and satisfies the RFC 1123 domain name format. Any URI that passes the CID-form check is treated as Form A regardless of dots.

**Ambiguity rule:** If a segment could plausibly be either a CID or a domain name (practically impossible but theoretically reachable), Form A takes precedence. CID format is checked first.

---

## 3. Resolution Algorithm

Resolution of a Form B URI `mcard://<domain>/<path>`:

```
1. Parse the URI:
   - Extract <domain> and <path>.
   - Lowercase-normalize <domain>.
   - Strip leading slash from <path> if present.

2. Check domain registration:
   - Call GetDomainRegistration(<domain>) on the storage contract.
   - If entry.exists == false: return NOT_FOUND (no policy registered for this domain).

3. Check suspension:
   - If entry.fraud_risk == 2 AND block.timestamp < entry.suspension_expires_at:
     return DOMAIN_SUSPENDED.
   - If entry.fraud_risk == 2 AND block.timestamp >= entry.suspension_expires_at:
     treat the domain as normal for resolution purposes (suspension has lapsed).

4. Look up policy address:
   - Compute key = keccak256(<domain> || "\x00" || <path>).
   - Call LookupPolicyAddress(<domain>, <path>) → policy_card_address (bytes32).
   - If policy_card_address == bytes32(0): return NOT_FOUND (no policy at this path).

5. Fetch card entry:
   - Call GetCardEntry(policy_card_address) → CardEntry.
   - If CardEntry.exists == false: return INCONSISTENT (policy address exists on-chain
     but the card entry is missing; governance authority should investigate).
   - If the card has a forward_to set: follow the forward once and use the forwarded
     address as the policy card address (one hop only; do not recurse).

6. Return policy_card_address.
   - The caller uses this address to fetch CardEntry.log_head_cid from the storage
     contract, then fetches the policy card document from IPFS at that CID.
```

**Client caching.** The storage contract is on-chain and reads are free (view calls). Clients MAY cache resolution results locally, but MUST re-resolve on any card validation failure, as `PolicyAddresses` entries can be updated or removed at any time.

**Acceptance criteria:**

- [ ] `mcard://bafyreiabc.../` is identified as Form A and does not trigger any on-chain read from `DomainRegistrations` or `PolicyAddresses`.
- [ ] `mcard://example.com/staff/reporter` is identified as Form B with domain `example.com` and path `staff/reporter`.
- [ ] Resolution of a registered, non-suspended domain with a matching path entry returns the correct `bytes32` policy card address.
- [ ] Resolution of a registered domain with no matching path entry returns NOT_FOUND (bytes32(0) from `LookupPolicyAddress`).
- [ ] Resolution of an unregistered domain returns NOT_FOUND.
- [ ] Resolution of a suspended domain with `block.timestamp < suspension_expires_at` returns DOMAIN_SUSPENDED.
- [ ] Resolution of a suspended domain with `block.timestamp >= suspension_expires_at` proceeds normally (suspension lapsed).

---

## 4. On-Chain Tables

### 4.1 DomainRegistrations

One entry per registered domain. Keyed by the domain string (lowercase, no trailing dot).

```
DomainRegistrations: mapping (string → DomainEntry)

DomainEntry {
    admin_card_address      bytes32   — On-chain registry address (CardEntry key) of the
                                        current active domain admin card. This is the card
                                        that holds write authority over PolicyAddresses entries
                                        for this domain. Set at RegisterDomain time; updated
                                        by the DNS governance authority if the admin card rotates.
                                        Sub-path-scoped sub-cards issued by this admin card are
                                        stored in SubCardRegistrations (existing table) with their
                                        path scope constraints in their IPFS card document.

    registered_at           uint64    — Unix timestamp of the most recent RegisterDomain call
                                        for this domain. Retained for audit purposes.

    fraud_risk              uint8     — Current fraud risk level.
                                        0 = normal (default)
                                        1 = monitored (all policy public keys must be registered
                                            with the authority before SetPolicyAddress is accepted)
                                        2 = suspended (SetPolicyAddress and RemovePolicyAddress
                                            are rejected; domain cannot be used for new entries)
                                        See §7 for escalation criteria.

    suspension_expires_at   uint64    — Unix timestamp after which a fraud_risk == 2 suspension
                                        automatically lapses for resolution purposes. Zero if not
                                        suspended. The contract does not automatically reset
                                        fraud_risk to 0; the DNS governance authority calls
                                        FlagDomainFraudRisk to restore normal status after a
                                        suspension expires.

    exists                  bool      — True once RegisterDomain has been called for this domain.
                                        Used to distinguish unregistered domains from domains with
                                        no policy entries.
}
```

**Storage note.** Mapping keys are Solidity `string` (dynamic type). In Stylus / Rust, this maps to `StorageString`. The implementation MUST normalize keys to lowercase before any read or write. The contract does not validate that the key is a well-formed domain name beyond checking that it is non-empty and does not exceed 255 bytes (the maximum domain name length per RFC 1035).

---

### 4.2 PolicyAddresses

One entry per registered domain/path pair. Keyed by a hash of the domain and path.

```
PolicyAddresses: mapping (bytes32 → bytes32)

key:   keccak256(<domain_bytes> || 0x00 || <path_bytes>)
         — where <domain_bytes> is the UTF-8 encoding of the lowercase domain string,
           and <path_bytes> is the UTF-8 encoding of the path string (no leading slash).
           The 0x00 byte separator prevents collisions between a domain with an empty
           path and a domain/path pair where the path starts with the domain prefix.
           This is the canonical key format; all callers MUST use this derivation.

value: bytes32
         — On-chain registry address of the policy card (CardEntry key) active at
           this domain/path. Zero value (bytes32(0)) means no entry is registered.
           The policy card's log_head_cid is obtained by calling GetCardEntry on this address.
```

**Zero-value semantics.** A zero value is indistinguishable from a missing entry (Solidity default for unset mapping slots). Callers MUST treat a zero response from `LookupPolicyAddress` as "not registered," not as "registered but empty."

---

### 4.3 DnsGovernancePolicyAddress

A single global storage variable (not a mapping) holding the on-chain policy address under which domain admin cards are issued.

```
DnsGovernancePolicyAddress: bytes32
```

All domain admin cards — full-domain and sub-path-scoped alike — are issued under the policy identified by this address. `SetPolicyAddress` checks that the submitting press is authorized under this policy: `PressAuthorizations[DnsGovernancePolicyAddress][press_address].active == true`. `RegisterDomain` checks that the admin card being registered was issued under this policy: `CardEntries[admin_card_address].policy_address == DnsGovernancePolicyAddress`.

**Initialization.** `DnsGovernancePolicyAddress` is set to `bytes32(0)` at storage contract deployment. It is set to the DNS governance authority's policy address during bootstrap via `SetDnsGovernancePolicyAddress` (§4.24 of the registry contract spec), which requires `DnsGovernanceBody` quorum.

**Mutability.** `DnsGovernancePolicyAddress` is mutable via `DnsGovernanceBody` quorum (§4.24). This is an intentional escape hatch for policy authorizer key compromise: the governance body can register a new policy via `RegisterPolicy`, rotate `DnsGovernancePolicyAddress` to it, re-issue domain admin cards under the new policy, and update each domain's entry via `RegisterDomain`. This is a breaking migration — all existing domain admin cards are orphaned by the change — and should only be used when `RotateAuthorizerKey` on the existing policy is insufficient (e.g., the authorizer key is irretrievably lost, not merely compromised and rotated).

---

## 5. Domain Admin Cards

Domain admin cards are the credential type that grants write authority over `PolicyAddresses` entries. They are standard cards in the card protocol sense — issued via a press, stored on IPFS, registered on-chain — but with two additional properties:

1. They are issued under the `DnsGovernancePolicyAddress` policy (§4.3).
2. Their IPFS card document MAY contain a `dns_path_scope` field restricting which paths the card (and its sub-cards) may update.

### 5.1 Full-Domain Admin Cards

A full-domain admin card has no `dns_path_scope` restriction in its card document. The holder may call `SetPolicyAddress` for any path under the registered domain.

The card is issued by the DNS governance authority after TXT verification confirms domain ownership (see §6.1). It is registered on-chain at `RegisterDomain` time via `DomainRegistrations[domain].admin_card_address`.

### 5.2 Sub-Path-Scoped Admin Cards

A sub-path-scoped admin card is a sub-card of the full-domain admin card (registered in `SubCardRegistrations`). Its IPFS card document contains:

```json
{
  "dns_path_scope": "<regex pattern>"
}
```

The `dns_path_scope` regex constrains which paths the sub-card may pass to `SetPolicyAddress`. The regex is evaluated by the press before submitting any `SetPolicyAddress` transaction. It is not evaluated on-chain.

**Regex constraints:**
- Pattern is a standard ECMAScript regex (or Rust regex crate compatible pattern, depending on press implementation).
- It is anchored at the start of the path string (the `^` anchor is implied even if not present).
- Example: `^volunteers/` allows `volunteers/organizer`, `volunteers/lead`, but not `staff/reporter`.
- The press MUST reject any `SetPolicyAddress` submission where the card's `dns_path_scope` regex does not match the requested path (press-side error E-44).

**Scope inheritance.** A sub-card of a sub-path-scoped card inherits the parent's scope constraint and may narrow it further (its own `dns_path_scope` must be a subset of the parent's). A sub-card whose `dns_path_scope` would allow paths outside the parent's scope is a press policy violation; the press MUST reject such issuance (press-side error E-22, as this is a master card holder authorization failure).

**Verification responsibility.** The press verifies scope:
1. Fetches the card document from IPFS.
2. Extracts the `dns_path_scope` field (if present; absence means the card is a full-domain admin card, which is only valid if the card is the direct admin card, not a sub-card).
3. Tests the regex against the requested path.
4. For sub-cards of sub-cards: walks the sub-card chain to verify that each parent's scope is consistent with the child's scope.

The contract does not verify scope. Scope verification is exclusively press-side, and fraudulent scope violations are detectable by the DNS governance authority via the `PolicyAddressSet` event (see §6.2 step 5).

---

## 6. Write Authorization Chain

### 6.1 Domain Registration Flow

This is the process by which a new domain admin card is created and a domain is registered on-chain. It is initiated by a domain owner seeking to use `mcard://` URIs for their domain.

**Actors:**
- **Domain applicant** — The organization or individual who controls the domain.
- **DNS governance authority operator** — Runs the `txt-verification` governance script.
- **Press** — A press authorized under the `DnsGovernancePolicyAddress` policy.
- **Arbitrum One registry** — Storage and logic contracts.

**Preconditions:**
- The applicant controls the domain (has access to set DNS TXT records).
- The applicant has a wallet address (card address derived from their ML-DSA-44 public key).
- The applicant has generated a secp256r1 keypair for DNS admin on-chain operations (distinct from their ML-DSA-44 IPFS identity key).
- A TXT record in the format `mcard-verify=<card_address_hex>.<pubkey_fingerprint>` is set at `_mcard.<domain>`, where `pubkey_fingerprint` is the hex-encoded first 8 bytes of `keccak256(applicant_ml_dsa_pubkey)`.

**Steps:**

1. Applicant submits a verification request to the DNS governance authority, providing: `domain`, `applicant_card_address` (bytes32), `applicant_ml_dsa_pubkey` (ML-DSA-44 key, for TXT record matching and card issuance), and `applicant_secp256r1_pubkey` (64-byte secp256r1 key, for on-chain sub-card authorization).

2. The `txt-verification` script resolves `_mcard.<domain>` TXT records via standard DNS (UDP/53 or DNS-over-HTTPS fallback). If the expected record is not found, the script retries with exponential backoff up to 3 times (accounting for DNS propagation delay). If not found after retries, the request is rejected and the applicant is notified.

3. On successful TXT verification, the governance authority issues a domain admin card to the applicant via a press authorized under the DNS governance policy. This is a standard `RegisterCard` call; the card document on IPFS contains the applicant's ML-DSA-44 public key and no `dns_path_scope` field (full-domain admin).

4. The DNS governance authority calls `RegisterDomain(domain, applicant_card_address, applicant_secp256r1_pubkey, governance_payload, governance_sigs)` with `DnsGovernanceBody` quorum signatures. This stores `applicant_secp256r1_pubkey` in `DnsAdminCardKeys[applicant_card_address]` on-chain.

5. The applicant receives their domain admin card address. They hold two keys for DNS admin operations: their ML-DSA-44 key (signing `SetPolicyAddressIntent`s and other holder-initiated operations) and their secp256r1 key (signing `AdminAuthorizeSubCardPayload`s when delegating to sub-cards).

**TXT record format:**
```
_mcard.<domain>  TXT  "mcard-verify=<card_address_hex>.<pubkey_fingerprint>"
```
- `<card_address_hex>` — lowercase hex-encoded bytes32 (64 characters, no `0x` prefix).
- `<pubkey_fingerprint>` — lowercase hex-encoded first 8 bytes of `keccak256(applicant_pubkey)` (16 characters).
- The two parts are separated by a single `.`.
- Multiple TXT records at `_mcard.<domain>` are allowed; at least one must match.

**Acceptance criteria:**

- [ ] A TXT record matching the expected format at `_mcard.<domain>` is confirmed before `RegisterDomain` is called.
- [ ] Multiple TXT records at `_mcard.<domain>` are handled: verification succeeds if at least one record matches.
- [ ] DNS propagation delay is accommodated: the authority retries up to 3 times with exponential backoff (minimum 30 seconds between retries) before rejecting the request.
- [ ] A verification request with no matching TXT record (after retries) is rejected; `RegisterDomain` is not called.
- [ ] A domain that is already registered (`DomainRegistrations[domain].exists == true`) returns E-38 from `RegisterDomain`; the verification script does not issue a new admin card unless the prior admin card is deactivated first.

---

### 6.2 SetPolicyAddress Flow

This is the process by which a domain admin card holder (or a delegated sub-card holder) registers or updates the policy card address for a specific domain/path.

**Actors:**
- **Submitting card holder** — Either the domain admin card holder or a sub-path-scoped sub-card holder delegated by the admin.
- **Press** — A press authorized under the `DnsGovernancePolicyAddress` policy.
- **DNS governance authority** — Monitors `PolicyAddressSet` events and verifies entries asynchronously.
- **Arbitrum One registry** — Storage and logic contracts.

**Preconditions:**
- `DomainRegistrations[domain].admin_card_address` is set (domain is registered).
- If a sub-card is submitting: the sub-card is registered in `SubCardRegistrations` as a direct sub-card of the domain admin card (`master_card_address == admin_card_address`, `active == true`). Sub-sub-cards (depth > 1) are not accepted on-chain.
- The press is authorized under `DnsGovernancePolicyAddress`.
- The policy card to be pointed to exists in `CardEntries`.
- If the sub-card is sub-path-scoped, the requested path matches its `dns_path_scope` regex.

**Steps:**

1. The submitting card holder constructs a `SetPolicyAddressIntent`:
   ```json
   {
     "op":                   "set_policy_address",
     "domain":               "<domain string>",
     "path":                 "<path string, no leading slash>",
     "policy_card_address":  "<base64url — bytes32>",
     "admin_card_address":   "<base64url — bytes32 of the domain admin card>",
     "sub_card_address":     "<base64url — bytes32 of sub-card, or zero if admin submitting directly>",
     "timestamp":            "<ISO 8601>"
   }
   ```

2. The submitting card holder signs the intent with their ML-DSA-44 private key (the admin card's key if submitting directly; the sub-card's key if delegating).

3. The holder submits the signed intent to a press authorized under the DNS governance policy.

4. The press performs pre-flight checks:
   a. Looks up `DomainRegistrations[domain].admin_card_address` and confirms it matches the `admin_card_address` in the intent (E-46 mismatch signals a stale or fraudulent intent).
   b. Verifies the holder's ML-DSA-44 signature against the submitting card's public key (fetched from IPFS card document). For direct admin submission: admin card's key. For sub-card submission: sub-card's key.
   c. If `sub_card_address` is non-zero: confirms the sub-card is in `SubCardRegistrations` with `master_card_address == admin_card_address` and `active == true` (E-45 if not). Fetches the sub-card's IPFS document and verifies `dns_path_scope` regex matches `path` (E-44 if mismatch).
   d. Confirms domain exists, is not suspended (E-39), and target policy card exists in `CardEntries` (E-41).
   e. If `DomainRegistrations[domain].fraud_risk == 1` (monitored): verifies the domain admin's public key is registered with the authority before proceeding.

5. The press calls `SetPolicyAddress(domain, path, policy_card_address, admin_card_address, sub_card_address, press_sig_payload, press_signature)` on the logic contract.

6. The contract performs on-chain binding checks: `admin_card_address == DomainRegistrations[domain].admin_card_address` (E-46); if `sub_card_address` non-zero, `SubCardRegistrations[sub_card_address].master_card_address == admin_card_address` and `active == true` (E-45).

7. The logic contract emits `PolicyAddressSet(domain, path, policy_card_address, admin_card_address, sub_card_address, press_address, timestamp)`.

8. The DNS governance authority's `policy-address-verifier` script observes the event within its 24-hour SLA, verifies the entry (scope check, policy card existence, brand-name scan if monitored), and either retains the entry or calls `GovernanceSetPolicyAddress` (§4.23) to overwrite with the correct value (or zero to clear) if the entry is unauthorized.

**Security note — compromised press.** A press whose private key is stolen cannot register fraudulent sub-cards of a domain admin card. `RegisterSubCard` requires the admin card holder's secp256r1 signature (`AdminAuthorizeSubCardPayload`), verified on-chain via RIP-7212 against `DnsAdminCardKeys[admin_card_address]` (§3.11 of the registry contract spec). Without the admin's secp256r1 private key a compromised press cannot produce this signature. The press remains able to submit fraudulent `SetPolicyAddress` calls for domains it legitimately administers (since the admin's secp256r1 key only gates sub-card registration, not direct policy address writes), but it cannot expand its reach to other domains by forging sub-card relationships. Detection is immediate via `PolicyAddressSet` events; `GovernanceSetPolicyAddress` provides rollback; `RevokePress` stops further damage.

**Acceptance criteria:**

- [ ] A valid call by an authorized press with a matching `admin_card_address` sets `PolicyAddresses[keccak256(domain||"\x00"||path)]` and emits `PolicyAddressSet` with `admin_card_address`, `sub_card_address`, and `press_address`.
- [ ] A call where `admin_card_address != DomainRegistrations[domain].admin_card_address` reverts with E-46.
- [ ] A call with a non-zero `sub_card_address` that is not a direct sub-card of `admin_card_address` (or is inactive) reverts with E-45.
- [ ] A call with a `sub_card_address` that is a sub-card of a sub-card (depth 2) reverts with E-45.
- [ ] A call with `sub_card_address == bytes32(0)` and a valid admin card succeeds (admin submitting directly).
- [ ] A `SetPolicyAddress` call with a press not authorized under `DnsGovernancePolicyAddress` reverts with E-04.
- [ ] A `SetPolicyAddress` call for a suspended domain reverts with E-39.
- [ ] A call where `policy_card_address` does not exist in `CardEntries` reverts with E-41.
- [ ] A press rejects (E-44, press-side) a submission where the sub-card's `dns_path_scope` does not match the path.
- [ ] `LookupPolicyAddress(domain, path)` returns the correct value after a successful call.

---

### 6.3 Governance Rollback

When the DNS governance authority detects a fraudulent or erroneous `PolicyAddressSet` entry, it corrects the state via `GovernanceSetPolicyAddress` (registry contract §4.23) rather than waiting for the domain admin to re-submit. This operation requires `DnsGovernanceBody` quorum and bypasses press and card-holder authorization entirely.

**To restore a prior legitimate value:** call `GovernanceSetPolicyAddress(domain, path, prior_policy_card_address, governance_payload, governance_sigs)`. The authority retrieves the prior value from the on-chain event history (`PolicyAddressSet` and `PolicyAddressGovernanceSet` events).

**To clear a fraudulent entry with no known prior value:** call `GovernanceSetPolicyAddress(domain, path, bytes32(0), ...)`. This sets the entry to zero; `LookupPolicyAddress` will return zero until a legitimate domain admin re-submits via press.

**Rollback on a suspended domain:** `GovernanceSetPolicyAddress` works on suspended domains (no E-39 check). The authority may need to clear or restore entries for domains that are simultaneously suspended and the subject of a fraud response.

**Tradeoff.** The governance-quorum write path expands the blast radius of a `DnsGovernanceBody` compromise: a compromised governance body could overwrite any domain's policy addresses, not just remove them. This is accepted because (a) the governance body already held significant destructive power (`DeregisterDomain`, `ClearDomainEntries`, `FlagDomainFraudRisk`) before this capability was added, (b) `DnsGovernanceBody` is M-of-N quorum (multiple keys must coordinate), and (c) all `PolicyAddressGovernanceSet` events are immediately public, making fraudulent writes immediately detectable.

---

## 7. Fraud Risk and Suspension

### 7.1 Fraud Risk Levels

| Level | Name | Meaning | Effect |
|---|---|---|---|
| 0 | Normal | No fraud flags. | Default behavior; no restrictions. |
| 1 | Monitored | The domain has received a fraud report or triggered an automated flag (see §7.2). | The DNS governance authority requires the domain admin's public key to be registered before accepting any `SetPolicyAddress` submissions. The `policy-address-verifier` script applies brand-name scanning to all new policy entries under this domain. |
| 2 | Suspended | The domain has committed a confirmed fraud violation. | `SetPolicyAddress` and `RemovePolicyAddress` are rejected on-chain (E-39). Existing `PolicyAddresses` entries remain queryable but the DNS governance authority calls `ClearDomainEntries` to remove them as part of the suspension action. |

**Public key registration under fraud_risk == 1.** "Public key registration required" means the domain admin submits their secp256r1 or ML-DSA-44 signing public key to the DNS governance authority via a side channel (HTTPS form, email-authenticated request) before any `SetPolicyAddress` submission is accepted. The press checks with the authority that the public key is registered before submitting. This allows the authority to scan policy card content associated with that key.

### 7.2 Escalation Path

**Automated flagging criteria (immediately sets fraud_risk = 1):**
- Domain string has an edit distance of 1 from any domain in the authority's top-1000 brand name list (Levenshtein distance, case-insensitive, after stripping common TLD suffixes).
- Domain string is an exact match (case-insensitive) for a trademarked brand name in the authority's registered brand list.

**Report-triggered flagging (sets fraud_risk = 1 pending review):**
- A verifier or card holder submits a fraud report to the DNS governance authority citing a specific domain and a specific policy card address.
- The authority reviews the report within 72 hours. If the report is substantiated: the authority calls `FlagDomainFraudRisk(domain, 1, 0)` (monitored, no suspension timer). If unsubstantiated: no action.

**Violation confirmed (sets fraud_risk = 2):**
- The authority's `policy-address-verifier` script finds that a policy card's content contains brand-name impersonation (policy card title or credential fields reference a brand name that the domain admin has not demonstrated a right to).
- The authority calls `FlagDomainFraudRisk(domain, 2, suspension_expires_at)` with the suspension expiry computed per §7.3.
- The authority simultaneously calls `ClearDomainEntries(domain)` to remove all existing policy entries for the domain.

**Restoration after suspension:**
- After the suspension expires, the domain admin may contact the governance authority to request restoration.
- The authority reviews the request and, if satisfied, calls `FlagDomainFraudRisk(domain, 0, 0)` to restore normal status.

### 7.3 Suspension Durations

| Violation count | Suspension duration |
|---|---|
| First confirmed violation | 1 year from `FlagDomainFraudRisk` timestamp |
| Second confirmed violation | 2 years from `FlagDomainFraudRisk` timestamp |
| Third confirmed violation | 3 years from `FlagDomainFraudRisk` timestamp |
| N-th confirmed violation | N years from `FlagDomainFraudRisk` timestamp |

The `DomainEntry` does not store a violation count directly. The DNS governance authority tracks the violation count off-chain (in its audit log) and computes the suspension duration before calling `FlagDomainFraudRisk`. The authority sets `suspension_expires_at` to `block.timestamp + (N * 365 * 24 * 3600)` seconds, where N is the violation count. The on-chain state stores only the resulting expiry timestamp; the violation history is in the governance authority's off-chain audit log and the on-chain `DomainFraudRiskUpdated` event log.

**Acceptance criteria:**

- [ ] A domain with `fraud_risk == 2` and active suspension has `SetPolicyAddress` calls rejected on-chain (E-39).
- [ ] A domain with `fraud_risk == 1` has `SetPolicyAddress` calls accepted on-chain but the press verifies public key registration before submitting.
- [ ] `FlagDomainFraudRisk(domain, 2, timestamp)` emits `DomainFraudRiskUpdated` with the correct parameters.
- [ ] `FlagDomainFraudRisk(domain, 0, 0)` restores normal status.

### 7.4 Brand-Name Scanning

Brand-name scanning is applied by the `policy-address-verifier` script to all policy cards registered under a monitored domain (fraud_risk == 1). Scanning is also applied to all new `PolicyAddresses` entries (regardless of fraud_risk level) where the policy card title or any credential field value exactly matches (case-insensitive) a brand name in the authority's registered brand list.

**Scanning scope:**
- Policy card title field.
- All text-type credential field values in the policy card document.

**Match condition:**
- An exact case-insensitive substring match of any registered brand name within the scanned text. Partial matches (the brand name is a substring of a longer word) do not trigger removal unless the full context clearly constitutes impersonation.

**Outcome of a scan failure:**
- The authority calls `RemovePolicyAddress(domain, path, governance_payload, governance_sigs)` with `DnsGovernanceBody` quorum.
- If the domain has multiple scan failures: the authority escalates to `FlagDomainFraudRisk` (confirmed violation) and `ClearDomainEntries`.

**Brand name list management:**
- The registered brand name list is maintained by the DNS governance authority as a versioned off-chain document.
- The list is published at a stable URL; governance authority operators use the same version during any single scanning pass.
- Changes to the list require approval by the DNS governance authority quorum (off-chain governance process, same process as other authority decisions).

---

## 8. Domain Handoff

When a domain transfers to a new owner, the new owner must establish a fresh admin chain. The following process preserves the protocol's trust model: the new owner does not inherit the prior owner's credentials, and prior-owner cards are provably deactivated.

**Steps:**

1. The new domain owner completes TXT verification (§6.1) with their own public key.

2. The DNS governance authority issues a new domain admin card to the new owner and verifies the TXT record.

3. The new domain owner (or the governance authority on their behalf) requests deactivation of all prior admin cards via the `admin-deactivation` governance script:
   - The new owner provides the list of old admin card addresses to deactivate.
   - The script verifies that the requester holds the current on-chain admin card (`DomainRegistrations[domain].admin_card_address` matches the new admin).
   - The script calls `ClearDomainEntries(domain)` with `DnsGovernanceBody` quorum to remove all `PolicyAddresses` entries for the domain.
   - The governance authority deactivates the listed old admin cards (and their sub-cards) via `UpdateCardHead` with a 9xx revocation entry.

4. The governance authority calls `RegisterDomain` again with the new admin card address (the old entry is cleared first, or `RegisterDomain` is called with the new admin card address as an update — see §4.17 for idempotency rules).

5. The new owner re-registers their policy entries via `SetPolicyAddress`.

**Audit trail.** The `DomainEntriesCleared` and `DomainRegistered` events on-chain provide a complete audit trail of the handoff. Prior cards issued under the old policy entries remain verifiable from IPFS (policy cards are content-addressed and do not disappear), but their domain/path association is severed from the on-chain table.

---

## 9. On-Chain Governance — Feasibility Analysis

### Architecture

Moving DNS TXT verification on-chain would require:

1. **Oracle integration.** EVM contracts cannot make outbound HTTP or DNS requests. An external oracle is required. Chainlink Functions is the most production-mature option on Arbitrum One as of 2025 (see [Chainlink Functions documentation](https://docs.chain.link/chainlink-functions)).

2. **Two-phase `RegisterDomain`.** The current single-call `RegisterDomain` (governance quorum → on-chain entry) would become:
   - **Phase 1:** `InitiateVerification(domain, applicant_card_address, callback_address)` — calls Chainlink Functions to resolve `_mcard.<domain>` TXT records.
   - **Phase 2:** `VerificationCallback(request_id, response, err)` — Chainlink's oracle network calls back with the TXT record response; the contract checks the record and, if valid, creates the `DomainEntry` and emits `DomainRegistered`.
   
3. **Pending verification state.** The storage contract would need a `PendingDomainVerifications: mapping(bytes32 → PendingVerificationEntry)` table to track in-flight verification requests between Phase 1 and Phase 2 callbacks.

4. **Governance authority key for card issuance.** Domain admin card issuance (the `RegisterCard` call creating the admin card) still requires the governance authority's press to sign and submit. Verifying the TXT record on-chain confirms domain ownership but does not replace the need to issue the card credential off-chain. The oracle architecture eliminates the off-chain DNS query but does not fully decentralize card issuance.

### Cost Estimates

Based on [Chainlink Functions pricing (Arbitrum One, 2025)](https://docs.chain.link/chainlink-functions/resources/billing):

| Cost component | Estimate | Notes |
|---|---|---|
| Chainlink Functions subscription fee | ~0.1 LINK per month | Fixed overhead; amortized across all requests |
| Per-request fee (LINK) | ~0.2 LINK | Per domain registration request; approximate at current pricing |
| LINK price (USD, 2025) | ~$15–25 USD | Volatile; estimate uses midpoint $20 |
| **Per-request cost (USD)** | **~$4.00** | 0.2 LINK × $20/LINK |
| Arbitrum One gas (oracle callback) | ~300,000 gas | Callback function storage writes + event emissions |
| Arbitrum One gas price | ~0.01 gwei | Typical Arbitrum One gas price (2025) |
| Gas cost (USD) | ~$0.02 | Negligible relative to oracle fee |
| **Total per domain registration** | **~$4.02** | Dominated by Chainlink oracle fee |

At a rate of 100 domain registrations per month, the oracle cost would be approximately $400/month. This is an acceptable operational cost for a protocol-level service, but it is borne by the DNS governance authority (or passed to applicants as a registration fee).

### Latency Implications

- **Chainlink Functions oracle round-trip:** 1–3 minutes after the `InitiateVerification` transaction is included in a block.
- **DNS propagation delay:** Up to 48 hours for TXT record changes to propagate globally. An oracle query returns the current view from Chainlink's node network, which may not reflect a recently-set TXT record.
- **Implication:** On-chain verification cannot be made synchronous with the DNS TXT record update. The applicant must either set the TXT record well in advance of the `InitiateVerification` call, or the contract must support retrying the oracle query. This adds complexity not present in the off-chain verification model.

### Recommendation: Defer

The current implementation defers on-chain TXT verification in favor of the off-chain DNS governance authority model. This decision is recommended pending the following preconditions:

1. **Chainlink Functions on Arbitrum One reaching production-grade SLA guarantees.** As of 2025, Chainlink Functions is generally available on Arbitrum One but carries no formal SLA commitment. A domain registration service requires high availability.

2. **DNS propagation delay handling resolved.** The oracle architecture must account for propagation delay without requiring manual retry logic in the contract. A clean solution (e.g., Chainlink Functions job with built-in retry, or an applicant-initiated retry call) must be specified before implementation.

3. **Gas cost acceptability at projected protocol scale.** If domain registrations grow significantly, the per-request Chainlink fee may become a material cost driver. A fee-sharing model (applicants pay, or the protocol treasury is funded for this) must be specified.

4. **Storage contract redeployment decision.** Adding oracle integration requires new storage slots (`PendingDomainVerifications`). This can be done via a logic upgrade if the storage contract already has the necessary setter interface, or requires a storage contract redeployment if new mappings are needed. This decision must be made in the context of the broader migration plan (Phase 4).

The off-chain verification model is auditable (TXT record checks are reproducible by anyone with DNS access), transparent (all registrations are on-chain events), and does not introduce oracle dependency risk. The DNS governance authority's off-chain scripts provide the same trust properties as on-chain verification for the purposes of this protocol.

---

## 10. Acceptance Criteria Summary

The following table summarizes all acceptance criteria in this spec, grouped by behavior:

| Behavior | Acceptance criteria location |
|---|---|
| URI form parsing (A vs. B) | §3 Resolution Algorithm |
| Resolution algorithm | §3 |
| DomainRegistrations structure | §4.1 |
| PolicyAddresses key derivation | §4.2 |
| Domain registration flow | §6.1 |
| SetPolicyAddress flow | §6.2 |
| Sub-path scope enforcement | §5.2 (press-side), §6.2 |
| Fraud risk escalation | §7.3 |
| Suspension enforcement | §7.1, §7.3 |
| Brand-name scanning | §7.4 |
| Domain handoff | §8 |

Contract-level acceptance criteria (on-chain preconditions, state changes, error codes) are specified in `specs/object_specs/registry_contract.md §4.17–4.22`.
