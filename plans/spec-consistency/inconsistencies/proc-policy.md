# Inconsistency Log — `proc-policy` (policy_creation.md)

**Unit:** `specs/process_specs/policy_creation.md`
**Requested process:** "Policy creation, updating, and revocation"
**Reviewer:** Phase 2 Step A subagent

---

## 0. Scope note: is "policy update/revocation" a genuine gap?

**Not a gap — but the pointer to where it's covered is thin and the on-chain governance side is entirely unaddressed (see Finding 3).**

`policy_creation.md` explicitly defers field updates and lifecycle changes to `card_updates.md` ("Related Specs": *"`card_updates.md` — used to add/remove auditors, presses, and update policy fields after publication"*), and step 12 of `policy_creation.md` itself invokes `card_updates.md` for adding press pointers to `approved_presses`. This is architecturally sound: a `PolicyCardDocument` **is a** `CardDocument` (`protocol-objects.md §2`), so the generic update/revocation flow in `card_updates.md` (codes 1xx–9xx) applies to policy cards without needing a bespoke "policy update" or "policy revocation" spec. `card_updates.md` itself is policy-agnostic and makes no distinction that would exclude policy cards.

However, one real gap exists at the intersection: `card_updates.md §Revocation Semantics` describes 8xx/9xx revocation of *any* card, but neither `card_updates.md` nor `policy_creation.md` states what happens to **cards already issued under a policy that is later revoked**, nor whether a policy revocation should be a distinct code range or carries special cascading semantics (e.g., does revoking a policy retroactively affect `policy_compliant` verification for cards issued under it, the way `card_validation.md` Stage 5a treats non-compliant policies?). `card_validation.md §Stage 5a` (line 117) says "Cards issued under a non-compliant policy inherit this flag" for **field-restriction non-compliance**, but is silent on whether an outright 8xx/9xx **revocation** of the policy card itself propagates the same way. This is a genuine, unaddressed lifecycle gap — log as a finding (Finding 1) rather than a silent pass.

---

## Finding 1 — Policy revocation's effect on already-issued cards is unspecified

**Specs:** `policy_creation.md` (silent), `card_updates.md` (silent), `card_validation.md` Stage 5a (line ~117)
**Issue:** `card_validation.md` addresses what happens when a policy's `field_definitions` are found non-compliant with an ancestor's `policy_creation` constraints (cards inherit `policy_compliant: false`). No spec addresses the analogous and more common case: an 8xx/9xx revocation entry posted directly to the *policy card's own log*. Does this retroactively/prospectively affect verification of cards issued under it? Does it block further issuance (presumably yes, since the press pre-flight in `policy_creation.md` step 10 walks ancestor policy chains for `policy_creation` restrictions, but doesn't check for policy-card revocation itself)? `policy_creation.md`'s own Error Paths table has no entry for "policy card has been revoked."
**Recommendation:** Add an explicit statement — either in `policy_creation.md`'s Error Paths / Postconditions, or in `card_updates.md`'s Revocation Semantics — that a revoked policy card (a) blocks new issuance under it (press must check for 8xx/9xx on the policy card during the pre-flight/issuance validation steps already listed in `policy_creation.md` and `card_offering_and_acceptance.md`), and (b) does not retroactively invalidate already-issued cards (consistent with the general 8xx/9xx semantics), mirroring the `PressAuthorizations`-revocation treatment in `card_validation.md` lines 99–103.

---

## Finding 2 — "Self-issuing" bypass of the press contradicts the mandatory 3-signature / on-chain write model

**Specs:** `policy_creation.md` step 8 vs. `protocol-objects.md §1` (CardDocument signing sequence), `card_offering_and_acceptance.md` (Actors, steps 17–18), `registry_contract.md §4.1` (`RegisterCard`)
**Issue:** `policy_creation.md` step 8 states:
> "A new Arbitrum One registry entry is created for the policy card... This write is signed by the press sub-card key acting on behalf of the authorizer (**or directly by the authorizer if self-issuing**)."

This "or directly by the authorizer" carve-out has no basis anywhere else in the now-fixed Phase 1 specs:
- `protocol-objects.md §1` lists `press_card` and `press_signature` as **Required: Yes** on every `CardDocument` with no stated exception, and `§2` states `PolicyCardDocument` "**Is a:** CardDocument (same protocol-required fields...)."
- `card_offering_and_acceptance.md` line 13 states its flow "applies to **all** targeted cards **including policy cards** and press sub-cards," and steps 17–18 have the press unconditionally validate, apply `press_signature`, and submit the on-chain registration signed by the press's secp256r1 key — no self-issuance branch.
- `registry_contract.md §4.1 RegisterCard` — the only on-chain entry point for registering a genesis card — is `**Called by:** Press (authorized for the target policy)` and its preconditions (`PressAuthorizations[policy_address][press_address]` must exist and be `active`) allow no other caller. There is no contract path for an authorizer to submit `RegisterCard` directly.

