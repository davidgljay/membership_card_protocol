# Inconsistency log — `proc-matrix-membership` (`specs/process_specs/matrix_room_membership.md`)

Reviewed against: `specs/process_specs/matrix_join_attestation_and_revocation.md` (primary cross-check, per task instructions), `specs/object_specs/matrix_synapse_module.md`, `specs/object_specs/matrix_encryption.md`, `specs/object_specs/matrix_room.md`, `specs/object_specs/registry_contract.md`.

Scope note: this is a read-only Step A review. No fixes applied here.

---

## Finding 1 — `matrix_room_membership.md §2` step 1 was never corrected, only flagged in the header note (load-bearing, not stylistic)

**Where:** `specs/process_specs/matrix_room_membership.md` §2 "Post Sequence," step 1 (line 37): *"Steps 1–6 above, identical, re-run for the posting card on every message."*

**Conflict:** The document's own 2026-07-11 amendment note (lines 8) explicitly says this exact phrasing is stale: *"§2 (Post Sequence) below is also partially superseded, not just historical: its 'Steps 1–6 above, identical' phrasing assumed the old step 2 ... still applied to posts the same way it applied to joins. It doesn't."* But the body text of §2 itself (the thing a reader actually executes) was **never edited to say so** — it still literally instructs re-running "Steps 1–6" verbatim, which includes the now-defunct step 2 (wallet-service card-binding resolver call). The correct behavior, per `matrix_join_attestation_and_revocation.md §2a`, is: look up `card_hash` from the persistent membership registry keyed by `(room_id, event.sender)` — no wallet-service call, no re-verification of the join attestation, and (implicitly) no re-run of the join sequence's steps 1-2 at all, since there is no attestation to check on a post.

A reader who reads §2 in isolation (a very likely path — it's the section that literally defines the post sequence) gets the wrong instruction unless they also carry forward the header's prose caveat. This is exactly the kind of "superseded framing leaves stale content elsewhere" case the task asked to check for.

**Recommendation:** Edit §2 step 1's body text directly (not just the header note) to say something like: *"Steps 3–6 above (chain-walk, predicate fetch, evaluate, allow/deny), re-run for the posting card on every message. Step 2 (`card_hash` resolution) is replaced for posts by a membership-registry lookup keyed by `(room_id, event.sender)` — see `matrix_join_attestation_and_revocation.md §2a` — not a re-run of the join-time attestation check."* The header note should point at this corrected text rather than being the only place the correction lives.

---

## Finding 2 — Superseded sections in `matrix_room_membership.md` use two different conventions, and the non-struck-through ones read as normative on a skim

**Where:** `specs/process_specs/matrix_room_membership.md` §1 step 2 (line 27) and §3 in full (lines 43–60).

**Conflict:** The document marks superseded content two different ways:
- §4's wallet-service failure row (line 68) and the Summary checklist's wallet-service bullet (line 95) use `~~strikethrough~~` — visually unambiguous even on a skim.
- §1 step 2 and all of §3 instead use a bold `**[Superseded 2026-07-11 — see ...]**` tag immediately followed by full, un-struck prose describing the old mechanism in plain declarative sentences ("Resolve the joining card's hash via a private lookup...", "Default TTL: 60 seconds...", "Cache key: `card_hash`..."). Nothing about the visual formatting of that prose distinguishes it from current, authoritative spec text once a reader's eye moves past the bracketed tag at the start of the line/section.

This isn't a factual contradiction between documents, but it is exactly the "stale content left elsewhere" risk the task asked to confirm is absent — it isn't fully absent. A reader skimming for "what's the TTL" or "how does the module resolve `card_hash`" can land on §1 step 2 or §3 and walk away with the pre-2026-07-11 (now-wrong) design, because the superseding tag is easy to skip past and the paragraph structure below it reads like normal spec prose.

**Recommendation:** Either strike through the full superseded body text in §1 step 2 and §3 (matching the convention already used in §4 and the checklist), or replace their bodies with a short "see companion doc" pointer instead of retaining the full original prose. Pick one convention and apply it consistently across all four superseded locations in this document.

---

## Finding 3 — `matrix_join_attestation_and_revocation.md §2`'s own header is stale relative to its later-resolved wire-transport decision (internal self-consistency issue in the doc this unit defers to)

**Where:** `specs/process_specs/matrix_join_attestation_and_revocation.md` §2 "Revised Join Sequence" (line 58): *"Triggered the same way as before — Synapse's `user_may_join_room` callback — but step 2 no longer calls out to `wallet-service`."*

**Conflict:** This directly contradicts the same document's own §1 "Wire transport — resolved 2026-07-12" note (line 52) and `matrix_synapse_module.md`'s explicit, updated callback description: `user_may_join_room` is now **always a permissive no-op** (it structurally cannot see the join attestation, since its signature carries no request content), and real join authorization runs inside `check_event_for_spam` on the `m.room.member` join event instead. `matrix_synapse_module.md` states this plainly: *"This runs instead of `user_may_join_room`, not in addition to any real check there."*

§2's opening sentence appears to be a leftover from the 0.1 draft (dated 2026-07-11, before the 2026-07-12 wire-transport resolution) that was never updated when the wire-transport decision landed later in the same document. Since `matrix_room_membership.md §1`'s own trigger description ("Synapse's room-join module callback (exact callback name confirmed in `matrix_synapse_module.md`)") is generic enough to not itself be wrong, this doesn't break my unit directly — but because my unit's task explicitly asks me to confirm this companion document's superseded/resolved framing is fully self-consistent, this is a real finding: the document that supersedes part of my unit is not itself internally consistent about which callback does the work it describes.

**Recommendation:** Update `matrix_join_attestation_and_revocation.md §2`'s opening line to say the join sequence is now triggered via `check_event_for_spam` observing an `m.room.member` join event (per §1's resolved wire-transport note), not `user_may_join_room`, and note that `user_may_join_room` remains registered only as a required-but-inert no-op.

