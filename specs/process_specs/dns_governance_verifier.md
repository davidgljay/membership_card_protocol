# DNS Governance Scripts — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-06-25  
**Status:** Draft  
**Charter:** [governance/DnsGovernanceBody/mandate.md](../../governance/DnsGovernanceBody/mandate.md)  
**DNS resolution spec:** [dns_resolution.md](../dns_resolution.md)  
**Contract spec:** [registry_contract.md](../object_specs/registry_contract.md) §4.17–4.24

---

## Overview

This document specifies three Nitro server scripts that implement the operational responsibilities of the DNS Governance Authority. All three scripts are deployed as [Nitro](https://nitro.unjs.io/) handlers, making them deployable to Node.js, Cloudflare Workers, Deno, Bun, or any Nitro-compatible edge environment.

| Script | File | Trigger | Purpose |
|---|---|---|---|
| A — TXT Verification | `governance/scripts/txt-verification.ts` | HTTPS POST from applicant | Verify DNS TXT record, issue domain admin card, call RegisterDomain |
| B — Admin Deactivation | `governance/scripts/admin-deactivation.ts` | HTTPS POST from current domain admin | Deactivate old admin chain during domain handoff |
| C — Policy Address Verifier | `governance/scripts/policy-address-verifier.ts` | Polling `PolicyAddressSet` on-chain events | Verify each new policy address entry within 24-hour SLA |

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

---

## Script A — TXT Verification (`txt-verification`)

### Purpose

Verify that an applicant controls a domain by checking a `mcard-verify=...` DNS TXT record at `_mcard.<domain>`, then issue a domain admin card and register the domain on-chain.

### Actors

| Actor | Role |
|---|---|
| **Domain applicant** | Submits a verification request with their domain, card address, ML-DSA-44 public key, and secp256r1 public key |
| **DNS Governance Authority operator** | Runs this script; signs `RegisterDomain` governance payload |
| **Authorized press** | Issues the domain admin card via `RegisterCard` under the DNS governance policy |
| **Arbitrum One registry** | Receives and records `RegisterDomain` |

### Preconditions

- The applicant has a card address (derived as `keccak256(ml_dsa_pubkey)`) and has set the corresponding `_mcard.<domain>` TXT record.
- The domain is publicly resolvable via standard DNS.
- The TXT record has the format: `mcard-verify=<card_address_hex>.<pubkey_fingerprint>` where `pubkey_fingerprint` is the hex-encoded first 8 bytes of `keccak256(ml_dsa_pubkey)`.
- `DnsGovernancePolicyAddress` has been initialized on-chain.
- The press is authorized under `DnsGovernancePolicyAddress`.
- The domain is not already registered with an active admin card (checked on-chain).

### Request Format

`POST /dns/verify`

```json
{
  "domain": "<lowercase domain string>",
  "card_address": "<hex bytes32>",
  "ml_dsa_pubkey": "<base64url — 1312 bytes>",
  "secp256r1_pubkey": "<base64url — 64 bytes>"
}
```

### Steps

1. **Validate request.** Confirm `domain` is a valid RFC 1123 hostname (1–255 bytes, no trailing dot). Confirm `card_address` is a 32-byte hex string. Confirm `ml_dsa_pubkey` is 1312 bytes base64url-decoded. Confirm `secp256r1_pubkey` is 64 bytes base64url-decoded. Return HTTP 400 on any failure.

2. **Verify card address derivation.** Compute `keccak256(ml_dsa_pubkey_bytes)` and confirm it equals `card_address`. This prevents an applicant from submitting a card address they do not control. Return HTTP 400 if mismatched.

3. **Check domain not already registered.** Call `GetDomainRegistration(domain)` on the storage contract. If `exists == true` and `admin_card_address != bytes32(0)`, return HTTP 409 (domain already has an active admin; the applicant must go through the admin-deactivation process first).

4. **Resolve TXT record.** Query `_mcard.<domain>` via DNS (UDP/53 with DNS-over-HTTPS fallback). Parse all TXT records at that subdomain. For each record, check if it matches the pattern `mcard-verify=<expected_card_address_hex>.<expected_fingerprint>` where `expected_fingerprint = hex(keccak256(ml_dsa_pubkey_bytes)[0:8])`. If no record matches:
   - Retry up to 3 times with exponential backoff (30s, 60s, 120s) to accommodate DNS propagation delay.
   - After all retries: return HTTP 422 with `{ "error": "txt_record_not_found", "domain": "..." }`.

5. **Issue domain admin card.** Construct a `RegisterCardPayload` signed by the press private key. Call `RegisterCard` on the logic contract with:
   - `card_address` = the applicant's card address
   - `initial_log_cid` = CID of the genesis card document (written to IPFS first)
   - `policy_address` = `DnsGovernancePolicyAddress`
   
   The genesis card document on IPFS includes the applicant's `ml_dsa_pubkey` and lists the DNS governance authority in its `auditors` field. It does NOT include a `dns_path_scope` field (this is a full-domain admin card).

6. **Call RegisterDomain.** Construct a `RegisterDomainPayload` and sign it with the governance private key. Submit `RegisterDomain(domain, card_address, secp256r1_pubkey_bytes, governance_payload, [governance_sig])` to the logic contract.

7. **Return result.** On success, return HTTP 200:
   ```json
   {
     "domain": "<domain>",
     "card_address": "<hex bytes32>",
     "tx_hash": "<hex>",
     "registered_at": "<ISO 8601>"
   }
   ```

### Acceptance Criteria

- [ ] A valid request with a correctly-formatted TXT record results in a `DomainRegistered` event on-chain and HTTP 200 with the card address.
- [ ] The card address derivation check (`keccak256(ml_dsa_pubkey)`) is verified before any DNS query is made.
- [ ] Multiple TXT records at `_mcard.<domain>` are handled: verification passes if at least one matches.
- [ ] A missing or mismatched TXT record is retried up to 3 times with backoff before returning HTTP 422.
- [ ] An already-registered domain (with active admin) returns HTTP 409 without issuing a card or calling RegisterDomain.
- [ ] The genesis card document is written to IPFS and its CID verified resolvable before `RegisterCard` is submitted.
- [ ] An invalid `ml_dsa_pubkey` length returns HTTP 400.
- [ ] All retries are logged with the TXT record query result at each attempt.

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
- The requester has completed TXT verification for their own key (Script A), generating their new domain admin card.
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

6. **Deregister old domain (clear admin pointer).** Call `DeregisterDomain(domain, governance_payload, [governance_sig])`.

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

The new admin registration (calling `RegisterDomain` with the new card) is handled separately by Script A after this operation completes.

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
| **DNS Governance Authority** | Runs this script continuously; signs `GovernanceSetPolicyAddress` or `RemovePolicyAddress` payloads on violations |
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

2. **Verify policy card exists.** Call `CardExists(policy_card_address)`. If false: call `GovernanceSetPolicyAddress(domain, path, bytes32(0), ...)` to clear the stale entry. Log as `FAILED_POLICY_CARD_NOT_FOUND`. Continue.

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
   - Log as `FAILED_BRAND_NAME_IMPERSONATION`. If the domain's `fraud_risk` is already 1 and this is the second scan failure: escalate to `FlagDomainFraudRisk(domain, 2, suspension_expiry)` and `ClearDomainEntries`.
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
- [ ] A non-existent `policy_card_address` results in `GovernanceSetPolicyAddress(domain, path, bytes32(0))` (clear the stale entry).
- [ ] The polling cursor is persisted between runs; no event is processed twice.
- [ ] SLA monitoring alerts operators when any event has been pending for more than 24 hours.
- [ ] Brand-name scanning uses the current version of the registered brand name list; the version used is logged with each scan result.
- [ ] Fraudulent press reports are generated after 3 confirmed violations from the same press within 30 days.
- [ ] A deregistered domain (exists == false at verification time) results in a warning log and no on-chain action.

---

## Nitro Deployment Notes

### Handler Structure

Scripts A and B are HTTP endpoint handlers. Script C is a background polling task.

**Scripts A and B — event handler pattern:**

```typescript
// nitro.config.ts
import { defineNitroConfig } from 'nitropack/config';
export default defineNitroConfig({
  routeRules: {
    '/dns/**': { cors: false }  // governance endpoints are not public-facing
  }
});

// routes/dns/verify.post.ts
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
