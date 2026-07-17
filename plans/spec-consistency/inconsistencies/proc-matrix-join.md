# Inconsistency Log — `proc-matrix-join`

**Unit:** `specs/process_specs/matrix_join_attestation_and_revocation.md`
**Reviewed against:** `matrix_room_membership.md`, `matrix_room.md`, `matrix_encryption.md`, `matrix_synapse_module.md`, `room_discovery.md`, `registry_contract.md`, `card_validation.md`, `card_updates.md`, `messaging_protocol.md`.

Overall the document is in good shape and its central claims (join-attestation replacing the wallet-service resolver, event-driven revocation replacing the TTL cache, the persisted encrypted membership registry, the `m.room.power_levels`/`m.room.encryption` room-creation requirements) are corroborated consistently across every sibling Matrix spec. `matrix_room.md`'s Phase 1 fix (adding `m.room.power_levels` granting kick power to `enforcement_matrix_user_id`, and `m.room.encryption` at room creation) matches this document's §3.1 "Force-part mechanism" note and Module Config Schema's `enforcement_matrix_user_id` entry exactly — no gap there. Findings below are the specific contradictions/gaps found.

---

## 1. §2's own header contradicts §1's 2026-07-12 wire-transport resolution (and `matrix_synapse_module.md`) — stale reference within the same document

**Where:** `matrix_join_attestation_and_revocation.md §2`, header line: *"Triggered the same way as before — Synapse's `user_may_join_room` callback — but step 2 no longer calls out to `wallet-service`."*

**Conflicts with:**
- This same document's own §1 "Wire transport — resolved 2026-07-12" paragraph, which states plainly: *"`user_may_join_room` becomes a permissive no-op (it structurally cannot see the attestation), and the actual authorization runs inside `check_event_for_spam`..."*
- `matrix_synapse_module.md §"user_may_join_room — always a permissive no-op (resolved 2026-07-12)"`: *"This callback structurally cannot authorize a card-gated join and always returns `NOT_SPAM`."* And under `check_event_for_spam`: *"Join authorization (new 2026-07-12 ...) ... This runs *instead of* `user_may_join_room`, not in addition to any real check there."*

**Description:** §2's join-sequence steps (1–8) are the current, correct sequence of checks — but the sentence introducing them still says the whole sequence is "triggered by `user_may_join_room`," which is exactly the design that was superseded by the 2026-07-12 wire-transport resolution documented three paragraphs earlier in the same file. This reads as leftover text from before the wire-transport question was resolved, never updated to match. A reader who only skims §2 (rather than cross-referencing §1's resolution note or `matrix_synapse_module.md`) would come away with the wrong mental model of which Synapse callback does the work.

