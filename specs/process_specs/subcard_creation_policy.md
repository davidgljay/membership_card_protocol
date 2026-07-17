# Sub-Card Governance

**Version:** 0.2 (draft)
**Date:** 2026-07-16
**Status:** Draft
**Applies to:** All sub-cards created under the card protocol

**Changelog (spec-consistency Phase 2, Step C, Decision (d)):** Full rewrite. This document previously presented itself as a governing `PolicyCardDocument` whose `revocation_permissions`/`field_definitions` predicates the press enforced "mechanically at update time" against a sub-card's own append-only log. That model has no attachment point in the actual object model: `SubCardDocument` (`protocol-objects.md §16`) has no `policy_id` field — unlike every other card type — and sub-cards are registered on-chain in `SubCardRegistrations` (`registry_contract.md §3.4`), a mapping structurally separate from the `CardEntry` mapping that policy-governed cards use. The generic update pathway (`press.md §5.3`'s "resolve the target card's policy from the on-chain `CardEntry`") cannot run for a sub-card, and no verifier reads a sub-card's own log for update or revocation codes — the only verifier-facing sub-card state is the on-chain `SubCardEntry.active` flag and the master card's `active_subcards` directory. This rewrite instead documents the three mechanisms that actually govern a sub-card today. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md` Decision (d) and Fixes #31, #39, #40.

---

## Purpose

Unlike an ordinary `CardDocument`, a sub-card is not issued under a `PolicyCardDocument` and has no `policy_id`. There is no separate policy object whose `revocation_permissions`/`field_definitions` predicates a press resolves and enforces against a sub-card's log, because a sub-card has no `CardEntry` and no such log is ever read by a verifier or a press.

What actually governs a sub-card's lifecycle is three independent, narrower mechanisms:

1. **The app-certification chain** — governs which applications are even eligible to hold a sub-card at all (§Mechanism 1).
2. **`capabilities` and `limitations`, fixed once at issuance in the `SubCardDocument` itself** — govern what a sub-card may sign, for the sub-card's entire lifetime (§Mechanism 2).
3. **On-chain deregistration (`DeregisterSubCard`)** — the sole mechanism by which a sub-card stops being valid (§Mechanism 3).

This document describes each of the three as they actually work, and cross-references `specs/subcards.md` (the creation/acceptance flow), `protocol-objects.md §16` (the `SubCardDocument` schema and runtime verifier chain walk), `registry_contract.md §4.3`/`§4.4` (the on-chain calls), and `press.md §5.4` (the press-side registration function) as the authoritative sources for each.

---

## Parties

**Holder:** The holder of the master (primary) card, who authorized the sub-card by countersigning its `SubCardDocument` with their primary card key. After issuance, the holder's wallet acts on the holder's behalf for lifecycle operations that require the holder's signature (notably, one of the three valid deregistration signer paths — see §Mechanism 3).

**Application:** The installed app that requested the sub-card, holds an **app card** issued by a governance-approved certifier (`specs/subcards.md §App Cards and the Trust Chain`), and holds the sub-card's private key in its hardware-scoped keystore.

---

## Mechanism 1: The App-Certification Chain

A sub-card can only be issued to (and remain valid for) an application whose **app card** chains to the governance authority's app-certification policy root. This is checked twice, independently:

- **At registration, by the press.** Before submitting `RegisterSubCard`, the press walks the `app_card` chain using `app_card_pubkey` (deriving the content key via `HKDF-SHA3-256(app_card_pubkey, info="card-content-v1")` to decrypt the app card, then following its `ancestry_pubkeys`) to confirm it reaches the governance authority's app-certification policy root, rejecting registration if it does not. See `press.md §5.4 verifyAppCertificationChain` and `registry_contract.md §4.3`.
- **At verification time, by every runtime verifier.** Per `protocol-objects.md §16`'s runtime chain-walk procedure (step 12), a verifier independently re-walks the `app_card` chain from `app_card_pubkey` up to the configured `appCertificationRoot`, hard-rejecting with `APP_CARD_CHAIN_NOT_TRUSTED` if the chain does not reach it — regardless of whether the press accepted the sub-card at registration time. Per-link on-chain addresses are authoritative; `app_card_pubkey` (like `holder_primary_card_pubkey`) is an untrusted hint whose validity is established by the `keccak256` binding check before use.

This is the mechanism that keeps an unapproved or decertified application from being able to hold a valid sub-card at all, independent of anything the application itself declares. See `specs/subcards.md §App Cards and the Trust Chain` for the full trust-chain diagram (governance authority → app-certification policy → certifier card → app card → `SubCardDocument`).

**Ongoing compliance.** Third-party annotations on the app's card (via the EAS annotation layer) can escalate after a sub-card has already been issued. A blocking annotation (8xx/9xx-equivalent) on the app's card triggers automatic revocation of all of that app's active sub-cards on the wallet's next sync — see §Mechanism 3's "Automatic revocation on annotation escalation" and `specs/subcards.md §Ongoing Compliance`. This is a wallet-enforced response to the app card's own annotation state, not a separate predicate evaluated against the sub-card.

---

## Mechanism 2: Capabilities and Limitations, Fixed at Issuance

`capabilities` (a whitelist of message-type strings) and `limitations` (additional content constraints on what a sub-card may sign, expressed in the protocol's existing predicate/`field_requirements` grammar) are both fields on the `SubCardDocument` itself (`protocol-objects.md §16`). They are set once, at issuance, and covered by both `app_signature` and `holder_signature`.

**These fields are immutable after issuance — there is no update path for them.** This follows the same logic that bars 1xx–7xx field changes on an ordinary card's log: a sub-card has no `policy_id` and no `CardEntry`, so there is no update-intent pathway (`press.md §5.3`) that could even target a `SubCardDocument`'s fields in the first place. If a holder or app wants a sub-card to have different `capabilities`/`limitations`, the only path is to revoke the existing sub-card (see §Mechanism 3) and issue a new one with the desired set — exactly as `specs/subcards.md` describes for capability changes. There is no "silent extension" or in-place field update for a sub-card, for `valid_until` or for anything else.

See `specs/subcards.md §Capabilities` and `§Limitations` for the field semantics and worked examples (whitelist checks, `field_requirements` regex constraints, and the explicit out-of-scope note on count-based rate limiting).

**A note on sub-card annotations.** Earlier drafts of this document described a per-sub-card "notes" mechanism (2xx/4xx codes posted to the sub-card's own log). No such log exists: a sub-card has no append-only IPFS log that a press appends to or a verifier reads, unlike an ordinary card. Any annotation about how an app is using a sub-card belongs on the **app's own card** via the EAS annotation layer (`specs/subcards.md §Trust-and-Safety Integration`), not on the sub-card itself. Annotations about the master card holder belong on the holder's own master card log, using the standard 2xx/4xx codes there (`update_codes.md`) — a separate log from the sub-card entirely.

---

## Mechanism 3: Revocation

A sub-card's validity is a single on-chain boolean: `SubCardRegistrations[sub_card_address].active` (`registry_contract.md §3.4`). There is no separate "quiet" vs. "loud" revocation state for a sub-card the way there is for an ordinary card's log — the only revocation operation is the on-chain `DeregisterSubCard` call (`registry_contract.md §4.4`), which sets `active` to `false`. Signatures produced by the sub-card before deregistration remain verifiable; signatures produced after are rejected by any verifier checking `SubCardRegistrations[sub_card_address].active`.

### Who can trigger deregistration

Per `registry_contract.md §4.4` (Decision (b), resolved), the press verifies `DeregisterSubCard`'s `signature` off-chain against **any one** of three independent, sufficient signer paths — the contract does not care which was used:

- **(a) the master card's holder key** — the holder's primary card, resolved from the master `CardDocument` on IPFS;
- **(b) the requesting app's own card key** — resolved from the `SubCardDocument`'s `app_card_pubkey`; or
- **(c) the sub-card's own key** — resolved from the `SubCardDocument`'s `recipient_pubkey`.

Any single valid signature from any one of these three is sufficient, for either a suspected-compromise scenario or a benign/cooperative removal. This is a change from an earlier (never-implemented) model in which only the master holder key could deregister a sub-card; that model is superseded by `registry_contract.md §4.4`'s current three-signer text.

Gas for `DeregisterSubCard` is paid from the requesting app's pre-funded gas account with the press; if that balance is insufficient, the issuing organization's press sponsors the cost, so that deregistration is never blocked by a depleted balance (`registry_contract.md §4.12`).

Deregistration should be paired with a code-511 `UpdateIntentPayload` against the holder's master card, removing the sub-card's pubkey from `active_subcards` — see `specs/subcards.md §Authorization for Deregistration`.

### Revocation scenario codes (informational)

The codes below label *why* a `DeregisterSubCard` call was made, for human/audit legibility. They are not separately enforced on-chain — the contract only ever sets `active` to `false` regardless of code — and they are the standard protocol-wide revocation codes defined canonically in `specs/update_codes.md §8xx — Quiet Revocations`, cited here (not restated with independent wording) per that document's `§Adding New Codes` step 3:

| Code | Canonical meaning (`update_codes.md §8xx`) | Typical sub-card trigger |
|---|---|---|
| 800 | Role ended; departed in good standing | App's certified role or agreement with the holder concluded normally |
| 801 | Voluntary surrender by holder | Holder revokes the app's authorization, unconditionally, at will (equivalent to revoking an OAuth grant) |
| 810 | Signing key compromised | Sub-card's private key suspected compromised |
| 811 | Sub-card lost or stolen (this card only) | App uninstalled, device retired, or device lost — this sub-card only; does not affect the holder's master card or other sub-cards |

`update_codes.md §8xx` is the canonical source for these descriptions; do not restate them with independently drifting wording elsewhere.

### Automatic revocation on annotation escalation

There is no 9xx ("loud") revocation pathway specific to sub-cards, distinct from the mechanism above — `SubCardEntry.active` is a single boolean with no code attached on-chain. What functions as an escalation path is: when the requesting app's own card receives a blocking annotation (8xx/9xx-equivalent, per `specs/subcards.md §Ongoing Compliance`) after sub-card issuance, the wallet SHOULD automatically call `DeregisterSubCard` (using signer path (a), the master holder key, which the wallet holds) for every active sub-card issued to that app, and notify the holder. This is a wallet-enforced policy response to the app card's annotation state — not a distinct sub-card revocation code, and not something a trust-and-safety governance body calls directly against a sub-card (there is no contract entry point for that).

### Deregistration after key recovery

If the holder's primary card key is lost and later recovered, the holder should treat all previously authorized sub-cards as potentially suspect and deregister them using the recovered key, prompting each app to re-request a new sub-card. See `specs/subcards.md §Deregistration After Key Recovery` for the full sequence.

---

## Cross-References

- `specs/subcards.md` — the sub-card creation/acceptance flow (Steps 1–5c), key management, capabilities/limitations worked examples, revocation authorization, and trust-and-safety integration. This document defers to it for anything not specific to governance/enforcement semantics.
- `protocol-objects.md §16` — the `SubCardDocument` schema and the authoritative 12-step runtime verifier chain walk.
- `registry_contract.md §4.3` (`RegisterSubCard`) and `§4.4` (`DeregisterSubCard`) — the on-chain calls underlying issuance and revocation.
- `press.md §5.4` — the press-side `processSubCardRegistration`/`verifyAppCertificationChain` functions.
- `specs/update_codes.md §8xx` — canonical revocation code descriptions.
