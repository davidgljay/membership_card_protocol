# Card Updates — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

**Changelog (spec-consistency Phase 2, Step C — `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`):**
- Fix #17: Postconditions rewritten — current field state comes from the head `LogEntry`'s `card_state`, not a full genesis-to-head walk; the notes array still requires visiting every entry, now in parallel via `history`.
- Fix #18: Step 9 (LogEntry assembly) rewritten to mirror `press.md §5.3 appendLogEntry` — adds the fetch/decrypt-current-head precondition and the `entry_type`, `history`, `card_state` fields that were previously omitted.
- Fix #19: Step 11 split into two named operations — posting the ML-DSA-44-signed `LogEntry` to IPFS, and separately calling `UpdateCardHead` authorized by the press's secp256r1 on-chain key.
- Fix #20: Notes Array mechanism description updated — head fetch + parallel predecessor fetches via `history`, not a sequential genesis-to-head walk.
- Fix #21: Sub-Card Directory Updates section now cross-references `press.md §5.3`'s sibling sub-card notification behavior.
- Fix #22: Concurrency section and Error Paths table row reworded — `UpdateIntentPayload` carries no `prev_log_root`; the actual race is press-side head staleness or the on-chain `prev_log_cid` check in `UpdateCardHead`.
- Fix #24 (partial): Step 7's immutable-fields list expanded to the complete protocol-required/reserved set.

---

## Overview

A card update is any post-issuance change to a card's state: field edits, annotations, privilege changes, or revocations. All updates follow a single unified flow — the updater signs an intent payload, submits it to any press listed in `approved_presses`, and the press validates authorization, assembles the full log entry, signs it, and posts it. The append-only log preserves complete history; nothing is silently removed.

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

- The target card exists on IPFS and is registered on Arbitrum One.
- The updater holds a card whose chain satisfies the relevant authorization predicate.
- The updater has a sub-card key available for signing.
- At least one press is listed in `approved_presses` for the target card's policy.

---

## Steps

### Phase 1: Intent Assembly

