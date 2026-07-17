# DNS Governance Scripts — Process Spec

**Version:** 0.2 (draft)  
**Date:** 2026-06-25 (amended 2026-07-16)  
**Status:** Draft  
**Charter:** [governance/DnsGovernanceBody/mandate.md](../../governance/DnsGovernanceBody/mandate.md)  
**DNS resolution spec:** [dns_resolution.md](../dns_resolution.md)  
**Contract spec:** [registry_contract.md](../object_specs/registry_contract.md) §4.17–4.24

**Changelog (spec-consistency Phase 2, Step C):** Script A split into a card-issuance stage (A1) and a domain-registration stage (A2) so a domain handoff can sequence A1 → Script B (`DeregisterDomain`) → A2, resolving the circular precondition between this document and `registry_contract.md §4.17` precondition 4 (Fix #35). Script A gains a cross-reference for the `DnsAdminCardKeys` write/read path and a new subsection on the sub-path-scoped sub-card delegation flow (Fix #33). Script B notes that deactivating a domain admin card also zeroes its `DnsAdminCardKeys` entry (Fix #33). Shared environment variables now note this spec's 1-of-1 `DNS_GOV_PRIVATE_KEY` bootstrap scope against `registry_contract.md §3.6`'s multi-key quorum design (Fix #36). Script C standardizes on `RemovePolicyAddress`'s governance path for all clearing actions (Fix #37) and renames `suspension_expiry` to `suspension_expires_at` (Fix #38). See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

---

## Overview

This document specifies three Nitro server scripts that implement the operational responsibilities of the DNS Governance Authority. All three scripts are deployed as [Nitro](https://nitro.unjs.io/) handlers, making them deployable to Node.js, Cloudflare Workers, Deno, Bun, or any Nitro-compatible edge environment.

| Script | File | Trigger | Purpose |
|---|---|---|---|
| A1 — TXT Verification & Card Issuance | `governance/scripts/txt-verification.ts` | HTTPS POST from applicant | Verify DNS TXT record, issue domain admin card (`RegisterCard`). No dependency on domain registration state. |
| A2 — Domain Registration | `governance/scripts/register-domain.ts` | HTTPS POST from applicant, after A1 (and, for a handoff, after Script B) | Call `RegisterDomain` for a card issued by A1 |
| B — Admin Deactivation | `governance/scripts/admin-deactivation.ts` | HTTPS POST from current domain admin | Deactivate old admin chain during domain handoff |
| C — Policy Address Verifier | `governance/scripts/policy-address-verifier.ts` | Polling `PolicyAddressSet` on-chain events | Verify each new policy address entry within 24-hour SLA |

**Domain handoff sequencing (Fix #35).** For a brand-new domain, A1 and A2 run back-to-back with no intervening step. For a handoff (the domain already has an active admin card), the order is: **A1** (issue the new admin's card — does not touch `DomainRegistrations`) → **Script B** (`admin-deactivation`, which deregisters the old admin via `DeregisterDomain`) → **A2** (`RegisterDomain` for the new card). This ordering is required because `registry_contract.md §4.17` precondition 4 rejects `RegisterDomain` while the domain still has a non-zero `admin_card_address`, so A2 cannot run until Script B's `DeregisterDomain` has cleared it.

**Shared environment variables** (all three scripts):

```
REGISTRY_ADDRESS=<hex>           # Storage contract address on Arbitrum One
RPC_URL=<https://...>            # Arbitrum One RPC endpoint
DNS_GOV_PRIVATE_KEY=<hex>        # secp256r1 private key for DnsGovernanceBody quorum signing
DNS_GOV_POLICY_ADDRESS=<hex>     # DnsGovernancePolicyAddress — policy under which admin cards are issued
PRESS_ADDRESS=<hex>              # On-chain address of the press authorized under DNS_GOV_POLICY_ADDRESS
PRESS_PRIVATE_KEY=<hex>          # secp256r1 private key for press operations
IPFS_GATEWAY_URL=<https://...>   # IPFS gateway for fetching card documents
```

**Scope note (bootstrap quorum, Fix #36).** This spec is written for the 1-of-1 bootstrap phase of `DnsGovernanceBody`: a single `DNS_GOV_PRIVATE_KEY` signs each governance payload alone, and every on-chain call below submits `governance_sigs` as a one-element array. `registry_contract.md §3.6` designs `DnsGovernanceBody`'s keyset to grow past 1-of-1 via `RotateGovernanceKeys` as additional governance members are added, after which every write operation's `governance_sigs[]` must be sized to the then-current quorum. Once the keyset expands, these scripts (or an operator-side co-signing workflow in front of them) must collect and assemble `governance_sigs` from multiple operators holding independent `DNS_GOV_PRIVATE_KEY` shares before submission — that multi-key assembly mechanism is out of scope for this document and is tracked as a follow-up once `DnsGovernanceBody` moves past its bootstrap keyset.

---

## Script A — TXT Verification & Domain Registration (`txt-verification` / `register-domain`)

**Fix #35 note.** This script is split into two independently callable stages, A1 and A2, so that a domain handoff can sequence card issuance before the old admin is deregistered without violating `registry_contract.md §4.17` precondition 4 (which rejects `RegisterDomain` while the domain still has an active admin card). A1 has no dependency on domain registration state; A2 depends only on A1 having issued the card, and — for a handoff — on Script B having already run `DeregisterDomain`. See "Domain handoff sequencing" above.

### Purpose

Verify that an applicant controls a domain by checking a `mcard-verify=...` DNS TXT record at `_mcard.<domain>` (A1), issue a domain admin card (A1), then register the domain on-chain (A2).

### Actors

| Actor | Role |
|---|---|
| **Domain applicant** | Submits a verification request with their domain, card address, ML-DSA-44 public key, and secp256r1 public key |
| **DNS Governance Authority operator** | Runs this script; signs the `RegisterDomain` governance payload in A2 |
| **Authorized press** | Issues the domain admin card via `RegisterCard` under the DNS governance policy (A1) |
| **Arbitrum One registry** | Receives and records `RegisterCard` (A1) and `RegisterDomain` (A2) |

---

### Stage A1 — TXT Verification & Card Issuance

#### Preconditions

- The applicant has a card address (derived as `keccak256(ml_dsa_pubkey)`) and has set the corresponding `_mcard.<domain>` TXT record.
- The domain is publicly resolvable via standard DNS.
- The TXT record has the format: `mcard-verify=<card_address_hex>.<pubkey_fingerprint>` where `pubkey_fingerprint` is the hex-encoded first 8 bytes of `keccak256(ml_dsa_pubkey)`.
- `DnsGovernancePolicyAddress` has been initialized on-chain.
- The press is authorized under `DnsGovernancePolicyAddress`.
- **No dependency on domain registration state.** A1 does not check whether the domain already has an active admin card — that check belongs to A2 (new domain) or is handled by requiring Script B to run first (handoff). This is what makes A1 safely callable before an old admin has been deregistered.

#### Request Format

`POST /dns/verify`

```json
{
  "domain": "<lowercase domain string>",
  "card_address": "<hex bytes32>",
  "ml_dsa_pubkey": "<base64url — 1312 bytes>",
  "secp256r1_pubkey": "<base64url — 64 bytes>"
}
```

#### Steps

1. **Validate request.** Confirm `domain` is a valid RFC 1123 hostname (1–255 bytes, no trailing dot). Confirm `card_address` is a 32-byte hex string. Confirm `ml_dsa_pubkey` is 1312 bytes base64url-decoded. Confirm `secp256r1_pubkey` is 64 bytes base64url-decoded. Return HTTP 400 on any failure.

2. **Verify card address derivation.** Compute `keccak256(ml_dsa_pubkey_bytes)` and confirm it equals `card_address`. This prevents an applicant from submitting a card address they do not control. Return HTTP 400 if mismatched.

3. **Resolve TXT record.** Query `_mcard.<domain>` via DNS (UDP/53 with DNS-over-HTTPS fallback). Parse all TXT records at that subdomain. For each record, check if it matches the pattern `mcard-verify=<expected_card_address_hex>.<expected_fingerprint>` where `expected_fingerprint = hex(keccak256(ml_dsa_pubkey_bytes)[0:8])`. If no record matches:
   - Retry up to 3 times with exponential backoff (30s, 60s, 120s) to accommodate DNS propagation delay.
   - After all retries: return HTTP 422 with `{ "error": "txt_record_not_found", "domain": "..." }`.

4. **Issue domain admin card.** Construct a `RegisterCardPayload` signed by the press private key. Call `RegisterCard` on the logic contract with:
   - `card_address` = the applicant's card address
   - `initial_log_cid` = CID of the genesis card document (written to IPFS first)
   - `policy_address` = `DnsGovernancePolicyAddress`
   
   The genesis card document on IPFS includes the applicant's `ml_dsa_pubkey` and lists the DNS governance authority in its `auditors` field. It does NOT include a `dns_path_scope` field (this is a full-domain admin card).

   **Cross-reference (Fix #33).** The `secp256r1_pubkey` collected in the A1 request is not written to `DnsAdminCardKeys` at this step — `RegisterCard` has no such parameter. It is carried forward to A2, where `RegisterDomain` (`registry_contract.md §4.17`) writes it to `DnsAdminCardKeys[admin_card_address]`. From that point on, any `RegisterSubCard` call naming this card as `master_card_address` requires an `AdminAuthorizeSubCardPayload` (`registry_contract.md §4.3`) signed with the corresponding secp256r1 private key and verified on-chain via RIP-7212 — see "Sub-Card Delegation by a Domain Admin" below.

5. **Return result.** On success, return HTTP 200:
   ```json
   {
     "domain": "<domain>",
     "card_address": "<hex bytes32>",
     "tx_hash": "<hex>",
     "issued_at": "<ISO 8601>"
   }
   ```
   The caller (applicant or governance operator, per deployment) then invokes A2 to complete registration — immediately for a new domain, or after Script B completes for a handoff.

#### Acceptance Criteria

- [ ] A valid request with a correctly-formatted TXT record results in a `RegisterCard` transaction on-chain and HTTP 200 with the card address.
- [ ] The card address derivation check (`keccak256(ml_dsa_pubkey)`) is verified before any DNS query is made.
- [ ] Multiple TXT records at `_mcard.<domain>` are handled: verification passes if at least one matches.
- [ ] A missing or mismatched TXT record is retried up to 3 times with backoff before returning HTTP 422.
- [ ] The genesis card document is written to IPFS and its CID verified resolvable before `RegisterCard` is submitted.
- [ ] An invalid `ml_dsa_pubkey` length returns HTTP 400.
- [ ] All retries are logged with the TXT record query result at each attempt.
- [ ] A1 succeeds regardless of whether the domain currently has an active admin card (no domain-state precondition).

---

### Stage A2 — Domain Registration

#### Preconditions

- Stage A1 has completed for `card_address` (the card exists in `CardEntries` under `DnsGovernancePolicyAddress`).
- For a **new** domain: `GetDomainRegistration(domain)` returns `exists == false` or an entry with `admin_card_address == bytes32(0)`.
- For a **handoff**: Script B's `DeregisterDomain` has already cleared the prior admin (`admin_card_address == bytes32(0)`) — see "Domain handoff sequencing" above. `registry_contract.md §4.17` precondition 4 enforces this on-chain (E-38 otherwise).

#### Request Format

`POST /dns/register-domain`

```json
{
  "domain": "<lowercase domain string>",
  "card_address": "<hex bytes32 — issued by A1>",
  "secp256r1_pubkey": "<base64url — 64 bytes, from the original A1 request>"
}
```

#### Steps

1. **Validate request.** Confirm all fields are present and well-formed. Return HTTP 400 on any failure.

2. **Check domain admin state.** Call `GetDomainRegistration(domain)` on the storage contract. If `exists == true` and `admin_card_address != bytes32(0)`, return HTTP 409 (domain already has an active admin; the caller must complete Script B's admin-deactivation process first).

3. **Call RegisterDomain.** Construct a `RegisterDomainPayload` and sign it with the governance private key. Submit `RegisterDomain(domain, card_address, secp256r1_pubkey_bytes, governance_payload, [governance_sig])` to the logic contract.

4. **Return result.** On success, return HTTP 200:
   ```json
   {
     "domain": "<domain>",
     "card_address": "<hex bytes32>",
     "tx_hash": "<hex>",
     "registered_at": "<ISO 8601>"
   }
   ```

#### Acceptance Criteria

- [ ] A2 called for a card issued by A1, with no active admin on the domain, results in a `DomainRegistered` event on-chain and HTTP 200.
- [ ] An already-registered domain (with active admin) returns HTTP 409 without calling `RegisterDomain`.
- [ ] A2 called for a `card_address` that does not exist in `CardEntries` reverts on-chain with E-02 (see `registry_contract.md §4.17`).
- [ ] Immediately after A2 succeeds, `GetDnsAdminCardKey(card_address)` returns the registered `secp256r1_pubkey`.

---

## Sub-Card Delegation by a Domain Admin (Fix #33)

A domain admin card holder can delegate authority over a specific URL path (e.g. `/blog/*`) to a sub-path-scoped sub-card, rather than handling every `SetPolicyAddress` submission personally. This section documents the operational flow; the on-chain mechanics are specified in `registry_contract.md §3.11` (`DnsAdminCardKeys`) and `§4.3` (`RegisterSubCard`), and the press-side implementation is specified in `press.md §5.4`.

**Precondition.** The domain admin card's `master_card_address` must have a non-zero entry in `DnsAdminCardKeys` — i.e., A2 (`RegisterDomain`) has already run for this card, writing its `secp256r1_pubkey` on-chain. If this precondition is not met, the card is not (yet) a DNS admin card as far as the registry is concerned, and `RegisterSubCard` takes the ordinary non-DNS-admin path (no secp256r1 co-signature required).

**Flow:**

1. The requesting app and the sub-card holder (the domain admin) go through the ordinary `SubCardDocument` signing sequence (`protocol-objects.md §16`): the app signs first, producing `app_signature`; the holder countersigns, producing `holder_signature`. The document includes a `dns_path_scope` field (see `protocol-objects.md §16` and Fix #34) — a regex describing the sub-path this sub-card may administer (e.g. `^/blog/.*$`).
2. Because the master card is a DNS admin card, the domain admin holder — using their secp256r1 private key (the one whose public counterpart is stored in `DnsAdminCardKeys`, not their ML-DSA-44 IPFS identity key) — additionally produces an `AdminAuthorizeSubCardPayload` (`registry_contract.md §4.3`) naming the `sub_card_address` and `sub_card_doc_cid`, and signs `keccak256(admin_secp_payload)` to produce `admin_secp_signature`.
3. Both the `SubCardDocument` submission and the `admin_secp_payload`/`admin_secp_signature` pair reach the press via the same `POST /sub-card/register` request (`press.md §5.4`), which carries them as `adminSecpPayload`/`adminSecpSignature` alongside the sub-card document and holder signature.
4. The press (per `press.md §5.4` step 5a) reads `DnsAdminCardKeys[master_card_address]` via `GetDnsAdminCardKey`, confirms it is non-zero, checks that `admin_secp_payload` encodes the matching `sub_card_address`/`sub_card_doc_cid`, and passes both values through unmodified to `RegisterSubCard` — the press does not itself verify the secp256r1 signature; the contract does, via RIP-7212, against `DnsAdminCardKeys[master_card_address]`.
5. **On error `E-47`** (`INVALID_ADMIN_CARD_SIGNATURE`): the contract has rejected the admin secp256r1 signature — missing/invalid `admin_secp_signature`, a payload field mismatch, or (for a non-DNS-admin master) a spurious non-zero signature. Per `press.md §5.4`, the press surfaces `E-47` to the caller directly and does not retry the submission. The sub-card is not registered; the requesting app/wallet must obtain a corrected co-signature from the domain admin holder and resubmit.

---

## Script B — Admin Deactivation (`admin-deactivation`)

### Purpose

Deactivate all prior domain admin cards and their policy entries during a domain handoff, then register a new domain admin. Called by the new domain owner after they complete TXT verification for their own key.

### Actors

| Actor | Role |
|---|---|
| **Current domain admin** | The holder of the on-chain active domain admin card for the domain; initiates the deactivation request |
| **DNS Governance Authority operator** | Verifies the requester's identity, deactivates old cards, calls `ClearDomainEntries` and `DeregisterDomain` |
| **Press** | Deactivates old admin cards via `UpdateCardHead` with a 9xx revocation entry |
| **Arbitrum One registry** | Receives `ClearDomainEntries`, `DeregisterDomain`, and card update transactions |

### Preconditions

- The requester holds the on-chain active domain admin card: `DomainRegistrations[domain].admin_card_address` must match the requester's card address.
- The new admin card has been issued (Script A, Stage A1 only — card issuance, not domain registration). **Fix #35 correction:** this precondition does not require that `RegisterDomain` (Stage A2) has been called for the new card. It cannot have been: `registry_contract.md §4.17` precondition 4 rejects `RegisterDomain` while the domain still has an active (old) admin, which is exactly the state this script exists to clear. Stage A2 for the new card runs *after* this script, per the closing note in Script B below and the "Domain handoff sequencing" note under Script A.
- A list of old admin card addresses to deactivate is provided.

### Request Format

`POST /dns/deactivate`

```json
{
  "domain": "<lowercase domain string>",
  "requester_card_address": "<hex bytes32 — current on-chain admin card>",
  "requester_signature": "<base64url — ML-DSA-44 sig over canonical request payload>",
  "old_admin_cards": ["<hex bytes32>", "..."],
  "active_paths": ["<path string>", "..."]
}
```

`requester_signature` covers the canonical JSON of `{ "op": "deactivate_admin", "domain": "...", "old_admin_cards": [...], "active_paths": [...], "timestamp": "..." }`.

### Steps

1. **Validate request.** Check all fields are present and well-formed. Return HTTP 400 on any failure.

2. **Verify requester is current on-chain admin.** Call `GetDomainRegistration(domain)`. Confirm `exists == true` and `admin_card_address == requester_card_address`. Return HTTP 403 if mismatched.

3. **Verify requester holds the card key.** Fetch the requester's card document from IPFS (via `GetCardEntry(requester_card_address).log_head_cid`). Extract the `ml_dsa_pubkey`. Verify `requester_signature` over the canonical request payload using ML-DSA-44. Return HTTP 403 if invalid.

4. **Verify each old admin card is a predecessor.** For each address in `old_admin_cards`:
   - Check the card exists in `CardEntries`.
   - Fetch the card document from IPFS and confirm it was issued under `DnsGovernancePolicyAddress`.
   - Confirm the card is a predecessor to the current admin (by walking the IPFS card log's `successor` chain forward from the old card, or the `forward_to` chain in the registry, until reaching the current admin or exhausting the chain). Cards that cannot be confirmed as predecessors are rejected.
   - Return HTTP 422 if any card fails this check.

5. **Clear domain entries.** Construct a `ClearDomainEntriesPayload` and sign with the governance private key. Call `ClearDomainEntries(domain, active_paths, governance_payload, [governance_sig])`.

6. **Deregister old domain (clear admin pointer).** Call `DeregisterDomain(domain, governance_payload, [governance_sig])`. **Note (Fix #33):** per `registry_contract.md §4.18`, `DeregisterDomain` also zeroes `DnsAdminCardKeys[old_admin]` as a side effect of clearing the admin pointer — the deactivated domain admin card immediately loses its ability to co-sign `AdminAuthorizeSubCardPayload`s (§4.3), independent of and prior to the 9xx revocation applied to the card itself in step 7 below.

7. **Revoke old admin cards.** For each card in `old_admin_cards`, submit `UpdateCardHead` with a 9xx revocation entry via the authorized press. Write the revocation log entry to IPFS first. Include the successor chain reference pointing to the new admin card.

8. **Return result.** On success, return HTTP 200:
   ```json
   {
     "domain": "<domain>",
     "deregistered_at": "<ISO 8601>",
     "cards_revoked": ["<hex bytes32>", "..."],
     "paths_cleared": <count>,
     "tx_hashes": { "clear": "<hex>", "deregister": "<hex>" }
   }
   ```

The new admin registration (calling `RegisterDomain` with the new card) is handled separately by Script A Stage A2 after this operation completes.

### Acceptance Criteria

- [ ] A valid request where the requester holds the on-chain admin card results in `DomainDeregistered` and `DomainEntriesCleared` events, HTTP 200.
- [ ] A requester whose `card_address` does not match `DomainRegistrations[domain].admin_card_address` returns HTTP 403.
- [ ] An invalid ML-DSA-44 `requester_signature` returns HTTP 403.
- [ ] An `old_admin_cards` entry that cannot be confirmed as a predecessor of the current admin causes the entire request to fail (HTTP 422) with no partial state changes.
- [ ] All cards in `old_admin_cards` are 9xx-revoked in the IPFS log, with revocation entries linking to the new admin card address.
- [ ] `ClearDomainEntries` is called before `DeregisterDomain` to ensure no orphaned entries remain.
- [ ] The `active_paths` list in the request is used for `ClearDomainEntries`; paths not in the list are not cleared.

---

## Script C — Policy Address Verifier (`policy-address-verifier`)

### Purpose

Monitor `PolicyAddressSet` on-chain events and verify each new entry within 24 hours. Remove unauthorized entries, report fraudulent presses to `PressRegistryBody`.

### Actors

| Actor | Role |
|---|---|
| **DNS Governance Authority** | Runs this script continuously; signs `RemovePolicyAddress` (governance path) payloads on violations |
| **Arbitrum One registry** | Source of `PolicyAddressSet` events; receives removal transactions |
| **IPFS** | Source of card documents (for scope regex and ML-DSA-44 pubkey verification) |

### Preconditions

- The script is subscribed to `PolicyAddressSet` events emitted by the logic contract.
- The authority holds ML-DSA-44 public keys for admin cards of Level 1 (Monitored) domains.
- The registered brand name list is loaded at startup and refreshed on each new version.

### Operation Mode

This script runs as a continuous polling process (not a one-shot HTTP handler). It polls for new `PolicyAddressSet` events on a configurable interval (default: 60 seconds) and maintains a cursor (last-processed block number) in persistent storage.

```
POLL_INTERVAL_MS=60000         # How often to poll for new events (ms)
EVENT_CURSOR_STORE=<path>      # File or KV key for the last-processed block cursor
BRAND_NAME_LIST_URL=<https://...>  # URL of the versioned brand name list JSON
SLA_HOURS=24                   # Maximum hours between event emission and verification
```

### Polling Loop Steps

1. **Load cursor.** Read the last-processed block number from `EVENT_CURSOR_STORE`. Default to the block at which `DnsGovernancePolicyAddress` was first set if no cursor exists.

2. **Fetch new events.** Query the logic contract for `PolicyAddressSet` events from `[cursor + 1, latestBlock]`. Parse each event into a `PolicyAddressSetEvent` record. Advance cursor to `latestBlock`.

3. **Process each event.** For each event, run the verification pipeline (see §Verification Pipeline below). Log the result (pass or fail) with the event's domain, path, block number, and timestamp.

4. **Sleep until next poll.** Wait `POLL_INTERVAL_MS` before repeating.

**SLA monitoring.** Before sleeping, the script checks whether any event in the processing queue has been pending for more than `SLA_HOURS`. If so, it alerts operators (via logging or a configured webhook) and prioritizes that event in the next pass.

### Verification Pipeline

For each `PolicyAddressSet` event `{ domain, path, policy_card_address, admin_card_address, sub_card_address, press_address, block_number }`:

1. **Check domain registration.** Call `GetDomainRegistration(domain)`. If `exists == false`: log a warning (domain was deregistered after the event; no action needed, entries were cleared by `DeregisterDomain`). Skip.

2. **Verify policy card exists.** Call `CardExists(policy_card_address)`. If false: call `RemovePolicyAddress(domain, path, bytes32(0), ...)` (governance path) to clear the stale entry. Log as `FAILED_POLICY_CARD_NOT_FOUND`. Continue. **(Fix #37: standardized on `RemovePolicyAddress`'s governance path — `registry_contract.md §4.20` Path B — for every clearing action in this pipeline, rather than alternating with `GovernanceSetPolicyAddress(..., bytes32(0), ...)`, which `§4.23` documents as an equivalent-but-separate clearing mechanism.)**

3. **Verify admin card.** Confirm `admin_card_address == DomainRegistrations[domain].admin_card_address`. If mismatched: the binding check should have caught this on-chain, but if the domain was re-registered after the event, the admin may have changed. Log as a warning; no removal action.

4. **Verify sub-card scope (if sub_card_address is non-zero).**
   - Fetch the sub-card document from IPFS (via `GetSubCardEntry(sub_card_address).sub_card_doc_cid`).
   - Extract the `dns_path_scope` regex from the document.
   - Test the regex against `path`. If the regex does not match: this entry was submitted without proper scope validation by the press.
   - Call `RemovePolicyAddress(domain, path, bytes32(0), ...)` (governance path).
   - Log as `FAILED_SCOPE_VIOLATION`. Record `press_address` for potential `RevokePress` report.

5. **Brand-name scan (all domains; mandatory for Level 1 monitored domains).**
   - Fetch the policy card document from IPFS (via `GetCardEntry(policy_card_address).log_head_cid`).
   - Scan the policy card title and all text-type credential field values against the registered brand name list.
   - **If a match is found:** Call `RemovePolicyAddress(domain, path, bytes32(0), ...)` (governance path).
   - Log as `FAILED_BRAND_NAME_IMPERSONATION`. If the domain's `fraud_risk` is already 1 and this is the second scan failure: escalate to `FlagDomainFraudRisk(domain, 2, suspension_expires_at)` and `ClearDomainEntries`. (Fix #38: parameter renamed from `suspension_expiry` to `suspension_expires_at` to match `registry_contract.md §3.8`/`§4.22`.)
   - If no match: log as `PASSED_BRAND_SCAN`.

6. **Level 1 (monitored) additional verification.**
   - Confirm the domain admin's public key is registered with the authority. If not: call `RemovePolicyAddress` (governance path). Log as `FAILED_PUBKEY_NOT_REGISTERED`.

7. **Mark as verified.** Log as `VERIFIED` with block number and timestamp. No on-chain action.

### Fraudulent Press Reporting

When a scope violation or brand-name impersonation is detected:
- The script logs the `press_address` to a fraudulent press queue.
- After 3 confirmed violations from the same press within 30 days, the authority prepares a fraud report for `PressRegistryBody` containing: press address, list of on-chain transaction hashes, violation type for each, and a summary.
- The fraud report is submitted to `PressRegistryBody`'s reporting channel (off-chain, per `PressRegistryBody` operational procedures). The DNS governance authority does not have the power to call `RevokePress` directly.

### Acceptance Criteria

- [ ] Every `PolicyAddressSet` event is processed within 24 hours of emission (SLA).
- [ ] A scope violation (sub-card `dns_path_scope` does not match path) results in `RemovePolicyAddress` being called and the event logged as `FAILED_SCOPE_VIOLATION`.
- [ ] A brand-name match in the policy card content results in `RemovePolicyAddress` being called and logged as `FAILED_BRAND_NAME_IMPERSONATION`.
- [ ] A non-existent `policy_card_address` results in `RemovePolicyAddress(domain, path, bytes32(0), ...)` (governance path — clear the stale entry).
- [ ] The polling cursor is persisted between runs; no event is processed twice.
- [ ] SLA monitoring alerts operators when any event has been pending for more than 24 hours.
- [ ] Brand-name scanning uses the current version of the registered brand name list; the version used is logged with each scan result.
- [ ] Fraudulent press reports are generated after 3 confirmed violations from the same press within 30 days.
- [ ] A deregistered domain (exists == false at verification time) results in a warning log and no on-chain action.

---

## Nitro Deployment Notes

### Handler Structure

Scripts A (Stages A1 and A2) and B are HTTP endpoint handlers. Script C is a background polling task.

**Script A/B — event handler pattern:**

```typescript
// nitro.config.ts
import { defineNitroConfig } from 'nitropack/config';
export default defineNitroConfig({
  routeRules: {
    '/dns/**': { cors: false }  // governance endpoints are not public-facing
  }
});

// routes/dns/verify.post.ts (Stage A1)
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  // ... handler logic
});

// routes/dns/register-domain.post.ts (Stage A2)
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  // ... handler logic
});
```

**Script C — scheduled task pattern:**

```typescript
// nitro.config.ts
export default defineNitroConfig({
  scheduledTasks: {
    '* * * * *': 'tasks/poll-policy-events'  // every 60s (or configured interval)
  }
});

// tasks/poll-policy-events.ts
export default defineTask({
  meta: { name: 'poll-policy-events', description: 'Verify PolicyAddressSet events' },
  async run() {
    // ... polling loop logic
  }
});
```

### Retry and Error Handling

- DNS queries (Script A): use exponential backoff (30s, 60s, 120s), maximum 3 retries.
- On-chain calls: use viem's `waitForTransactionReceipt` with a 60-second timeout. Retry failed transactions once with a higher gas price before alerting operators.
- IPFS fetches: retry 3 times with 5-second delays. If an IPFS document is unreachable after retries, log the failure and skip the scan for that item (do not remove the entry solely because IPFS is unreachable).

### Recommended Deployment Targets

- **Node.js** — for the operator running the governance scripts directly on a server with persistent storage for the event cursor.
- **Cloudflare Workers** — for Scripts A and B (HTTP handlers); Script C requires a Durable Object or Workers Cron Trigger for the cursor persistence.
- All three scripts use the same environment variable set and can be deployed from a single Nitro application instance.

### Key Security Notes

- `DNS_GOV_PRIVATE_KEY` and `PRESS_PRIVATE_KEY` must be stored as environment secrets, never in the repository.
- On Cloudflare Workers, use Workers Secrets. On Node.js, use a secrets manager or environment injection at deploy time.
- The governance endpoint (Scripts A and B) should be protected with at minimum an API key header (`X-Governance-Token`) to prevent unauthenticated submissions. Script C has no public endpoint.