**Recommendation:** Either (a) remove the "or directly by the authorizer if self-issuing" clause from `policy_creation.md` step 8 as inconsistent with the mandatory press-mediated model, or (b) if a genuine self-issuance path is intended for root/bootstrap policies, it needs to be specified end-to-end (a new `RegisterCard`-equivalent contract entry point, and an exception to the `CardDocument` 3-signature requirement) rather than asserted in one line of `policy_creation.md` with no supporting mechanism elsewhere. This also bears on the bootstrap question in Finding 3 below — flag to David per the plan's "gap = ask before a fix agent invents a mechanism" rule, since resolving this touches the trust-root bootstrap story.

---

## Finding 3 — Bootstrapping a policy card never engages `RegisterPolicy` / `PolicyAuthorizerKeys`, and `policy_creation.md` is silent on this precondition

**Specs:** `policy_creation.md` (Preconditions, Phase 3), `registry_contract.md §4.6 RegisterPolicy` / `§3.2 PolicyAuthorizerKeys`, `§4.1 RegisterCard` precondition 2
**Issue:** `registry_contract.md §4.1 RegisterCard` precondition 2 requires `policy_address` to already **exist in `PolicyAuthorizerKeys`** before *any* card (including a policy card) can be registered under it. An entry in `PolicyAuthorizerKeys` is created only by `RegisterPolicy` (`§4.6`), which is called by a **Root Policy Governance Body** using a **quorum of secp256r1 governance signatures** (`GovernanceKeysets[RootPolicyBody]`) — an entirely separate, governance-gated process with no press involvement at all, and no mention anywhere in `policy_creation.md`.

`policy_creation.md`'s Preconditions section only says: "The authorizer holds a card (or is a trusted root) whose key will be used to sign the policy." It never states that the authorizer's own address must first be registered in `PolicyAuthorizerKeys` via `RegisterPolicy` (a governance action, distinct from anything in the "Draft → Authorize → Publish → Press Registration" flow it describes), nor identifies who the "Root Policy Governance Body" is or how it relates to the "authorizer" role defined in `policy_creation.md`'s own Actors table.

There's also a related terminology collision worth flagging: `registry_contract.md`'s `RegisterPolicy` registers an `authorizer_pubkey` that is explicitly **secp256r1** (64 bytes x||y, RIP-7212), separate from the ML-DSA-44 key used for `issuer_signature` on the policy `CardDocument` itself. `protocol-objects.md §1`'s "Press dual-key model" section documents this secp256r1/ML-DSA-44 split **only for presses**; it says nothing about policy authorizers needing an equivalent on-chain secp256r1 write key. `policy_creation.md` never mentions the authorizer needing a second, distinct on-chain key at all.
**Recommendation:** Add a precondition/step to `policy_creation.md` (likely a new "Phase 0: Authorizer Registration" or an explicit Preconditions bullet) covering: (a) the authorizer's `policy_address` must be registered via `RegisterPolicy` before any card can be issued under it (first-time authorizers only — established authorizers reusing an address skip this), (b) who operates as the "Root Policy Governance Body" and how that relates to the authorizer/administrator roles already defined, and (c) whether/how the authorizer obtains and registers a secp256r1 on-chain key distinct from their ML-DSA-44 signing key, consistent with (or extending) the dual-key model `protocol-objects.md §1` currently documents only for presses.

---

## Finding 4 — Field-name collision list in `policy_creation.md` step 2 is missing several protocol-reserved/required fields

**Specs:** `policy_creation.md` step 2 vs. `protocol-objects.md §1` (CardDocument required fields table)
**Issue:** `policy_creation.md` step 2 tells the drafter to confirm "No field name collides with protocol-required fields," listing: `policy_id, issuer_card, press_card, recipient_pubkey, issued_at, issuer_signature, holder_signature, press_signature`.

Per `protocol-objects.md §1`, the full set of required/protocol-reserved fields on a `CardDocument` (which a `PolicyCardDocument` "is a" per §2) also includes `ancestry_pubkeys` (Required: Yes) and `protocol_version` (Required: Yes), plus the conditionally-present `past_keys`, `active_subcards`, `successor`, `supersedes`, and `supersession_note` (§1.1). None of these appear in `policy_creation.md`'s collision-check list. A policy author following `policy_creation.md` literally could define a custom field named e.g. `ancestry_pubkeys` or `protocol_version` in `field_definitions` and the spec's own validation step would not catch the collision.

