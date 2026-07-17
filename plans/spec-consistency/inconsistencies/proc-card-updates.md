# Inconsistency Log — `proc-card-updates` (`specs/process_specs/card_updates.md`)

Reviewed against: `protocol-objects.md` (§1, §1.1, §3, §4 — read in full, including the 2026-07-16 `LogEntry` `card_state`/`history` redesign), `update_codes.md`, `registry_contract.md` (§3.1, §4.2, §4.3), `card_validation.md`, `policy_creation.md`, `log_auditing.md`, `notification_relay.md`, `card_migration.md`, `subcard_creation_policy.md`, `press.md` (§5.3 `processUpdateIntent` / `appendLogEntry`, already amended in Phase 1 for the same `LogEntry` redesign).

`card_updates.md` is dated 2026-05-25 and has **not** been updated for the 2026-07-16 `LogEntry` amendment described in `protocol-objects.md §3`. `press.md` (an in-scope Phase-1 object spec) **has** already been updated for that amendment. This means `card_updates.md` is now stale relative to both its own object-spec dependency and its sibling process-spec-adjacent object spec, not just relative to an abstract "new model." Findings below are ordered roughly by severity.

---

## Finding 1 — Postconditions directly contradict `card_state`'s stated purpose (HIGH)

- **card_updates.md, Postconditions:** "Any verifier can re-derive the complete current state of the card — including the full notes array — by reading the append-only log from the genesis document to the current head."
- **protocol-objects.md §3, `card_state` field description:** "Lets a reader learn a card's current values from the current head object alone, **with no need to fold `field_updates` across every entry in the log**."
- **protocol-objects.md §3 amendment note:** a `LogEntry` "reposts the card's complete current field state (`card_state`) ... rather than requiring a reader to walk `prev_log_root` backward one hop at a time to reconstruct current state."

These are opposite claims about the same operation. `card_updates.md` still describes current-state reconstruction as requiring a full genesis-to-head walk; `protocol-objects.md` says the whole point of `card_state` is that a single head fetch suffices for current field state. (The notes array is a partial exception — see Finding 4 — but the postcondition as written claims the *full* genesis walk is needed for *all* current state, which is no longer true for field values.)

**Recommended resolution:** Rewrite the Postconditions bullet to state that current field state is obtainable from the head `LogEntry`'s `card_state` alone (no walk required), while the derived notes array still requires visiting every entry (though `history` makes this a set of parallel fetches rather than a sequential backward walk — see Finding 4).

---

## Finding 2 — Phase 4 entry-assembly steps (9) omit `card_state`, `history`, and `entry_type` entirely (HIGH)

- **card_updates.md, step 9:** "The press assembles the complete `LogEntry`: Copies the intent payload verbatim. Adds `version` — the current log head's version plus one. Adds `prev_log_root` — the CID of the current log head. Signs the canonical serialization of the complete `LogEntry` (excluding `press_signature`) ... → `press_signature`."
- **protocol-objects.md §3:** `LogEntry` has three more required fields not mentioned in card_updates.md's assembly steps: `entry_type` ("Yes" — "present in all entries"), `card_state` ("Yes" — "the card's complete current field state ... with this entry's own `field_updates`/`revocation` already applied"), and `history` ("Yes" — ordered array of every predecessor CID).
- **press.md §5.3 `appendLogEntry`** (already fixed in Phase 1) spells out exactly the missing steps: fetch+decrypt the current head, derive `entry_type` from the code range, set `history` = current head's `history` + current head's own CID, set `card_state` = current head's field state with `field_updates` applied.

card_updates.md's step 9 describes assembling a `LogEntry` with only `version`, `prev_log_root`, and `press_signature` added to the intent — i.e., the pre-2026-07-16 model. It is missing three now-required fields and the precondition step (fetching/decrypting the current head) that producing them requires.

**Recommended resolution:** Rewrite step 9 to match `press.md §5.3`'s `appendLogEntry` steps: press fetches and decrypts the current head object first, then assembles `version`, `code`, `entry_type` (derived from code range), `prev_log_root`, `history` (prior head's `history` + prior head's own CID), `card_state` (prior head's field state with `field_updates` applied, or unchanged for revocations), `field_updates`/`revocation`, `notify_holder`, `updater_message`, `intent_signature`, then signs for `press_signature`.

---

## Finding 3 — Step 11 conflates the press's two distinct keys (MEDIUM)

