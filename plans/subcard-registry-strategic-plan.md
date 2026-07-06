# Sub-Card Registry & Card Extensibility — Strategic Plan

**Date:** 2026-07-05
**Status:** Draft — pending open-question review
**Companion spec:** `specs/subcards.md`, `specs/card_protocol_spec.md`, `specs/protocol-objects.md`
**Related:** `plans/subcard_redteam_plan.md`

---

## Goals

**1. The master card is a self-sufficient directory of its own live sub-cards.**
A holder's master `CardDocument` carries an authoritative, signed list of the public keys of every currently-active sub-card, so that any party — most importantly the client SDK — can encrypt or address a message to "all of this person's devices/apps" without an out-of-band lookup, a chain crawl of on-chain `SubCardEntry` records, or trusting a wallet-service API.

**2. Sub-cards can be constrained by more than a capability whitelist.**
Today a sub-card's only attenuation mechanism is the `capabilities` message-type whitelist. Holders and apps need a general way to place additional, arbitrary limitations on a sub-card relative to its parent — spend limits, rate limits, field-level restrictions, time windows, predicate constraints — without protocol changes every time a new kind of limitation is needed.

**3. Cards are never limited to a fixed field set.**
A card's protocol-required fields (§`card_protocol_spec.md` Background Concepts) are non-negotiable, but a card must be able to carry additional fields beyond whatever a policy's `field_definitions` enumerates — at issuance and at update time — without the schema being treated as a closed allow-list.

**4. Sub-card lifecycle authority belongs to the holder alone.**
Only the cardholder — never the issuer ("granter") of the holder's card — can add or remove that holder's sub-cards. This must be a protocol-enforced invariant, not a policy-configurable default that an issuer could quietly override.

---

## Rationale

**Why the sub-card pubkey list matters now:** `protocol-objects.md §16` already assumes this exists. Step 8 of the documented runtime verifier chain walk says a verifier must "confirm the sub-card appears in the master card's active sub-card list" — but no such field is defined anywhere in the `CardDocument` schema (§1) or the protocol-reserved fields table (§1.1). This is a live spec inconsistency: the verification algorithm references a data structure that was never specified. Fixing it is not a new feature so much as closing a gap the spec already implies. It also directly serves the client-SDK use case David described: encoding a message to "all sub-cards" today requires either trusting the wallet's own bookkeeping or crawling on-chain `SubCardEntry` writes and cross-referencing `master_card_address` — expensive and not something a lightweight SDK should have to do.

**Why this must be a protocol-reserved field, not a policy field:** If the sub-card list lived inside a policy's ordinary `field_definitions`, its `update_policy` could be set by whoever authors the policy — including giving issuer-side write access, which would directly violate Goal 4. The existing `successor` field (§1.1) is the precedent: a small set of fields sit outside policy control entirely, with hardcoded authorization baked into the protocol itself. The sub-card list should follow the same pattern.

**Why "arbitrary limitations" generalizes the existing model:** The protocol already has a general-purpose predicate and field-restriction system for policies (`recipient_predicate`, `update_policy`, `field_requirements`, `policy_creation.field_restrictions`). Sub-cards currently get none of that expressiveness — just a flat string whitelist. Reusing the existing predicate/restriction vocabulary for sub-card limitations avoids inventing a second, parallel constraint language, and lets tooling (chain walkers, wallets, verifiers) that already evaluates policy predicates evaluate sub-card limitations the same way.

**Why arbitrary card fields need explicit sign-off:** The press today validates that a countersigned card's fields are "policy compliant" and "schema satisfied" (`card_protocol_spec.md §2`, issuance flow step 9) — language that reads as a closed-schema check. If cards are meant to carry fields outside `field_definitions`, that has real security consequences: an issuer or holder could smuggle in fields the policy author never reviewed, and downstream verifiers have no `update_policy` to evaluate for them. This needs a considered decision (signed but unvalidated passthrough? immutable after issuance? excluded from policy-driven update authorization?) rather than a one-line spec tweak.

**Why this touches the verifier and contracts, not just specs:** `packages/verifier/src/CardVerifier.ts` implements the chain-walk and revocation logic that `protocol-objects.md §16` describes; `contracts/logic-contract/src/subcard_ops.rs` implements `RegisterSubCard`/`DeregisterSubCard`. Both currently reflect the *current*, pubkey-list-less spec. Any schema change here is only real once the verifier enforces the holder-only-authorization/limitation checks and the on-chain/off-chain code paths agree with the updated spec — otherwise the spec update is decorative.

---

## Key Objectives

**Goal 1 — Sub-card pubkey directory on the master card**
- `CardDocument` gains a protocol-reserved field (working name `active_subcards`) listing the public key and registry pointer of every currently-active sub-card, defined in `protocol-objects.md §1.1` alongside `successor`.
- The field's authorization rule is hardcoded in the protocol (not overridable by any policy's field definitions) and is exercised only by holder-signed log entries.
- `CardVerifier.ts`'s existing "confirm the sub-card appears in the master card's active sub-card list" step (currently unimplementable, since the field doesn't exist) has real data to check against, and the check is implemented and covered by a verifier test.
- The client SDK can read a decrypted master card and obtain every active sub-card's public key in one fetch, with no additional on-chain or wallet-service round trip.
- Sub-card revocation (existing `DeregisterSubCard` flow) removes the corresponding entry from this list as part of the same holder-authorized operation, so the list never drifts from on-chain `SubCardEntry.active` state.

