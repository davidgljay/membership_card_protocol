# Open Questions to Resolve Before Implementation

**Date:** 2026-06-14
**Status:** Draft for review
**Scope:** A consolidated, de-duplicated, prioritized inventory of every unresolved
question in `specs/` that should be answered before — or early in — the build of the
Card Protocol. Sources are cited per item.

This is a synthesis of the per-document "Open Questions" sections plus several
cross-cutting inconsistencies surfaced while reviewing the specs that are **not** tracked
in any existing list. It does not invent new requirements; it collects what the specs
themselves flag as undecided.

> **How to read priority:** **Blocking** = must be decided before the Stylus contract is
> deployed or the `CardAuth` npm API is locked (a wrong choice is a breaking change).
> **High** = needed before the relevant subsystem is built. **Medium / Low** = can be
> resolved during implementation or deferred, but should be tracked.

---

## 0. Cross-cutting inconsistencies (not in any existing OQ list)

These were found during review and block a clean implementation start because they affect
naming, field schemas, and which document is authoritative. They are not yet captured as
numbered OQs anywhere.

### ~~X-1 — Protocol name is unsettled~~ ✅ RESOLVED 2026-06-14

**Decision:** The canonical term is **"card"** (membership card). URI scheme is `mcard://`. Package name is `card-validator` / `CardAuth`. Object names are `CardDocument`, `CardEntry`, etc. On-chain function is `RegisterCard`. All files and filenames have been updated; no remaining "chitt" or "mark" (as protocol term) references exist in the codebase.

### ~~X-2 — `registry_contract.md` and `protocol-objects.md` describe the on-chain entry differently~~ ✅ RESOLVED 2026-06-14

**Decision:** `protocol-objects.md §14` has been updated to show the full 4-field `CardEntry` struct (`log_head_cid`, `policy_address`, `last_press_address`, `exists`) and explicitly cites `registry_contract.md §3.1` as authoritative. The stale 2-field `RegistryEntry` description and name are replaced. Write-gate language updated from "appears in `approved_presses`" to "registered in on-chain `PressAuthorizations` table." Note: INC-16 tracks the parallel §15 (`SubCardRegistration`) update, which was not in scope here.

### ~~X-3 — Red-team plans target a transport the spec has removed~~ ✅ RESOLVED 2026-06-14

**Decision:** Acknowledged as stale. The Nym mixnet threat-model sections in `plans/strategic-plan.md`, `plans/implementation-plan.md`, and `plans/subcard_redteam_plan.md` are outdated following ADR-007. They should be updated to target the HTTPS/OHTTP message-server model before the red-team phase begins, but this is not an implementation blocker and is deferred until those plans are actively exercised.

### ~~X-4 — Duplicate OQ numbering across documents~~ ✅ RESOLVED 2026-06-14

**Decision:** `messaging_protocol.md` open questions renamed from OQ-1…OQ-18 → MSG-OQ-1…MSG-OQ-18, eliminating the collision with the global OQ-n series used in `ARCHITECTURE.md` and `registry_contract.md`. This consolidated document uses MSG-OQ-n for messaging questions, INC-n for spec inconsistencies, X-n for cross-cutting items, KR-n / SM-n / MA-n for subsystem questions.

---

## 0b. Spec inconsistencies & contradictions (added 2026-06-14)

These are places where two specs (or a spec and the normative conformance corpus)
contradict each other, or where one spec defines a mechanism another never reconciles. Unlike
the open questions above, these are not "undecided" — they are **already decided differently
in different places** and must be made to agree. Several are signing-critical: because every
signature commits to canonical CBOR of an exact field set, a mismatch silently breaks
cross-implementation verification.

### Signing / serialization-critical (silent interop breakage)

~~**INC-1 — Private-address derivation differs across specs (Blocking).**~~ ✅ RESOLVED 2026-06-14

**Decision:** Canonical derivation is `keccak256(sign(private_key, "card-address-v1"))`. All six references updated (`ARCHITECTURE.md`, `card_protocol_spec.md`, `protocol-objects.md §14`, `registry_contract.md §3.1`, `raw_notes/Card Creation.md`, `raw_notes/Badge Architecture Overview.md`). The unspecified `hash(...)` form and the old domain string `"card-log-v1"` have been replaced everywhere.

~~**INC-2 — `LogEntry.entry_type` is required in some places, absent in others (Blocking).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `entry_type` is required in all LogEntry objects. `card_protocol_spec.md §5` updated: `"entry_type": "field_update"` added to the LogEntry JSON example and the prose now states the code→entry_type mapping (`"field_update"` for 1xx–7xx, `"revocation"` for 8xx–9xx). `protocol-objects.md §3` and `serialization-conformance.json` already had it; all three now agree.

~~**INC-3 — Protocol-required field named `press_card` vs `press_card` (Blocking).**~~ ✅ RESOLVED 2026-06-14

**Decision:** The canonical field name is `press_card`. This inconsistency was resolved implicitly during the X-1 rename: `protocol-objects.md §1`, `card_protocol_spec.md §Background`, `policy_creation.md`, and `card_updates.md` all now use `press_card`. No outstanding discrepancy remains.

~~**INC-4 — `SignedMessageEnvelope` payload shape is contested (Blocking for messaging).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `messaging_protocol.md` format is canonical. `protocol-objects.md §5` and `card_protocol_spec.md §6` updated to match: `type` (text, required), `content` (structured object, type-specific schema per `messaging_protocol.md §2`), `senders` (master card pointers), `recipients`, `timestamp`, and the optional threading fields. MSG-OQ-1 (type field routing vs outer header) and MSG-OQ-2 (senders necessity) remain open for behavior decisions but do not block the schema freeze.

~~**INC-5 — AuthenticationResponse's `signed_statement` does not match the envelope it claims to be (High).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `signed_statement` is now a proper `SignedMessageEnvelope` (§5) with `type: "auth_response"`, `content: { statement, context, nonce }` (auth-specific content), `senders` (holder's master card), `recipients` (requester card), and `timestamp` (set by wallet at signing time). `protocol-objects.md §9` and `card_protocol_spec.md §8` step 7 updated accordingly. The nonce remains auth-specific (inside `content`) — see nonce discussion below.

### Mechanism / structural conflicts

~~**INC-6 — Two conflicting mechanisms for key-rotation / un-revocation (High).**~~ ✅ RESOLVED 2026-06-14

**Decision:** Both mechanisms are kept; they serve distinct purposes:
- **`successor`** (holder forward-pointer, codes 100/101) is the canonical mechanism for holder-initiated master key rotation — the holder sets a `successor` on their old card pointing to a new card with their new key.
- **`successor`** (issuer forward-pointer, code 102) is an additional path for issuer-initiated card recovery when a holder has lost all key access. Subject to a **72-hour pending window** and a **mandatory notification message** to the holder. The holder may cancel within 72 hours by posting a code-103 entry.
- **`supersedes` + `supersession_note`** (issuer backward-pointer on a new card) are for un-revocation — an issuer correcting an erroneous revocation by issuing a new card that points back to the incorrectly revoked one. Distinct use case from key rotation; these fields remain in `card_protocol_spec.md §Background` and `card_updates.md`.

All fields added to canonical schema: `successor` documented as a protocol-reserved updatable field in `protocol-objects.md §1.1`; `supersedes` and `supersession_note` documented in the `protocol-objects.md §1` CardDocument field table. `key_rotation.md §3.5`, §8.1, and §8.2 updated with the issuer-recovery path and codes 102/103.

~~**INC-7 — "sub-card" is overloaded across two different concepts (High).**~~ ✅ RESOLVED 2026-06-14

**Decision:** "Sub-card" is the single canonical term for all device-bound, app-specific credentials — both wallet sub-cards and third-party app sub-cards. The old "device sub-card" and "per-installation card key" terminology is retired. The wallet is itself an app with an app card; it creates sub-cards for its own use via the same `SubCardDocument` protocol as any other app (wallet self-signing skips the user approval step). Three-tier architecture: (1) primary card key — not device-bound, backed up by wallet service, cold; used only to authorize sub-card creation; (2) sub-cards — hardware-bound to device + app signing identity, non-exportable; (3) app cards — registered cards issued by governance-approved certifiers, the trust anchor for sub-card delegation. `subcards.md` fully rewritten; `key_rotation.md §1` updated; `protocol-objects.md §15–16` updated with `SubCardDocument` and `SubCardRegistration`.

