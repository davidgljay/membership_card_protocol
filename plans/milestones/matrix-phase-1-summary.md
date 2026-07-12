# Matrix Phase 1 — Milestone Summary

**Completed:** 2026-07-10; restructured 2026-07-11 (join-attestation redesign, room discovery added, in a separate thread); reviewed for consistency 2026-07-11 (this pass); membership-registry persistence decided 2026-07-11 (same day, following the review) — see Revision Log below for full history.
**Status:** Done, six documents, no open decisions remaining from this phase

## What was built

Six spec documents, per `plans/matrix-implementation-plan.md` Steps 1–4c:

**Step 1 — `specs/object_specs/matrix_room.md`.** The room predicate document (IPFS-addressed `policy_id`): a fixed `policies` list, each entry a pinned CID or a mutable-pointer reference resolved once at authoring time (never live), optionally refined by a `field_match` regex. `m.card.policy` state event, `POST /matrix/rooms` shape, and the "what the Synapse operator can see" table.

**Step 2 — `specs/process_specs/matrix_room_membership.md`.** Join/post sequences and deny-by-default failure handling. **Its original join-resolution mechanism (§1 step 2, a wallet-service card-binding query) and its TTL cache (§3) are superseded by Step 4b's output** (below) — the file is kept for its still-current parts (§2's post re-evaluation requirement, §5's per-room card binding) with an in-place changelog note pointing to what replaced the rest.

**Step 3 — `specs/object_specs/matrix_synapse_module.md`.** Confirmed real, current Synapse callback names (`check_event_for_spam`/`user_may_join_room`, not the deprecated/experimental `check_event_allowed` the plan originally assumed). Module config schema and package layout, **updated 2026-07-11** to drop the (now-removed) wallet-service resolver config and add the watcher's config and files.

**Step 4 — `specs/object_specs/matrix_encryption.md`.** Megolm confirmation, card-signature envelope, and the shadow-account derivation as a **one-way cryptographic commitment** (not a reversible encoding) — `verifyMatrixUserIdBinding` is the only forward-verification primitive, with no general inverse. This primitive is what both the sender-binding check (§4) and the newer join-attestation mechanism (Step 4b) build on.