**Goal 2 — Arbitrary sub-card limitations**
- `SubCardDocument` gains a general limitations mechanism (beyond `capabilities`) expressed using the protocol's existing predicate/restriction vocabulary, defined in `specs/subcards.md` and `protocol-objects.md §16`.
- At minimum, the mechanism supports: field-level restrictions on what the sub-card may assert, and predicate-style constraints evaluable the same way `update_policy` and `field_requirements` are evaluated elsewhere in the protocol.
- Verifiers reject any sub-card-signed statement that violates a stated limitation, with the same rigor already required for `capabilities` (`subcards.md` Acceptance Criteria).
- The red-team plan (`plans/subcard_redteam_plan.md`) findings that already assume richer sub-card constraints (e.g. S-5 note-size limits) are expressible under the new mechanism rather than living as ad hoc policy text.

**Goal 3 — Arbitrary fields on cards**
- `card_protocol_spec.md` explicitly states that a card's field set is the protocol-required fields plus whatever `field_definitions` declares plus any additional fields the issuer/holder choose to include — the schema is a floor, not a ceiling.
- The spec defines, precisely, the trust and mutability rules for fields outside `field_definitions`: whether they're signed the same way as declared fields, whether they're mutable post-issuance, and what a verifier or auditor is expected to do when it encounters one.
- The press's issuance validation logic (and its implementation) is updated to reflect that "schema satisfied" means "required fields present," not "no fields beyond the schema."

**Goal 4 — Holder-exclusive sub-card lifecycle authority**
- Both `specs/subcards.md` and `protocol-objects.md §16` state explicitly, as a normative rule (not an inference from the signing sequence), that only the holder's primary card key may authorize adding or removing entries in a card's sub-card list — issuers have no path to do so, under any policy.
- This rule is enforced in the same protocol-reserved-field mechanism as Goal 1 (the authorization predicate for `active_subcards` updates is hardcoded, not policy-supplied).
- `contracts/logic-contract/src/subcard_ops.rs` and `packages/verifier` are audited to confirm no code path allows an issuer-signed intent to add or remove a sub-card list entry; a regression test asserts this.

---

## Open Questions — RESOLVED 2026-07-05

- ~~**[Design] Field shape.**~~ **RESOLVED** — `active_subcards` is a flat array of public keys only (no `sub_card_pointer` / `added_at` object wrapper). Each pubkey is sufficient to derive the sub-card's registry address (`keccak256(pubkey)`) client-side. Timing information is unnecessary in the directory itself, since every addition/removal is already timestamped by the log entry that changed the list (see codes 510/511 below) — duplicating `added_at` inside the field would be redundant with data the log already carries.
- ~~**[Design] List semantics on revocation.**~~ **RESOLVED** — Entries are deleted outright from `active_subcards` on removal (the field always reflects the live/current set). The removal itself is recorded permanently in the master card's append-only log via a code-511 entry with an explanatory note — history lives in the log, not in the field.
- ~~**[Engineering] New update codes.**~~ **RESOLVED** — Three protocol-reserved codes in the 5xx (programmatic update) range, already reflected in `specs/update_codes.md`: **510** (subcard addition), **511** (subcard removal), **512** (subcard key rotation — an atomic remove-old/add-new operation on the same logical sub-card slot, avoiding a remove+add pair for what is really one operation). These apply to entries on the **master card's** log (recording changes to `active_subcards`) — not the sub-card's own log, where 5xx field updates remain prohibited per `subcard_creation_policy.md §Update Card Content`. The implementation plan must state this scoping explicitly to avoid the two being conflated.
- ~~**[Design] Limitations vocabulary for Goal 2.**~~ **RESOLVED** — Reuse the existing predicate / `field_requirements` grammar (`card_protocol_spec.md` §The Predicate System) verbatim rather than inventing a parallel vocabulary for sub-card limitations.
- ~~**[Security] Arbitrary-field validation boundary (Goal 3).**~~ **RESOLVED** — Fields outside `field_definitions` are signed (covered by the same three signatures as any other field) but otherwise unvalidated by the press — no implicit `update_policy` is synthesized for them. This is an accepted, intentional trade-off: simplicity now, revisit if abuse patterns emerge.
- ~~**[Engineering] Versioning.**~~ **RESOLVED** — No migration path is needed. No cards are deployed yet under the current protocol version, so `active_subcards` (and the arbitrary-fields clarification) can ship as part of the current version-in-development with no backfill concern. A `protocol_version` bump is still appropriate procedure per `protocol-versioning.md`, but purely forward-looking.
- ~~**[Process] Scope confirmation for Goal 4.**~~ **RESOLVED** — Holder-only authorization over `active_subcards` (add, remove, and rotate) is a **hard protocol limit for this version of the protocol**, not policy-configurable and not exposed as an override point. Rationale (David's, recorded verbatim for future reference): it would be easy for a card issuer/granter to abuse a configurable version of this to spy on cardholders' sub-card activity, so this is intentionally not left open as an extension point. Revisiting this would require a deliberate future protocol version change, not a policy-level toggle.
