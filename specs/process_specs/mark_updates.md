# Mark Updates — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt" and "press" for the issuance service. The rename is in progress; treat the terms as interchangeable.

---

## Overview

A mark update is any post-issuance change to a mark's state: field edits, annotations, privilege changes, or revocations. All updates follow a single unified flow — the updater signs an intent payload, submits it to any press listed in `approved_presses`, and the press validates authorization, assembles the full log entry, signs it, and posts it. The append-only log preserves complete history; nothing is silently removed.

Updates are classified by a three-digit code (1xx–9xx) that signals the semantic nature of the update to verifiers. Codes 1xx–7xx are field updates; codes 8xx–9xx are revocations.

---

## Actors

| Actor | Role |
|---|---|
| **Updater** | The party submitting the update intent (holder, issuer, or another authorized party) |
| **Press** | Validates authorization, assembles the log entry, posts to IPFS and Arbitrum One |
| **Holder** | Receives an HTTPS notification via their wallet service if `notify_holder` is true and the code prefix is not suppressed |

---

## Preconditions

- The target mark exists on IPFS and is registered on Arbitrum One.
- The updater holds a mark whose chain satisfies the relevant authorization predicate.
- The updater has a press sub-mark key available for signing.
- At least one press is listed in `approved_presses` for the target mark's policy.

---

## Steps

### Phase 1: Intent Assembly

1. The updater determines the appropriate update code:
   - **1xx** — positive update (e.g., linked to a successor mark)
   - **2xx** — positive annotation (commendation, endorsement)
   - **3xx** — neutral field update (e.g., `valid_until` refresh)
   - **4xx** — neutral annotation (informational note for verifiers)
   - **5xx** — programmatic update (automated field change by protocol/policy logic)
   - **6xx** — negative annotation (concern noted; revocation not yet warranted)
   - **7xx** — privilege reduction
   - **8xx** — quiet revocation (holder not an active risk; historical signatures remain trusted before `effective_date`)
   - **9xx** — loud revocation (holder may pose risk to other communities)

2. The updater assembles the `UpdateIntentPayload`:
   ```json
   {
     "target_mark":    "<mutable pointer of the mark being updated>",
     "updater_mark":   "<mutable pointer of the updater's mark>",
     "code":           <integer 100–999>,
     "field_updates":  [{ "field": "<name>", "value": <new value> }],
     "revocation":     { "effective_date": "<ISO 8601>", "note": "<optional>" },
     "notify_holder":  true,
     "updater_message":"<optional — forwarded to holder in HTTPS notification>",
     "timestamp":      "<ISO 8601 — replay prevention>"
   }
   ```
   - For codes 1xx–7xx: populate `field_updates`; omit `revocation`.
   - For codes 8xx–9xx: populate `revocation` with an `effective_date` (may predate posting); omit `field_updates`.
   - Set `notify_holder: false` for adversarial scenarios (e.g., a 9xx revocation where notification would be harmful). The policy may also suppress notification for specific code prefixes.

3. The updater canonically serializes the `UpdateIntentPayload` (canonical CBOR per RFC 8949 §4.2 with protocol-specific overrides).

4. The updater signs the canonical serialization with their current sub-mark private key → `intent_signature`.

### Phase 2: Submission

5. The updater sends the signed intent via HTTPS POST to any press listed in `approved_presses` for the mark's policy. The press is neutral infrastructure — any listed press may process any update; the updater does not need to use the original issuing press.

### Phase 3: Press Validation

6. The press fetches the target mark's current log head from IPFS and confirms the on-chain Arbitrum One pointer matches.

