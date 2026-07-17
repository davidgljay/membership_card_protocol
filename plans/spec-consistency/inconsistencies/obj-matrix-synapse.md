# Inconsistency Review — `obj-matrix-synapse` (`specs/object_specs/matrix_synapse_module.md`)

**Reviewed against:** every other object spec in scope and every process spec in scope, with tight focus on the Matrix cluster (`matrix_encryption.md`, `matrix_room.md`) and the process specs `matrix_join_attestation_and_revocation.md`, `matrix_room_membership.md`, `room_discovery.md`.

**Overall assessment:** This spec set is unusually well cross-checked already — most of the obvious failure modes (stale wallet-service resolver dependency, TTL-cache vs. event-driven revocation, wire-transport for the join attestation, force-part mechanism) have explicit "superseded"/"resolved" annotations pointing at the document that changed them, and field names/types (`chain_reaches_trusted_root`, `revocation.status`, `ancestry_pubkeys`, `CardHeadUpdated`, `LogicUpgradeConfirmed`, the predicate grammar) all check out consistently against `card_verifier.md`, `registry_contract.md`, and `card_validation.md`. I found no contradictions in the core lifecycle logic (join/post/revocation flows agree across all three documents that describe them). The findings below are narrower: one real cross-reference gap where a cited section doesn't contain what it's cited for, and two documentation-hygiene gaps (stale companion-doc headers, one stale checklist line) that don't change behavior but would mislead a reader following the citations.

---

## Finding 1 — `matrix_room.md`'s Room Creation section doesn't contain the power-level grant that two other documents cite it for

**Conflicting specs:** `specs/object_specs/matrix_synapse_module.md` (§Module Config Schema, `enforcement_matrix_user_id` row) and `specs/process_specs/matrix_join_attestation_and_revocation.md` (§3.1) **vs.** `specs/object_specs/matrix_room.md` (§Room Creation: `POST /matrix/rooms`).

**The conflict:**

- `matrix_synapse_module.md`, describing `enforcement_matrix_user_id`:
  > "This account instead needs kick-level power in every card-gated room, granted at room creation (`matrix_room.md §Room Creation`'s `m.room.power_levels` initial state, Step 16) — a permission grant, not a credential to protect."

- `matrix_join_attestation_and_revocation.md` §3.1:
  > "`update_room_membership` still enforces ordinary Matrix power-level auth on `sender`, so a dedicated enforcement account (not a card-holder's own shadow account) must be granted kick-level power in every card-gated room's initial `m.room.power_levels` at creation time — a new requirement on the room-creation endpoint, not something this watcher can retrofit after the fact."

- But `matrix_room.md`'s actual "Room Creation: `POST /matrix/rooms`" section specifies only:
  - Request: `card_hash`, `policy_id`, `name` (optional), `topic` (optional)
  - Response: `room_id`, `matrix_alias` (optional)

  There is no mention anywhere in `matrix_room.md` of an `m.room.power_levels` initial-state event, a kick-level grant, or the enforcement account at all. Grepping the file confirms zero occurrences of "power_levels", "kick", or "enforcement".

**Why this matters:** two documents describe this power-level grant as a *hard requirement* on the room-creation endpoint ("a new requirement... not something this watcher can retrofit after the fact"), but the document that is supposed to own the room-creation API contract doesn't specify it. A Phase 3 implementer reading only `matrix_room.md` would build `POST /matrix/rooms` without the grant; a Phase 3 implementer reading only the other two documents would assume it's already specified elsewhere and not add it either.

**Recommended resolution:** Add a paragraph (or a line item) to `matrix_room.md`'s Room Creation section describing the room's initial `m.room.power_levels` state event, specifically that it must grant kick-level power (or whatever the exact power-level threshold `update_room_membership`'s force-part requires) to the Matrix user ID configured as `enforcement_matrix_user_id` (`matrix_synapse_module.md`), alongside the existing `m.room.name`/`m.room.topic` state events the section already describes as being set at creation. This makes `matrix_room.md` the actual source of truth the other two documents already claim it is.

---

## Finding 2 — Stale/incomplete "Companion documents" headers across the three-file Matrix cluster

**Conflicting specs:** all three Matrix object specs' own headers, checked against what each document's body actually cites.

**The conflict:**

- `matrix_synapse_module.md`'s header lists companions as `matrix_room.md`, `matrix_room_membership.md`, `matrix_join_attestation_and_revocation.md` — but **omits `matrix_encryption.md`**, even though the body cites it repeatedly and substantively (e.g. the `matrix_server_name` config row: "passed to `verifyMatrixUserIdBinding` (`matrix_encryption.md §3`)"; `attestation.py`'s description: "`verifyMatrixUserIdBinding` (matrix_encryption.md §3...)").

- `matrix_encryption.md`'s header lists `matrix_room.md`, `matrix_room_membership.md §5`, `matrix_join_attestation_and_revocation.md`, `messaging_protocol.md`, `plans/matrix-strategic-plan.md` — but **omits `matrix_synapse_module.md`**, even though §3 cites it directly ("the module's `matrix_server_name` config, `matrix_synapse_module.md`") and §4 leans on it for the enforcement-boundary argument ("Synapse's structural guarantee (via the policy module, `matrix_synapse_module.md`) is limited to...").

- `matrix_room.md`'s header lists `matrix_room_membership.md`, `matrix_synapse_module.md`, `matrix_encryption.md` plus two plan docs — but **omits `matrix_join_attestation_and_revocation.md` and `room_discovery.md`**, even though its own "What the Synapse Operator Can See" table cites the former by name and section number twice, and its Room Creation section's `matrix_alias` paragraph explicitly hands off to the latter ("see `specs/process_specs/room_discovery.md` (2026-07-11), which adds a lightweight room index...").