~~**INC-8 — Open-offer on-chain entrypoint: dedicated function vs inline path (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `ClaimOpenOffer` is the canonical entrypoint for all open-offer claims — a press must not call `RegisterCard` for open-offer submissions. Additionally, offer constraints (`max_acceptances`, `expires_at`) are enforced by **both** the press (pre-flight read before submitting the transaction) and the contract (atomic on-chain re-validation) independently. Dual enforcement is required because open offers present a larger abuse surface than targeted issuance. Prose in `card_protocol_spec.md §2` (steps 8–9 and the enforcement paragraph) and `protocol-objects.md §7` (press validation steps) updated to reflect the separate entrypoint and dual-verification requirement.

~~**INC-9 — `max_acceptances` sentinel: `null` vs `0` (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `null` = unconstrained at the document level (canonical). On-chain (`uint64`) mapping: `null` → `type(uint64).max` (i.e., `0xFFFFFFFFFFFFFFFF`); the press performs this encoding when constructing `ClaimOpenOffer` calldata. `0` on-chain means zero acceptances permitted (the offer always reverts — a pathological case but unambiguous). `registry_contract.md §4.5` preconditions and parameter comments updated; §3.5 `OpenOfferUseCounts` description updated; `card_protocol_spec.md §2` enforcement paragraph updated with the null→sentinel mapping.

### Authority-model / posture conflicts

~~**INC-10 — "All writes go through a press" vs holder-callable on-chain ops (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** All writes go through a press. `registry_contract.md §4.3` (`RegisterSubCard`) and §4.4 (`DeregisterSubCard`) updated to "Called by: Press (authorized for the card's policy), on behalf of the sub-card holder." Gas for `RegisterSubCard` and `DeregisterSubCard` is paid from the requesting app's pre-funded gas account; the issuing organization's press sponsors `DeregisterSubCard` if the app account is empty (deregistration must never be blocked by a depleted balance). Gas for card writes (`RegisterCard`, `UpdateCardHead`, `ClaimOpenOffer`) is paid by the issuing organization's press. Holder signatures are verified off-chain by the press and retained in calldata for auditability. `registry_contract.md §4.12` (Gas Payment and Rate Limiting) documents the rate-limit defaults (1000 tx/week per policy; 10 RegisterSubCard/week per holder) and suspicious-activity notification to granting agencies at 80% of any limit. (INC-27 resolved 2026-06-15.)

~~**INC-11 — Attestation deferred by the core spec but required by subcards (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** Attestation is in scope for v1. Two tiers: **T2** (full app attestation via iOS App Attest / Android Play Integrity) is the default and required for all sub-cards. **T1** (hardware-backed key storage only — TEE/Secure Enclave) is available as a policy exception for devices that cannot support T2 (e.g. Android devices without Google Play Services, ~25–30% of Android globally). T1 must be explicitly accepted by the governing policy; absent explicit acceptance, T2 is required. The `SubCardDocument` now includes `attestation_level` (`"T2"` | `"T1"`) and `attestation_proof` (present for T2; omitted for T1). The "Not: Hardware attestation in v1" Non-Goal removed from `card_protocol_spec.md §2`. `subcards.md §Attestation Tiers` added; `protocol-objects.md §16` updated with the new fields.

~~**INC-12 — `delegated_capabilities` is not integrated with predicate-based verification (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** The `delegated_capabilities` object is replaced by the `capabilities` whitelist array on `SubCardDocument`. Verifiers enforce the whitelist: if a sub-card signed a message, check that the message's `type` field appears in the sub-card's `capabilities` array; if absent, reject regardless of cryptographic validity. `card_protocol_spec.md §7` updated with step 2a (capability check). No separate predicate mechanism is required.

### Audit-encryption model conflict

~~**INC-13 — Per-entry ML-KEM vs per-epoch AEK audit encryption coexist (High).**~~ ✅ RESOLVED 2026-06-14

**Decision:** The epoch AEK model is canonical. `ARCHITECTURE.md` ADR-003 and `protocol-objects.md §2` (PolicyCardDocument `auditors` field description) updated to match `card_protocol_spec.md §2 Audit Epoch Lifecycle`: auditors receive a per-epoch AEK wrapped once per auditor via ML-KEM-768; all entries in the epoch are encrypted under that shared AEK rather than individually per-entry. The per-entry ML-KEM description is removed from all documents.

### Hygiene / lower severity

~~**INC-14 — ML-KEM parameter set not pinned (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** ML-KEM-768 is normatively pinned. `ARCHITECTURE.md` ADR-004 updated to "ML-KEM-768 (FIPS 203, parameter set 768 is normatively pinned)." This matches the ciphertext size already assumed in `protocol-objects.md §12`.

~~**INC-15 — `press_signature` coverage wording differs (Medium).**~~ ✅ RESOLVED 2026-06-14

**Decision:** The press signs canonical CBOR of the complete LogEntry **excluding the `press_signature` field itself**, then appends `press_signature` after signing. `ARCHITECTURE.md` ADR-003 and `card_protocol_spec.md §5 step 4` updated to include the explicit exclusion. `protocol-objects.md §3` already had the correct language and is unchanged.

~~**INC-16 — `protocol-objects.md` §15 is also stale (Low).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `protocol-objects.md §15` (`SubCardRegistration`) updated to state "Written by: Press (authorized for the card's policy), on behalf of the holder — see `registry_contract.md §4.3` for the authoritative on-chain schema, preconditions, and state changes. §15 here is a high-level summary only."

~~**INC-17 — `update_codes.md` is a divergent legacy restatement (Low).**~~ ✅ RESOLVED 2026-06-14

**Decision:** `specs/update_codes.md` is now the canonical code registry. Rewritten to include: all range descriptions (1xx–9xx); all specific codes from `card_protocol_spec.md` (100–911); key-rotation codes (100/101/102/103) from `key_rotation.md`; authority rules per code; extended notes. `card_protocol_spec.md` "Initial defined codes" table replaced with a shorter reference table plus a pointer to `update_codes.md` as authoritative; codes 101/102/103 added; code 811 updated to "sub-card lost or stolen". `key_rotation.md §8.2` updated to cross-reference `update_codes.md`.

~~**INC-18 — `messaging_protocol.md` doc errors (Low).**~~ ✅ RESOLVED 2026-06-14

**Decision:** All duplicate `### 5.` headings fixed. `messaging_protocol.md` now has unique sequential headings 1 through 19: `### 6. card_offer_accepted` through `### 19. error` (previously 7 headings were off by one due to the duplicate `### 5.`). Summary table already had the correct 1–19 numbering and was not changed.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~INC-1~~ | ~~Blocking~~ | ~~Address-derivation string + hash differ~~ ✅ `keccak256(sign(key, "card-address-v1"))` | — |
| ~~INC-2~~ | ~~Blocking~~ | ~~`entry_type` required vs omitted~~ ✅ | — |
| ~~INC-3~~ | ~~Blocking~~ | ~~`press_card` vs `press_card` field name~~ ✅ resolved by X-1 rename | — |
| ~~INC-4~~ | ~~Blocking*~~ | ~~Envelope payload adds `type`/`senders`, `content` object~~ ✅ messaging format is canonical | — |
| ~~INC-5~~ | ~~High~~ | ~~Auth response payload ≠ declared envelope schema~~ ✅ | — |
| ~~INC-6~~ | ~~High~~ | ~~`successor` vs `supersedes` rotation mechanisms~~ ✅ Both mechanisms kept (different purposes); issuer-recovery path (72h delay + notification) added; all fields in canonical schema | — |
| ~~INC-7~~ | ~~High~~ | ~~"sub-card" overloaded (device vs app)~~ ✅ "Sub-card" unified; `SubCardDocument` + app-card trust chain; `subcards.md` rewritten; `key_rotation.md §1` updated | — |
| ~~INC-8~~ | ~~Medium~~ | ~~`ClaimOpenOffer` function vs inline registration~~ ✅ `ClaimOpenOffer` is the separate endpoint; dual verification (press + contract) required for abuse-surface reasons | — |
| ~~INC-9~~ | ~~Medium~~ | ~~`max_acceptances` null vs 0 sentinel~~ ✅ `null` = unconstrained (document); press encodes `null` → `type(uint64).max` in calldata; `0` = zero acceptances | — |
| ~~INC-10~~ | ~~Medium~~ | ~~"all writes via press" vs holder-callable ops~~ ✅ All writes via press; `RegisterSubCard`/`DeregisterSubCard` gas paid by requesting app's pre-funded account; press sponsors `DeregisterSubCard` if app balance empty; card write gas paid by issuing org's press; rate limits + suspicious-activity notifications added (§4.12) | — |
| ~~INC-11~~ | ~~Medium~~ | ~~Attestation deferred vs required~~ ✅ T2 (App Attest/Play Integrity) default; T1 accepted by policy exception; `attestation_level` + `attestation_proof` added to SubCardDocument | — |
| ~~INC-12~~ | ~~Medium~~ | ~~`delegated_capabilities` not in verification~~ ✅ `capabilities` whitelist; verifier step 2a added to spec §7 | — |
| ~~INC-13~~ | ~~High~~ | ~~Per-entry ML-KEM vs per-epoch AEK audit model~~ ✅ Epoch AEK model canonical; ADR-003 and protocol-objects §2 updated | — |
| ~~INC-14~~ | ~~Medium~~ | ~~ML-KEM parameter set unpinned~~ ✅ ML-KEM-768 normatively pinned in ADR-004 | — |
| ~~INC-15~~ | ~~Medium~~ | ~~`press_signature` coverage wording~~ ✅ Signs complete entry excluding `press_signature` field; ADR-003 and spec §5 updated | — |
| ~~INC-16~~ | ~~Low~~ | ~~protocol-objects §15 also stale~~ ✅ §15 updated to reference registry_contract.md §4.3 as authoritative | — |
| ~~INC-17~~ | ~~Low~~ | ~~`update_codes.md` legacy drift~~ ✅ `update_codes.md` rewritten as canonical registry; spec updated to cross-reference it | — |
| ~~INC-18~~ | ~~Low~~ | ~~messaging doc errors / object name~~ ✅ Duplicate `### 5.` headings fixed; messaging_protocol.md now has unique sequential headings 1–19 | — |

\* Blocking specifically for the messaging subsystem / envelope freeze.

> **Triage note:** INC-1, INC-2, INC-3, and INC-4 are signing-critical and belong in the same
> "resolve before npm API lock / contract deploy" bucket as Section 1. INC-13 (audit model) and
> INC-6 (rotation mechanism) should be settled before auditor and key-rotation code is written.

---

## 0c. New spec inconsistencies found 2026-06-15

A re-review of `specs/` on 2026-06-15 (after the 2026-06-14 ADR-010 serialization
reversal and the ADR-012 split-signing change) surfaced a fresh cluster of
contradictions. These are **not** in any existing INC/OQ list above and are mostly the
result of two recent edits being applied to some documents but not others. Several are
signing-critical for the same reason the original INC set was: every signature commits to
an exact serialization of an exact field set, so a document that still describes the old
encoding silently breaks cross-implementation verification.

> **INC-19 through INC-23 were resolved 2026-06-15.** The stale Section 1 CBOR note and OQ-2 / OQ-16 resolutions have been updated below.

### Signing / serialization-critical (silent interop breakage)

~~**INC-19 — Canonical serialization is split-brain: RFC 8785 (JCS) vs canonical CBOR (Blocking).**~~ ✅ **RESOLVED 2026-06-15**
ADR-010 was *reversed* on 2026-06-14: CBOR was dropped and **RFC 8785 (JSON Canonicalization
Scheme)** adopted. `card_protocol_spec.md` Appendix A, `ARCHITECTURE.md` ADR-010, and the
normative corpus `serialization-conformance.json` (which even contrasts itself against CBOR:
*"Unlike CBOR (§4.2.1), RFC 8785 uses pure Unicode code-point order"*) all now say RFC 8785.
But the following still mandate **"canonical CBOR (RFC 8949 §4.2) with protocol-specific
overrides"** as the bytes that get signed/verified:
`protocol-objects.md` (~48 references, including every object's "Serialized for signing" line
and the whole Serialization Quick Reference table labelling objects "CBOR-signed"),
`object_specs/registry_contract.md` (all `press_sig_payload`, `offer_id`, governance payloads),
`key_rotation.md` (the rotation statement is "a CBOR document"; §3.3/§8.1),
`messaging_protocol.md` (envelope signature), `subcards.md` (`SubCardDocument` signing),
and the process specs `card_signing.md`, `card_validation.md`, `card_updates.md`,
`open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`,
`open_offer_acceptance_new_wallet.md`, `card_offering_and_acceptance.md`, `log_auditing.md`.
**Most acute:** `card_signing.md §3` and `card_validation.md` describe CBOR-specific transforms —
base64url fields → CBOR byte strings, ISO-8601 timestamps → CBOR Tag 1 uint — which produce
*different bytes than RFC 8785*, where every value stays a JSON string. The signer path
(`card_signing.md`) and verifier path (`card_validation.md`) are both specified in the encoding
the project just abandoned. **Decision needed:** global find-and-replace of the CBOR
serialization language with RFC 8785 across all the documents above; delete the CBOR byte-string /
Tag-1 override text; re-derive `offer_id` / message-ID hashing over RFC 8785 bytes; and update this
OQ doc's own Section 1 note.

~~**INC-20 — `card_protocol_spec.md` still mandates ML-DSA-44 for on-chain writes; ADR-012 switched on-chain to secp256r1 (Blocking).**~~ ✅ **RESOLVED 2026-06-15**
ADR-004 (revised) + ADR-012 + `protocol-objects.md §14` + `registry_contract.md` + `key_rotation.md §6`
now use a **split signing model**: secp256r1 (RIP-7212) for on-chain write authorization,
ML-DSA-44 only for IPFS content. `card_protocol_spec.md` was never updated to match:
- *Timeline Considerations* still states *"The Arbitrum One registry contract must implement
  ML-DSA-44 signature verification via Stylus, performed in full on-chain … Full on-chain
  verification is required before contract deployment"* — the exact opposite of ADR-012, which
  defers ML-DSA-44 on-chain to Phase 3 and uses secp256r1 now.
- *The Press Model* says *"The press's signing key is the private key for its press sub-card —
  no separate press key type exists,"* contradicting the now-mandatory two-key (secp256r1 +
  ML-DSA-44) press model.
- §1 acceptance criterion *"A press sub-card whose mutable pointer does not appear in
  `approved_presses` is rejected by the Arbitrum One registry contract"* and the §2 "Smart
  contract enforcement" narrative describe the pre-ADR-011 `approved_presses` on-chain check that
  ADR-011 already replaced with the `PressAuthorizations` table.

This also means **OQ-2's resolution in this document (Section 1) is wrong**: it records "Full
on-chain ML-DSA-44 verification is retained," but `ARCHITECTURE.md` and `registry_contract.md §9`
both **closed OQ-2 the opposite way** (secp256r1 / RIP-7212). And **OQ-16's option costs are now
stale** — it cites "store `holder_pubkey` on-chain (~1,312 B/card)," the ML-DSA-44 size; on-chain
keys are now secp256r1 (64 B). **Decision needed:** rewrite the on-chain-signing passages of
`card_protocol_spec.md` for the split model; correct OQ-2 and OQ-16 here.

~~**INC-21 — `ClaimOpenOffer` requires on-chain ML-DSA-44 verification the Phase-1 contract cannot do (Blocking for open offers).**~~ ✅ **RESOLVED 2026-06-15**
`registry_contract.md §4.5` precondition 3 and error `E-14` require the **contract** to verify the
issuer's **ML-DSA-44** signature over the offer payload atomically on-chain; `card_protocol_spec.md §2`
("Open offer smart contract enforcement", check 1) says the same. But `registry_contract.md §1`,
§6.3, and ADR-012 state the Phase-1 contract has **no on-chain ML-DSA-44 verifier** — only secp256r1
via RIP-7212; the ML-DSA-44 Stylus verifier is deferred to Phase 3. As written, `ClaimOpenOffer`
is unimplementable in Phase 1. **Decision needed:** either move issuer-signature verification
off-chain (press-verified, like the `RegisterSubCard` master-signature resolution), or accept a
Phase-1 ML-DSA-44 verifier for this one path — and reconcile `card_protocol_spec.md §2` accordingly.

### Mechanism / structural conflicts

~~**INC-22 — `registry_contract.md §4.3/§4.4`: master signature verified on-chain or off-chain? (Medium).**~~ ✅ **RESOLVED 2026-06-15**
`RegisterSubCard` (§4.3) lists *"`master_signature` verifies against the master card holder's public
key"* as a **"Precondition checked by contract,"** and the error table defines `E-22
INVALID_MASTER_SIGNATURE`; `DeregisterSubCard` (§4.4) precondition 2 is parallel. But each section's
Resolution note and the §6.1 write gate say the contract verifies **only press authorization**, and
the master (ML-DSA-44) signature is verified **off-chain by the press** (and indeed the Phase-1
contract can't verify ML-DSA-44 — cf. INC-21). If verification is off-chain, the contract can never
emit `E-22`. **Decision needed:** move the master-signature checks out of the contract precondition
lists, and either remove `E-22` or relabel it a press-side (off-chain) rejection code.

### Hygiene / lower severity

~~**INC-23 — Protocol rename is incomplete; X-1 is marked resolved but "Mark"/"chitt" artifacts remain (Low–Medium).**~~ ✅ **RESOLVED 2026-06-15**
X-1 claims *"no remaining 'chitt' or 'mark' (as protocol term) references exist in the codebase"* and
*"all files and filenames updated."* They do not. `registry_contract.md` carries ~32 leftover
artifacts: the write op `UpdateMarkHead`, field `master_mark_address`, object `OpenMarkOffer`, and
error codes `MARK_ALREADY_EXISTS` / `MARK_NOT_FOUND` / `SUB_MARK_NOT_FOUND` / `SUB_MARK_ALREADY_ACTIVE`.
These conflict with the card-named equivalents used elsewhere — `protocol-objects.md` and
`card_protocol_spec.md` use **`OpenCardOffer`**, and the renamed on-chain op is **`RegisterCard`**,
so `RegisterCard` (renamed) and `UpdateMarkHead` (not renamed) coexist as sibling write ops.
Separately, a blind substring replace corrupted **"architecture" → "arcardecture"** ("arc-**hit**-ecture"
→ "arc-**card**-ecture"): `ARCHITECTURE.md`'s title is *"Arcardecture Decision Record"* and the
spelling recurs there and in `mutual_aid_mvp.md` ("onboarding arcardecture"). Even this OQ file's
title begins with a stray *"Mark "*. `mutual_aid_mvp.md` also still lists *"Product name"* as an open
blocking question, which X-1 supposedly resolved to "card." **Decision needed:** finish the rename
(decide `UpdateMarkHead`→`UpdateCardHead`, `OpenMarkOffer`→`OpenCardOffer`, `MARK_*`→`CARD_*`,
`master_mark_address`→`master_card_address` across `registry_contract.md` **and** the `card-validator`
code that references them), fix the "arcardecture" corruption, and re-verify X-1 before relying on it.

~~**INC-24 — `registry_contract.md §9` open-questions table is stale and self-contradictory (Low).**~~ ✅ **RESOLVED 2026-06-15**
§3.6 states *"Bootstrap (OQ-15, resolved 2026-06-14)"* and implements the 1-of-1 bootstrap, yet §9
still lists **OQ-15 as "Critical / Blocking" open** — the same document contradicts itself. §9 also
still lists **OQ-17** (High) and **OQ-4** (High) as open, although §3.3 already implements OQ-17 as
`next_sequence` per-press and this OQ doc marks both OQ-17 and OQ-4 resolved. **Decision needed:**
strike OQ-15/OQ-17/OQ-4 in `registry_contract.md §9`, or — for OQ-16, whose §4.3 Resolution note
says "resolved" while §9 and this doc both say "open" — pick one status and propagate it.

~~**INC-25 — Duplicate section number `§4.11` in `registry_contract.md` (Low).**~~ ✅ **RESOLVED 2026-06-15**
Two different sections are both numbered **4.11**: *RotateOnChainKeyScheme* and *Gas Payment and Rate
Limiting*. Cross-references to "§4.11" (from `protocol-objects.md`, `key_rotation.md`, and the INC-10
resolution) are therefore ambiguous. Renumber one (e.g. Gas/Rate-limiting → §4.12).

~~**INC-26 — `protocol-objects.md` §14 vs its own Serialization Quick Reference (Low).**~~ ✅ **RESOLVED 2026-06-15**
§14 was updated to secp256r1 / RIP-7212, but the Serialization Quick Reference row at the bottom of
the same file still reads *"CardEntry | Arbitrum One | On-chain; write authorized by ML-DSA-44 sig
verified by Stylus against `PressAuthorizations` table."* Update the table row to secp256r1.

~~**INC-27 — `DeregisterSubCard` gas payer: INC-10 summary vs `registry_contract.md §4.11` (Low).**~~ ✅ **RESOLVED 2026-06-15**
INC-10's table line here says *"RegisterSubCard/DeregisterSubCard gas paid by requesting app's
pre-funded account (not issuing org),"* but `registry_contract.md §4.11` assigns **`RegisterSubCard`
→ requesting app's pre-funded account** and **`DeregisterSubCard` → issuing organization's press.**
(INC-10's own prose at the top, "gas sponsored by the issuing organization's press," also disagrees
with its table line.) Reconcile the deregistration gas payer in one place.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~INC-19~~ | ~~Blocking~~ | ~~Canonical serialization split-brain: RFC 8785 (spec/ARCH/corpus) vs canonical CBOR (everything else, incl. signer & verifier paths)~~ ✅ RESOLVED 2026-06-15 — Global find-and-replace of CBOR serialization language with RFC 8785 across all spec files; CBOR-specific transforms (base64url→byte strings, Tag 1 timestamps) removed from `card_signing.md`; `card_validation.md` and all process specs updated. | — |
| ~~INC-20~~ | ~~Blocking~~ | ~~`card_protocol_spec.md` still ML-DSA-44 / full-on-chain; ADR-012 switched on-chain to secp256r1~~ ✅ RESOLVED 2026-06-15 — Timeline section, Press Model, smart contract enforcement, and acceptance criterion in `card_protocol_spec.md` updated to secp256r1 split-signing model; OQ-2 and OQ-16 corrected in this doc. | — |
| ~~INC-21~~ | ~~Blocking*~~ | ~~`ClaimOpenOffer` requires on-chain ML-DSA-44 verify the Phase-1 contract can't do~~ ✅ RESOLVED 2026-06-15 — Issuer signature verification moved to press-side only; `issuer_sig_payload`/`issuer_signature` params removed from `ClaimOpenOffer` calldata; precondition 3 removed; E-14 relabeled as press-side rejection; `card_protocol_spec.md §2` updated accordingly. | — |
| ~~INC-22~~ | ~~Medium~~ | ~~Sub-card master signature: contract precondition + `E-22` vs off-chain press verification~~ ✅ RESOLVED 2026-06-15 — Precondition 4 removed from `RegisterSubCard` contract checks; `DeregisterSubCard` precondition 2 clarified as press-side; E-22 relabeled as press-side rejection; OQ-16 marked resolved. | — |
| ~~INC-23~~ | ~~Low–Med~~ | ~~Rename incomplete (`UpdateMarkHead`, `OpenMarkOffer`, `MARK_*`, `master_mark_address`) + "arcardecture" corruption; X-1 wrongly marked resolved~~ ✅ RESOLVED 2026-06-15 — All renames applied in `registry_contract.md`, `protocol-objects.md`, `key_rotation.md`, and process specs; "arcardecture" corruption fixed in `ARCHITECTURE.md`; `mutual_aid_mvp.md` product name resolved to "Card". | — |
| ~~INC-24~~ | ~~Low~~ | ~~`registry_contract.md §9` OQ table stale/self-contradictory~~ ✅ RESOLVED 2026-06-15 — OQ-15, OQ-16, OQ-4, OQ-17 struck and annotated with resolution text in §9. | — |
| ~~INC-25~~ | ~~Low~~ | ~~Duplicate `§4.11` (RotateOnChainKeyScheme & Gas/Rate-limiting)~~ ✅ RESOLVED 2026-06-15 — Gas/Rate-limiting renumbered to §4.12; TOC updated; §4.3/§4.4 cross-references updated. | — |
| ~~INC-26~~ | ~~Low~~ | ~~protocol-objects §14 (secp256r1) ↔ its own Serialization Quick Reference (ML-DSA-44/Stylus)~~ ✅ RESOLVED 2026-06-15 — Serialization Quick Reference `CardEntry` row updated to secp256r1/RIP-7212; `SubCardRegistration` row updated to reflect press secp256r1 on-chain + master ML-DSA-44 off-chain. | — |
| ~~INC-27~~ | ~~Low~~ | ~~DeregisterSubCard gas payer: INC-10 summary ↔ `registry_contract.md §4.11`~~ ✅ RESOLVED 2026-06-15 — Decision: app pre-funded account pays for both `RegisterSubCard` and `DeregisterSubCard`; issuing org's press sponsors `DeregisterSubCard` if app balance is empty. Updated §4.12 table, prose, and acceptance criteria; §4.4 header; INC-10 resolution note. | — |

\* Blocking specifically for the open-offer issuance path.

> **Root cause:** two 2026-06-14 changes — the ADR-010 serialization reversal (CBOR → RFC 8785) and
> the ADR-012 split-signing switch (on-chain ML-DSA-44 → secp256r1) — were applied to a subset of
> documents. INC-19 and INC-20 are each a "finish propagating the change" task more than an open
> design question, but until propagated they are genuine signing-critical blockers. INC-21 and INC-22
> are real design gaps the propagation exposed.

---

## 0d. Second-pass review 2026-06-15

A second sweep on 2026-06-15 covered the files not deeply read in the 0c pass (`key_rotation.md`,
`update_codes.md`, and the `process_specs/` set) and re-checked the 0c findings.

### Status of the 0c items (INC-19 – INC-27)

**All nine 0c inconsistencies are now resolved in the specs** — they were fixed between the two
reviews:

- **INC-19** (CBOR vs RFC 8785) — ✅ resolved. Zero `canonical CBOR` / `RFC 8949` references remain
  anywhere in `specs/`; every signing/verifying path now cites RFC 8785 (JCS).
- **INC-20** (`card_protocol_spec.md` on-chain ML-DSA-44) — ✅ resolved. *The Press Model* and
  *Timeline Considerations* now describe the secp256r1 (RIP-7212) / ML-DSA-44 split; the §1
  acceptance criterion now references `PressAuthorizations` instead of on-chain `approved_presses`.
- **INC-21** (`ClaimOpenOffer` on-chain ML-DSA-44 issuer sig) — ✅ resolved *in `registry_contract.md
  §4.5` and `card_protocol_spec.md §2`*: issuer-signature verification moved to press pre-flight; the
  contract no longer receives or verifies it. **But see INC-36 — the fix wasn't propagated everywhere.**
- **INC-22** (sub-card master-sig on-chain vs off-chain) — ✅ resolved. §4.3/§4.4 now carry "Master
  signature is press-side only" notes; E-22/E-14 reclassified as press-side errors.
- **INC-23** (incomplete rename) — ✅ resolved. `UpdateMarkHead`→`UpdateCardHead`,
  `OpenMarkOffer`→`OpenCardOffer`, `master_mark_address`→`master_card_address`, `MARK_*`→`CARD_*`,
  and "Arcardecture"→"Architecture" are all fixed. (One literal "Mark a sub-card as inactive" remains
  in `registry_contract.md §4.4` — that's the English verb, not the protocol term. **But INC-32/INC-31
  below catch rename artifacts the 0c sweep missed in `key_rotation.md` and `card_validation.md`.**)
- **INC-24** (registry §9 OQ table stale) — ✅ resolved. OQ-15/OQ-4/OQ-17 are struck and marked
  resolved with §-references.
- **INC-25** (duplicate §4.11) — ✅ resolved. Now §4.11 RotateOnChainKeyScheme / §4.12 Gas Payment.
- **INC-26** (protocol-objects table ML-DSA/Stylus row) — ✅ resolved.
- **INC-27** (DeregisterSubCard gas payer) — ✅ resolved. §4.4 now: app pre-funded account, issuing
  org as fallback.

### New inconsistencies found this pass

**~~INC-28 — `card_signing.md` defines a `SignedMessageEnvelope` that disagrees with the canonical schema (Blocking, signing-critical).~~ ✅ RESOLVED 2026-06-15 (see resolution note below).**
The envelope is signed byte-for-byte, so its field set and field names must be identical across
specs. `card_signing.md` diverges from `protocol-objects.md §5`, `messaging_protocol.md §1`,
`card_protocol_spec.md §6`, and `card_validation.md` in three ways:
- *Payload type field:* `card_signing.md` uses **`message_type`**; every other spec uses **`type`**
  inside `payload`. Different field name in the signed bytes.
- *`signer_card` dropped:* `card_signing.md`'s `SignatureEntry` contains only `public_key` +
  `signature` and states the address "is derived from `public_key` by verifiers; it is not included."
  All other specs include **`signer_card`** in the `SignatureEntry`, and `card_validation.md` Stage 2
  *resolves* `signer_card`. Worse, deriving the address from `public_key` only works for **public**
  cards — private / selectively-shared addresses are `keccak256(sign(private_key, "card-address-v1"))`
  and cannot be derived from the public key, so the verifier could not locate the signer's registry
  entry at all.
- *Extra `forwards` field + `ForwardPackage`:* `card_signing.md` adds a `forwards` payload field and a
  `ForwardPackage` object and makes `edit_of`/`retracts`/`forwards` three-way mutually exclusive;
  `card_protocol_spec.md §6` and `protocol-objects.md §5` define only `edit_of`/`retracts` (two-way)
  and no `forwards`. **Decision needed:** reconcile the envelope schema in one place (`type` vs
  `message_type`; `signer_card` in or out; whether `forwards`/`ForwardPackage` is part of the protocol)
  and align the other four documents to it.

> **✅ RESOLVED 2026-06-15.** Decisions applied across all envelope specs (`card_signing.md`,
> `protocol-objects.md §5`, `messaging_protocol.md §1`, `card_protocol_spec.md §6`, `card_validation.md`):
> 1. **Field name is `type`** everywhere (`message_type` removed from `card_signing.md`).
> 2. **`SignatureEntry` carries only `public_key` + `signature`.** `signer_card` was removed from *all*
>    signed objects (envelopes, LogEntry intent/press signatures, SCIP) — not just envelopes — and the
>    signer's registry address is derived as `keccak256(public_key)`. Verification flows
>    (`card_protocol_spec.md §7` Stage 2, `card_validation.md` Stage 2) updated to derive the address.
>    The `signer_card` field that remains in the verification *result* objects is an output (the
>    resolved address), not a signed input.
> 3. **`forwards` + `ForwardPackage` are now canonical**: added to `protocol-objects.md §5.1`,
>    `messaging_protocol.md §1`, and `card_protocol_spec.md §6` (three-way mutual exclusion with
>    `edit_of`/`retracts`; non-recipient delivery without a `ForwardPackage` is rejected).
>
> **Related decision — private-card privacy model removed (resolves the address-derivation concern in
> sub-point 2).** Per the same instruction ("no need to support private cards; a card should always be
> readable if its public key is shared"), the ADR-006 privacy model was removed: a single public
> address derivation `keccak256(recipient_pubkey)`, plaintext on-chain CIDs and IPFS content *(corrected 2026-06-15: IPFS card content is encrypted per ADR-006 — see INC-38)*, and no
> address secret / per-card decryption key / capability bundle. Swept across `ARCHITECTURE.md` ADR-006
> (retitled *Address Model — Single Public Derivation*) and ADR-005, `card_protocol_spec.md`
> *Card Address Model*, `protocol-objects.md §14`, `registry_contract.md §3.1`, `messaging_protocol.md`
> (address model + the `capability_grant` message type removed and types renumbered + MSG-OQ-14 retired),
> `message_routing.md`, and `card_signing.md`. Message-level confidentiality is unaffected — it remains
> provided by E2E message encryption (ADR-007), which is separate from the card address model. **Note:**
> the keyring decryption key (passkey + service_secret) used for YubiKey backup/recovery is a different
> mechanism (key custody) and was intentionally left in place.

**~~INC-29 — Offer signing actor / press-key custody conflict (High).~~ ✅ RESOLVED 2026-06-15.** Adopted a three-party signing sequence: the offerer's wallet service constructs the offer and signs it with the **offerer's own card key** (`issuer_signature`); the recipient countersigns (`holder_signature`); the offerer validates; the card is then sent to the press, which signs last with the **press sub-card key** (`press_signature`) and registers it. Added `issuer_card` + `issuer_signature` + `press_signature` to the CardDocument fields (replacing the single `offer_signature`); policy cards (authorizer-issued, no press) carry `issuer_signature` + `holder_signature` only. Updated `card_protocol_spec.md` (fields, Press Model, §2, §4, criteria), `protocol-objects.md §1/§2`, `ARCHITECTURE.md` ADR-005 + data flow, `card_offering_and_acceptance.md`, the open-offer specs, `messaging_protocol.md` (`card_offer`), and the immutable-field lists. Original finding:
`card_offering_and_acceptance.md` has the **"issuer's wallet service"** assemble the offer and sign it
**"with its press sub-card private key"** (Actors table; Phase 3 steps 6–8), then the press validates
and posts. But `card_protocol_spec.md §2`/§4, `ARCHITECTURE.md` ADR-005, and `protocol-objects.md §1`
("Signed by: Press (offer)") have **the press** hold the press sub-card key and sign the offer —
user-sovereign custody hinges on the press, not the issuer's wallet service, holding that key.
**Decision needed:** state unambiguously who holds the press sub-card key and signs `offer_signature`;
fix `card_offering_and_acceptance.md` if the press is the signer.

**~~INC-30 — `card_validation.md` adds a mandatory non-compliance-reporting regime not in the core spec (High).~~ ✅ RESOLVED 2026-06-15.** Non-compliance is reported to the **Press Registry Body** (ADR-011), which can revoke the press — a press must verify content before posting, so non-compliant content on-chain is press accountability, not an application trust decision. Removed the undefined `certification_authority` field and "press certification authority" entity; updated `card_validation.md` Stage 5 + Postconditions + Error Paths, and reconciled `card_protocol_spec.md §7` (the reporting obligation is now a stated exception to the "returns facts" Non-Goal). Original finding:
`card_validation.md` Stage 5 makes it **mandatory** ("the verifier MUST submit a non-compliance report
to the press certification authority identified in the policy snapshot's `certification_authority`
field"). This introduces three things that exist nowhere else:
- `certification_authority` is **not a field** of `PolicyCardDocument` (`protocol-objects.md §2`,
  `card_protocol_spec.md §1`).
- a **"press certification authority"** entity that is undefined (the only governance bodies are the
  Root Policy Body and Press Registry Body, per ADR-011).
- new per-signature result fields `policy_compliant`, `policy_match`, `non_compliance_reported`, absent
  from the `card_protocol_spec.md §7` result schema.

It also contradicts `card_protocol_spec.md §7`'s stated Non-Goals ("**Not:** Making trust decisions on
behalf of the application" — verification "returns facts") and the independence property: this spec's
own Postconditions admit the verifier now contacts an external authority. And it makes the
field-definition compliance check run "**Always** … for every verified card," whereas §7 scopes the
policy check to authentication flows. **Decision needed:** decide whether mandatory reporting + a
certification authority are in scope; if so, define the entity and the `certification_authority` policy
field and update §7; if not, remove this from `card_validation.md`.

**~~INC-31 — npm API surface names differ between `card_validation.md` and `card_protocol_spec.md §7` (Medium; npm-API-lock).~~ ✅ RESOLVED 2026-06-15.** The concrete npm API is out of scope for the process specs and is deferred to a future dedicated npm-package spec. Removed the npm API code blocks from `card_validation.md` and `card_protocol_spec.md §7` (replaced with deferral notes); the specs now define only the verification *procedure*/semantics, not the package surface. Original finding:
`card_validation.md`'s API block uses `createRequest({ requesterMark, … })`, `findMatchingMarks(…)`,
`signResponse(request, chosenMark, subMarkKey)` — old "Mark" names. `card_protocol_spec.md §7` uses
`createRequest({ requesterCard, … })`, `findMatchingCards(…)`, `signResponse(request, chosenCard,
subCardKey)`. The public API is specified two ways (and the `card_validation.md` form is a rename
artifact INC-23 missed). Lock one before the npm API is frozen.

**~~INC-32 — The dual-signed key-rotation statement has two schemas, plus `old_marks`/`new_marks` rename artifacts (Medium, signing-relevant).~~ ✅ RESOLVED 2026-06-15.** Standardized on the `statement_type: "key_rotation"` discriminator in both `key_rotation.md` §3.3 and §8.3 (removed `doc_type`), and renamed `old_marks`/`new_marks` → `old_cards`/`new_cards`. Original finding:
`key_rotation.md §3.3` defines the rotation statement with `"statement_type": "key_rotation"`; `§8.3`
defines the *same* document with `"doc_type": "card_key_rotation_statement"`. Both also use the field
names **`old_marks` / `new_marks`** (should be `old_cards`/`new_cards` per the card rename). Because
the statement is dual-signed and verifier-checked, its schema and field names must be singular and
final. **Decision needed:** pick one discriminator (`statement_type` vs `doc_type`) and rename
`old_marks`/`new_marks`.

~~**INC-33 — `code_equals` predicate is used but undefined (Medium).**~~ ✅ **RESOLVED 2026-06-15** — see table below.
`key_rotation.md §4.3`'s recommended `revocation_permissions` uses `{ "code_equals": 910 }`, but the
Predicate System (`card_protocol_spec.md §Background`) defines no `code_equals` leaf, and its
predicates evaluate a *subject's card chain*, not the update code. `revocation_permissions` already
keys by range (`"8xx"`/`"9xx"`); a per-code predicate needs an explicit definition.

~~**INC-34 — "Per-installation card key" terminology persists, contradicting INC-7 (Low–Medium).**~~ ✅ **RESOLVED 2026-06-15** — see table below.
INC-7 (resolved) retired "per-installation card key" in favor of the unified "sub-card." But
`key_rotation.md` still had a distinct **§2 "Per-Installation Card Key Rotation,"** the Overview called
`subcards.md` the "(per-installation card keys)" companion, and §5.2 distinguished "device sub-cards"
from "per-installation sub-cards." §2 was also largely redundant with §1 (Sub-Card Key Rotation).

~~**INC-35 — `message_routing.md` requires on-chain structures absent from `registry_contract.md` (Medium).**~~ ✅ **RESOLVED 2026-06-15** — see table below.
`message_routing.md` depends on a **Wallet Service Registry** table in the registry contract
(`wallet_service_id`, `endpoint`, `transport_flags`, `active`), `RegisterWalletService` /
`RevokeWalletService` write ops, a `MigrateCard` event, and a `wallet_service_id` carried in
`RegisterCard` calldata. **Decision:** routing state is off-chain; the Wallet Service Registry will not live in the contract. Full design deferred to the wallet service spec.

~~**INC-36 — The INC-21 fix (issuer signature is press-side, not on-chain) was not fully propagated (Medium).**~~ ✅ **RESOLVED 2026-06-15** — see table below.
`registry_contract.md §4.5` and `card_protocol_spec.md §2` correctly state the contract does **not**
verify the issuer signature. Three remaining locations have been updated to match: `protocol-objects.md §14`, `protocol-objects.md §7` step 6 (E-14 reclassified as press-side), and `open_offer_creation.md §On-Chain Counter Initialization`.

### Hygiene / low-severity (this pass)

- **Stale `RegistryEntry` name in cross-references.** §14 is now "CardEntry," but
  `open_offer_creation.md` §Related ("`protocol-objects.md §14` — `RegistryEntry`") and the
  `registry_contract.md` footer still call it `RegistryEntry`.
- **`approved_presses` as the on-chain write gate** still appears in `card_offering_and_acceptance.md`
  step 17 ("verified on-chain against `approved_presses`"), contradicting ADR-011 (the gate is
  `PressAuthorizations`; `approved_presses` is an audit surface). `card_protocol_spec.md` was fixed
  here; this process spec was not.
- **`PolicyMarkDocument`** (rename artifact) in `policy_creation.md` (×2) vs `PolicyCardDocument` in
  `protocol-objects.md §2` — the §2 cross-reference even names the wrong object.
- **`card_validation.md` duplicate step numbers** — two "20." and two "21." across Stages 5/5a/6.
- **`key_rotation.md` Overview says "five distinct categories"** but the table lists four.
- **`key_rotation.md §3.3` ordering note** reads "Steps 3–5 … should be completed before step 5"
  (should be steps 3–4 before step 5).
- **`ARCHITECTURE.md` OQ table** still lists **OQ-4** as open (line ~602) though `registry_contract.md
  §9` and this doc mark it resolved.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~INC-28~~ | ~~Blocking~~ | ~~Envelope schema diverges: `message_type` vs `type`, `signer_card` dropped, extra `forwards`/`ForwardPackage`~~ ✅ **RESOLVED 2026-06-15** — `type` everywhere; `SignatureEntry` = `public_key`+`signature` only (address = `keccak256(public_key)`); `forwards`/`ForwardPackage` canonicalized; private-card privacy model removed (ADR-006). *(corrected 2026-06-15: card content is encrypted per ADR-006; see INC-37/INC-38 — only the on-chain CID is plaintext, not the IPFS content)* | — |
| ~~INC-29~~ | ~~High~~ | ~~Offer signed by "issuer's wallet service" with the press sub-card key vs press-signed offer~~ ✅ **RESOLVED 2026-06-15** — three-party sequence: offerer signs (`issuer_signature`) → recipient countersigns (`holder_signature`) → offerer validates → press signs last (`press_signature`). | — |
| ~~INC-30~~ | ~~High~~ | ~~Mandatory non-compliance reporting + `certification_authority` field~~ ✅ **RESOLVED 2026-06-15** — reported to the Press Registry Body (ADR-011); `certification_authority` removed; §7 reconciled. | — |
| ~~INC-31~~ | ~~Medium~~ | ~~npm API names diverge across specs~~ ✅ **RESOLVED 2026-06-15** — npm API removed from process specs and §7; deferred to a future npm-package spec. | — |
| ~~INC-32~~ | ~~Medium~~ | ~~Rotation statement: `statement_type` vs `doc_type`; `old_marks`/`new_marks` artifacts~~ ✅ **RESOLVED 2026-06-15** — standardized on `statement_type`; renamed to `old_cards`/`new_cards`. | — |
| ~~INC-33~~ | ~~Medium~~ | ~~`code_equals` predicate used but undefined in the predicate system~~ ✅ **RESOLVED 2026-06-15** — `code_equals` defined as a leaf predicate in `card_protocol_spec.md §Background` (The Predicate System). Evaluates the update code of the current operation (not the subject's chain); valid only inside `revocation_permissions` predicates. Prose note added clarifying it is the sole context-predicate (vs. chain-predicates). | — |
| ~~INC-34~~ | ~~Low–Med~~ | ~~"Per-installation card key" term persists; §2 redundant with §1~~ ✅ **RESOLVED 2026-06-15** — `key_rotation.md §2` ("Per-Installation Card Key Rotation") folded into §1 as new §1.5 ("Reinstallation and Migration"); all "per-installation card key/sub-card" and "device sub-card" terminology replaced with "sub-card" throughout; Overview companion reference updated; "five distinct categories" → "four distinct categories"; sections renumbered §3–§9 → §2–§8 accordingly. | — |
| ~~INC-35~~ | ~~Medium~~ | ~~Routing needs a Wallet Service Registry table/ops/event + `RegisterCard` `wallet_service_id` not in the contract~~ ✅ **RESOLVED 2026-06-15** — Decision: the Wallet Service Registry will not live on-chain. Routing state is off-chain; the full registry design will be specified in the wallet service spec. `message_routing.md §Wallet Service Registry` updated with a status note reflecting this decision. No changes to `registry_contract.md`. | — |
| ~~INC-36~~ | ~~Medium~~ | ~~INC-21 fix not propagated: on-chain issuer-sig verification still described~~ ✅ **RESOLVED 2026-06-15** — Three locations updated to match the press-side model: (1) `protocol-objects.md §14` contract-checks paragraph rewritten — issuer signature is press pre-flight, not a contract check; remaining contract checks renumbered 1–4; (2) `protocol-objects.md §7` step 6 — E-14 noted as press-side rejection, not a contract revert code; contract reverts surface only E-12/E-13; (3) `open_offer_creation.md §On-Chain Counter Initialization` — `issuer_signature` removed from calldata description; press-side pre-flight verification noted explicitly. | — |

> **Pattern:** the 0c blockers were fixed by editing the documents named in 0c, but several *sibling*
> documents that describe the same mechanisms (`card_signing.md`, `card_validation.md`,
> `key_rotation.md`, the `process_specs/`, `protocol-objects.md`) were not swept. INC-28, INC-31,
> INC-32, and INC-36 are propagation gaps of the same kind that 0c flagged; INC-29, INC-30, INC-33, and
> INC-35 are substantive design gaps those documents expose. A single editorial pass that treats
> `protocol-objects.md` + `card_protocol_spec.md` as authoritative and reconciles every other document
> to them would clear most of this section.

---

## 0e. Third-pass review 2026-06-15 — content-encryption reintroduction

A third sweep on 2026-06-15 focused on `ARCHITECTURE.md`, `card_protocol_spec.md`,
`protocol-objects.md`, and `process_specs/card_validation.md`. It surfaced a new cluster
centered on one change that postdates the 0d review: **card *content* on IPFS is now
encrypted again.** The INC-28 resolution above originally recorded that the ADR-006 privacy model was
*removed* in favor of "plaintext on-chain CIDs **and IPFS content**" (corrected 2026-06-15: card content is encrypted per ADR-006; only the on-chain CID is plaintext — see INC-38). The specs were
subsequently revised (ADR-006 "revised 2026-06-15 — Address Model — Single Public
Derivation") to re-introduce content encryption — AES-256-GCM under a key derived from the
card's public key. That single revision was applied to the architecture and object specs but
its consequences were not traced through the verification model, and it re-opens questions the
0d pass believed closed. These are **not** in any INC/OQ list above.

### Substantive design gap

~~**INC-37 — Re-introduced card-content encryption breaks third-party chain-walk verification (Blocking, substantive).**~~ ✅ **RESOLVED 2026-06-15**

**Decision (Option 2):** Card content remains encrypted on IPFS (encryption is retained; INC-39's domain rename to `"card-content-v1"` is resolved — see §0e). To restore third-party chain-walk verification without requiring verifiers to already possess ancestor public keys, every `CardDocument` (including `PolicyCardDocument`) now carries a protocol-required field **`ancestry_pubkeys`**: an ordered array of base64url ML-DSA-44 public keys (1,312 bytes each), one per ancestor card the verifier must traverse to reach a trusted root — ordered from immediate parent up toward the root, covering the issuer chain and the press/policy chain as applicable. Set at issuance by the offerer; covered by all three signatures (`issuer_signature`, `holder_signature`, `press_signature`).

**Binding/security requirement:** `ancestry_pubkeys` is an **untrusted hint**. A verifier MUST, for each entry, confirm `keccak256(entry_pubkey)` equals the on-chain address it is resolving (the mutable pointer from the prior link). A wrong or forged pubkey yields either an address mismatch (caught by the binding check) or an AES-GCM authentication failure when decrypting the ancestor ciphertext (caught by decryption). Either is a hard rejection; the chain walk aborts. This prevents the array from being used to substitute a forged ancestor. Per-link on-chain addresses remain authoritative; `ancestry_pubkeys` is a performance hint that enables parallel content-key derivation and decryption.

**Files updated:** `specs/protocol-objects.md` §1 (CardDocument JSON example and field table; signing-sequence notes; §2 PolicyCardDocument note and JSON example; §7 open-offer assembly note; Serialization Quick Reference), `specs/card_protocol_spec.md` (Protocol-Required Fields table; §2 issuance flow step 5; §2 acceptance criteria; §4 step 8; §7 chain walk stage 3; §7 acceptance criteria), `specs/ARCHITECTURE.md` ADR-006 (new "Ancestor Key Hint" subsection; Chain Verification data flow updated), `specs/process_specs/card_validation.md` (Stage 2 steps 6–7 added leaf-card decryption; Stage 3 full rewrite to use `ancestry_pubkeys` with binding check; Stage 5a cross-reference; Stage 6 annotation note; Error Paths table updated).

### Documentation contradiction

~~**INC-38 — INC-28 resolution note (plaintext content) contradicts the current specs (encrypted content) (Medium).**~~ ✅ **RESOLVED 2026-06-15**
~~This file's INC-28 resolution (§0d) states "plaintext on-chain CIDs **and IPFS content**" and
"the ADR-006 privacy model was removed." The live specs disagree: `ARCHITECTURE.md` ADR-006,
`card_protocol_spec.md §Address Model`, `protocol-objects.md §1` (and the `key_rotation.md` §6
acceptance criterion about deriving an *old* card's content key to decrypt historical entries)
all now specify AES-256-GCM content encryption. The record is stale and should be corrected once
INC-37 is decided. Separately, **within `ARCHITECTURE.md`** the wording conflicts: ADR-005
("**Card content and on-chain CIDs are public.** … anyone holding a card's public key can resolve
and read it") reads as plaintext, while ADR-006 ("IPFS card content is **encrypted**") is the
authoritative mechanism. Reconcile ADR-005's "public" to "readable by any holder of the card's
public key" (or to plaintext, per INC-37).~~

**Resolution:** `ARCHITECTURE.md` ADR-005 "Privacy Properties of the Press" section updated: the stale "Card content and on-chain CIDs are public" bullet replaced with "On-chain CIDs are public; card content is encrypted" (AES-256-GCM under a content key derived from the card's public key per ADR-006). The INC-28 resolution note in §0d and the §0e introductory prose corrected with a dated annotation. No spec mechanism changed; all edits are record-keeping only.

### Hygiene / crypto-domain

~~**INC-39 — KDF domain separator retains the "mark" prefix; X-1/INC-23 claimed all "mark" artifacts removed (Low–Medium, freeze before crypto code locks).**~~ ✅ **RESOLVED 2026-06-15.** Domain renamed to `"card-content-v1"` across all spec files (`ARCHITECTURE.md`, `card_protocol_spec.md`, `card_validation.md`, `key_rotation.md`); TOC anchor corrected to `#42-updatecardhead` in `registry_contract.md`.
~~The content-key domain string is `info="mark-card-content-v1"` in `ARCHITECTURE.md` (lines ~306,
~315), `card_protocol_spec.md` (§Address Model, line ~37), and `key_rotation.md` (line ~262) —
a leftover "mark" prefix (note: the old `"card-address-v1"` address-derivation domain no longer
exists — address derivation is now the bare `keccak256(recipient_pubkey)` — so `"mark-card-content-v1"`
is the *only* remaining KDF/domain constant, and it carries the wrong prefix). This contradicts
X-1/INC-23's assertion that no "mark" protocol artifacts remain. It is currently *consistent*
across all three files, so it is not a cross-implementation break **today**, but it is a
signing/derivation-critical constant: once the `card-validator` HKDF code and the Stylus/clients
lock it, a later cleanup becomes a breaking change. **Decision needed:** rename to
`"card-content-v1"` now, or consciously keep `"mark-card-content-v1"`. (If INC-37 resolves to
plaintext content, this string is deleted and the question is moot.) Related minor artifact: the
`registry_contract.md` table-of-contents anchor `#42-updatemarkhead` still says "mark" though the
heading text was renamed to `UpdateCardHead`.~~

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~**INC-37**~~ | ~~**Blocking**~~ | ~~Re-introduced AES-GCM card-content encryption (key from `recipient_pubkey`) makes ancestor cards undecryptable to a third-party walker (only the address/hash is known), breaking issuer-signature verification, chain-walk to trusted root, annotation filtering, and the "verifiable by anyone" goal~~ ✅ **RESOLVED 2026-06-15** — Option 2 chosen: `ancestry_pubkeys` array added as a protocol-required immutable field (ordered from immediate parent toward root, base64url ML-DSA-44 pubkeys); covered by all three signatures; walkers bind each entry with `keccak256(entry_pubkey)` == on-chain address check before deriving content key and decrypting. | — |
| ~~**INC-38**~~ | ~~Medium~~ | ~~This doc's INC-28 resolution ("plaintext IPFS content") contradicts current specs ("encrypted"); ADR-005 "content is public" vs ADR-006 "content is encrypted"~~ ✅ **RESOLVED 2026-06-15** — INC-28 note corrected; ADR-005 "Card content and on-chain CIDs are public" bullet replaced with accurate wording distinguishing plaintext CID from encrypted IPFS content. | — |
| ~~**INC-39**~~ | ~~Low–Med~~ | ~~KDF domain `"mark-card-content-v1"` retains "mark" prefix (now the only KDF/domain constant left); contradicts X-1/INC-23 "all mark artifacts removed"; freeze before HKDF code locks. Plus stale TOC anchor `#42-updatemarkhead`~~ ✅ **RESOLVED 2026-06-15** — Domain is now `"card-content-v1"` across all specs; TOC anchor corrected to `#42-updatecardhead`. | — |

> **Root cause:** the ADR-006 *re-introduction* of content encryption (2026-06-15, after the 0d
> sweep) was applied to the address/object specs but not traced through the verification path. The
> INC-28 note that declared content plaintext was never revisited. INC-37 is a genuine design
> decision (is content confidentiality a requirement, and if so how do walkers get ancestor keys);
> INC-38 and INC-39 are propagation/record-keeping cleanups that the same decision resolves.

---

## 0f. Fourth-pass review 2026-06-15 — `ancestry_pubkeys` follow-through

A fourth sweep on 2026-06-15 re-checked the whole `specs/` tree **after** the INC-37 fix
(the new `ancestry_pubkeys` array on `CardDocument`/`PolicyCardDocument`) landed. The fix is
internally consistent for the master→root walk, but it solved only one of the boundaries the
content-encryption model breaks. The decisive gap is at the **sub-card boundary**, which is the
entry point of essentially every verification (almost all signed statements are produced by a
sub-card, not a master card). These are **not** in any INC/OQ list above.

### Substantive design gap (same class as INC-37, not covered by its fix)

~~**INC-40 — The sub-card→master and sub-card→app-card hops still cannot be decrypted; `ancestry_pubkeys` was added to `CardDocument` but not to `SubCardDocument` (Blocking for the verification path).**~~ ✅ RESOLVED 2026-06-15
INC-37 added `ancestry_pubkeys` to `CardDocument`/`PolicyCardDocument`, letting a walker go from a
**decrypted master card** up to the root. But a verifier almost never starts at a master card — it
starts at a `SignedMessageEnvelope` (or AuthResponse / LogEntry) signed by a **sub-card**. The flow
(`card_validation.md` Stage 2) is:
1. Stage 2 step 6 decrypts the **leaf sub-card** document with the signer's `public_key` from the
   `SignatureEntry` (content key `HKDF-SHA3-256(public_key, info="card-content-v1")`). ✓ works.
2. Stage 2 step 7 must "confirm the sub-card appears in the active sub-card list of its claimed
   **master card's current metadata**," and step 8 must "verify the **master card's** ML-DSA-44
   signature on the sub-card registration." Both require reading the **master (primary) card**, whose
   IPFS content is encrypted under the *master's* public key.
3. The decrypted `SubCardDocument` (§16) gives only **pointers** — `holder_primary_card` and
   `app_card` are `card-pointer` (= on-chain address = `keccak256(pubkey)`, one-way) — **not** the
   master's or app card's public key. `SubCardRegistration` (§15) likewise stores only addresses
   and a CID. The messaging envelope's `senders` (§5) is also a master **pointer**, not a pubkey.

So the verifier holds the sub-card pubkey but **cannot derive the master card's pubkey**, cannot
compute the master content key, cannot decrypt the master card — and therefore cannot read the
master's active-sub-card list, cannot verify the holder/primary signature on the registration, and
cannot even reach the master card's own `ancestry_pubkeys` (which is inside the ciphertext it can't
open). The identical problem applies to the `app_card` certification chain (Stage 2/§16 verifier
step 5: "`app_card` chains to the governance app-certification policy root"). `ancestry_pubkeys` on
the master/app cards does not help, because you must already be able to decrypt those cards to read
it. This also makes messaging **MSG-OQ-2**'s proposed alternative ("clients infer master identity
via the sub-card→master link") unimplementable under content encryption.

**Suggested resolution (mirror the INC-37 decision one level down):**
- Add the **public keys** (not just pointers) of the immediate parents to `SubCardDocument`:
  e.g. `holder_primary_card_pubkey` and `app_card_pubkey` (base64url ML-DSA-44, 1312 B), each an
  untrusted hint bound by `keccak256(pubkey) == the corresponding pointer address`. With the master
  card decryptable, its own `ancestry_pubkeys` carries the walk the rest of the way to root; with the
  app card decryptable, its `ancestry_pubkeys` carries the app-certification walk. Alternatively give
  `SubCardDocument` its own `ancestry_pubkeys` array covering **both** chains (primary-card chain and
  app-card chain).
- These fields are set at sub-card issuance and must be **inside the signed bytes** (`app_signature`
  and `holder_signature`) — signing-critical, like `ancestry_pubkeys` on `CardDocument`.
- Update `card_validation.md` Stage 2 (read the parent pubkeys from the decrypted sub-card, bind via
  `keccak256`, decrypt parents), `subcards.md` "Verifier chain walk," and `protocol-objects.md §16`.

**Decision:** Two explicitly-named fields chosen over a single `ancestry_pubkeys`-style array, for clarity. `holder_primary_card_pubkey` and `app_card_pubkey` added to `SubCardDocument` as required fields, set at sub-card issuance, covered by both `app_signature` and `holder_signature`. Binding check wording: *each parent pubkey is an untrusted hint; the verifier MUST confirm `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address (and likewise for `app_card_pubkey` / `app_card`) before using it to derive a content key or verify a signature. A mismatch, or an AES-GCM authentication failure when decrypting the referenced card, is a hard rejection. Per-link on-chain addresses remain authoritative.* Files updated: `specs/protocol-objects.md` §15 (note on parent public keys living in §16) and §16 (JSON example, field table, "Serialized for signing" line, signing-sequence steps, verifier chain walk); `specs/process_specs/card_validation.md` Stage 2 (fully rewritten to read parent pubkeys, apply binding checks, decrypt master and app cards, then confirm sub-card in master's active list and verify holder sig — steps renumbered throughout); `specs/ARCHITECTURE.md` ADR-006 ("Sub-card boundary" note added; Chain Verification data flow updated); `specs/subcards.md` (SubCardDocument JSON example, wallet-validation steps, countersign step, acceptance criteria); `specs/card_protocol_spec.md` §7 step 2 (sub-card to master link).

**Strategic question (messaging bootstrap):** End-to-end messages are encrypted to "the recipient's
static ML-KEM public key on their card" (MSG-OQ-3a), but `recipients`/`senders` are card **hashes**.
A sender who knows only a recipient's address cannot derive the recipient's public key (one-way hash)
to (a) decrypt their card or (b) obtain their ML-KEM key to encrypt. This is probably acceptable *by
design* (you must have been shown a card — i.e. hold its public key — before you can message it), but
it should be stated explicitly: under content encryption, a card's public key is a **prerequisite
capability** for both reading and messaging it, and address-only cold-start is impossible. Confirm
this is intended and document it.

*Note: The INC-40 fix (adding `holder_primary_card_pubkey` / `app_card_pubkey` to `SubCardDocument`) resolves the verifier chain-walk gap but does **not** resolve this messaging cold-start question — a sender holding only an address still cannot derive the recipient's public key to encrypt. This question remains open (see MSG-OQ-2 and MSG-OQ-3 in Section 3).*

### Hygiene / lower severity (this pass)

~~**INC-41 — Genesis / trusted-root base case for `ancestry_pubkeys` is unspecified (Low–Medium).**~~ ✅ RESOLVED 2026-06-15
`ancestry_pubkeys` is `Required: Yes`, but a self-rooted trusted-root policy card has no ancestors.
No document states that such a card's `ancestry_pubkeys` is the empty array `[]`, nor defines the
walk **termination condition** (stop when the resolved address is a registered trusted root — i.e.
present in `PolicyAuthorizerKeys`, per OQ-9's resolution). Without this, a walker has no defined stop
and an empty array could be read as a schema violation. Specify: `ancestry_pubkeys` is `[]` for a
card whose parent is itself a trusted root (or for the root card itself), and the walk terminates
when the next address to resolve is a registered trusted root.

**Decision:** `ancestry_pubkeys: []` (empty array) is the valid, signed value for a trusted-root card and for any card whose immediate parent is a registered trusted root. The field is REQUIRED and always present; `[]` is not omission — per RFC 8785 rules, `[]` serializes as a present empty array, distinct from an omitted field. The walk terminates when the next address to resolve is registered in the on-chain `PolicyAuthorizerKeys` table. If `ancestry_pubkeys` is `[]` and the card's own address is **not** in `PolicyAuthorizerKeys`, the chain does not reach a trusted root and `chain_reaches_trusted_root: false` is recorded. Files updated: `specs/protocol-objects.md` §1 (field table note) and §2 (policy card `ancestry_pubkeys` note); `specs/card_protocol_spec.md` (Protocol-Required Fields table; §7 chain-walk step 3 termination condition; two new acceptance criteria); `specs/ARCHITECTURE.md` ADR-006 Ancestor Key Hint subsection; `specs/process_specs/card_validation.md` Stage 3 (termination condition in step 15; steps 16–17 updated; Error Paths table new row).

**INC-42 — Conformance corpus has no `CardDocument` vector and none covering `ancestry_pubkeys` or the three distinct signature-input subsets (Low — coverage gap; action item before signing code locks).**

**What the corpus currently covers.** `serialization-conformance.json` contains 22 generic canonicalization cases (TC-01…TC-22): individual field types (strings, integers, booleans, base64url, timestamps, nested objects, arrays of text, arrays of base64url), key-ordering edge cases, null-field omission, and one `SignedMessageEnvelope`-shaped payload (TC-20) plus two `LogEntry`-shaped payloads (TC-21–TC-22). These cases establish that RFC 8785 key sort, value encoding, and null-stripping work correctly in isolation.

**What it omits.** The corpus has no whole-object vector for any of the three signed document types: `CardDocument`, `PolicyCardDocument`, or `SubCardDocument`. In particular there is no vector for:
- a `CardDocument` with a populated multi-entry `ancestry_pubkeys` array, and
- the three distinct serialized-for-signing inputs that each `CardDocument` produces — one per party in the three-party signing sequence.

**Why `CardDocument` vectors matter specifically now.** `CardDocument` (§1 of `protocol-objects.md`) is the object whose canonical RFC 8785 bytes are signed three times, each over a *different* field subset defined by the exclusion lists in the "Serialized for signing" note:

- **Issuer-signature input** — all fields present at offer time: `ancestry_pubkeys`, `issued_at`, `issuer_card`, `policy_id`, `press_card`. Fields `recipient_pubkey`, `holder_signature`, and `press_signature` are absent (not yet added); `issuer_signature` itself is absent (it is the output of this signing step, not an input). Sorted key order: `ancestry_pubkeys` → `issued_at` → `issuer_card` → `policy_id` → `press_card`.
- **Holder-signature input** — adds `issuer_signature` and `recipient_pubkey` to the issuer set; excludes `holder_signature` and `press_signature`. Sorted key order: `ancestry_pubkeys` → `issued_at` → `issuer_card` → `issuer_signature` → `policy_id` → `press_card` → `recipient_pubkey`.
- **Press-signature input** — the complete countersigned document minus `press_signature`: `ancestry_pubkeys`, `holder_signature`, `issued_at`, `issuer_card`, `issuer_signature`, `policy_id`, `press_card`, `recipient_pubkey`. Sorted key order: `ancestry_pubkeys` → `holder_signature` → `issued_at` → `issuer_card` → `issuer_signature` → `policy_id` → `press_card` → `recipient_pubkey`.

A cross-implementation mismatch in how the whole object is canonicalized — especially the key-ordering interaction between `ancestry_pubkeys` and the other top-level keys, or the exact field set present at each signing stage — would produce different bytes at each party and cause silent verification failure. The current single-field and partial-object cases (TC-19, TC-20, TC-21) cannot catch a mismatch in the composition of a full `CardDocument` signature payload.

**Key-ordering note for implementers.** `ancestry_pubkeys` sorts *before* every other mandatory `CardDocument` key under Unicode code-point order, because `a` (U+0061) < `h` (U+0068) < `i` (U+0069) < `p` (U+0070) < `r` (U+0072). Concretely: `ancestry_pubkeys` < `holder_signature` < `issued_at` < `issuer_card` < `issuer_signature` < `policy_id` < `press_card` < `press_signature` < `recipient_pubkey`. This ordering applies at every nesting level — the same rule applies inside nested objects such as the `revocation` object in a `LogEntry`. Implementers MUST verify their sort produces this order; a sort that is length-first (CBOR-style) or case-insensitive would produce different output.

**Specific cases that should be added.** Four vectors cover the critical gaps:

a. **TC-23 — `CardDocument` issuer-signature input (populated `ancestry_pubkeys`).** The object assembled before the offerer signs: `ancestry_pubkeys` (two base64url entries), `issued_at`, `issuer_card`, `policy_id`, `press_card`. Expected canonical string: `{"ancestry_pubkeys":["DEAD","F00D"],"issued_at":"2026-06-15T00:00:00Z","issuer_card":"BAED","policy_id":"AAEC","press_card":"CAFE"}`. This is the byte sequence the offerer signs with their card key.

b. **TC-24 — `CardDocument` holder-signature input.** Adds `issuer_signature` and `recipient_pubkey` to TC-23; still excludes `holder_signature` and `press_signature`. Expected canonical string: `{"ancestry_pubkeys":["DEAD","F00D"],"issued_at":"2026-06-15T00:00:00Z","issuer_card":"BAED","issuer_signature":"BEEF","policy_id":"AAEC","press_card":"CAFE","recipient_pubkey":"FACE"}`. This is the byte sequence the holder countersigns.

c. **TC-25 — `CardDocument` press-signature input.** Adds `holder_signature` to TC-24; still excludes `press_signature`. Expected canonical string: `{"ancestry_pubkeys":["DEAD","F00D"],"holder_signature":"B00B","issued_at":"2026-06-15T00:00:00Z","issuer_card":"BAED","issuer_signature":"BEEF","policy_id":"AAEC","press_card":"CAFE","recipient_pubkey":"FACE"}`. This is the byte sequence the press signs and the complete on-IPFS document minus the final signature.

d. **TC-26 — `CardDocument` with `ancestry_pubkeys: []` (the INC-41 root base case).** The complete stored document with all five signature fields present and `ancestry_pubkeys` as an empty array. Expected canonical string: `{"ancestry_pubkeys":[],"holder_signature":"B00B","issued_at":"2026-06-15T00:00:00Z","issuer_card":"BAED","issuer_signature":"BEEF","policy_id":"AAEC","press_card":"CAFE","press_signature":"DEED","recipient_pubkey":"FACE"}`. This pins that `[]` serializes as a present two-character token, distinct from field omission, which is the normative INC-41 requirement.

**Severity and action.** Low — this is a test-coverage gap, not a silent cross-implementation break in the field today, because primitive array-of-base64url canonicalization (TC-19) already establishes that base64url strings in arrays stay as JSON strings and arrays are not reordered. The gap becomes a real risk once multiple independent implementations (TypeScript `canonicalize()` in `card-validator` and the Stylus WASM encoder) both exist and are being validated separately. **Action:** add TC-23 through TC-26 to `serialization-conformance.json` (TC-23–TC-26 have now been added — see the `serialization-conformance.json` file), then run both the TS `canonicalize()` implementation and the Stylus WASM encoder against the full corpus (TC-01…TC-26) before any signing code or contract is deployed. A `PolicyCardDocument` and a `SubCardDocument` (the latter now also carrying `holder_primary_card_pubkey` and `app_card_pubkey` per INC-40) whole-object vectors should be added in a follow-on pass once those objects are closer to code freeze.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~**INC-40**~~ | ~~**Blocking**~~ | ~~INC-37 added `ancestry_pubkeys` to `CardDocument` only; the sub-card→master and sub-card→app-card hops (the entry point of all verification) still expose only pointers, so a verifier cannot decrypt the master/app card to confirm the link, verify the holder/app signature, or reach the master's `ancestry_pubkeys`~~ ✅ RESOLVED 2026-06-15 — Two required fields added to `SubCardDocument`: `holder_primary_card_pubkey` and `app_card_pubkey` (base64url ML-DSA-44, 1312 B each). Both are untrusted hints bound by keccak256 check before use; AES-GCM failure on the referenced card is a hard rejection. Both covered by `app_signature` and `holder_signature`. `protocol-objects.md §15/§16`, `card_validation.md` Stage 2, `subcards.md`, `card_protocol_spec.md §7`, `ARCHITECTURE.md` ADR-006 all updated. | — |
| ~~**INC-41**~~ | ~~Low–Med~~ | ~~`ancestry_pubkeys` (`Required: Yes`) has no defined empty-array/root base case or walk-termination condition~~ ✅ RESOLVED 2026-06-15 — `[]` allowed for root cards; walk terminates at a `PolicyAuthorizerKeys`-registered trusted root. | — |
| **INC-42** | Low | Conformance corpus has no `CardDocument` vector and none covering `ancestry_pubkeys` or the three distinct signature-input subsets — TC-23…TC-26 now added to `serialization-conformance.json`; validate TS + Stylus encoders against full corpus before signing code locks | `serialization-conformance.json` vs `protocol-objects.md §1` |

> **Root cause:** the INC-37 fix was applied to `CardDocument`/`PolicyCardDocument` but the
> verification path actually *enters* at a sub-card, and `SubCardDocument` was not given the same
> ancestor-pubkey treatment. INC-40 is the missing half of the INC-37 decision; INC-41 and INC-42 are
> the base-case and test-coverage loose ends of the same change.

---

## 0g. Fifth-pass review 2026-06-15 — pubkey-availability gap in other verification-trigger objects

A fifth sweep on 2026-06-15 checked whether the content-encryption + address-by-hash model breaks
verification in objects **other** than `CardDocument`/`SubCardDocument` (which INC-37 and INC-40
fixed). It does. The same root cause recurs: **any object that references a card by *pointer* (an
on-chain address = `keccak256(pubkey)`, one-way) and then asks a relying party to verify that card's
signature or walk its chain is unsatisfiable, because the relying party cannot recover the card's
public key from the pointer, and the card's IPFS content is encrypted under that public key.** Three
concrete instances remain unfixed, each on a primary protocol flow.

> **The general principle (recommended as a protocol invariant):** every signed object that obliges a
> relying party to verify a pointer-referenced card's signature, decrypt it, or walk its chain MUST
> embed that card's **public key**, bound by `keccak256(pubkey) == pointer`. The referenced card's own
> `ancestry_pubkeys` (INC-37) then carries any further walk to the root — so only the **single
> immediate pubkey** needs to be added to each object, not a full ancestry array. Adopt this as a
> standing rule and audit every object against it. Current status of the inventory: `CardDocument`
> ✅ (INC-37), `SubCardDocument` ✅ (INC-40), `OpenCardOffer` ✅ (INC-44), `AuthenticationRequest`
> ✅ (INC-45), `PressIssuanceRecord` ✅ (INC-43), EAS annotation ✗ (underspecified — see note).

### Substantive gaps (all the same class as INC-40)

~~**INC-43 — Auditors cannot decrypt the issued cards they are auditing; `PressIssuanceRecord` carries only `card_cid` and a `requester_card` pointer (High).**~~
~~The audit model is a core feature: auditors decrypt the per-epoch press log and "review the decrypted
records for policy compliance (e.g., that issuances match expected predicates)" (`log_auditing.md`
step 3). But `PressIssuanceRecord` (`protocol-objects.md §11`) contains only `card_cid` (CID of the
*encrypted* issued `CardDocument`) and an optional `requester_card` **pointer** — no recipient public
key. An auditor can fetch the issued card's ciphertext but cannot derive its content key
(`HKDF-SHA3-256(recipient_pubkey, "card-content-v1")`) to decrypt it, so the audit is reduced to CIDs
and timestamps and **cannot inspect the card's field values or verify predicate compliance** — the
stated purpose of the audit. **Resolution:** add `recipient_pubkey` (the issued card's public key) to
the `PressIssuanceRecord` plaintext. It is already encrypted under the epoch AEK, so the key is
exposed only to auditors — no privacy loss. With it, the auditor decrypts the issued card and uses the
card's own `ancestry_pubkeys` for any chain walk. Update `protocol-objects.md §11` and
`log_auditing.md`.~~

✅ RESOLVED 2026-06-15 — `recipient_pubkey` (base64url ML-DSA-44, 1312 bytes) added to `PressIssuanceRecord` plaintext as a required field. The press populates it from the `CardDocument` it just assembled — zero extra work at issuance time. The outer on-IPFS envelope (`epoch_id` / `nonce` / `ciphertext`) is unchanged; `recipient_pubkey` lives only inside the AEK-encrypted plaintext, exposed only to auditors. Auditor usage: derive `content_key = HKDF-SHA3-256(recipient_pubkey, info="card-content-v1")`, decrypt the issued card at `card_cid`, and inspect fields and predicate compliance; walk the card's chain via its `ancestry_pubkeys` if needed. Binding check: auditor SHOULD confirm `keccak256(recipient_pubkey)` equals the card's on-chain registry address; mismatch or AES-GCM auth failure MUST be flagged in `findings`. Files updated: `protocol-objects.md §11` (JSON example, field table, envelope-vs-plaintext note, binding check paragraph); `process_specs/log_auditing.md` (step 3 rewritten with sub-steps a–f, new Acceptance Criteria section); `card_protocol_spec.md §2` (press-log construction prose and acceptance criterion).

~~**INC-44 — Open-offer recipients (and the press) cannot verify the offer; `OpenCardOffer` carries the issuer only as a pointer (Blocking for the open-offer path).**~~
~~`open_offer_acceptance_new_wallet.md`/`…_existing_wallet.md` both require the recipient's wallet to
"Verify `issuer_signature` over the canonical RFC 8785 JSON of all offer fields" and "Resolve the
issuer's card chain to a trusted root … reject the offer before displaying it" if that fails; the
press re-verifies `issuer_signature` press-side. But `OpenCardOffer` (`protocol-objects.md §6`)
contains `issuer_card` (a **pointer**) and `issuer_signature` (a bare base64url, not a `SignatureEntry`
with an inline key) — and **no issuer public key**. The recipient therefore cannot verify
`issuer_signature` at all, and cannot decrypt the issuer's card to walk its chain. As written, the
offer "could not be verified" path triggers unconditionally; the open-offer flow is unsatisfiable.
**Resolution:** add `issuer_pubkey` to `OpenCardOffer`, covered by `issuer_signature` and bound by
`keccak256(issuer_pubkey) == issuer_card`. The recipient verifies the signature with it, then decrypts
the issuer card and walks via that card's `ancestry_pubkeys`. Update `protocol-objects.md §6`,
`open_offer_creation.md`, and both `open_offer_acceptance_*` specs.~~

✅ RESOLVED 2026-06-15 — `issuer_pubkey` (base64url ML-DSA-44, 1312 bytes) added to `OpenCardOffer` as a required field, set by the issuer at offer creation, covered by `issuer_signature`. Binding check: verifier MUST confirm `keccak256(issuer_pubkey) == issuer_card` before use; mismatch or AES-GCM failure is a hard rejection. Files updated: `protocol-objects.md §6` (JSON, field table, "Serialized for signing", offer_id note) and `§7` (press validation step 1 binding check); `open_offer_creation.md` (step 2 JSON example, step 4 prose); `open_offer_acceptance_new_wallet.md` (step 2 verification, step 16 press validation); `open_offer_acceptance_existing_wallet.md` (step 2 verification, step 11 press validation).

~~**INC-45 — Auth-request verifiers cannot verify the request; `AuthenticationRequest` carries the requester only as a pointer (Blocking for the auth path).**~~
~~`card_protocol_spec.md §8` and `ARCHITECTURE.md` data-flow §4 require the wallet to verify
`request_signature` "before displaying" and to "walk the requester's card chain to a trusted root …
rejected before display" on failure. But `AuthenticationRequest` (`protocol-objects.md §8`) carries
`requester_card` (a **pointer**) and `request_signature` (bare base64url) — **no requester public
key**. The wallet cannot verify the signature or decrypt the requester's card to walk its chain.
**Resolution:** add `requester_pubkey` to `AuthenticationRequest`, covered by `request_signature` and
bound by `keccak256(requester_pubkey) == requester_card`. Update `protocol-objects.md §8`,
`card_protocol_spec.md §8`, and the ARCHITECTURE data flow.~~

✅ RESOLVED 2026-06-15 — `requester_pubkey` (base64url ML-DSA-44, 1312 bytes) added to `AuthenticationRequest` as a required field, set by the requesting site, covered by `request_signature`. Binding check: wallet MUST confirm `keccak256(requester_pubkey) == requester_card` before use; mismatch or AES-GCM failure when decrypting the requester card is a hard rejection. Files updated: `protocol-objects.md §8` (JSON, field table, "Serialized for signing", binding-check and verifier-usage paragraphs); `card_protocol_spec.md §8` (request object JSON, steps 3–4 of the direct fetch flow, acceptance criteria); `ARCHITECTURE.md` Key Data Flows §4 (requesting-site creation step, wallet verification steps).

> **Note — EAS annotations (same class, currently underspecified).** ADR-008 says annotations are
> "signed by the annotator's card" and "filterable by the signing card's chain" (chain walk), but no
> annotation object is defined in `protocol-objects.md`. Whatever object EAS points to must likewise
> carry the **annotator's public key** (bound to the annotator's card pointer) so a verifier can check
> the signature and walk the annotator's chain under content encryption. Fold this into the annotation
> object spec when it is written; tracked here so the invariant above is applied to it.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~INC-43~~ | ~~High~~ | ~~`PressIssuanceRecord` gives auditors only `card_cid` + a `requester_card` pointer; no recipient pubkey, so auditors cannot decrypt the issued card to verify predicate compliance — hollowing the audit~~ ✅ RESOLVED 2026-06-15 — `recipient_pubkey` added to `PressIssuanceRecord` plaintext; AEK-encrypted so auditor-only; outer envelope unchanged. | — |
| ~~INC-44~~ | ~~Blocking*~~ | ~~`OpenCardOffer` references the issuer only by pointer + a bare `issuer_signature`; recipient/press cannot recover the issuer pubkey to verify the signature or walk the issuer chain (which the acceptance specs require before display)~~ ✅ RESOLVED 2026-06-15 — `issuer_pubkey` added to `OpenCardOffer`; covered by `issuer_signature`; binding check `keccak256(issuer_pubkey) == issuer_card` required before use | — |
| ~~INC-45~~ | ~~Blocking**~~ | ~~`AuthenticationRequest` references the requester only by pointer + a bare `request_signature`; wallet cannot recover the requester pubkey to verify the signature or walk the requester chain before display~~ ✅ RESOLVED 2026-06-15 — `requester_pubkey` added to `AuthenticationRequest`; covered by `request_signature`; binding check `keccak256(requester_pubkey) == requester_card` required before use | — |

\* Blocking for the open-offer issuance path. \*\* Blocking for the authentication path.

> **Root cause (same as INC-37/INC-40):** content encryption makes a card's public key a prerequisite
> capability for reading/verifying it, but several signed objects still pass card identity as a
> one-way pointer only. The fix is mechanical and uniform — embed the immediate pubkey, bound by
> `keccak256`, and lean on the referenced card's `ancestry_pubkeys` for the rest. Applying the
> invariant above once, across all objects, closes this class for good. These three can be resolved
> together in a single editorial pass like the INC-40 fix.

---

## 0h. Sixth-pass review 2026-06-15 — line-by-line read of registry_contract / key_rotation / messaging

A full line-by-line read of `object_specs/registry_contract.md`, `key_rotation.md`, and
`messaging_protocol.md` (the three files not deeply re-read in passes 0c–0g). Findings below are
**not** in any prior INC/OQ list. None are in the pubkey-availability class of §0g; these are schema
mismatches, an undefined field, stale cross-references from earlier renumbering, and one consequence
of the encryption model in the offer phase.

### Schema / mechanism

~~**INC-46 — On-chain sub-card registration schema disagrees between `registry_contract.md §3.4` and `protocol-objects.md §15` (Medium).**~~ ✅ RESOLVED 2026-06-15
`registry_contract.md §3.4` (authoritative for on-chain structure) defines `SubCardEntry` as
`master_card_address`, `registration_log_head`, `active`, `registered_at`, `deregistered_at` — and
`RegisterSubCard §4.3` stores exactly those. But `protocol-objects.md §15` describes the on-chain
`SubCardRegistration` as `holderPrimaryCardAddress`, `appCardAddress`, `registrationLogHeadCid`, and
says `appCardAddress` is "used to verify the app's certification chain **on-chain**." Two conflicts:
(1) **field naming** — `master_card_address` vs `holderPrimaryCardAddress`, `registration_log_head`
vs `registrationLogHeadCid`; (2) **`appCardAddress` does not exist in the contract** — the contract
neither stores the app card address nor performs any on-chain app-chain verification (app-chain
verification is done off-chain by the wallet, per `subcards.md` and the INC-40 model). **Decision
needed:** reconcile §15 to the contract — adopt one set of field names, and either drop
`appCardAddress` and the "verified on-chain" claim from §15 (app-chain checks are off-chain) or add
`appCardAddress` to `SubCardEntry` if an on-chain app reference is actually wanted. Note the master
card is also called the "primary card" / `holder_primary_card` elsewhere — pick one term.

**Resolution (2026-06-15):** On-chain `SubCardEntry` stores `master_card_address` (the holder's master card registry address), `registration_log_head` (log head CID snapshot for scope-attenuation), and a new `sub_card_doc_cid` field — the CID of the `SubCardDocument` on IPFS. The app card address (`app_card`), app card pubkey (`app_card_pubkey`), and app signature (`app_signature`) live in the IPFS `SubCardDocument` (§16) pointed to by `sub_card_doc_cid`. The on-chain entry does **not** store the app card address. `holderPrimaryCardAddress` → `master_card_address`; `registrationLogHeadCid` → `registration_log_head`; `appCardAddress` dropped entirely from the on-chain entry. App-chain verification (confirming `app_card` chains to the governance app-certification policy root) is performed **by the press at registration time** — the press fetches the `SubCardDocument` from IPFS, verifies `app_signature`, and walks the `app_card` certification chain before submitting `RegisterSubCard`. Runtime verifiers rely on the press's registration-time validation and do not re-walk the app certification chain independently. **Trust consequence:** relying parties now trust the press's app-chain validation rather than re-deriving it themselves at runtime — the same trust model already in use for the master signature (E-22), open-offer issuer signature (E-14), and forward-registration revocation check (E-28). The `app_card_pubkey` and `holder_primary_card_pubkey` fields are preserved in `SubCardDocument` (INC-40 fix) — `holder_primary_card_pubkey` is still used by runtime verifiers to decrypt/walk the holder's master chain; `app_card_pubkey` is used by the press at registration and may be used by auditors. Files updated: `registry_contract.md §3.4` (added `sub_card_doc_cid` to `SubCardEntry`), `§4.3` (`RegisterSubCard` call args, payload, state changes, press-side app-chain note), `§5` (`GetSubCardEntry` description), `§7` (`SubCardRegistered` event carries `sub_card_doc_cid`); `protocol-objects.md §15` (field names reconciled, `appCardAddress` dropped, `sub_card_doc_cid` added, app-chain press-side note), `§16` (Verifier chain walk updated — runtime verifiers do not re-walk app chain; app-certification note added), Object Relationship Summary updated, Serialization Quick Reference `SubCardRegistration` row updated; `subcards.md` (Step 5 rewritten as press-side app-chain verification + registration, Acceptance Criteria updated); `card_validation.md` Stage 2 (steps 11–12 updated — sub-card active check added; app-certification-chain walk removed from runtime; app_signature still verified; Stage 3 note updated; Error Paths updated).

~~**INC-47 — `past_keys` is used as a `CardDocument` field but is not defined in the object spec (Medium, signing-relevant).**~~
~~`key_rotation.md §2.3/§2.4` require "the new card's document includes a `past_keys` array" (objects
of `{pubkey, valid_from, rotated_at}`) so a holder of the new key can derive content keys for
historical entries after a master-key rotation — with a dedicated acceptance criterion (§2.7). But
`past_keys` appears in **no** `CardDocument` definition: it is absent from `protocol-objects.md §1`
(JSON, field table, and "Serialized for signing" lists) and from the `card_protocol_spec.md`
Protocol-Required Fields table. Because it lives in the card document, it is almost certainly inside
the signed bytes — so its absence from the object spec is a signing-critical omission. **Decision
needed:** add `past_keys` to `protocol-objects.md §1` and `card_protocol_spec.md` (type, optionality
— absent/empty on a never-rotated card, akin to `ancestry_pubkeys: []`), and place it in the
issuer/holder/press signature coverage lists.~~

✅ **RESOLVED 2026-06-15.** `past_keys` is now formally defined as a `CardDocument` field in `protocol-objects.md §1` (JSON example, field table, and "Serialized for signing" header) and added to the Protocol-Required Fields table in `card_protocol_spec.md`. **Optionality:** omitted entirely on cards that have never been the product of a rotation (not `null`, not `[]`) — consistent with the RFC 8785 "absent optional fields must be omitted" rule. **Ordering:** oldest-first (confirmed from `key_rotation.md §2.3` and stated explicitly in the field table). **Signing coverage:** covered by all three signatures (`issuer_signature`, `holder_signature`, `press_signature`); not in any exclusion list; immutable from genesis (populated at offer-assembly time by the offerer's wallet service, before any signature is applied). **Cross-reference added** to `key_rotation.md §2.3` noting `protocol-objects.md §1` as the authoritative schema. **Conformance vector:** deferred as a follow-on (analogous to INC-42) — the vector requires computing canonical RFC 8785 bytes over a multi-entry `past_keys` array, which should be validated against the live conformance corpus rather than hand-computed here.

~~**INC-49 — Offer-phase card documents have no defined content-encryption key (Medium).**~~ ✅ RESOLVED 2026-06-15

ADR-006 content encryption applies only to the **registered** card document the press posts to IPFS after the recipient countersigns — the document that now has `recipient_pubkey` present. Offer-phase `CardDocument`s (without `recipient_pubkey`, `holder_signature`, or `press_signature`) are **not** content-encrypted under ADR-006; they are delivered to the prospective recipient in the clear within the invite payload or protected only by the E2E message encryption used to deliver the `card_offer` message (ML-KEM per ADR-007). The "every card document" framing in ADR-006 has been corrected to scope it to registered cards. Files updated: `ARCHITECTURE.md` ADR-006 (offer-phase exemption note and revised table); `card_protocol_spec.md` "Content encryption" section (offer-phase exemption paragraph); `messaging_protocol.md §5` `card_offer` notes (offer-phase plaintext / transport-encrypted; inline-carry option noted) and `§6` `card_offer_accepted` notes (completed card is content-encrypted); `protocol-objects.md §1` signing-sequence step 5 and new "Content encryption and the offer phase" paragraph; `process_specs/card_offering_and_acceptance.md` step 17; `process_specs/open_offer_acceptance_existing_wallet.md` step 12; `process_specs/open_offer_acceptance_new_wallet.md` step 17.

~~**INC-50 — `messaging_protocol.md §10 auth_response` content schema diverges from the canonical auth_response (Low–Medium, signing-relevant).**~~ ✅ RESOLVED 2026-06-15

The auth_response payload is signed, so its `content` field set must be singular across specs. The
INC-5 resolution and `protocol-objects.md §9` / `card_protocol_spec.md §8` define auth_response
`content` as `{ statement, context, nonce }`. But `messaging_protocol.md §10` (v0.1, predates the
INC-5 harmonization) shows `content: { nonce, session_id }` — different field set (`statement` and
`context` absent; `session_id` present in content rather than at the envelope level).

**Decision:** `session_id` is folded into `content.context`, which becomes an **object** (not a plain string). The canonical auth_response `content` is `{ statement, context: { session_id, ... }, nonce }` across all three specs. `session_id` inside `content.context` is **signed** (cryptographically bound to the holder's signature); the top-level `session_id` outside `signed_statement` is an **unsigned** convenience field for HTTP routing only. Files updated: `messaging_protocol.md §10` (content schema updated to `{ statement, context: { session_id }, nonce }`; Notes expanded to explain signed vs unsigned `session_id` and the canonical schema); `protocol-objects.md §9` (JSON example updated; `context` shown as an object; field table expanded; signed-vs-unsigned note added; verification sentence updated to check both `content.context.session_id` and `content.nonce`); `card_protocol_spec.md §8` step 7 (wallet assembly updated; verification sentence updated; new acceptance criterion for `content.context.session_id` added); `ARCHITECTURE.md §4` auth flow (wallet "generates" line expanded to full `content` schema; requester verification line updated).

### Hygiene / lower severity

~~**INC-48 — Stale `key_rotation.md §3.x` cross-references after the INC-34 renumber (Medium; broken cross-refs across 4 files).**~~
~~INC-34 folded `key_rotation.md §2` into §1.5 and renumbered the old §3 (Master Card Key Rotation) to
§2. The citing documents were not updated and still point to the old numbers: `protocol-objects.md`
line ~118 (`§3.5`), `update_codes.md` lines ~43 (`§3.3`/`§3.4`/`§3.5`), ~97 (`§3.4`), ~141 (`§3.4`),
and `registry_contract.md` lines ~792 (`§3.4 step 4a`) and ~983 (`§3.3`). Correct targets after the
renumber: old `§3.3` (Address Transitions) → **§2.3**; old `§3.4` (Planned flow / step 4a) → **§2.4**;
code-810 emergency → **§2.5**; old `§3.5` (Issuer-recovery / code 102/103) → **§2.6**. Also an
*internal* error: `key_rotation.md §7.2`'s code-102 row says "see §2.5" but issuer recovery is
**§2.6**. **Fix:** repoint all of these.~~

✅ **RESOLVED 2026-06-15.** All stale `§3.x` refs repointed to `§2.x` across 4 files (`protocol-objects.md`, `update_codes.md`, `registry_contract.md`, `key_rotation.md`) and the internal §7.2 slip (code-102 row "see §2.5" → "see §2.6") corrected.

**Additional low-severity items:**
- ~~**`registry_contract.md` TOC anchor `#41-registermark`** (line 23) still carries the "mark"
  artifact — INC-39 fixed only the `§4.2` anchor (`#42-updatecardhead`). Update to
  `#41-registercard`.~~ ✅ **RESOLVED 2026-06-15** — Anchor updated to `#41-registercard`.
- ~~**`registry_contract.md §4.13` precondition 4 / error `E-28`** state the *contract* "detects a
  conflict via the `last_press_address` field" when the old card has been revoked. The contract is
  revocation-agnostic (§4.2 note) and cannot read the IPFS log; `last_press_address` does not encode
  revocation. Revocation ordering is enforced **press-side only** (E-28 is already labelled a
  press-side rejection). Drop the "contract detects" wording to avoid implying an on-chain check that
  cannot exist.~~ ✅ **RESOLVED 2026-06-15** — Precondition 4 reworded: revocation check is explicitly press-side; E-28 is a press-side rejection; the contract's revocation-agnostic nature is stated; `last_press_address` no-revocation-encoding note added.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~**INC-46**~~ | ~~Medium~~ | ~~On-chain sub-card schema differs: `master_card_address` (+no app addr) in the contract vs `holderPrimaryCardAddress`/`appCardAddress`/`registrationLogHeadCid` "verified on-chain" in §15~~ ✅ RESOLVED 2026-06-15 — On-chain stores `master_card_address` + `registration_log_head` + new `sub_card_doc_cid` (CID of IPFS SubCardDocument); app card address + app signature in IPFS only; app-certification chain walk is press-side at registration; runtime verifiers rely on press validation. | `registry_contract.md §3.4/§4.3` vs `protocol-objects.md §15` |
| ~~**INC-47**~~ | ~~Medium~~ | ~~`past_keys` required on the card document by `key_rotation.md` but undefined in the `CardDocument` object spec (and signing coverage unspecified)~~ ✅ RESOLVED 2026-06-15 — `past_keys` defined in `protocol-objects.md §1` + `card_protocol_spec.md`; optionality (omitted when absent, not `[]`), oldest-first ordering, and signing coverage (all three signatures, no exclusion list) all specified; cross-reference added to `key_rotation.md §2.3`; conformance vector deferred as follow-on. | ~~`key_rotation.md §2.3/§2.4/§2.7` vs `protocol-objects.md §1`, `card_protocol_spec.md`~~ |
| ~~**INC-48**~~ | ~~Medium~~ | ~~Stale `key_rotation.md §3.x` cross-references (INC-34 renumber not propagated) in 4 files + one internal `§2.5`/`§2.6` slip~~ ✅ RESOLVED 2026-06-15 | ~~`protocol-objects.md`, `update_codes.md`, `registry_contract.md`, `key_rotation.md`~~ |
| ~~**INC-49**~~ | ~~Medium~~ | ~~Offer-phase `CardDocument` has no `recipient_pubkey`, so ADR-006's content-encryption key is undefined for the offer document referenced by `offer_cid`~~ ✅ RESOLVED 2026-06-15 — ADR-006 content encryption applies only to the registered card; offer-phase documents are not content-encrypted (no `recipient_pubkey` yet); delivered in clear or via E2E transport (ADR-007). | — |
| ~~**INC-50**~~ | ~~Low–Med~~ | ~~`messaging §10 auth_response` content `{nonce, session_id}` ≠ canonical `{statement, context, nonce}`~~ ✅ RESOLVED 2026-06-15 — `session_id` folded into `content.context` (object); canonical auth_response content is `{statement, context: {session_id, ...}, nonce}` across `messaging_protocol.md §10`, `protocol-objects.md §9`, and `card_protocol_spec.md §8`. | ~~`messaging_protocol.md §10` vs `protocol-objects.md §9`, `card_protocol_spec.md §8`~~ |

> **Pattern:** INC-46/INC-47/INC-50 are object-schema drift between `protocol-objects.md` (and
> `key_rotation.md`) and their authoritative counterparts; INC-48 is unpropagated renumbering from the
> INC-34 fix; INC-49 is a genuine design gap the encryption model opens in the offer phase. None block
> the others, but INC-47 and INC-49 are signing/encryption-relevant and should be settled before the
> card schema and the offer flow are frozen.

---

## 0i. Seventh-pass review 2026-06-15 — post-fix verification + remaining process specs

A seventh pass: (a) verified the INC-46…INC-50 fixes for new contradictions, and (b) read the
process specs not yet deeply reviewed (`card_signing.md`, `card_updates.md`, `message_routing.md`,
and spot-checks of the others). Several findings are **propagation gaps from the latest fixes**
(INC-46, INC-37/47, INC-35) plus a couple of pre-existing omissions. None are in any prior list.

### Signing / schema-critical

~~**INC-53 — `card_signing.md` payload omits `senders`, which is a Required signed field in the other two envelope specs (Medium–High, signing-critical).**~~ ✅ RESOLVED 2026-06-16
`protocol-objects.md §5` and `messaging_protocol.md §1` both define `payload.senders` as **Required**
(master-card pointers, parallel to `signatures`). But `card_signing.md` Phase 1 — the **signer-side**
assembly that actually builds and signs the payload — omits `senders` entirely from its payload object
and validation. Because the signature commits to the canonical payload byte-for-byte, an
implementation following `card_signing.md` produces different bytes (no `senders` key) than one
following protocol-objects/messaging — a silent cross-implementation verification break. (Note:
**MSG-OQ-2** asks whether `senders` should exist at all; this must be decided, then made consistent in
all three places.) **Fix:** either add `senders` to `card_signing.md`'s payload assembly + example +
validation, or resolve MSG-OQ-2 to drop `senders` everywhere — but the three envelope specs must end
with one field set.

~~**INC-54 — The immutable-field guard omits `ancestry_pubkeys` and `past_keys` (Medium).**~~ ✅ RESOLVED 2026-06-16
`card_updates.md` step 7 ("Immutable fields") rejects `field_updates` targeting `policy_id`,
`issuer_card`, `press_card`, `recipient_pubkey`, `issued_at`, and the three signatures — but **not**
`ancestry_pubkeys` (INC-37) or `past_keys` (INC-47), both of which are immutable, signed,
protocol-required fields. As written, an updater could post a `field_update` mutating them and the
press's explicit guard would not reject it. **Fix:** add `ancestry_pubkeys` and `past_keys` to the
immutable-field list in `card_updates.md` step 7 (and confirm `card_protocol_spec.md §5`'s generic
"protocol-required immutable fields" wording is understood to include them).

### Mechanism / propagation gaps from recent fixes

~~**INC-51 — `protocol-objects.md §16` still says "There is no press in sub-card issuance" — contradicts the INC-46 press-side model (Medium).**~~ ✅ RESOLVED 2026-06-16 — `protocol-objects.md §16` opening sentence reworded: the app initiates and first-signs, the holder countersigns (authorizing the delegation), and the press verifies the app-certification chain off-chain and submits `RegisterSubCard` on-chain. "There is no press in sub-card issuance" removed; the holder/wallet is now described as the delegating party and the press as the on-chain registration party.
The INC-46 fix made the **press** validate the app-certification chain and call `RegisterSubCard`
(`subcards.md` "Step 5: Press Validates the App Card Chain and Registers On-Chain"). But
`protocol-objects.md §16` still stated *"There is no press in sub-card issuance; the wallet is the
authorizing party."* That is now false. **Fix:** reword §16 to reflect that a press participates
(verifies the app chain off-chain and submits the on-chain registration), while the holder/wallet is
the delegating party that countersigns with the primary key.

~~**INC-52 — `DeregisterSubCard` gas payer is stated three different ways (Medium).**~~ ✅ RESOLVED 2026-06-16 — Both `subcards.md` statements updated to match `registry_contract.md §4.12`: the "Authorization for Deregistration" section now states app pre-funded account pays; issuing org's press sponsors if balance insufficient; deregistration never blocked. The SM-GAS resolution bullet updated to add the press-sponsor fallback for `DeregisterSubCard` (while keeping `RegisterSubCard` as app-always-pays with no fallback).
The INC-27 resolution (in `registry_contract.md §4.4/§4.12`) is: the app's pre-funded account pays for
`DeregisterSubCard`, and the **issuing org's press sponsors only if the app balance is insufficient**
(so deregistration is never blocked). But `subcards.md` disagreed with itself and with the contract:
line ~210 said deregistration "gas is paid by the issuing organization's press" (press pays outright);
line ~287 (SM-GAS resolution) said app-initiated `DeregisterSubCard` is "always the requesting app's
responsibility" (no sponsor fallback). **Fix:** align both `subcards.md` statements to
`registry_contract.md §4.12` — app pays; issuing-org press sponsors as a fallback when the app balance
is insufficient.

~~**INC-55 — `message_routing.md` body still relies on on-chain routing structures the INC-35 decision removed (Medium).**~~ ✅ RESOLVED 2026-06-16 — `message_routing.md` §Local Routing Tables reworked: the three numbered items now describe off-chain binding announcements (card registration, migration, startup sync) via the off-chain Wallet Service Registry rather than on-chain events. The claim that the routing table is "derived entirely from on-chain events," the `RegisterCard`-calldata `wallet_service_id` reference, and the `MigrateCard` on-chain event in the Card Migration section are all replaced by off-chain binding and announcement wording. The `410 Gone` redelivery mechanism is unchanged. Related-Specs footnote for `registry_contract.md` updated to note routing state is off-chain (INC-35).
`message_routing.md`'s INC-35 status note correctly says the Wallet Service Registry is **off-chain**.
But the body still specifies on-chain mechanisms: routing tables "derived entirely from on-chain
events," `RegisterCard` calldata that "includes the `wallet_service_id`," and a "card migration event
posted on-chain." None of these exist in `registry_contract.md` — `RegisterCard` has no
`wallet_service_id` parameter and there is no `MigrateCard` event (only `AddressTransition`, for key
rotation). The doc thus contradicts both its own status note and the contract. **Fix:** rework the
routing-table derivation to an off-chain mechanism (or, if on-chain hints are genuinely wanted, that is
a contract change that must be re-opened against INC-35 — but as written it is unimplementable).

### Lower severity / undefined-field

~~**INC-56 — `erasure` / `erasable` are used but undefined in the object spec (Low–Medium).**~~ ✅ RESOLVED 2026-06-16 — `erasable` (boolean, optional, default false; immutable, set at policy issuance; governs whether `erasure: true` may appear on revocation entries) added to `PolicyCardDocument` (§2) JSON example and field table. `erasure` (boolean, optional; valid only on 8xx/9xx entries; part of signed `UpdateIntentPayload` and copied verbatim into `LogEntry`) added to `UpdateIntentPayload` (§4) and `LogEntry` (§3) JSON examples and field tables. Press rejects `erasure: true` if the policy does not have `erasable: true`. Cross-references to `card_protocol_spec.md §952` and `card_updates.md §Phase 3` added in the field notes. *(superseded by INC-60 — erasure removed)*
`card_protocol_spec.md §2`/acceptance and `card_updates.md` step 7 / error paths reference an
`erasure: true` flag on an update and an `erasable: true` policy field, but neither is defined in
`protocol-objects.md`: `PolicyCardDocument §2` has no `erasable`, and `UpdateIntentPayload §4` /
`LogEntry §3` have no `erasure`. **Fix:** add `erasable` to `PolicyCardDocument` and `erasure` to
`UpdateIntentPayload`/`LogEntry` (with signing/immutability treatment), or remove the erasure feature
if out of scope for v1.

~~**INC-57 — Verifiers check press authorization against the IPFS `approved_presses` snapshot, but ADR-011 makes on-chain `PressAuthorizations` authoritative (Medium).**~~ ✅ RESOLVED 2026-06-16 — Decision: on-chain `PressAuthorizations` is authoritative for verification; `approved_presses` is an advisory cross-check only. `card_validation.md` step 24 rewritten: verifier checks the on-chain `PressAuthorizations` table (via `GetPressAuthorization` / `IsPressActive`) as the normative authorization source; IPFS `approved_presses` may be consulted as advisory; on-chain governs where they diverge. Point-in-time note added: a press later revoked on-chain was still authorized at issuance; `policy_compliant: false` applies only if no prior active window covers `issued_at`. Both `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md` Phase 1 step 2 (offer verification) and error-path rows updated to check on-chain `PressAuthorizations` as the authoritative source. `ARCHITECTURE.md` ADR-011 "Integration with IPFS `approved_presses`" section updated with an explicit bullet: "Verifiers consult on-chain `PressAuthorizations`…not the IPFS `approved_presses` audit surface."
`card_validation.md` step 24 and both `open_offer_acceptance_*` specs confirm "the press sub-card
appears in `approved_presses`" (the IPFS policy-snapshot array) as the authorization check. ADR-011
designates `approved_presses` a **non-authoritative audit surface** that "may diverge" from the
authoritative on-chain `PressAuthorizations`. A verifier consulting only `approved_presses` can
therefore disagree with on-chain authority (accept a press revoked on-chain but still listed, or reject
one authorized on-chain but not yet synced). **Decision needed:** specify what a verifier consults —
on-chain `PressAuthorizations` (authoritative, current-state), the issuance-time policy snapshot
(point-in-time but non-authoritative), or both — and reconcile the verification specs with ADR-011.

### Hygiene / minor

- ~~**`card_updates.md` Preconditions** say the updater needs "a **press** sub-card key available for
  signing" — but the updater signs the intent with their **own** sub-card key (step 4). Drop "press".~~ ✅ RESOLVED 2026-06-16 — `card_updates.md` Preconditions line changed from "a **press** sub-card key available for signing" to "a sub-card key available for signing".
- ~~**`past_keys` provenance (follow-on to INC-47):** `past_keys` is the *holder's* key history but is "populated by the offerer's wallet service at offer-assembly time" and first-covered by `issuer_signature`. The specs don't say how the offerer obtains the holder's prior-key history, and conceptually the holder is the authority on it (the `holder_signature` is the meaningful attestation). Clarify provenance — likely the holder/wallet supplies `past_keys` during the rotation request.~~ ✅ RESOLVED 2026-06-16 — Provenance clarified in `protocol-objects.md §1` (`past_keys` field note) and `card_protocol_spec.md` Protocol-Required Fields table: during a master-key rotation, the holder/wallet supplies their prior-key history to the offerer as part of the rotation request; the offerer includes it verbatim in the assembled offer; the **holder is the authority on their own key history** — the authoritative attestation is `holder_signature`; `issuer_signature` and `press_signature` also cover the bytes. Signing coverage decision unchanged.
- ~~**`policy_creation.md` still uses `PolicyMarkDocument`** (×2, lines ~40 and ~122) — the rename
  artifact first noted in §0d hygiene is **still unfixed**; rename to `PolicyCardDocument`.~~ ✅ RESOLVED 2026-06-16 — Both occurrences in `policy_creation.md` (step 1 prose and Related Specs link) renamed to `PolicyCardDocument`. Grep confirms zero `PolicyMarkDocument` remaining in `specs/`.
- ~~**`mutual_aid_mvp.md`** still contains unfilled `[Product Name]` placeholders throughout, while its
  open-questions table marks "Product name" resolved to "Card / Card Protocol" — note that conflates the
  *protocol* name with the *product* (the mutual-aid app) name; the product still has no name and the
  placeholders remain.~~ ✅ RESOLVED 2026-06-16 — `mutual_aid_mvp.md` open-questions table row corrected: "Product name" is now **Open** with a note that INC-23 resolved the *protocol* name ("Card Protocol") only; the mutual-aid product name is a distinct open product decision. `[Product Name]` placeholders left as-is.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~**INC-51**~~ | ~~Medium~~ | ~~`protocol-objects.md §16` "no press in sub-card issuance" contradicts INC-46 press-side app-chain verification + registration~~ ✅ RESOLVED 2026-06-16 — §16 reworded: press verifies app chain off-chain and submits `RegisterSubCard`; holder/wallet is the delegating party. | — |
| ~~**INC-52**~~ | ~~Medium~~ | ~~`DeregisterSubCard` gas payer stated 3 ways (subcards line ~210 press-pays, line ~287 app-always, contract §4.12 app-with-press-fallback)~~ ✅ RESOLVED 2026-06-16 — Both `subcards.md` statements aligned to `registry_contract.md §4.12`: app pays; press sponsors if app balance insufficient; deregistration never blocked. | — |
| ~~**INC-53**~~ | ~~Med–High~~ | ~~`card_signing.md` payload omits `senders`, a Required signed field in protocol-objects §5 / messaging §1 (signing-critical; tied to MSG-OQ-2)~~ ✅ RESOLVED 2026-06-16 — `senders` added to `card_signing.md` Phase 1 payload JSON, field-by-field description (master-card pointer(s), parallel to `signatures`, required, part of the signed payload), and Phase 1 local-validation list (step 2). One-line note added that MSG-OQ-2 (drop `senders` for sender-privacy) remains an open future option; current schema includes `senders` in all three specs. Payload field set in `card_signing.md` now matches `protocol-objects.md §5` exactly: `type`, `content`, `senders`, `recipients`, `timestamp`, `in_reply_to`, `edit_of`, `retracts`, `forwards`. | — |
| ~~**INC-54**~~ | ~~Medium~~ | ~~Immutable-field guard omits `ancestry_pubkeys` and `past_keys`~~ ✅ RESOLVED 2026-06-16 — `ancestry_pubkeys` and `past_keys` added to the immutable-field list in `card_updates.md` step 7. A note clarifies that `successor`, `supersedes`, and `supersession_note` are protocol-reserved *updatable* fields and are NOT in the immutable list. `card_protocol_spec.md §5` acceptance criterion updated with a parenthetical enumerating the complete immutable set (`policy_id`, `issuer_card`, `press_card`, `recipient_pubkey`, `issued_at`, `ancestry_pubkeys`, `past_keys`, `issuer_signature`, `holder_signature`, `press_signature`). | — |
| ~~**INC-55**~~ | ~~Medium~~ | ~~`message_routing.md` body uses on-chain `wallet_service_id` calldata + migration event (don't exist; removed by INC-35) — contradicts its own off-chain status note and the contract~~ ✅ RESOLVED 2026-06-16 — §Local Routing Tables and Card Migration reworked to off-chain binding/announcement model; `MigrateCard` on-chain event removed; `410 Gone` retry kept; Related Specs footnote updated. | — |
| ~~**INC-56**~~ | ~~Low–Med~~ | ~~`erasure`/`erasable` referenced in spec but undefined in `protocol-objects.md` (§2/§3/§4)~~ ✅ RESOLVED 2026-06-16 — `erasable` added to `PolicyCardDocument §2` (immutable, default false); `erasure` added to `UpdateIntentPayload §4` and `LogEntry §3` (optional, revocation-only, signed, copied verbatim into log entry). *(superseded by INC-60 — erasure removed)* | — |
| ~~**INC-57**~~ | ~~Medium~~ | ~~Verifiers check `approved_presses` (IPFS, non-authoritative per ADR-011) for press authorization instead of on-chain `PressAuthorizations`~~ ✅ RESOLVED 2026-06-16 — `card_validation.md` step 24 rewrites press-auth check to on-chain `PressAuthorizations` (authoritative) with `approved_presses` advisory; point-in-time note added. Both open-offer acceptance specs updated. ADR-011 verifier guidance bullet added. | — |

> **Pattern:** INC-51/52/55 are the latest fixes (INC-46, INC-27/35) not fully propagated to sibling
> docs — the recurring "edited the named file, not its siblings" pattern. INC-53/54 are the
> envelope/immutable-field schemas not catching up to the `senders` decision and the INC-37/47 field
> additions. INC-56/57 are pre-existing under-specifications surfaced by the full process-spec read.
> INC-53 and INC-54 are the signing-critical ones to prioritize.

---

## 0j. Eighth-pass review 2026-06-16 — post-fix verification of the INC-51…57 batch

Verified the INC-51…57 + hygiene fixes all landed (greps clean). Three issues were **introduced or
exposed by that batch** — two are the recurring "fixed the named file, not its sibling" pattern, one is
a genuine design gap that defining the `erasure` field surfaced.

~~**INC-58 — `ARCHITECTURE.md` ADR-007 still describes on-chain routing, contradicting the INC-55 off-chain rework (Medium).**~~ ✅ RESOLVED 2026-06-16
INC-55 reworked `message_routing.md` so the `{card_hash → wallet_service_id}` table is maintained
off-chain (no `wallet_service_id` in `RegisterCard` calldata, no on-chain migration event). But
`ARCHITECTURE.md` ADR-007 (line ~358) still says the routing table is *"derived from **on-chain card
registration and migration events**,"* and the Component Map (line ~455) shows *"card registration
events → wallet service routing tables."* These now contradict both `message_routing.md` and
`registry_contract.md` (which has no such calldata/event). **Fix:** update ADR-007's routing paragraph
and the Component Map annotation to the off-chain model (routing state maintained off-chain via the
Wallet Service Registry; mechanism deferred to the wallet service spec), consistent with the INC-35/55
decision.

**Decision:** ADR-007 now explicitly distinguishes the two mappings: (1) `card_hash → log-head CID` is on-chain (the registry contract `CardEntries[card_address].log_head_cid`); (2) `card_hash → wallet_service_id` used for message delivery is off-chain (Wallet Service Registry, design deferred to wallet service spec). The "derived from on-chain card registration and migration events" claim is removed. The Component Map annotation is corrected to note that wallet-service routing tables are off-chain.

~~**INC-59 — INC-57's verification asks for an authorization "window covering `issued_at`" that on-chain state cannot provide (Medium).**~~ ✅ RESOLVED 2026-06-16
`card_validation.md` step 24/98 now says the verifier rejects if the press was "not authorized for
this policy at issuance (no entry, or `active = false` with no prior active window covering
`issued_at`)." But `PressAuthEntry` (`registry_contract.md §3.3`) stores only the *most recent*
`authorized_at`, a single `active` bool, and `revoked_at` — **not** a history of authorize/revoke/
re-authorize windows. A verifier therefore cannot reconstruct whether the press was active at an
arbitrary past `issued_at` (e.g., across a rotation or a revoke-then-reauthorize). Moreover, the card's
**existence on-chain already proves** the press was active at registration — the contract's write gate
enforced `active == true` at `RegisterCard`/`ClaimOpenOffer`. **Fix:** simplify the check — the
on-chain registration is itself proof of authorization-at-write-time; the verifier consults current
`PressAuthorizations` for present revocation status, and (consistent with revocation semantics) a
press that is currently revoked does not retroactively invalidate cards it correctly registered while
active. Drop the "prior active window covering `issued_at`" reconstruction that stored state can't
support.

**Decision:** On-chain registration proves authorization-at-write-time; verifier uses current `PressAuthorizations` only for present revocation context, which does not retroactively invalidate correctly-registered cards. "Active window covering `issued_at`" reconstruction removed from `card_validation.md` step 24.

~~**INC-60 — `erasure` (now a defined field) conflicts with the append-only CID chain; reconciliation unspecified (Medium, design gap).**~~ ✅ RESOLVED 2026-06-16
~~With `erasure: true` defined (INC-56), the mechanism's interaction with ADR-003's linked-CID-chain is
unspecified. Each `LogEntry` chains via `prev_log_root` (the prior entry's CID), and verifiers walk
head→genesis; `ancestry_pubkeys`/`past_keys` content-key derivation and version monotonicity also
assume the chain is intact. "Redacting prior log entries, leaving only the revocation statement"
(`card_protocol_spec.md §952`) would leave dangling `prev_log_root` pointers and break chain-walk,
decryption, and version continuity — and because IPFS is content-addressed and immutable, "redaction"
can only mean un-pinning (anyone who cached an entry still has it; the revocation's `prev_log_root`
hash still commits to the redacted content). **Decision needed:** specify how an erasable card's chain
is represented after erasure (e.g., the erasure entry becomes a new genesis with no `prev_log_root`, or
carries a tombstone summarizing redacted versions), how verifiers treat a chain with a redacted
interior, and what `erasure` actually guarantees given immutable content addressing (it is best-effort
un-pinning, not cryptographic deletion — state this honestly). Alternatively defer the erasure feature
to a later version if the chain reconciliation is out of scope for v1.~~

**Decision:** Erasure feature removed entirely. Card logs are strictly append-only with no erasure mechanism; entries are never removed or redacted. The `erasable` policy field and the `erasure` update/log flag (added by INC-56) have been deleted from all specs (`protocol-objects.md §2/§3/§4`, `card_protocol_spec.md §852/§952/§961`, `process_specs/card_updates.md`). The Non-Goals statement in `card_protocol_spec.md §5` is now unconditional: retroactive removal of prior log entries is not supported, full stop. Revocation remains the mechanism for withdrawing standing — it appends a revocation entry rather than deleting anything.

**Minor (this pass):** `card_signing.md` Forwarding — the `forward_envelope` payload requirements list
(`forwards`, `recipients`, `content`, `timestamp`) omits `senders`, but after INC-53 `senders` is
Required in every payload; the forward envelope's payload also needs `senders` (the forwarder's
master-card pointer). Add it for consistency.

| ID | Severity | One-line | Primary docs in conflict |
|---|---|---|---|
| ~~**INC-58**~~ | ~~Medium~~ | ~~ADR-007 + Component Map still say routing tables are derived from on-chain registration/migration events; INC-55 made routing off-chain~~ ✅ RESOLVED 2026-06-16 — ADR-007 now distinguishes on-chain `card→CID` resolution from off-chain `card→wallet_service` message routing; Component Map annotation corrected. | — |
| ~~**INC-59**~~ | ~~Medium~~ | ~~Verification asks for a press "active window covering `issued_at`" that `PressAuthEntry` doesn't store; on-chain registration already proves authorization-at-write-time~~ ✅ RESOLVED 2026-06-16 — On-chain registration proves authorization-at-write-time; verifier uses current `PressAuthorizations` only for present revocation context, which does not retroactively invalidate correctly-registered cards; "active window covering `issued_at`" reconstruction removed from `card_validation.md` step 24. | — |
| ~~**INC-60**~~ | ~~Medium~~ | ~~`erasure` (now defined) breaks the append-only `prev_log_root` chain / content-addressed immutability; reconciliation unspecified~~ ✅ RESOLVED 2026-06-16 — Erasure feature removed; logs are strictly append-only; `erasable`/`erasure` deleted from all specs. | — |

> **Pattern (again):** INC-58 and INC-59 are the INC-55 and INC-57 fixes not propagated to ARCHITECTURE
> ADR-007 and not reconciled with what the contract actually stores. INC-60 is a substantive design
> question that defining the field exposed. None are blocking, but INC-60 should be settled (or the
> feature deferred) before erasable policies ship.

---

## 1. Blocking — resolve before contract deployment / npm API lock

| ID | Area | Question | Source |
|---|---|---|---|
| ~~**OQ-2**~~ | Contract | ~~**On-chain signature scheme.**~~ ✅ **RESOLVED 2026-06-14 (updated 2026-06-15)** — Phase 1 uses **secp256r1 via RIP-7212 precompile** (~3,450 gas/verify) for all on-chain write authorization (ADR-012 split-signing model). ML-DSA-44 is used for IPFS content signing only. The keccak256 hash of each press's ML-DSA-44 public key is stored on-chain in `PressAuthorizations` to enable a Phase 3 upgrade to full post-quantum on-chain verification without re-registration. Full ML-DSA-44 on-chain verification via Stylus is deferred to Phase 3. (INC-20 resolved 2026-06-15.) | ARCH OQ-2; registry OQ-2; spec Timeline |
| ~~**OQ-15**~~ | Governance | ~~**Bootstrap of initial governance keysets.**~~ ✅ **RESOLVED 2026-06-14** — Deploy with a 1-of-1 governance keyset (single deployer key). As additional governance members are invited in, `RotateGovernanceKeys` expands the keyset and raises quorum. Once the board has multiple members, quorum is required to add or remove members (via `RotateGovernanceKeys`). The quorum threshold itself is board-updatable via the same operation (self-amending). No deploy-time timelock or external multisig required; the single-key bootstrap is the accepted initial trust anchor. | registry OQ-15 |
| ~~**OQ-16**~~ | Contract | ~~**Sub-card holder key verification.**~~ ✅ **RESOLVED 2026-06-15** — Press mediates all sub-card registration and verifies the holder's ML-DSA-44 master signature off-chain before submitting `RegisterSubCard`. The holder signature is included in calldata as an auditable proof of holder intent but is not re-verified by the contract (Phase-1 contract has no on-chain ML-DSA-44 verifier). A press submitting without a valid holder signature is detectable and subject to deregistration (press-side E-22). (INC-22 resolved 2026-06-15.) | registry OQ-16 |
| ~~**X-1 / X-2**~~ | Spec | ~~Canonical protocol name; reconcile `CardEntry`/`RegistryEntry`.~~ ✅ Both resolved 2026-06-14 — see §0. | §0 above |

Also effectively blocking the contract (listed as High in source but gate deployment):

| ID | Area | Question | Source |
|---|---|---|---|
| ~~**OQ-17**~~ | Contract | ~~**Nonce storage & pruning.**~~ ✅ **RESOLVED 2026-06-14** — Per-press sequence numbers. Each `PressAuthEntry` gains a `next_sequence: uint64` field. Press-signed payloads use `"sequence": <uint64>` instead of a random nonce; the contract checks `sequence == next_sequence` and increments on success. No nonce storage table or pruning needed. Governance payloads retain timestamp-scoped random nonces (governance bodies don't map cleanly to per-entity sequences and governance ops are rare). | registry OQ-17 |
| ~~**OQ-18**~~ | Contract | ~~**Upgradeability path.**~~ ✅ **RESOLVED 2026-06-14** — Modular upgrade (Option C). The ML-DSA-44 verifier logic lives in a separate Stylus module; the registry storage contract is immutable. The verifier module address is stored in the registry and upgradeable via governance quorum (`UpgradeVerifier` governance operation) with a 48-hour timelock. Storage layout, card entries, and authorization tables are never touched by an upgrade. | registry OQ-18 |

> Note: Canonical serialization (former OQ-1) is **resolved** — RFC 8785 JSON Canonicalization Scheme (JCS), per ADR-010 (as reversed 2026-06-14), `card_protocol_spec.md` Appendix A, and `serialization-conformance.json`. All field values are serialized as plain JSON strings; there is no schema-aware type coercion. One action item remains open: validate the npm JCS encoder against the full conformance corpus before deploy. (INC-19 resolved 2026-06-15.)

---

## 2. High — resolve before building the relevant subsystem

| ID | Area | Question | Source |
|---|---|---|---|
| ~~**OQ-4**~~ | Contract / keys | ~~**Recipient-initiated writes.**~~ ✅ **RESOLVED 2026-06-14** — Press always mediates all writes. Holder-initiated `UpdateMarkHead` (self-revocation, key rotation) is submitted through a press just like issuer-initiated updates. Gas for holder-initiated writes is paid by the issuing organization's press — holders do not hold or spend ETH directly. | ARCH OQ-4; registry OQ-4; spec §2 |
| ~~**OQ-5**~~ | Verification | ~~**Policy schema evolution.**~~ ✅ **RESOLVED 2026-06-14** — Previously-issued cards remain valid. Verifiers check `field_definitions` against the policy version in effect at card creation time (from the policy card's IPFS log history), not the current version. Cards issued before a field was added are conforming under the policy version at their issuance. | ARCH OQ-5; spec §1, §5 |
| ~~**OQ-9**~~ | Client / Design | ~~**Trusted-root configuration & sync.**~~ ✅ **RESOLVED 2026-06-14** — Trusted roots are at the protocol/contract level only. A policy registered in `PolicyAuthorizerKeys` on the Arbitrum One contract is a trusted root; an unregistered policy is not. No per-wallet trust store, no per-user trust configuration in v1. Wallets verify that a card's chain terminates at a policy present in the on-chain registry. | ARCH OQ-9; spec §7 |
| ~~**SUB-DEREG**~~ | Keys | ~~**Sub-card deregistration with recovery-only access.**~~ ✅ **RESOLVED 2026-06-14** — Sub-cards are deregistered via a request signed by the holder's **primary card key** (not a sub-card key), submitted through a press. The primary card key is recoverable via the protocol's key recovery process. Gas is paid by the issuing organization's press (holder-sovereignty operation, consistent with OQ-4). After a key recovery event, all existing sub-cards should be revoked (the recovered-from key may have been compromised) and re-requested from each app. | spec §3 |

---

## 3. Medium — resolve during implementation

| ID | Area | Question | Source |
|---|---|---|---|
| **OQ-3** | Infra | Minimum IPFS replication before the on-chain pointer update is "safe," and how/whether it is enforced. | ARCH OQ-3; registry OQ-3; spec §2 |
| **OQ-6** | Client | New-log-entry detection: poll the registry vs. subscribe to `CardHeadUpdated` events (needs an indexer). | ARCH OQ-6; registry OQ-6; spec §5 |
| **OQ-7** | Client | Fetch budget & caching for chain/annotation lookups on mobile with limited connectivity. | ARCH OQ-7; spec §7 |
| **OQ-8** | Verification | When a cached chain array's version CIDs diverge from a link's current state (ancestor updated post-issuance), how does the verifier reconcile? | ARCH OQ-8; spec §7 |
| **OQ-10** | Recovery / Design | Recovery UX when the holder has lost *both* primary service and YubiKey. In scope for v1? | ARCH OQ-10; spec §3 |
| **OQ-13** | Interop / Design | Should wallet services publish `/.well-known/card-wallet.json` advertising supported transports so requesters can populate `callbacks` correctly? | ARCH OQ-13; spec §8 |
| **OQ-14** | Governance | Governance key-holder identity: pseudonymous (coercion-resistant) vs identifiable (accountable). Deferred to governance charter. | ARCH OQ-14; registry OQ-14 |
| **OQ-19** | Contract | `BatchUpdateMarkHeads` to amortize gas for high-volume presses — needed for press economics at scale? | registry OQ-19 |
| **OQ-20** | Governance | Policy deregistration / kill-switch: should `PolicyAuthorizerKeys` support removal (bricks all presses + cards under it)? | registry OQ-20 |
| **TRUST-IND** | Design | Trust indicator must distinguish "verified to a root I trust" from "verified to an unknown root." | spec §7 |
| **MSG-EDIT** | Messaging | Delivering edits of private/encrypted messages to recipients who never received the original. | spec §6 |
| **KR-PRESS-ROT** | Security | Press emergency rotation: is deactivating the on-chain `PressAuthorizations` entry enough, or is a signed "press-compromise notification" needed for verifiers checking already-issued cards? | key_rotation §9 |
| **KR-901** | Policy | Is holder-issued 910 (full-wallet-compromise loud revocation) appropriate for all policies, or should root-of-trust policies block holder-issued loud revocations? | key_rotation §9 |
| **SM-CADENCE** | Trust & Safety | Minimum audit cadence for an app to keep "audited" status (per-version, per-major, time-based?). | subcards §9 |
| **SM-SPAM** | Security | App pays gas for sub-card registration → registry-spam risk; rate-limit per installation card? | subcards §9 |
| **MA-RECOVERY** | Product | Key-custody UX: user-visible recovery flow when a member loses keyring access (blocking for onboarding design). | mutual_aid §OQ |
| **MA-ONBOARD** | Product | WhatsApp onboarding via Rhizal, a standalone bot, or hybrid (determines onboarding arcardecture). | mutual_aid §OQ |
| **MA-DATA** | Product | Data residency: where exchange records and offer content live (IPFS vs hosted DB) and privacy implications. | mutual_aid §OQ |

### Messaging-protocol set (MSG-OQ-1…18, condensed)

The messaging spec carries 18 of its own open questions. The ones that shape core data
structures (and so should be settled before the envelope schema is frozen) are:

- **MSG-OQ-1** Type-field routing vs. encryption — is a coarse routing category (`system|human|machine`) in an unencrypted outer header, or routing by recipient only?
- **MSG-OQ-2** Keep the explicit `senders` (master pointer) field, or infer master identity via the sub-card→master link to avoid disclosure?
- **MSG-OQ-3** Message-type versioning: `min_version`, capability negotiation, or `type` namespacing.
- **MSG-OQ-6 / OQ-7** Group membership representation across changes; large-audience announcement delivery (shared group key vs per-recipient vs unencrypted).
- **MSG-OQ-11 / OQ-12** MCP: wrap JSON-RPC verbatim vs translate to envelope; multi-hop delegation model.
- **MSG-OQ-18** Shared error-code namespace vs per-domain codes.

The remainder (MSG-OQ-4,5,8,9,10,13,14,15,16,17 — reactions, OHTTP auth callback,
multi-predicate auth, API idempotency window, capability-grant revocation/expiry,
introduction semantics, read-receipt privacy, ephemeral message class) are feature-level and
can be resolved as those message types are implemented. (Source: `messaging_protocol.md §Open Questions`.)

---

## 4. Low — track but not blocking

| ID | Area | Question | Source |
|---|---|---|---|
| **OQ-11** | Design | UX when a recipient declines an offer; notify the press? | ARCH OQ-11; spec §4 |
| **OQ-12** | Governance | Foundation-operated transparency log of approved press implementations (relevant only if TEE attestation lands in P2). | ARCH OQ-12; spec §2 |
| **OQ-21** | Infra | Canonical indexer interface (e.g., subgraph schema) to keep IPFS `approved_presses` synced with on-chain `PressAuthorizations`. | registry OQ-21 |
| **OFFER-TTL** | Press | How long should the press retain unsigned offers before expiry? | spec §4 |
| **MSG-RCPT-MAX** | Design | Maximum `recipients` array size; should broadcast use a different primitive? | spec §6 |
| **AUTH-PREDICATE-UX** | Design | Evaluate `required_predicate` before showing the request (hide unfulfillable requests) vs. always show with explanation. | spec §8 |
| **AUTH-CODE-GC** | Engineering | Confirmation-code expiry/cleanup for sessions the user never completes. | spec §8 |
| **KR-101** | Design | Should verifiers require re-attestation under a new key for high-stakes checks when a sub-card's signing key was later revealed compromised (code 101)? | key_rotation §9 |
| **KR-BOOTSTRAP** | Engineering | After a 910 full-wallet-compromise revocation, auto-initiate a new identity bootstrap or require explicit holder trigger? | key_rotation §9 |
| **KR-STMT** | Design | Post the key-rotation statement to the old card's log, or just reference its CID in the 1xx entry's `updater_message`? | key_rotation §9 |
| **SM-SHARE-ALL** | Design | Offer a "share all cards" option vs mandatory per-card selection. | subcards §9 |
| **SM-OFFLINE** | Engineering | Sub-card request that arrives while the user is offline: queue or reject-with-retry? | subcards §9 |
| **SM-GAS** | Engineering | Should the wallet ever sponsor gas for sub-card registration, or is it always the app's responsibility? (intersects OQ-4) | subcards §9 |
| **SM-RENEW** | Design | On `valid_until` sub-cards, send a renewal reminder before expiry vs. require app re-request. | subcards §9 |
| **MA-MONETIZE** | Product | Monetization model (free/grant-funded/freemium). | mutual_aid §OQ |
| **MA-PILOT** | Product | First pilot community + initial offer types. | mutual_aid §OQ |
| **MA-NOTIFY** | Engineering | HTTPS notification failure modes & retry strategy at MVP scale. | mutual_aid §OQ |

---

## Suggested resolution sequence

0. ~~**Decide whether card *content* is encrypted or plaintext on IPFS (INC-37, §0e).**~~ ✅ **RESOLVED 2026-06-15.** Content stays encrypted (Option 2). Each `CardDocument` (including `PolicyCardDocument`) carries a new protocol-required immutable field `ancestry_pubkeys` — an ordered array of base64url ML-DSA-44 public keys (1,312 bytes each, immediate parent first) covering every ancestor the verifier must traverse to reach a trusted root. Walkers bind each entry with `keccak256(entry_pubkey)` == on-chain address before deriving the content key and decrypting; a mismatch or AES-GCM failure is a hard rejection. All three signatures (issuer, holder, press) cover `ancestry_pubkeys`. The `"card-content-v1"` domain string (INC-39) is now resolved — see §0e.
1. ~~**Settle the name (X-1) and reconcile the on-chain entry spec (X-2)**~~ ✅ Both resolved 2026-06-14.
2. **Lock the contract design decisions** — OQ-2 (gas), OQ-15 (bootstrap), OQ-16 (holder-key
   verification), OQ-17 (nonces), OQ-18 (upgradeability), OQ-4 (recipient writes). These are
   irreversible-after-deploy.
3. **Finish the serialization action items** — npm JSON↔CBOR surface + Stylus conformance
   validation against `serialization-conformance.json`.
4. **Resolve verification semantics** — OQ-5 (schema evolution), OQ-8 (chain-array
   divergence), OQ-9 (trusted-root config).
5. **Freeze the messaging envelope** — MSG-OQ-1/2/3/6/7 before clients ship.
6. **Product-track questions** (mutual-aid MA-*) on their own timeline, gated only where the
   table cards them blocking for onboarding design.