**Step 4b — `specs/process_specs/matrix_join_attestation_and_revocation.md` (added 2026-07-11, in a separate thread).** Two mechanism changes: (1) join authorization now uses a **client-presented signed attestation**, verified via `verifyMatrixUserIdBinding`, instead of a live query to a wallet-service card-binding resolver — that resolver is removed from scope entirely; (2) revocation detection is **event-driven** (a persistent subscription to the registry contract's `CardHeadUpdated`, with an hourly backstop re-walk), replacing the 60-second TTL cache, and **every** detected revocation (8xx or 9xx, no distinction) triggers an **immediate force-part**, not just a future-post denial — because a revoked-but-not-removed account would otherwise keep receiving Megolm session keys and keep reading the room.

**Step 4c — `specs/process_specs/room_discovery.md` (added 2026-07-11, in a separate thread).** A card holder can learn which rooms their card qualifies for via a public, unauthenticated room index (`{room_id, policy_id}` pairs) plus a client-side function that evaluates the card's own chain against each listed room's predicate document — no server ever needs to see the card's identity to answer this by default. A server-hosted convenience endpoint exists as an explicitly-flagged secondary path (session-authenticated, no persistent query log).

## This Review's Findings and Fixes (2026-07-11)

The 2026-07-11 restructuring (Step 4b/4c) was thorough about the join path but left one real gap and several stale cross-references from the pre-restructuring documents. Found and fixed during this pass:

1. **Real gap: no specified mechanism for post-time identity resolution.** The join attestation is presented once, at join time. Nothing said how `check_event_for_spam` (the post hook) learns `card_hash` for an already-joined member's *subsequent* messages, now that the wallet-service resolver it used to call for this is gone. As written, the post hook had no way to identify the poster. **Fixed:** added `matrix_join_attestation_and_revocation.md §2a` — the module's membership registry (already required by Step 12a for watch-set reference counting) is reused to carry the join-verified `card_hash` forward for every subsequent post; a registry miss is a hard deny (`"membership_not_registered"`), never a fallback. This also surfaced a genuine open question, not previously visible as a decision point: **if the registry is in-memory only, a Synapse/module restart wipes every current membership's association, forcing every active room member to rejoin before they can post again.** Flagged as a new Clarification Checkpoint before Step 12a, not resolved by this review.
2. **Stale text in `matrix_encryption.md §3`** still described the module resolving discovery via "a private, internal-only lookup" to `wallet-service` — exactly the mechanism Step 4b removed. Corrected to describe the current attestation-based flow and the (now stronger) "honest limit" framing: Synapse never queries `wallet-service` at authorization time at all anymore, not just via a private channel.
3. **Stale text in `matrix_room.md`'s operator-visibility table** (room membership row) had the same claim. Corrected.
4. **Clerical error in the implementation plan's own Phase 1 Milestone Review checklist**, unrelated to the spec docs themselves: it referenced "Step 17a's client-side function" for room discovery — Step 17a is the join-attestation signing step; the discovery function is Step 16b. Corrected in `matrix-implementation-plan.md`.
5. Implementation plan Step 12 and Step 12a updated to reflect the §2a fix (post-hook resolution mechanism, registry persistence as an explicit open decision).

## Consistency Check (this pass)

- **Predicate grammar:** all six documents point to the same `card_protocol_spec.md §The Predicate System` grammar; no reintroduction of `raw_notes/matrix.md`'s ad hoc rules format.
- **Shadow-account derivation:** `matrix_encryption.md §3` remains the single source of truth for the one-way commitment and `verifyMatrixUserIdBinding`. After this pass's fixes, `matrix_room.md`, `matrix_synapse_module.md`, and `matrix_join_attestation_and_revocation.md` all correctly describe zero runtime queries to `wallet-service` for authorization — none restate or diverge from the derivation formula.
- **Deny-by-default coverage:** `matrix_room_membership.md §4` (non-superseded rows) plus `matrix_join_attestation_and_revocation.md §3.3` (attestation validity, WS subscription gaps, backstop discrepancies, force-part API failure, RPC/IPFS, and — new from this review — the membership-registry-miss case) together cover every external dependency across both the Synapse module and the watcher, including both HTTP and WS RPC and Synapse's own admin API for force-part.
- **Synapse callback names:** `check_event_for_spam`/`user_may_join_room` confirmed live; the implementation plan's Step 12 text is now corrected to match (it originally still named the deprecated `check_event_allowed`).
- **Room discovery index shape:** consistent between `room_discovery.md §1`, the write side (Step 16), and both read sides (Step 16a's endpoint, Step 16b's client function).

## Membership Registry Persistence — Decided (2026-07-11, same day as the review)

The open question this review surfaced (§Findings item 1) is resolved: **the membership registry is persisted, encrypted at rest** — a local encrypted file (SQLite or equivalent) on its own volume, keyed by `(room_id, matrix_user_id) → card_hash`, encryption key managed through the same secrets-backend pattern as every other credential in this deployment (Step 7's pattern, reused via new Step 7c). Startup reconciles against Synapse's live membership list; a gap (file loss, corruption) denies only the specific affected member's posts, not the whole room. Specified in `matrix_join_attestation_and_revocation.md §2a`, with matching config (`membership_registry_path`) and package layout (`membership_registry.py`) added to `matrix_synapse_module.md`, and Steps 5c/7c/12a/21 updated in the implementation plan.

**Broader observation this decision prompted (David):** encrypting this registry at rest is real mitigation against passive/incidental exposure (a stolen disk snapshot, a misconfigured backup) — but it cannot, and doesn't try to, protect this data from whoever operates the live Synapse instance holding the decryption key. A card-gated Matrix deployment now durably accumulates real sensitive server-side metadata beyond message ciphertext (this registry), a scope `matrix-strategic-plan.md`'s Goal 4 didn't originally account for. This has been recorded as a second 2026-07-11 amendment to Goal 4: the protocol's actual privacy property for this kind of data is "protected from casual/passive third-party exposure," not "invisible to the operator of the instance holding it" — a party that wants the latter needs to run (or fully control) their own Synapse instance. This is a trust-model statement, not a new technical requirement, and should inform Step 21's runbook and any future federation follow-on plan.

## Notes for Phase 2 and beyond

- The 60-second card-cache-TTL assumption from the original Phase 1 pass is now moot — superseded entirely by the event-driven watcher model. The plan's checkpoint before Phase 3, Step 9 has been rewritten accordingly (confirm the watcher backstop interval and force-part-on-every-revocation instead).
- `wallet-service`'s runtime role in the Matrix subsystem is now minimal by design: shadow-account provisioning (once, at first use) and room creation. It is not queried by the Synapse module at join or post time under the current (2026-07-11) design — a stronger confidentiality/decoupling property than the original Phase 1 pass achieved, arrived at through two rounds of design discussion (see Revision Log).
- Where the one-time mutable-pointer-to-CID resolution for a `ref_type: "pointer"` room-policy entry actually happens (which component, at what point in room/document creation) remains an open item in `matrix_room.md`, unaffected by this review.

## Revision Log

**2026-07-10, design discussion (three revisions before Phase 2 began):**
1. **Federation question.** Room policy content lives on IPFS for content-addressed pinning and independent verifiability, not because Matrix federation needs it to propagate `m.card.policy` — Matrix's own room-state federation already does that, the same as `m.room.name`.
2. **Predicate schema.** Replaced an arbitrary predicate tree with a fixed `policies` list (pinned-CID or authoring-time-resolved-pointer entries, each with an optional field-match). An intermediate design that let pointer entries re-resolve *live* at every evaluation was corrected to resolve **once, at authoring time** — matching how `policy_id` pins everywhere else in the protocol.
3. **Shadow-account exposure.** Replaced a directly-reversible Matrix ID encoding (`hex(card_hash)` in the username, readable by any room participant or federated peer) with a one-way cryptographic commitment. At that point, the module still resolved join/post identity via a private `wallet-service` query.

**2026-07-11, separate thread — join-attestation and revocation redesign, plus room discovery:** Replaced the wallet-service resolver query entirely with a client-presented signed attestation (removing a live cross-service dependency at authorization time), replaced the 60-second TTL revocation cache with an event-driven watcher that force-parts on every detected revocation, and added card-based room discovery as new scope (Goal 6). Two new spec documents (`matrix_join_attestation_and_revocation.md`, `room_discovery.md`); `matrix_room.md` and `matrix_synapse_module.md` amended in place.

**2026-07-11, this review:** Found and fixed the post-time identity resolution gap (§2a addition), stale wallet-service-resolver references in `matrix_encryption.md` and `matrix_room.md` left over from before the join-attestation redesign, and a clerical step-number error in the implementation plan's own milestone checklist. See "This Review's Findings and Fixes" above.

**2026-07-11, later the same day — persistence decision.** David decided the membership registry must be encrypted and persisted, not ephemeral, and flagged the broader implication: this protocol is accumulating real server-side sensitive metadata beyond message content, and an operator's ability to protect it is now a meaningful part of the trust story, not a solved problem. See "Membership Registry Persistence — Decided" above and the second Goal 4 amendment in `matrix-strategic-plan.md`.

## Checkpoint

Per the implementation plan: **pause here and present all six Phase 1 documents to David for review before any Phase 2 (container/infrastructure) work begins.** No open decisions remain from this phase.