7. The press validates the intent:
   - **Signature validity:** Verify `intent_signature` over the canonical `UpdateIntentPayload`.
   - **Updater not revoked:** Confirm the updater's mark has no 8xx or 9xx entry with `effective_date` ≤ now.
   - **Authorization — field updates (codes 1xx–7xx):** For each field in `field_updates`, confirm the updater's mark chain satisfies that field's `update_policy` predicate (from the policy's `field_definitions`). All predicates must be satisfied by the same updater.
   - **Authorization — revocations (codes 8xx–9xx):** Confirm the updater's mark chain satisfies `revocation_permissions` for the given code range. If `revocation_permissions` is absent from the policy, the default applies: 8xx by holder or issuer, 9xx by issuer only.
   - **Immutable fields:** Confirm no `field_updates` entry targets a protocol-required immutable field (`policy_id`, `press_mark`, `recipient_pubkey`, `issued_at`, `offer_signature`, `holder_signature`).
   - **Code consistency:** 8xx–9xx entries must include `revocation` and no `field_updates`; 1xx–7xx entries must include `field_updates` and no `revocation`.
   - **Erasure eligibility:** If the entry carries `erasure: true`, confirm the policy specifies `erasable: true`. Reject otherwise.
   - **Timestamp freshness:** Reject intents with timestamps outside the acceptable replay-prevention window.

8. If any check fails, the press rejects the intent with a specific error code and does not post. The updater receives the rejection reason via the submission channel.

### Phase 4: Entry Assembly and Posting

9. The press assembles the complete `LogEntry`:
   - Copies the intent payload verbatim.
   - Adds `version` — the current log head's version plus one.
   - Adds `prev_log_root` — the CID of the current log head.
   - Signs the canonical serialization of the complete `LogEntry` (excluding `press_signature`) with the press sub-mark key → `press_signature`.

10. The press posts the new log entry to IPFS.

11. The press updates the Arbitrum One registry pointer for the target mark to the CID of the new log entry, signed with the press sub-mark key.

### Phase 5: Notification and Confirmation

12. If `notify_holder` is `true` and the policy does not suppress notification for this code prefix:
    - The press sends an HTTPS notification to the holder's wallet service endpoint containing: the update code, the `updater_message` (if present), and the CID of the new log entry.
    - If the holder's wallet service endpoint is unreachable, the notification is dropped; the holder will discover the update on next poll.

13. The press sends a success confirmation to the updater via the submission channel.

---

## Postconditions

- A new `LogEntry` is appended to the target mark's IPFS log, chained via `prev_log_root`.
- The Arbitrum One registry entry for the target mark points to the new log head.
- The updater's identity and intent signature are permanently recorded in the log entry.
- If `notify_holder` was true, an HTTPS notification was sent to the holder's wallet service endpoint.
- Any verifier can re-derive the complete current state of the mark by reading the append-only log from the genesis document to the current head.

---

## Concurrency

If two update intents are submitted concurrently and one is posted first, the second intent will reference a stale `prev_log_root` when the press validates. The press rejects the stale intent with a clear error. The updater must re-fetch the current log head and resubmit against the new head.

---

## Revocation Semantics

- **8xx (quiet revocation):** The mark is revoked. Historical signatures before `effective_date` remain trusted. The revocation signals a change of state, not a retroactive claim that prior actions were invalid.
- **9xx (loud revocation):** The mark is revoked. Things on or after `effective_date` are suspect or invalid; things before are trusted. Verifiers may notify issuers of other marks they have seen from the same holder — but this is a social protocol, not cryptographic.
- **Un-revocation:** The append-only log cannot remove a revocation entry. To restore standing, the authorizer issues a new **successor mark** with a `supersedes` field pointing to the old mark's mutable pointer and a `supersession_note` explaining the context.
- **Effective date backdating:** The `effective_date` in a revocation may be earlier than the posting date. If multiple revocation entries exist, the one with the earliest `effective_date` governs.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Intent timestamp too old or too far in the future | Updater resubmits with a fresh timestamp |
| Updater's mark revoked with `effective_date` ≤ now | Updater is not eligible; must use a different authorized party |
| `update_policy` predicate not satisfied for one or more fields | Updater does not have authority; request must come from an authorized party |
| `revocation_permissions` not satisfied | Updater does not have revocation authority; requester must use an authorized party |
| `prev_log_root` is stale (concurrent update race) | Updater re-fetches current log head and resubmits |
| IPFS post fails | Press retries; does not write on-chain until IPFS CID is confirmed |
| Erasure attempted on non-erasable mark | Press rejects; policy must specify `erasable: true` |

---

## Related Specs

- `policy_creation.md` — where `update_policy` and `revocation_permissions` are defined
- `mark_offering_and_acceptance.md` — the issuance flow (genesis of the mark being updated)
- `log_auditing.md` — how update entries are visible to auditors
- `chitt_protocol_spec.md §5` — full feature spec for updating marks
- `protocol-objects.md §3` — `LogEntry` object reference
- `protocol-objects.md §4` — `UpdateIntentPayload` object reference
- `update_codes.md` — full update code taxonomy