1. The updater determines the appropriate update code:
   - **1xx** — positive update (e.g., linked to a successor card)
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
     "target_card":    "<mutable pointer of the card being updated>",
     "updater_card":   "<mutable pointer of the updater's card>",
     "code":           <integer 100–999>,
     "field_updates":  [{ "field": "<name>", "value": <new value> }],
     "revocation":     { "effective_date": "<ISO 8601>", "note": "<optional>" },
     "note":           "<optional free text — appended to the card's notes array>",
     "notify_holder":  true,
     "updater_message":"<optional — forwarded to holder in HTTPS notification>",
     "timestamp":      "<ISO 8601 — replay prevention>"
   }
   ```
   - For codes 1xx–7xx: populate `field_updates`; omit `revocation`.
   - For codes 8xx–9xx: populate `revocation` with an `effective_date` (may predate posting); omit `field_updates`.
   - `note` is optional and may be included with any update code. If present, it is appended to the card's notes array (see Notes Array below). It is distinct from `revocation.note`, which is internal to the revocation record and not surfaced in the notes array.
   - Set `notify_holder: false` for adversarial scenarios (e.g., a 9xx revocation where notification would be harmful). The policy may also suppress notification for specific code prefixes.

3. The updater canonically serializes the `UpdateIntentPayload` (canonical RFC 8785 JSON).

4. The updater signs the canonical serialization with their current sub-card private key → `intent_signature`.

### Phase 2: Submission

5. The updater sends the signed intent via HTTPS POST to any press listed in `approved_presses` for the card's policy. The press is neutral infrastructure — any listed press may process any update; the updater does not need to use the original issuing press.

### Phase 3: Press Validation

6. The press fetches the target card's current log head from IPFS and confirms the on-chain Arbitrum One pointer matches.

7. The press validates the intent:
   - **Signature validity:** Verify `intent_signature` over the canonical `UpdateIntentPayload`.
   - **Updater not revoked:** Confirm the updater's card has no 8xx or 9xx entry with `effective_date` ≤ now.
   - **Authorization — field updates (codes 1xx–7xx):** For each field in `field_updates`, confirm the updater's card chain satisfies that field's `update_policy` predicate (from the policy's `field_definitions`). All predicates must be satisfied by the same updater.
   - **Authorization — sub-card directory updates (codes 510/511/512):** The press MUST confirm the intent is signed by the target card's own holder key (`{ "is_holder": true }`), regardless of what the governing policy's `update_policy` states for `active_subcards` or any other field. This authorization is hardcoded per `protocol-objects.md §1.1` and `update_codes.md §5xx` — a policy cannot grant this authority to an issuer or any other party, and the press MUST reject any 510/511/512 intent not signed by the holder even if the policy's `update_policy` would otherwise permit it.
   - **Authorization — revocations (codes 8xx–9xx):** Confirm the updater's card chain satisfies `revocation_permissions` for the given code range. If `revocation_permissions` is absent from the policy, the default applies: 8xx by holder or issuer, 9xx by issuer only.
   - **Immutable fields:** Confirm no `field_updates` entry targets a protocol-required immutable field: `policy_id, issuer_card, press_card, recipient_pubkey, issued_at, issuer_signature, holder_signature, press_signature, ancestry_pubkeys, past_keys, protocol_version, active_subcards, successor, supersedes, supersession_note` (per `protocol-objects.md §1`/§1.1). Note: `active_subcards` (codes 510/511/512, per the dedicated authorization path below), `successor` (codes 100/101/102), `supersedes`, and `supersession_note` are protocol-reserved fields that may be set post-issuance via their defined update-code mechanisms and are listed here only to flag that they are otherwise off-limits to ordinary `field_updates` — a generic 1xx–7xx intent may not target them outside those specific mechanisms.
   - **Code consistency:** 8xx–9xx entries must include `revocation` and no `field_updates`; 1xx–7xx entries must include `field_updates` and no `revocation`.
   - **Timestamp freshness:** Reject intents with timestamps outside the acceptable replay-prevention window.

8. If any check fails, the press rejects the intent with a specific error code and does not post. The updater receives the rejection reason via the submission channel.

### Phase 4: Entry Assembly and Posting

9. The press assembles the complete `LogEntry` (mirrors `press.md §5.3 appendLogEntry` — see there for the canonical implementation-level steps):
   - Fetches and decrypts the current log head object from IPFS (the genesis `CardDocument`, or the prior `LogEntry` if one exists) to obtain its current field state and, if it is itself a `LogEntry`, its `history` array.
   - Adds `version` — the current log head's version plus one.
   - Adds `code` — from the intent.
   - Adds `entry_type` — `"field_update"` for codes 1xx–7xx; `"revocation"` for codes 8xx–9xx (derived from the code range).
   - Adds `prev_log_root` — the CID of the current log head.
   - Adds `history` — the current head's own `history` array (or `[]` if the head is the genesis document) with the current head's own CID appended.
   - Adds `card_state` — the current head's field state with the intent's `field_updates` applied (unchanged from the current head's `card_state` for 8xx–9xx codes, which carry no `field_updates`).
   - Copies `field_updates`/`revocation`, `notify_holder`, and `updater_message` from the intent payload verbatim.
   - Copies `intent_signature` from the submitted intent.
   - Signs the canonical serialization of the complete `LogEntry` (excluding `press_signature`) with the press's ML-DSA-44 IPFS identity key → `press_signature`.

10. The press posts the new log entry to IPFS.

11. The press updates the on-chain registry pointer for the target card. This is a separate operation from step 9's signing and uses the press's other key (see `protocol-objects.md §1`'s "Press dual-key model" and `registry_contract.md §4.2`): the `LogEntry` itself was already signed end-to-end with the press's ML-DSA-44 IPFS identity key in step 9 (`press_signature`); the on-chain write is a distinct `UpdateCardHead` call authorized by the press's separate secp256r1 on-chain write-authorization key, verified by the registry contract via the RIP-7212 precompile. Concretely:
    - **Post to IPFS:** the CID from step 10 becomes `new_log_cid`.
    - **Call `UpdateCardHead`:** the press builds an `UpdateCardHeadPayload` (`card_address`, `prev_log_cid` = the CID of the log head read in step 9, `new_log_cid`, `press_address`, `sequence`, `timestamp`), signs `keccak256(payload_bytes)` with its secp256r1 key, and submits `UpdateCardHead(card_address, new_log_cid, payload_bytes, press_signature)` to the registry contract. The contract checks `prev_log_cid` against its stored `log_head_cid` before accepting the write (see Concurrency below).

### Phase 5: Notification and Confirmation

12. If `notify_holder` is `true` and the policy does not suppress notification for this code prefix:
    - The press sends an HTTPS notification to the holder's wallet service endpoint containing: the update code, the `updater_message` (if present), and the CID of the new log entry.
    - If the holder's wallet service endpoint is unreachable, the notification is dropped; the holder will discover the update on next poll.

13. The press sends a success confirmation to the updater via the submission channel.

---

## Sub-Card Directory Updates (Codes 510/511/512)

These codes are a special case of the 1xx–7xx field-update flow above (they use `field_updates`, not `revocation`), scoped to the `active_subcards` field on the **holder's own master card** (`protocol-objects.md §1.1`). They follow the same five phases as any other update, with these specifics:

- **Updater:** Always the master card's own holder — the `updater_card` in the `UpdateIntentPayload` is the target card itself, and `intent_signature` is produced with the holder's current master-card key. There is no cross-card scenario for these codes: an app or issuer cannot originate a 510/511/512 intent on a holder's behalf.
- **Code 510 (addition):** `field_updates` is `[{ "field": "active_subcards", "value": <full new array, with the new pubkey appended> }]`. If `active_subcards` is not yet present on the card, this entry both adds the field and sets its first element.
- **Code 511 (removal):** `field_updates` is `[{ "field": "active_subcards", "value": <full new array, with the removed pubkey deleted> }]`. A `note` explaining the removal (e.g., "device lost", "app uninstalled") is recommended but not required.
- **Code 512 (key rotation):** `field_updates` is `[{ "field": "active_subcards", "value": <full new array, with exactly one pubkey swapped for its replacement> }]` — a single atomic entry, not a paired 511+510.
- **Press validation (step 7):** In addition to the standard signature and freshness checks, the press MUST confirm the intent is signed by the target card's own holder key before posting (see Phase 3, step 7 above). No other authorization path is accepted for these three codes.
- **Verifier requirement:** Any verifier or press encountering a 510/511/512 entry not signed by the card's own holder key MUST reject it, independent of the card's governing policy. This is a MUST, not a SHOULD — see `card_validation.md`.
- **Sibling sub-card notification:** When a press accepts a 510 (addition), 511 (removal), or 512 (rotation) entry, it also notifies the holder's *other* active sub-cards of the change — `subcard_sibling_added`, `subcard_sibling_removed`, or `subcard_sibling_rotated` respectively (per `messaging_protocol.md §9`), so the holder's other devices/apps can detect unauthorized additions. This notification is best-effort and does not block or fail the underlying update. See `press.md §5.3` for the full mechanism (`diffActiveSubcards`/`notifySubcardSiblings`).

---

## Notes Array

A card's notes array is not stored as a mutable field. It is derived by verifiers and clients by fetching the current head `LogEntry` and, from its `history` array (`protocol-objects.md §3`), reading every predecessor object in the log — the head's own CID plus its full `history` gives the complete set of CIDs to fetch, all resolvable in a single round of parallel fetches rather than a sequential genesis-to-head walk — and collecting every entry whose intent payload contains a non-empty `note` field. The result is an ordered list of note objects, one per qualifying entry, in chronological order (readers sort by `timestamp` or by position in `history` once all entries are fetched, since fetching in parallel does not preserve chronological order on arrival).

Each entry in the derived notes array has the following shape:

```json
{
  "text":         "<the note string from UpdateIntentPayload.note>",
  "timestamp":    "<ISO 8601 — the intent timestamp from the same payload>",
  "updater_card": "<mutable pointer of the updater's card>",
  "log_entry_cid":"<IPFS CID of the LogEntry that carried this note>",
  "update_code":  <integer — the code from the same log entry>
}
```

Notes are immutable once posted — they are part of the signed log and cannot be edited or removed. A note may accompany any update code; the `update_code` field in the derived object lets readers understand the context in which the note was written (e.g., a 2xx commendation note vs. a 6xx concern note).

---

## Postconditions

- A new `LogEntry` is appended to the target card's IPFS log, chained via `prev_log_root`.
- The Arbitrum One registry entry for the target card points to the new log head.
- The updater's identity and intent signature are permanently recorded in the log entry.
- If the intent payload included a `note`, it is now part of the immutable log and will appear in the card's derived notes array, attributed to `updater_card` with the intent timestamp.
- If `notify_holder` was true, an HTTPS notification was sent to the holder's wallet service endpoint.
- Any verifier can obtain the card's current field state directly from the head `LogEntry`'s `card_state` field — no genesis-to-head walk is required (`protocol-objects.md §3`). Deriving the full notes array still requires visiting every entry in the log, but the head's `history` array (see Notes Array above) lets a reader fetch every predecessor CID in parallel from a single fetch of the head, rather than walking the chain sequentially.

---

## Concurrency

`UpdateIntentPayload` does not itself carry a `prev_log_root` — that field is assembled by the press at entry-assembly time (Phase 4, step 9), not supplied by the updater (`protocol-objects.md §4`). The race instead surfaces in one of two places when two update intents targeting the same card are processed concurrently and one is posted first:

- **Press-side staleness:** the press that processes the second intent may have fetched the target card's log head (step 6) before the first intent's entry was posted, so the head object it reads and the `prev_log_root`/`history`/`card_state` it assembles in step 9 are already stale by the time it attempts to post.
- **On-chain rejection:** even if the press's local view was current when it built the entry, the registry contract's `UpdateCardHead` precondition (`registry_contract.md §4.2` step 5) checks that the submitted `prev_log_cid` still matches the on-chain `log_head_cid` at call time. If the first intent's entry was registered on-chain in the interim, this check fails (`E-08`/`STALE_PREV_CID`) and the second press's write is rejected.

Either way, the press re-fetches the current log head and retries entry assembly against it (see `press.md §5.3 updateCardHeadOnChain` step 5, which retries once before returning `P-12`). If the underlying `field_updates`/`revocation` is still valid against the new head, the press resubmits automatically; if retried assembly still conflicts, the updater is notified to resubmit their original intent so the press can reassemble against the new head.

---

## Revocation Semantics

- **8xx (quiet revocation):** The card is revoked. Historical signatures before `effective_date` remain trusted. The revocation signals a change of state, not a retroactive claim that prior actions were invalid.
- **9xx (loud revocation):** The card is revoked. Things on or after `effective_date` are suspect or invalid; things before are trusted. Verifiers may notify issuers of other cards they have seen from the same holder — but this is a social protocol, not cryptographic.
- **Un-revocation:** The append-only log cannot remove a revocation entry. To restore standing, the authorizer issues a new **successor card** with a `supersedes` field pointing to the old card's mutable pointer and a `supersession_note` explaining the context.
- **Effective date backdating:** The `effective_date` in a revocation may be earlier than the posting date. If multiple revocation entries exist, the one with the earliest `effective_date` governs.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Intent timestamp too old or too far in the future | Updater resubmits with a fresh timestamp |
| Updater's card revoked with `effective_date` ≤ now | Updater is not eligible; must use a different authorized party |
| `update_policy` predicate not satisfied for one or more fields | Updater does not have authority; request must come from an authorized party |
| `revocation_permissions` not satisfied | Updater does not have revocation authority; requester must use an authorized party |
| Concurrent update race — press re-fetches a now-stale head at validation time, or the on-chain `prev_log_cid` check in `UpdateCardHead` fails (`E-08`/`STALE_PREV_CID`) | Press re-fetches the current log head and retries entry assembly (see Concurrency above); if still conflicting, updater resubmits their original intent |
| IPFS post fails | Press retries; does not write on-chain until IPFS CID is confirmed |

---

## Related Specs

- `policy_creation.md` — where `update_policy` and `revocation_permissions` are defined
- `card_offering_and_acceptance.md` — the issuance flow (genesis of the card being updated)
- `log_auditing.md` — how update entries are visible to auditors
- `card_protocol_spec.md §5` — full feature spec for updating cards
- `protocol-objects.md §3` — `LogEntry` object reference
- `protocol-objects.md §4` — `UpdateIntentPayload` object reference
- `update_codes.md` — full update code taxonomy
