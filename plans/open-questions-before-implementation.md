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

**Decision:** The canonical term is **"card"** (membership card). URI scheme is `card://`. Package name is `card-validator` / `CardAuth`. Object names are `CardDocument`, `CardEntry`, etc. On-chain function is `RegisterCard`. All files and filenames have been updated; no remaining "chitt" or "mark" (as protocol term) references exist in the codebase.

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

**INC-10 — "All writes go through a press" vs holder-callable on-chain ops (Medium).**
`card_protocol_spec.md` §5 Non-Goals: *"No special direct-write paths for any code range. All
updates… go through an approved press."* But `registry_contract.md` §4.3–4.4 card
`RegisterSubCard`/`DeregisterSubCard` as *"Called by: Master card holder (via paymaster or
press)."* Resolve whether holders can write directly (ties to OQ-4).

**INC-11 — Attestation deferred by the core spec but required by subcards (Medium).**
`card_protocol_spec.md` defers hardware attestation ("Not: Hardware attestation in v1"; TEE is
P2), yet `subcards.md` Step 2 makes platform app-attestation (iOS App Attest / Android Play
Integrity) a hard P0 gate ("An app that cannot produce a valid attestation is rejected").
Decide whether attestation is in scope for v1.

**INC-12 — `delegated_capabilities` is not integrated with predicate-based verification
(Medium).** `subcards.md` §Step 4 introduces a `delegated_capabilities` object (`can_sign_statements`,
`revocation_8xx`, …). The core verification flow (§7) evaluates authority only via
`update_policy`/`revocation_permissions` predicates and the sub-card→master link — there is no
defined way for a verifier to enforce `delegated_capabilities`. Specify how (or whether) these
grants are checked.

### Audit-encryption model conflict

**INC-13 — Per-entry ML-KEM vs per-epoch AEK audit encryption coexist (High).**
`ARCHITECTURE.md` ADR-003 (and the `protocol-objects.md` §2 PolicyCardDocument table) say each
issuance entry is encrypted **to each auditor's key via ML-KEM** (per-entry). But
`card_protocol_spec.md` §2 "Audit Epoch Lifecycle" and `protocol-objects.md` §11–§12 specify a
**per-epoch AEK** (AES-GCM, the AEK wrapped per auditor via ML-KEM). ADR-003 and the §2 table
still describe the superseded per-entry model. This affects the auditor implementation and the
forward-secrecy claims; update ADR-003 to the epoch model.

### Hygiene / lower severity

**INC-14 — ML-KEM parameter set not pinned (Medium).** ADR-004 says "ML-KEM (FIPS 203)" without
choosing 512/768/1024; `protocol-objects.md` §12 silently assumes ML-KEM-768 (1088-byte
ciphertext). Pin the parameter set normatively in ADR-004.

**INC-15 — `press_signature` coverage wording differs (Medium).** `protocol-objects.md` §3 says
the press signs "the complete LogEntry **excluding the `press_signature` field**";
`ARCHITECTURE.md` ADR-003 and `card_protocol_spec.md` §5 say "the complete/assembled LogEntry"
with no exclusion. State exactly which fields are covered (a signature cannot cover itself).

**INC-16 — `protocol-objects.md` §15 is also stale (Low).** `registry_contract.md` §2 says it
supersedes `protocol-objects.md` §14 (`RegistryEntry`) but does not mention §15
(`SubCardRegistration`), which the contract's `SubCardRegistrations`/`RegisterSubCard` likewise
supersede. Flag §15 for update alongside §14 (extends X-2).

**INC-17 — `update_codes.md` is a divergent legacy restatement (Low).** It uses "card" and
gives `710` as the "honorable" example, whereas `card_protocol_spec.md` defines `700`
honorable / `750` procedural / `760` unfavorable. New codes introduced elsewhere (e.g.
`key_rotation.md` code `101`) are not reflected here or in the main code table. Make one
document the canonical code registry and delete/redirect the other.

**INC-18 — `messaging_protocol.md` doc errors (Low).** Two consecutive `### 5.` headings
(`card_offer` and `card_offer_accepted`); the genesis object is called `CardDocument` here vs
`CardDocument` in `protocol-objects.md` (folds into X-1).

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
| INC-10 | Medium | "all writes via press" vs holder-callable ops | spec §5 vs registry_contract |
| INC-11 | Medium | Attestation deferred vs required | spec vs subcards |
| INC-12 | Medium | `delegated_capabilities` not in verification | subcards vs spec §7 |
| INC-13 | High | Per-entry ML-KEM vs per-epoch AEK audit model | ADR-003/§2 table vs spec §2/protocol-objects §11-12 |
| INC-14 | Medium | ML-KEM parameter set unpinned | ADR-004 vs protocol-objects §12 |
| INC-15 | Medium | `press_signature` coverage wording | protocol-objects vs ARCH/spec |
| INC-16 | Low | protocol-objects §15 also stale | registry_contract §2 |
| INC-17 | Low | `update_codes.md` legacy drift | update_codes vs spec |
| INC-18 | Low | messaging doc errors / object name | messaging vs protocol-objects |