**Why this matters:** the task's cross-referencing check for this cluster specifically asked whether `matrix_synapse_module.md` (added to scope later, per a follow-up request) is fully cross-referenced by the other two. It is cited correctly in body text throughout, but the header metadata — the part a reader or a doc-linter would check first — doesn't reflect it symmetrically in either direction, and the same staleness affects `matrix_room.md`'s relationship to the two newer process specs it was amended to reference.

**Recommended resolution:** Update each of the three headers' "Companion documents" line to include every document actually cited substantively in the body:
- `matrix_synapse_module.md`: add `specs/object_specs/matrix_encryption.md`.
- `matrix_encryption.md`: add `specs/object_specs/matrix_synapse_module.md`.
- `matrix_room.md`: add `specs/process_specs/matrix_join_attestation_and_revocation.md` and `specs/process_specs/room_discovery.md`.

---

## Finding 3 — Stale checklist line in `matrix_room_membership.md` contradicts its own superseding note and both other documents

**Conflicting specs:** `specs/process_specs/matrix_room_membership.md` (its own "Summary: Deny-by-Default Coverage Checklist") **vs.** the same document's amendment note, `matrix_join_attestation_and_revocation.md` (§3.3, §4), and `matrix_synapse_module.md` (which removed the config keys this dependency needed).

**The conflict:**

- `matrix_room_membership.md`'s header note (2026-07-11 amendment) states plainly: "`§1` step 2 (wallet-service card-binding resolver)... [is] **superseded** by `specs/process_specs/matrix_join_attestation_and_revocation.md`." Its own §4 failure-mode table correctly strikes through the row: "~~`wallet-service`'s binding resolver unreachable...~~ | **Superseded 2026-07-11.**"

- But the document's final section, "Summary: Deny-by-Default Coverage Checklist," still reads, unedited:
  > "- [x] Wallet-service card-binding resolver unreachable, erroring, or not-found → deny"

  presented as a currently-true, checked item, with no strikethrough or superseded annotation — inconsistent with the rest of the same document and with `matrix_join_attestation_and_revocation.md`'s explicit statement (§2, restated in its Summary table) that "`wallet-service` is not called anywhere in this sequence" and "Dependency on `wallet-service` at join/post time: None." `matrix_synapse_module.md` correspondingly lists `wallet_service_internal_url`/`wallet_service_module_shared_secret` as **removed** config keys.

**Why this matters:** a reader who jumps straight to the summary checklist (a plausible thing to do with a document like this) would conclude the wallet-service-resolver failure mode is still an active, checked-off part of the deny-by-default posture, when the rest of the same document — and both companion documents — say the dependency no longer exists at all.

**Recommended resolution:** Strike (or replace) that checklist line the same way the corresponding §4 table row already was, e.g.: "~~Wallet-service card-binding resolver unreachable...~~ **Superseded — see `matrix_join_attestation_and_revocation.md §3.3`'s `attestation_invalid` and `membership_not_registered` rows.**"

---

## Non-findings worth recording (checked, no contradiction)

- Field/type names used by `matrix_synapse_module.md` for the verifier package (`chain_reaches_trusted_root`, `revocation.status`, `CardVerificationResult`, `SignatureVerificationResult`) match `card_verifier.md §8` exactly.
- Revocation code semantics (8xx "quiet"/9xx "loud", `effective_date`) referenced in `matrix_join_attestation_and_revocation.md §3.1` match `card_updates.md` exactly, including the "force-part applies uniformly regardless of code" clarification, which doesn't contradict `card_updates.md`'s own note that the 8xx/9xx distinction affects signaling elsewhere, not Matrix room access.
- `registry_contract.md`'s OQ-6 has been marked resolved with a citation to this module's watcher design, and the citation is accurate (`matrix_join_attestation_and_revocation.md §3`, watch-set construction, catch-up-on-reconnect, self-hosted-vs.-third-party-RPC open item all match).
- The predicate grammar (`issued_under_template`, `card_field_matches`, `any_of`, `is_holder`/`is_issuer` reserved-but-unused, `code_equals` scoped to `revocation_permissions`) used by `matrix_room.md`'s room predicate document is consistent with `card_protocol_spec.md §The Predicate System`.
- The module's package layout (`module.py`, `config.py`, `rpc_provider.py`, `ipfs_provider.py`, `predicates.py`, `chain_context.py`, `cache.py`, `attestation.py`, `watcher.py`, `membership_registry.py`) matches the actual files present in `wallet-service/matrix-policy-module/src/matrix_policy_module/`, and the `pyproject.toml` dependency shape (path dependency on `membership-card-verifier`, `web3`, `httpx`, `synapse` as dev-only) matches the spec's description. No Phase 3 code-alignment flag needed here.
- `matrix_synapse_module.md`'s note that the module reads `membership_registry_path` as "a SQLite file (or equivalent)" is loose enough to cover the actual implementation's single encrypted-JSON-blob approach (`membership_registry.py`'s own docstring explains the SQLite-vs.-blob tradeoff) — not a contradiction, just noting it for whoever runs the Phase 3 code-alignment pass in case a stricter reading is intended.
- Top-level docs (`specs/card_protocol_spec.md`, `specs/protocol-objects.md`, `specs/ARCHITECTURE.md`) contain no mention of Matrix at all. This isn't a contradiction (nothing in those docs claims something about Matrix that conflicts with the Matrix specs), but it is a completeness gap worth flagging separately if the top-level docs are meant to be a complete map of the protocol's components — outside this unit's contradiction-hunting scope, so not written up as a numbered finding here.