- **card_updates.md, step 11:** "The press updates the Arbitrum One registry pointer for the target card to the CID of the new log entry, **signed with the press sub-card key**."
- **protocol-objects.md §1, "Press dual-key model"** (added in the same Phase-1 amendment round): a press card carries two independent keys — an ML-DSA-44 "IPFS identity key" used for `press_signature` on IPFS content, and a separate secp256r1 "on-chain write authorization key," verified via the RIP-7212 precompile on every `RegisterCard`/`UpdateCardHead` call, registered in `PressAuthorizations` (not on the `CardDocument`).
- **registry_contract.md §4.2 `UpdateCardHead`:** the on-chain call is authorized by a `secp256r1` signature (`press_signature bytes[64]`) verified against `PressAuthorizations[...].press_public_key` — a different signature and different key from the ML-DSA-44 `press_signature` that appears inside the `LogEntry` object itself (step 9).
- **press.md §5.3 `appendLogEntry`** correctly keeps these separate: step 5 signs the `LogEntry` with the press's ML-DSA-44 key; step 7 is a distinct call (`updateCardHeadOnChain`) using the on-chain (secp256r1) key.

Step 11's single phrase "signed with the press sub-card key" reads as if the same key/signature from step 9 is reused for the on-chain write. Given `protocol-objects.md` now explicitly documents these as two unrelated keys with different algorithms and different registration tables, this is a stale/ambiguous claim that should name both signing operations distinctly.

**Recommended resolution:** Split step 11 into "posts the `LogEntry` CID to IPFS (already signed per step 9, ML-DSA-44)" and "calls `UpdateCardHead` on Arbitrum One, authorized by the press's separate secp256r1 on-chain write key (verified via RIP-7212, per `registry_contract.md §4.2`)."

---

## Finding 4 — Notes Array section describes a sequential backward walk; `history` makes this a parallelizable single-head-fetch operation (MEDIUM)

- **card_updates.md, "Notes Array" section:** "It is derived by verifiers and clients by walking the append-only log from genesis to the current head and collecting every `LogEntry` whose intent payload contains a non-empty `note` field."
- **protocol-objects.md §3:** `history` is defined precisely so a reader can "reconstruct full provenance (every CID this card has ever had) from a single fetch of the current head, with no backward IPFS walk."

The notes array genuinely does still require visiting every entry (since `card_state` does not include a rolled-up notes array — notes are not a policy-defined or protocol-reserved field), so Finding 1's correction doesn't fully resolve this section. But the *mechanism* description is stale: with `history` available on the head, a reader fetches the head once, gets the full list of predecessor CIDs, and can fetch all of them in parallel — it does not need to "walk from genesis" hop-by-hop the way the pre-amendment design required. As written, this section still describes the old sequential-walk mechanism.

**Recommended resolution:** Update the Notes Array section to say the current head's `history` array (plus the head's own CID) gives the reader the complete list of entries to fetch (in parallel) when building the notes array, rather than describing a sequential backward walk.

---

## Finding 5 — Sub-card sibling notifications (press.md) are undocumented in card_updates.md's Phase 5 / Sub-Card Directory Updates section (LOW — gap, not contradiction)

- **press.md §5.3:** when a code-510/511/512 `LogEntry` is accepted, the press additionally sends `subcard_sibling_added` / `subcard_sibling_removed` / `subcard_sibling_rotated` notifications (per `messaging_protocol.md §9`) to the holder's *other* active subcards — a notification path distinct from the `notify_holder` HTTPS mechanism described in card_updates.md's Phase 5.
- **card_updates.md**, both in Phase 5 ("Notification and Confirmation") and in the "Sub-Card Directory Updates (Codes 510/511/512)" section, describes only the generic `notify_holder`/HTTPS-to-wallet-service notification. It never mentions the sibling-subcard alert behavior.

This isn't a contradiction (both can be true simultaneously) but it is a one-sided claim: press.md documents a notification behavior specific to 510/511/512 that card_updates.md — whose Sub-Card Directory Updates section is supposed to be the authoritative process description for those exact codes — omits entirely.

**Recommended resolution:** Add a note to the Sub-Card Directory Updates section cross-referencing the sibling-notification behavior in `press.md §5.3`, so the process spec for these codes is complete on its own.

---

## Finding 6 — Concurrency / Error Paths sections imply `UpdateIntentPayload` carries `prev_log_root`, but it doesn't (LOW — internal terminology inconsistency)

