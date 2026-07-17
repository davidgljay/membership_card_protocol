[Strategic Plan](./subcard-registry-strategic-plan.md)

# Sub-Card Registry & Card Extensibility — Implementation Plan

**Date:** 2026-07-05
**Status:** Draft

Decisions locked in during strategic review (see strategic plan's Open Questions for full rationale):
`active_subcards` is a flat array of bare public keys, entries are deleted outright on removal (history lives in the log, not the field), codes are **510** (addition) / **511** (removal) / **512** (key rotation) on the **master card's** log, sub-card limitations reuse the existing predicate/`field_requirements` grammar, arbitrary card fields are signed-but-unvalidated, no migration is needed (no cards deployed), and holder-only authorization over `active_subcards` is a hard protocol limit (not policy-configurable) for this protocol version.

---

## Phase 1: Spec & Process-Spec Updates

### Step 1.1 — Add `active_subcards` as a protocol-reserved field
**What:** In `specs/protocol-objects.md §1.1` ("Protocol-Reserved Updatable Fields"), add `active_subcards` alongside `successor`: type `array of base64url` (ML-DSA-44 public keys, 1312 bytes each), not present at genesis, added/modified only via codes 510/511/512, authorization hardcoded to `{ "is_holder": true }` — explicitly **not** overridable by any policy's field definitions or `update_policy`. Add the same field to the `CardDocument` §1 template/table as an optional field (absent = no active sub-cards) and to the RFC 8785 field-ordering note if it affects sort position.
**Who:** Claude
**Context needed:** `protocol-objects.md §1` and `§1.1` (existing `successor` field as the precedent pattern), strategic-plan.md Goal 1 + resolved open questions on field shape and codes.
**Done when:** `protocol-objects.md` documents `active_subcards` with type, mutability, authorization rule, and the three codes that touch it, consistent with how `successor` is documented.

### Step 1.2 — Wire codes 510/511/512 into the update-code system
**What:** `specs/update_codes.md` already lists 510 (subcard addition), 511 (subcard removal), 512 (subcard key rotation) in the 5xx table — confirm the entries and add the missing **authority rule** for each (hardcoded `is_holder` only, not policy-configurable), plus a note that these three codes are scoped to entries on the **master/parent card's** log, not the sub-card's own log. Cross-reference `specs/process_specs/subcard_creation_policy.md §Update Card Content`, which already prohibits 5xx updates *on the sub-card itself* — add a clarifying sentence there distinguishing "5xx on the sub-card" (prohibited) from "510/511/512 on the parent card" (holder-authorized, this feature).
**Who:** Claude
**Context needed:** `specs/update_codes.md` §5xx section (already has the three codes listed), `specs/process_specs/subcard_creation_policy.md §Update Card Content`.
**Done when:** `update_codes.md` states who may post each of 510/511/512 and confirms it's hardcoded; `subcard_creation_policy.md` explicitly disambiguates parent-card-log codes from sub-card-log codes.

### Step 1.3 — Update the card update/validation process specs
**What:** `specs/process_specs/card_updates.md` and `specs/process_specs/card_validation.md` need to describe: (a) how a holder submits a 510/511/512 `UpdateIntentPayload` targeting their own master card, what `field_updates` looks like for an `active_subcards` change (add one pubkey / remove one pubkey / atomic swap for rotation), and (b) that verifiers/presses reject any 510/511/512 intent not signed by the card's own holder key, regardless of what the governing policy says.
**Who:** Claude
**Context needed:** `specs/process_specs/card_updates.md`, `specs/process_specs/card_validation.md`, `protocol-objects.md §4` (`UpdateIntentPayload`), Step 1.1 and 1.2 outputs.
**Done when:** Both process specs describe the full submit → validate → append flow for all three codes, and state the holder-only rule as a press/verifier MUST, not a SHOULD.

### Step 1.4 — Sub-card runtime verification: point at real data
**What:** `specs/protocol-objects.md §16`'s "Verifier chain walk (runtime)" step 8 currently says to "confirm the sub-card appears in the master card's active sub-card list" with no field to check. Update this step to reference `active_subcards` concretely: derive `keccak256(pubkey)` for each entry and confirm the sub-card's own address is among them. Note the failure mode (sub-card not present in the list → reject, distinct from `SubCardEntry.active == false` — a sub-card could in principle be on-chain-active but absent from the directory if the two ever desync; verifiers should treat "not in `active_subcards`" as a hard rejection independent of the on-chain flag).
**Who:** Claude
**Context needed:** `protocol-objects.md §16` full verifier chain-walk list (12 steps), Step 1.1 output.
**Done when:** Step 8 of the chain walk is fully concrete (no forward reference to an undefined structure) and a new acceptance-criterion bullet is added to `specs/subcards.md` Acceptance Criteria reflecting it.

### Step 1.5 — Sub-card arbitrary limitations mechanism
**What:** Add a `limitations` field to the `SubCardDocument` schema (`protocol-objects.md §16`) reusing the existing predicate/`field_requirements` grammar (`card_protocol_spec.md` §The Predicate System and §The Field Type System's `field_requirements`), covered by both `app_signature` and `holder_signature` like every other sub-card field. Document at least two concrete limitation shapes as examples in `specs/subcards.md` (e.g., a `field_requirements`-style constraint on message content, and a predicate-style time/rate constraint), and add acceptance criteria requiring verifiers to reject any sub-card-signed statement violating a stated limitation, with the same rigor as the existing `capabilities` check.
**Who:** Claude
**Context needed:** `specs/subcards.md` (`§Capabilities` section as the pattern to extend), `protocol-objects.md §16`, `card_protocol_spec.md` §The Predicate System.
**Done when:** `SubCardDocument` schema includes `limitations`, `subcards.md` has worked examples and new acceptance criteria, and the red-team plan's relevant findings (e.g. S-5 on note-writing abuse) are cross-referenced as addressed by this mechanism where applicable.

### Step 1.6 — Arbitrary card fields, explicitly
**What:** In `specs/card_protocol_spec.md` (Background Concepts, near "Protocol-Required Fields" and the Field Type System), add an explicit statement: a card's fields are the protocol-required fields (always) plus the policy's `field_definitions` (if any) plus any additional issuer/holder-supplied fields not declared in either — the schema is a floor, not a closed allow-list. State the resolved trust rule: undeclared fields are covered by the same three signatures as declared fields (signed, tamper-evident) but have no synthesized `update_policy` — the press does not validate them against any schema, and no update authorization is implied for changing them later (in practice, since nothing grants authority to update them, they should be treated as effectively immutable after issuance unless a future update explicitly and separately gets some other party's cooperation to co-sign a policy-defined path for them — call this out as a known sharp edge, not hidden behavior). Correct the "policy compliance"/"schema satisfied" language in `card_protocol_spec.md §2` issuance flow (step 9) so it reads as "required fields present and declared-field values valid" rather than implying a closed schema.
**Who:** Claude
**Context needed:** `card_protocol_spec.md` Background Concepts (Protocol-Required Fields, Field Type System), `§2` issuance flow step 9, strategic-plan.md Goal 3 + resolved open question on validation boundary.
**Done when:** The spec states unambiguously that cards are never limited to their declared schema, and the issuance-flow language no longer reads as a closed-schema check.

### Step 1.7 — Update the object/process spec cross-references
**What:** Sweep `specs/object_specs/card_verifier.md`, `specs/object_specs/press.md`, `specs/object_specs/client_sdk.md`, and `specs/object_specs/registry_contract.md` for any language that assumes a closed field schema or omits the sub-card directory, and align them with Steps 1.1–1.6. In particular, `client_sdk.md` should gain a section describing how the SDK reads `active_subcards` off a decrypted master card and uses each pubkey to derive an address / encryption target for "send to all sub-cards" flows — this is the concrete feature David asked for.
**Who:** Claude
**Context needed:** The four `object_specs` files listed, Steps 1.1–1.6 outputs.
**Done when:** No remaining spec document describes card schemas as closed or omits `active_subcards` from the verifier/press/SDK responsibilities that touch it; `client_sdk.md` documents the "message all sub-cards" use case end-to-end.

### Phase 1 Milestone Review
**What:** Read every spec file touched in Steps 1.1–1.7 together and confirm: consistent field name (`active_subcards`) and type everywhere; consistent code numbers (510/511/512) and consistent authority language ("hardcoded holder-only, not policy-configurable") everywhere it's mentioned; no leftover language implying a closed card schema; the sub-card verifier chain-walk in §16 no longer forward-references an undefined structure; `subcards.md` and `protocol-objects.md` agree on the shape of `limitations`. Write a one-paragraph summary to `plans/milestones/subcard-registry-phase-1-summary.md`.
**Who:** Claude
**Context needed:** `specs/protocol-objects.md`, `specs/card_protocol_spec.md`, `specs/subcards.md`, `specs/update_codes.md`, `specs/process_specs/subcard_creation_policy.md`, `specs/process_specs/card_updates.md`, `specs/process_specs/card_validation.md`, `specs/object_specs/card_verifier.md`, `specs/object_specs/press.md`, `specs/object_specs/client_sdk.md`, `specs/object_specs/registry_contract.md`.
**Done when:** All the above files are internally consistent, contradictions (if any) are resolved in place, the summary file is written, and David has confirmed the spec set is ready for implementation to begin.

**Clarification checkpoint:** Pause here and get David's sign-off on the spec changes before touching any code. This is the highest-leverage place to catch a wrong call, since Phases 2–4 all build on these documents.

---

## Phase 2: Smart Contract Updates (`contracts/`)

### Step 2.1 — Extend the card registry to track `active_subcards` operations
**What:** `contracts/logic-contract/src/subcard_ops.rs` currently implements `register_sub_card` (line 62) and `deregister_sub_card` (line 209). Confirm the on-chain contract's role here: per the spec, `active_subcards` itself lives in the **IPFS** `CardDocument`/log, not on-chain — the contract's job is unchanged in kind (`RegisterSubCard`/`DeregisterSubCard` still write `SubCardEntry`), but the **authorization check** for any accompanying master-card log update (codes 510/511/512) must be confirmed holder-only at the point the press assembles and signs that `LogEntry`. Add a rotation path: either a new `rotate_sub_card` contract entrypoint (atomic deregister-old + register-new) or confirm rotation is handled entirely off-chain as a paired deregister+register with a single code-512 master-card log entry tying them together. Decide and implement per `contracts/protocol-types/src/lib.rs` conventions.
**Who:** Claude
**Context needed:** `contracts/logic-contract/src/subcard_ops.rs` (both functions in full), `contracts/logic-contract/src/write_gate.rs`, `contracts/protocol-types/src/lib.rs`, Phase 1 outputs (especially Step 1.3 on what a 510/511/512 intent looks like).
**Done when:** The contract-level behavior for add/remove/rotate is implemented or explicitly confirmed as off-chain-only with a clear rationale recorded in code comments; a rotation path exists in some form (on-chain or via the paired-log-entry convention).

### Step 2.2 — Enforce holder-only authorization at the write gate
**What:** Audit `contracts/logic-contract/src/write_gate.rs` and `subcard_ops.rs` to confirm no code path accepts an issuer-signed (or press-signed-only) intent as sufficient authorization for a change that affects `active_subcards`. Add an explicit unit test asserting an issuer-signed 510/511/512 intent is rejected.
**Who:** Claude
**Context needed:** `contracts/logic-contract/src/write_gate.rs`, `contracts/logic-contract/src/subcard_ops.rs`, `contracts/tests/` structure (existing test conventions), strategic-plan.md Goal 4.
**Done when:** A regression test exists and passes, demonstrating issuer-only signatures cannot authorize `active_subcards` changes; existing tests still pass.

### Step 2.3 — Contract test suite pass
**What:** Run the existing Rust/Stylus test suite (`contracts/tests/`) plus any new tests from Steps 2.1–2.2 to confirm no regressions in `RegisterSubCard`/`DeregisterSubCard`/new rotation path.
**Who:** Claude
**Context needed:** `contracts/tests/`, `contracts/Cargo.toml` test configuration.
**Done when:** Full contract test suite passes locally; failures (if any) are triaged and fixed before moving to Phase 3.

### Phase 2 Milestone Review
**What:** Confirm the contract changes match Phase 1's spec decisions exactly — same code numbers referenced in comments, same holder-only invariant enforced, rotation handled consistently with what `client_sdk.md`/`card_verifier.md` will assume in Phase 3. Write a summary to `plans/milestones/subcard-registry-phase-2-summary.md`.
**Who:** Claude
**Context needed:** Diffs from Steps 2.1–2.3, `plans/milestones/subcard-registry-phase-1-summary.md`.
**Done when:** Contract behavior and spec text agree; summary written; any spec ambiguity discovered during contract work is fed back into Phase 1 docs before proceeding.

---

## Phase 3: Verifier Codebase (`membership_card_verifier/`)

### Step 3.1 — Implement `active_subcards` membership check
**What:** In `packages/verifier/src/CardVerifier.ts`, implement the concrete version of §16 chain-walk step 8 (Step 1.4's output): given a decrypted master `CardDocument`, derive `keccak256(pubkey)` for each entry in `active_subcards` and confirm the sub-card under evaluation is present. Add the corresponding error code/type in `packages/verifier/src/errors.ts` and `types.ts` for "sub-card not in active directory."
**Who:** Claude
**Context needed:** `packages/verifier/src/CardVerifier.ts`, `packages/verifier/src/types.ts`, `packages/verifier/src/errors.ts`, `packages/verifier/src/crypto.ts` (for the keccak256/address-derivation helper already in use elsewhere), Phase 1 Step 1.4 output.
**Done when:** A sub-card signature whose pubkey is absent from the master card's `active_subcards` is rejected with a distinct, documented error code, independent of the on-chain `active` flag check.

### Step 3.2 — Implement sub-card `limitations` enforcement
**What:** Extend `CardVerifier.ts`'s sub-card signature validation to evaluate `limitations` (Step 1.5) using the same predicate-evaluation code path already used for policy `update_policy`/`recipient_predicate` evaluation (locate and reuse, don't fork). Reject any statement that violates a stated limitation.
**Who:** Claude
**Context needed:** `packages/verifier/src/CardVerifier.ts` (existing predicate evaluation logic — grep for how `update_policy`/`recipient_predicate` are currently evaluated), Phase 1 Step 1.5 output.
**Done when:** A sub-card statement violating a `limitations` entry is rejected; a statement respecting all limitations is accepted; both paths covered by tests.

### Step 3.3 — Verifier test coverage
**What:** Add test cases (co-located with existing verifier tests) covering: sub-card present/absent in `active_subcards`; sub-card violating/respecting `limitations`; a card carrying arbitrary undeclared fields (confirm the verifier does not choke on or reject them, per Step 1.6's signed-but-unvalidated rule); a 510/511/512 log entry signed by the holder (accept) vs. signed by the issuer (reject).
**Who:** Claude
**Context needed:** Existing verifier test files/conventions (locate via `packages/verifier` test directory), Steps 3.1–3.2 outputs.
**Done when:** All new tests pass; existing verifier test suite has no regressions.

### Phase 3 Milestone Review
**What:** Confirm verifier behavior matches spec exactly (error codes, rejection conditions, and the arbitrary-fields passthrough behavior). Write a summary to `plans/milestones/subcard-registry-phase-3-summary.md`.
**Who:** Claude
**Context needed:** Diffs from Steps 3.1–3.3, `plans/milestones/subcard-registry-phase-1-summary.md`, `plans/milestones/subcard-registry-phase-2-summary.md`.
**Done when:** Verifier, spec, and contract layers agree; summary written.

---

## Phase 4: Client SDK (`client-sdk/packages/client-sdk`, `client-sdk-web`, `client-sdk-rn`)

### Step 4.1 — Read `active_subcards` and expose a "message all sub-cards" helper
**What:** In `client-sdk/packages/client-sdk`, add a function that takes a decrypted master `CardDocument`, reads `active_subcards`, and returns the set of sub-card public keys (and derived addresses) ready for use by the messaging layer (`messaging_protocol.md`) to encode/encrypt a `SignedMessageEnvelope` addressed to all of a holder's sub-cards. Confirm this composes with the existing message-sending path rather than duplicating it.
**Who:** Claude
**Context needed:** `client-sdk/packages/client-sdk` (locate existing card-reading and messaging helpers), `specs/messaging_protocol.md`, `specs/object_specs/client_sdk.md` (Step 1.7 output), `packages/verifier` crypto helpers for consistent address derivation.
**Done when:** A documented, tested SDK function exists that turns a master card into a ready-to-use list of sub-card message targets, with no additional network round trip beyond the single card fetch.

### Step 4.2 — Propagate to platform SDKs
**What:** Confirm `client-sdk-web` and `client-sdk-rn` either re-export the new core `client-sdk` helper or wrap it consistently with their existing card-access patterns.
**Who:** Claude
**Context needed:** `client-sdk/packages/client-sdk-web`, `client-sdk/packages/client-sdk-rn`, Step 4.1 output.
**Done when:** Both platform packages expose the same capability with consistent naming; no platform-specific duplication of the address-derivation logic.

### Step 4.3 — SDK test coverage
**What:** Add unit tests for Step 4.1's helper (empty `active_subcards`, single entry, multiple entries, and a card entirely lacking the field — must not throw, per the "absence = no active sub-cards" convention).
**Who:** Claude
**Context needed:** Existing client-sdk test conventions, Step 4.1 output.
**Done when:** Tests pass, including the absent-field edge case.

### Phase 4 Milestone Review
**What:** Confirm the SDK's behavior matches what `client_sdk.md` documents (Step 1.7) and what the verifier enforces (Phase 3) — e.g., the SDK should not construct a message target list that the verifier would then reject. Write a summary to `plans/milestones/subcard-registry-phase-4-summary.md`.
**Who:** Claude
**Context needed:** Diffs from Steps 4.1–4.3, prior phase summaries.
**Done when:** SDK, verifier, contracts, and specs all agree; summary written.

---

## Phase 5: Cross-Cutting Consistency Pass

### Step 5.1 — Update the red-team plan
**What:** Revisit `plans/subcard_redteam_plan.md` in light of the new `active_subcards` directory and `limitations` mechanism — both are new attack surfaces (e.g., could a compromised holder key silently rewrite `active_subcards` to insert a rogue sub-card pubkey? Is there a new correlation risk from the directory being visible to anyone who decrypts the master card?). Add findings/mitigations as needed; note that Finding S-5 (note-writing abuse) may now be partially addressable via `limitations`.
**Who:** Claude
**Context needed:** `plans/subcard_redteam_plan.md` (full document), Phase 1–4 summaries.
**Done when:** The red-team plan reflects the new surfaces with at least a first-pass severity/likelihood/mitigation entry for each; existing findings cross-referenced where the new mechanism changes their status.

### Step 5.2 — Final end-to-end consistency check
**What:** Confirm, across every touched file (specs, process specs, contracts, verifier, SDK, red-team plan), that: field name and semantics for `active_subcards` are identical everywhere; codes 510/511/512 mean the same thing everywhere and are always described as holder-only/hardcoded; the arbitrary-card-fields rule (signed-but-unvalidated) is stated consistently; no document still implies issuer/granter authority over sub-card lifecycle.
**Who:** Claude
**Context needed:** All files touched across Phases 1–5.
**Done when:** A final summary is written to `plans/milestones/subcard-registry-final-summary.md` listing every file changed and confirming consistency; David has reviewed and approved.

**Clarification checkpoint:** Before merging/finalizing, present David with the full diff set (specs + contracts + verifier + SDK) for review — this is a protocol-level change touching cryptographic authorization boundaries (Goal 4 in particular), and should get a human pass before being treated as final.

---

## Notes on Sequencing

Phases are ordered spec-first deliberately: contracts, verifier, and SDK all consume decisions made in Phase 1, and re-deriving them independently in each codebase risks the exact kind of drift that created the original problem this plan opens with (an implied-but-undefined field in §16). If time pressure forces parallelization, Phases 2 and 3 can run concurrently once Phase 1 is signed off, since neither depends on the other's output — but Phase 4 should wait for both, since the SDK needs the verifier's error-handling conventions and the contract's rotation decision (Step 2.1) to know what shape of data it's consuming.