**Recommended resolution:** Reword §2's header to something like: *"Triggered by Synapse's `check_event_for_spam` callback observing an `m.room.member` event with `content.membership == "join"` in a card-gated room (§1's wire-transport resolution) — but no longer calls out to `wallet-service`."* Also update the "Creator auto-join" paragraph immediately below §2 (which says "`matrix_synapse_module.md`'s existing note that `user_may_join_room` isn't invoked for a room creator's own auto-join still applies") to name `check_event_for_spam` as the callback that matters post-2026-07-12, since that's the callback actually responsible for join authorization now, and it's also skipped for creator auto-join per `matrix_synapse_module.md`'s "Known limitation" note.

---

## 2. Spec gap: server-administrator joins have no defined membership-registry treatment

**Where:** `matrix_join_attestation_and_revocation.md §2` "Creator auto-join" paragraph, and §2a.

**Description:** `matrix_synapse_module.md`'s "Known limitation" note states: *"neither callback is invoked for joins performed by a server administrator, or in the context of room creation."* This document's §2 addresses the room-creation/creator-auto-join case explicitly (the room-creation code path must register the creator's membership directly, since `check_event_for_spam` never fires for it). It says nothing about the sibling case Synapse's own docs call out in the same sentence — a server administrator joining a card-gated room by admin fiat (not room creation). Under §2a's rule ("If not found: deny... a room member could lack a registry entry [if] they were never validly joined by this module"), an admin-joined account would have no membership-registry entry and would therefore have every subsequent post denied with `membership_not_registered` — but nothing says whether that's the intended outcome, whether admin joins should be blocked entirely, or whether some other registration path is expected for them. This is a genuine spec gap, not just an edge case to infer from context, per the task's "process X has no spec for lifecycle stage Y" standard.

**Recommended resolution:** Add an explicit rule to §2 or §2a settling what happens for a non-creator admin-performed join: either (a) state that this deployment's operational posture disallows admin-forced joins into card-gated rooms (and note this as an operator constraint), or (b) specify that such a join, lacking a registry entry, is treated identically to any other unregistered member — denied on next post — and that this is accepted, deliberate behavior rather than an oversight.

---

## 3. Minor citation imprecision: post-time resolution is attributed to a superseded section

**Where:** `matrix_synapse_module.md §"check_event_for_spam"`: *"For a **post** (`m.room.message`) in a card-gated room, the module runs the post sequence from `matrix_room_membership.md §2` (resolve `card_hash` from the membership registry — no fresh attestation ...)."*

**Description:** The behavior described in the parenthetical — "resolve `card_hash` from the membership registry, no fresh attestation" — is specifically defined by `matrix_join_attestation_and_revocation.md §2a` ("Post-Time Identity Resolution"), not by `matrix_room_membership.md §2`. `matrix_room_membership.md §2` is the document that originally assumed a re-resolvable `card_hash` lookup per post, and is explicitly called out by `matrix_room_membership.md`'s own amendment note as "partially superseded, not just historical" precisely because it doesn't describe the membership-registry mechanism. Citing `matrix_room_membership.md §2` alone for behavior that only exists because of this document's §2a risks sending a reader to the wrong (superseded) section for the authoritative description.

**Recommended resolution:** Update `matrix_synapse_module.md`'s citation to read `matrix_room_membership.md §2 (structure), as superseded by matrix_join_attestation_and_revocation.md §2a (actual resolution mechanism)` or simply cite `§2a` directly alongside/instead of `matrix_room_membership.md §2`.

---

## 4. Document metadata (version/date header) not updated to reflect its own 2026-07-12 content

**Where:** `matrix_join_attestation_and_revocation.md`'s header: `**Version:** 0.1 (draft)` / `**Date:** 2026-07-11`.

**Description:** The document body contains three items explicitly dated and resolved **2026-07-12** (the join-attestation wire transport in §1, the force-part mechanism in §3.1, and the corresponding Open Questions entries) — one day after the document's own stated `Date`. Sibling documents that received comparable revisions (`matrix_room.md`, `matrix_encryption.md`, `matrix_synapse_module.md`) all carry an "amended 2026-07-11" (or later) marker in their version header reflecting the revision. This document's header wasn't bumped to reflect its own 2026-07-12 changes, which is a minor internal staleness/metadata inconsistency — someone scanning only the header for "how current is this doc" would miss that it contains next-day content.

**Recommended resolution:** Update the header to `**Version:** 0.2 (draft, amended 2026-07-12)` / add an "Amended 2026-07-12" note summarizing the wire-transport and force-part resolutions, matching the convention used in `matrix_room.md` / `matrix_synapse_module.md`.

---

## Non-findings worth recording (checked, no conflict)

To save duplicate work in Step B, these specific cross-checks were made and found consistent — not restating them as findings:

- `matrix_room.md` Room Creation's `m.room.power_levels`/`m.room.encryption` additions (Phase 1 fix) match this document's §3.1 force-part note and Module Config Schema's `enforcement_matrix_user_id` entry.
- `registry_contract.md §7`'s `CardHeadUpdated` event fields (`card_address`, `prev_log_cid`, `new_log_cid`, `press_address`, `timestamp`) match this document's §3.1 watcher description and its use of `new_log_cid`.
- `registry_contract.md §4.2`'s note ("the contract does not distinguish revocations from ordinary updates... determined by verifiers reading the log from IPFS") matches this document's §1/§3.1 characterization.
- `card_validation.md` Stage 3/Stage 4 chain-walk and revocation-check mechanics match this document's §2 step 5 and §3.2 watch-set construction (full chain, not just leaf).
- `card_updates.md`'s 8xx ("quiet") / 9xx ("loud") revocation semantics match this document's §3.1 uniform-force-part treatment and its stated rationale.
- `matrix_encryption.md §3`/§4's `verifyMatrixUserIdBinding` signature and semantics match this document's §1/§2 usage.
- `room_discovery.md`'s framing ("actually joining still requires the join attestation flow") correctly defers to this document and introduces no conflicting claim about join mechanics.
- `matrix_synapse_module.md`'s Module Config Schema (`join_attestation_freshness_seconds`, `watcher_backstop_interval_seconds`, `membership_registry_path`, `membership_registry_key_path`, `enforcement_matrix_user_id`) all match fields/behaviors this document specifies or requires.
- The membership-registry row shape — `(room_id, matrix_user_id, card_hash, joined_at)` per this document's §2a vs. `(room_id, matrix_user_id) → card_hash` per `matrix_synapse_module.md`'s `membership_registry.py` comment — is consistent (the latter is an abbreviated gloss of the former, not a conflicting shape).