---

## Finding 4 — `matrix_room_membership.md`'s Summary checklist doesn't reflect the new failure modes introduced by the superseding document (completeness gap, not a hard contradiction)

**Where:** `specs/process_specs/matrix_room_membership.md`, "Summary: Deny-by-Default Coverage Checklist" (lines 93–102).

**Conflict:** The checklist strikes the old wallet-service-resolver line and points to `matrix_join_attestation_and_revocation.md §3.3`'s replacement rows, but it doesn't add checklist entries for the new failure modes that document introduces: `"attestation_invalid"`, `"membership_not_registered"`, and the encrypted-registry-unreadable-at-startup case. The checklist's title claims to be "Deny-by-Default Coverage" for this subsystem, but as written it only fully covers the pre-2026-07-11 failure surface plus a pointer to the old one being superseded — it doesn't positively enumerate the current full set the way it does for RPC/IPFS/malformed-data failures.

This is minor (the pointer to §3.3 does exist), but it means no single checklist in either document gives a reader the complete, current "everything that must deny" list in one place.

**Recommendation:** Either add the new failure-mode bullets to this checklist (mirroring `matrix_join_attestation_and_revocation.md §3.3`'s table), or replace the whole checklist with a note that the authoritative, current deny-by-default list lives in `matrix_join_attestation_and_revocation.md §3.3` and this document's checklist only covers the failure modes that section doesn't touch (RPC/IPFS/malformed-data/evaluator-error rows).

---

## Non-findings (checked, no conflict)

- `verifyMatrixUserIdBinding` call signature and semantics are used identically across `matrix_room_membership.md §5`, `matrix_encryption.md §3–4`, and `matrix_join_attestation_and_revocation.md §2` step 4 — `(candidate_card_hash, matrix_user_id, server_name) → bool`, forward-only, no inverse. No drift found.
- `matrix_room_membership.md §4`'s non-wallet-service failure rows (RPC unreachable, IPFS timeout, malformed chain, malformed predicate document, evaluator error) are correctly carried forward unchanged and referenced as such by `matrix_join_attestation_and_revocation.md §3.3` ("Unchanged from `matrix_room_membership.md §4`").
- `matrix_room_membership.md §5` (Per-Room Card Binding, client-side sender-binding enforcement) is unaffected by the join-attestation/event-driven-revocation redesign and remains consistent with `matrix_encryption.md §4`'s worked example and enforcement-boundary language.
- `registry_contract.md`'s OQ-6 is marked resolved and correctly cross-references `matrix_join_attestation_and_revocation.md §3` for the watcher design — no stale open-question language left behind.
- No other in-scope process or object spec (`protocol-objects.md`, `room_discovery.md`, or any other process spec) references the now-removed wallet-service card-binding resolver or the 60-second TTL cache as if still current — grep across the spec tree found no additional stale references beyond the two documents already discussed above.