- **card_updates.md, "Concurrency" section:** "If two update intents are submitted concurrently and one is posted first, the second intent will reference a stale `prev_log_root` when the press validates."
- **card_updates.md, Error Paths table:** "`prev_log_root` is stale (concurrent update race) | Updater re-fetches current log head and resubmits."
- **card_updates.md's own Phase 1 step 2** (the `UpdateIntentPayload` JSON example) and **protocol-objects.md §4** (`UpdateIntentPayload` schema and the explicit note "The intent does **not** include `version` or `prev_log_root`") agree the updater's intent has no `prev_log_root` field at all — the updater doesn't reference a log root; only the press-assembled `LogEntry` does (step 9).

The Concurrency section's phrasing ("the intent will reference a stale `prev_log_root`") is inconsistent with the object both the updater signs and the same document's own Phase 1 payload example. The actual race is: the press fetches the current head at validation time (step 6) and assembles `prev_log_root` from it (step 9); the true optimistic-concurrency check happens on-chain in `UpdateCardHead` (`registry_contract.md §4.2`, step 5: `prev_log_cid` must match the stored `log_head_cid`). The updater never "references" `prev_log_root` — it simply resubmits and the press re-derives everything fresh.

**Recommended resolution:** Reword the Concurrency section and the Error Paths row to describe the race in terms of the press re-fetching a now-stale head / the on-chain `prev_log_cid` check failing, rather than implying the updater's intent carries a `prev_log_root` value that can go stale.

---

## Items checked with no inconsistency found

- **Update codes (1xx–9xx) and their authorization predicates** — card_updates.md's code-range table, the 8xx/9xx default `revocation_permissions` fallback (holder-or-issuer for 8xx, issuer-only for 9xx), and the 510/511/512 hardcoded-holder-only rule all match `update_codes.md` and `protocol-objects.md §1.1` exactly, including the "not policy-configurable" language.
- **Immutable-fields list** (step 7, "Immutable fields") — matches the protocol-required field list in `protocol-objects.md §1`; the carve-out for `successor`/`supersedes`/`supersession_note` as legitimately-post-issuance-settable fields is consistent with `protocol-objects.md §1` and §1.1.
- **Sub-card directory update authorization (510/511/512)** — card_updates.md's requirement that the press "MUST confirm the intent is signed by the target card's own holder key" and reject otherwise matches `protocol-objects.md §1.1`, `card_validation.md` (Stage 2, step 9's note on rejecting improperly-signed 510/511/512 entries), and `press.md §5.3` step 4 (`P-23`/`P-13` rejections) precisely, including the "MUST, not SHOULD" framing.
- **Revocation semantics (8xx quiet / 9xx loud, effective-date backdating, earliest-`effective_date`-governs rule)** — matches `update_codes.md`'s Historical Signature Semantics table and `card_validation.md` Stage 4 verbatim.
- **`policy_creation.md`** references `card_updates.md` correctly for how `approved_presses`/auditor field updates are performed (step 12; also referenced from `log_auditing.md`'s auditor-add/remove triggers) — no contradiction; card_updates.md's generic field-update flow (codes 1xx-7xx via `update_policy` predicates) is a sufficient mechanism for both.
- **`registry_contract.md §4.2` `UpdateCardHead`** note that "the contract does not distinguish between update codes... both use `UpdateCardHead`" is consistent with card_updates.md treating both field updates and revocations as producing a new log head via the same posting mechanism.
- **`card_migration.md`** and **`notification_relay.md`** have no direct structural dependency on card_updates.md's internal object shapes; no contradictions found (notification_relay.md's holder-notification path is a different, device/UUID-level mechanism than the wallet-service-endpoint notification described in card_updates.md Phase 5, and the two don't conflict — card_updates.md's press-to-wallet-service HTTPS notification is upstream of notification_relay.md's wallet-to-device fan-out).

---

## Summary

Six findings, two high-severity (Findings 1–2) both stemming directly from the task's central question: **card_updates.md has not been updated for the `LogEntry` `card_state`/`history` redesign** and still describes the old diff-only/backward-walk model in its entry-assembly steps and its postconditions. `press.md` (Phase 1, already fixed) demonstrates the corrected version of the same assembly logic almost step-for-step, which should make Step C straightforward: card_updates.md's Phase 4 and Postconditions sections can be brought in line by mirroring `press.md §5.3`'s already-updated `appendLogEntry` procedure.