(Note: `card_updates.md` step 7's "Immutable fields" list has the same gap for `protocol_version` — it lists `ancestry_pubkeys` and `past_keys` but not `protocol_version`. This looks like a protocol-wide omission rather than something specific to `policy_creation.md`; flagging here since it's directly load-bearing for policy field-schema validation, but the consolidated fix may want to correct both lists together.)
**Recommendation:** Update `policy_creation.md` step 2's collision list to the complete set of protocol-required/reserved field names from `protocol-objects.md §1` and `§1.1` (`policy_id, issuer_card, press_card, recipient_pubkey, issued_at, issuer_signature, holder_signature, press_signature, ancestry_pubkeys, past_keys, protocol_version, active_subcards, successor, supersedes, supersession_note`), and cross-check/fix the equivalent list in `card_updates.md` step 7 in the same pass.

---

## Finding 5 — No press validation/signing step described between countersignature and IPFS posting in `policy_creation.md` Phase 2→3

**Specs:** `policy_creation.md` steps 5–7 vs. `card_offering_and_acceptance.md` steps 16–18 (which `policy_creation.md` step 5 explicitly cites as "the standard targeted issuance flow")
**Issue:** `policy_creation.md` step 5 correctly points to `card_offering_and_acceptance.md` for the issuance mechanics, but its own narrative in steps 6–7 skips directly from "administrator countersigns" to "completed policy card is posted to IPFS," omitting the press's mandatory validation and `press_signature` application (`card_offering_and_acceptance.md` step 17) that sits between those two steps in the cited flow. As written, a reader of `policy_creation.md` alone would not learn that a press must validate policy compliance and countersign before the policy card can be posted — they'd have to already know to consult `card_offering_and_acceptance.md` step 17 to fill the gap. This compounds Finding 2 (the erroneous self-issuance carve-out appears in exactly the sentence — step 8 — that should describe this press step but instead conflates it with the *on-chain registration* write).
**Recommendation:** Either inline a one-line summary step in `policy_creation.md` Phase 3 noting "the press validates the countersigned policy card against the meta-policy's `field_definitions` and applies `press_signature`, per `card_offering_and_acceptance.md` step 17" before the IPFS-posting step, or make the deferral to `card_offering_and_acceptance.md` explicit enough that a reader isn't misled by the abbreviated step 6→7 transition.

---

## Findings considered and ruled out (no inconsistency)

- **`meta-policy` / `policy_id` self-reference for trusted roots:** `policy_creation.md` step 5's description of `policy_id` pointing to a "meta-policy" (self-referential or well-known root CID for trusted roots) matches `protocol-objects.md §2`'s `policy_id` field description and the `ancestry_pubkeys: []` root base case. Consistent.
- **`revocation_permissions` defaults:** `policy_creation.md`'s implicit reliance on defaults matches `protocol-objects.md §2` ("defaults to holder-or-issuer for 8xx, issuer-only for 9xx") and `card_updates.md` step 7's identical statement of the same default. Consistent.
- **Policy-creation-chain walk (Stage 5a) terminology:** `policy_creation.md` step 10's description of walking "administrator's card → its policy → that policy's holder → their card → ..." matches `card_validation.md` Stage 5a's description of the same walk almost verbatim. Consistent.
- **`allow_open_offers` naming and default:** Consistent across `policy_creation.md`, `protocol-objects.md §2`, and all three open-offer process specs (`open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`).
- **`field_restrictions` / `policy_creation` object shape:** `policy_creation.md`'s description of the pre-flight check (required/prohibited/type/regex restrictions) matches the `policy_creation.field_restrictions` schema in `protocol-objects.md §2` field-by-field.

---

## Cross-reference note for Step B

Findings 2 and 3 are related (both concern the never-specified bootstrap/self-issuance path for a policy's own genesis) and may be worth consolidating into a single fix item that resolves both: either document a genuine self-issuance/bootstrap mechanism end-to-end, or strike the self-issuance language and make explicit that even a "trusted root" authorizer's policy card must be issued through a press already authorized under some pre-existing meta-policy (with the very first root policy's bootstrap handled as a one-time governance/deployment step outside the normal `policy_creation.md` flow). Given the plan's guidance ("if Step A finds a 'spec gap' is actually a missing spec entirely... stop and ask"), this may warrant flagging directly to David rather than folding into a routine consolidated fix, since it touches the trust-root bootstrap security model.