\* Blocking specifically for the messaging subsystem / envelope freeze.

> **Triage note:** INC-1, INC-2, INC-3, and INC-4 are signing-critical and belong in the same
> "resolve before npm API lock / contract deploy" bucket as Section 1. INC-13 (audit model) and
> INC-6 (rotation mechanism) should be settled before auditor and key-rotation code is written.

---

## 1. Blocking — resolve before contract deployment / npm API lock

| ID | Area | Question | Source |
|---|---|---|---|
| **OQ-2** | Contract | **ML-DSA-44 Stylus gas cost.** Benchmark full on-chain ML-DSA-44 verification against current Arbitrum One blob-era pricing. One press sig per `RegisterCard`/`UpdateMarkHead`; up to *quorum* (3–5) sigs + 1,312-byte keys per governance op. Confirm per-write and per-governance-op cost is acceptable before deploy. | ARCH OQ-2; registry OQ-2; spec Timeline |
| **OQ-15** | Governance | **Bootstrap of initial governance keysets.** The deployer sets the first `GovernanceKeysets`; no quorum can authorize itself before it exists. How are initial holders chosen, published, audited? Timelock or recognized-stakeholder multisig at deploy? | registry OQ-15 |
| **OQ-16** | Contract | **Sub-card holder key verification.** `RegisterSubCard` must verify a signature from the master-card *holder*, not the press. Options: (a) store `holder_pubkey` on-chain per card (~1,312 B/card); (b) press-mediate all sub-card registration (adds press dependency to a user-sovereign op); (c) off-chain verify + press-countersigned payload (weakens user-sovereign model). | registry OQ-16 |
| ~~**X-1 / X-2**~~ | Spec | ~~Canonical protocol name; reconcile `CardEntry`/`RegistryEntry`.~~ ✅ Both resolved 2026-06-14 — see §0. | §0 above |

Also effectively blocking the contract (listed as High in source but gate deployment):

| ID | Area | Question | Source |
|---|---|---|---|
| **OQ-17** | Contract | **Nonce storage & pruning.** Replay protection must bound storage growth. Timestamp-scoped nonces vs per-press sequence numbers; must align with the `timestamp` already in signed payloads. | registry OQ-17 |
| **OQ-18** | Contract | **Upgradeability path.** Immutable vs proxy (trusted upgrade key) vs modular (only the verifier upgradeable). The new ML-DSA-44 Stylus code is bug-prone enough to argue for *some* path. | registry OQ-18 |

> Note: Canonical serialization (former OQ-1) is **resolved** — canonical CBOR per RFC 8949
> §4.2 with a JSON input surface (ADR-010, spec Appendix A, `serialization-conformance.json`).
> Two action items remain open: implement the npm JSON↔CBOR surface, and validate the Stylus
> WASM CBOR encoder against the full conformance corpus before deploy.

---

## 2. High — resolve before building the relevant subsystem

| ID | Area | Question | Source |
|---|---|---|---|
| **OQ-4** | Contract / keys | **Recipient-initiated writes.** Can a holder call `UpdateMarkHead` directly (e.g., self-revocation) via paymaster, or must a press always mediate? Direct writes need holder-key verification on-chain + gas sponsorship; press-mediated adds a liveness dependency on a user-sovereign op. Intersects key-rotation KR-4 and subcard SM-3. | ARCH OQ-4; registry OQ-4; spec §2 |
| **OQ-5** | Verification | **Policy schema evolution.** When a running policy adds a `field_definitions` field, are previously-issued cards lacking it non-conforming or still valid? Affects every verifier. | ARCH OQ-5; spec §1, §5 |
| **OQ-9** | Client / Design | **Trusted-root configuration & sync.** How does a user configure trusted roots and sync them across devices? Foundational to all client verification and to the captured-root threat (red-team 3.1-B). Spec flags design work should start in parallel. | ARCH OQ-9; spec §7 |
| **SUB-DEREG** | Keys | **Sub-card deregistration with recovery-only access.** After recovery, how does a holder deregister compromised device sub-cards when they have no active device sub-card to sign with? | spec §3 |

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
