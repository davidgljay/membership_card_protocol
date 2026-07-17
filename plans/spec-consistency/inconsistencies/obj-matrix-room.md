# Inconsistency Review: `obj-matrix-room` (`specs/object_specs/matrix_room.md`)

Reviewed against: `matrix_encryption.md`, `matrix_synapse_module.md` (Matrix cluster); `matrix_join_attestation_and_revocation.md`, `matrix_room_membership.md`, `room_discovery.md` (Matrix process specs); `card_protocol_spec.md`, `specs/protocol-objects.md`, `registry_contract.md`, `ipfs_card.md`, `press.md`, `wallet.md`, `relay.md`, `relay_data_model.md`, `card_verifier.md`, `app_sdk.md`, `wallet_sdk.md`, `ARCHITECTURE.md`; and the remaining Phase-2-scope process specs (spot-checked — none reference `matrix_room.md`).

Four findings, all fixable, none blocking. No mismatched field/type shapes, no conflicting lifecycle states, and no stale `client_sdk.md` citations were found in `matrix_room.md`.

---

## 1. Room-creation endpoint is missing power_levels / encryption setup that two other specs assume it performs

**Conflicting specs:** `matrix_room.md` §"Room Creation: `POST /matrix/rooms`" (lines 105–134) vs. `matrix_synapse_module.md` (Module Config Schema table, `enforcement_matrix_user_id` row) and `matrix_join_attestation_and_revocation.md` §3.1.

**Conflict:** `matrix_synapse_module.md` states:

> "This account instead needs kick-level power in every card-gated room, granted at room creation (`matrix_room.md §Room Creation`'s `m.room.power_levels` initial state, Step 16)"

and `matrix_join_attestation_and_revocation.md` §3.1 independently states:

> "a dedicated enforcement account ... must be granted kick-level power in every card-gated room's initial `m.room.power_levels` at creation time — a new requirement on the room-creation endpoint, not something this watcher can retrofit after the fact."

Both treat this as an already-specified (or at least clearly assigned) behavior of `matrix_room.md`'s `POST /matrix/rooms` endpoint. But `matrix_room.md`'s own Room Creation section — request shape, response shape, and the surrounding prose — says nothing about `m.room.power_levels`, the enforcement account, or granting kick-level power to anything. It also never mentions setting the `m.room.encryption` state event at creation time, even though `matrix_encryption.md` §1 assumes every card-gated room is Megolm-encrypted (`m.room.encryption`, `algorithm: m.megolm.v1.aes-sha2`) and never states who sets that event or when.

This is a one-sided claim: two downstream specs assume `matrix_room.md` covers this, but it doesn't. It is a genuine spec gap, not just a cross-reference typo — the room-creation flow as currently written would produce a room with no enforcement account empowered to force-part, breaking `matrix_join_attestation_and_revocation.md` §3.1's revocation model, and (if `m.room.encryption` is likewise unset) a room with no encryption at all, breaking `matrix_encryption.md` §1 entirely.

**Recommended resolution:** Add to `matrix_room.md`'s "Room Creation" section: (a) that room creation sets an initial `m.room.encryption` state event (`m.megolm.v1.aes-sha2`) alongside `m.room.name`/`m.room.topic`, and (b) that room creation sets an initial `m.room.power_levels` state event granting kick-level (or higher) power to the configured `enforcement_matrix_user_id` account. Point back to `matrix_synapse_module.md`'s `enforcement_matrix_user_id` config key as the account to grant.

---

## 2. Citation to a nonexistent section number in `card_protocol_spec.md`

**Conflicting specs:** `matrix_room.md` line 34 vs. `card_protocol_spec.md`.

**Conflict:** `matrix_room.md` cites the pinned-CID compliance rule as:

> "matching how `issued_under_template` behaves everywhere else in the protocol (`card_protocol_spec.md §71`: compliance anchored to the CID pinned at issuance, not the policy's current mutable head)."

`card_protocol_spec.md` does not use `§NN`-style section numbering anywhere in its own body (its internal cross-references are things like "See §7" referring to its own heading "## 7. Validating That a Message Has Been Signed by a Card", and outbound refs like "`protocol-objects.md` §7"). There is no section "71". The content matches — line 71 of `card_protocol_spec.md` ("Policy compliance is always anchored to `policy_id`...") does say what's cited, and it falls under the "### Protocol-Required Fields" heading — but "§71" reads as a section reference to a section that doesn't exist, since it's actually a raw line number dressed up with a section symbol.

**Recommended resolution:** Change the citation to either the heading name (`card_protocol_spec.md §"Protocol-Required Fields"`) or `card_protocol_spec.md`'s own local numbering convention (it uses `§7` to mean its "## 7. ..." heading elsewhere in the same file's citations by other specs) — not a bare line number.

---

## 3. `matrix_room.md`'s version/amendment metadata doesn't reflect content it already contains

**Conflicting specs:** `matrix_room.md` header vs. its own body, and vs. sibling cluster docs' header conventions (`matrix_encryption.md`, `matrix_synapse_module.md`).

**Conflict:** `matrix_room.md`'s header reads:

> "**Version:** 0.1 (draft) **Date:** 2026-07-10 **Status:** Draft"

with no amendment note. But its own body already incorporates later content: the "What the Synapse Operator Can See" table (line 143) discusses "the 2026-07-11 join-attestation redesign" in detail, and the Room Creation section (line 133) cites `room_discovery.md` "(2026-07-11)" as adding room-index discoverability. Sibling cluster docs that received equivalent later edits mark this explicitly in their header metadata: `matrix_encryption.md` has "**Note (2026-07-11):** §3's discussion ... is superseded by ..." right under its header, and `matrix_synapse_module.md`'s header itself reads "**Date:** 2026-07-10 (amended 2026-07-11)" with an explicit "**Amended 2026-07-11:**" changelog line. `matrix_room.md` does neither, despite depending on the same 2026-07-11 changes for its own table to be accurate.

This isn't a content contradiction — the table's content is correct and consistent with the join-attestation redesign — but the missing amendment marker is inconsistent documentation practice within the same tightly-coupled cluster, and could mislead a reader skimming just the header into thinking this document predates (and is unaware of) the join-attestation/room-discovery changes.

**Recommended resolution:** Add an "(amended 2026-07-11)" marker to `matrix_room.md`'s Date line and a short changelog note, matching the convention already used by `matrix_encryption.md` and `matrix_synapse_module.md`.

---

## 4. Minor terminology drift: "mutable pointer registry address" vs. registry_contract.md's actual vocabulary

**Conflicting specs:** `matrix_room.md` (multiple places, e.g. line 27, line 35) vs. `registry_contract.md`.

**Conflict:** `matrix_room.md` describes `ref_type: "pointer"`'s `ref` field as "the policy card's mutable pointer registry address" and generally uses "mutable pointer" as its term for the on-chain resolvable key. `registry_contract.md` never uses the phrase "mutable pointer" for this concept — it names the registry key `card_address`/`policy_address` (a bytes32 registry key) which resolves to a mutable `log_head_cid`. This is the same underlying mechanism (confirmed: `registry_contract.md`'s `CardEntries[policy_address].log_head_cid` is exactly what `matrix_room.md` means by "resolving the pointer to its current CID"), so this is not a factual contradiction — but the vocabulary isn't unified across the cluster, which risks a reader (or an implementer) treating "mutable pointer" as a distinct on-chain object from `policy_address`/`card_address` rather than the same thing under a different name. Note `card_protocol_spec.md` itself does use "mutable pointer" pervasively as its own preferred term (e.g. line 31, line 158, line 384), so `matrix_room.md`'s usage is at least consistent with the top-level spec's vocabulary — the drift is specifically against `registry_contract.md`'s more literal/technical naming.

**Recommended resolution:** Low priority. Optionally add a one-line gloss in `matrix_room.md` (or in `registry_contract.md`) explicitly equating "mutable pointer" (used by `card_protocol_spec.md` and `matrix_room.md`) with `registry_contract.md`'s `card_address`/`policy_address` + `log_head_cid` terms, so a reader moving between the top-level spec's vocabulary and the contract spec's vocabulary doesn't have to infer the equivalence.

---

## Non-findings worth recording (checked, no conflict)

- **Predicate document shape / `m.card.policy` state event / `POST /matrix/rooms` request-response shapes**: consistent across `matrix_synapse_module.md` (`predicates.py`, `check_event_for_spam` logic), `matrix_room_membership.md` §1 steps 4–5, and `room_discovery.md` §2 step 3 — all three describe the identical `{"policies":[{"ref_type","ref","resolved_ref"?,"field_match"?}]}` schema and `any_of`-across-`issued_under_template`-plus-optional-`card_field_matches` evaluation semantics matrix_room.md defines.
- **Synapse-operator-visibility table**: consistent with `matrix_encryption.md` §3's shadow-account/no-inverse claims and with the 2026-07-11 join-attestation redesign — already correctly updated in `matrix_room.md` itself.
- **Room discoverability**: `matrix_room.md` line 133 already correctly forward-references `room_discovery.md` rather than asserting the superseded "no way to discover" framing — no stale claim here.
- **`client_sdk.md`**: not referenced anywhere in `matrix_room.md`. No stale-reference issue.
- **`card_hash` terminology**: `matrix_room.md`'s use of "card_hash — the creating card's registry address" is consistent with `registry_contract.md`'s and `card_migration.md`'s `keccak256(recipient_pubkey)` definition (`protocol-objects.md` itself doesn't define `card_hash` — it lives in `registry_contract.md` and `ARCHITECTURE.md`'s vocabulary instead — not a conflict, just noting where the term actually lives).
- **`wallet.md` / `wallet_sdk.md`**: no mention of Matrix, rooms, or shadow accounts; no contradiction, simply predates this feature area.
- **`press.md`, `ipfs_card.md`, `card_verifier.md`, `app_sdk.md`, `relay.md`, `relay_data_model.md`, `ARCHITECTURE.md`**: no conflicting `policy_id`/predicate/CID-pinning claims found; no mention of Matrix rooms.
