# Sub-Cards — Feature Specification

**Version:** 0.2 (INC-7 revision, 2026-06-14)
**Date:** 2026-06-14
**Status:** Draft

> **Terminology note.** This spec uses "sub-card" as the canonical term for device-bound, app-specific credentials. All sub-cards follow the same `SubCardDocument` schema (see `protocol-objects.md §16`). The wallet is itself an app that creates sub-cards for its own use.

---

## Overview

A **sub-card** is a device-bound, app-specific credential that delegates a scoped subset of a holder's signing authority to a specific application. Sub-cards are the mechanism by which apps sign statements on a user's behalf, authenticate the user, and access cards the user has selected — while being structurally prevented from exfiltrating the user's primary card key or accessing unauthorized cards.

Every sub-card follows the same protocol:

1. The requesting app holds a registered **app card** and uses its app card key to sign a `SubCardDocument`.
2. The user's wallet presents the request and the requested capability whitelist to the user for approval.
3. The holder's **primary card key** countersigns the document, authorizing the delegation.
4. The completed sub-card is registered on-chain, linked to both the holder's primary card and the app's card.

The wallet is itself an app — it has its own app card and creates its own sub-cards (for message signing, authentication, and other routine operations) via the same protocol. The only difference is that the wallet self-signing flow skips the user approval step, since the user already trusts the wallet with their primary card key.

---

## App Cards and the Trust Chain

Every app that requests sub-cards must hold an **app card** — a registered card in the protocol issued by a governance-approved certifier. App cards are not self-issued.

The trust chain for a sub-card is:

```
Badge governance authority
  └── App-certification policy (governed by badge governance authority)
       └── Certifier card (issued to an approved certifier)
            └── App card (issued by certifier; attests the app agrees to data-protection norms)
                 └── SubCardDocument (signed by app card key + holder primary card key)
```

A **certifier** is an entity approved by the governance authority to evaluate whether apps meet the protocol's user data-protection norms. Issuance of an app card by a certifier is a standing attestation that the app has agreed to those norms and passed initial review.

Third-party annotators may post annotations on an app's card using the EAS annotation layer — security audits, compliance certifications, or safety concerns. Wallets act on these annotations at sub-card issuance time and on an ongoing basis.

---

## Sub-Card Request Flow

### Step 1: App Generates Keypair and Constructs SubCardDocument

The app generates a fresh ML-DSA-44 keypair inside the device's hardware-backed secure storage (Secure Enclave on iOS, StrongBox / TEE-backed Keystore on Android). The private key is scoped to the app's signing identity and cannot be read, exported, or accessed by any other process.

The app assembles a `SubCardDocument` (see `protocol-objects.md §16`):

```json
{
  "holder_primary_card":        "<mutable pointer of the holder's primary card>",
  "holder_primary_card_pubkey": "<base64url — ML-DSA-44 public key of the holder's primary card, 1312 bytes raw>",
  "app_card":                   "<mutable pointer of this app's card>",
  "app_card_pubkey":            "<base64url — ML-DSA-44 public key of the app's card, 1312 bytes raw>",
  "capabilities":               ["<message type>", "..."],
  "recipient_pubkey":           "<base64url — new ML-DSA-44 public key>",
  "issued_at":                  "<ISO 8601>",
  "valid_until":                "<ISO 8601 — optional>",
  "attestation_level":          "T2",
  "attestation_proof":          "<base64url — App Attest / Play Integrity assertion, omitted if T1>"
}
```

The app signs canonical RFC 8785 JSON of this document (including `holder_primary_card_pubkey` and `app_card_pubkey`, without the two signature fields) with its app card key → `app_signature`. The partially-signed document is sent to the wallet.

**Delivery channel.** The app sends the request to the wallet via an HTTPS callback or platform deep link. The delivery mechanism is determined by the platform integration layer (see `messaging_protocol.md`).

### Step 2: Wallet Validates the App Card Chain

Before presenting the request to the user, the wallet:

1. Verifies `app_signature` against the app's card key (`app_card_pubkey` from the document).
2. Applies the binding checks for both parent-pubkey hints:
   - Confirms `keccak256(holder_primary_card_pubkey)` equals the `holder_primary_card` pointer address. A mismatch is a hard rejection.
   - Confirms `keccak256(app_card_pubkey)` equals the `app_card` pointer address. A mismatch is a hard rejection.
3. Walks the `app_card` chain using `app_card_pubkey` (deriving the content key as `HKDF-SHA3-256(app_card_pubkey, info="card-content-v1")` to decrypt the app card, then continuing via the app card's `ancestry_pubkeys`) to confirm it reaches the governance authority's app-certification policy root.
4. Checks the app card's log for any revocation entries.
5. Queries the EAS annotation layer for third-party annotations on the app's card.
6. Verifies the attestation: if `attestation_level` is `"T2"`, verifies the `attestation_proof` assertion against the platform's attestation service and confirms the attested key hash matches `recipient_pubkey`. If `attestation_level` is `"T1"`, confirms the platform keystore reports the key as hardware-backed. If the policy does not accept T1 and the level is not T2, blocks the request.

**Outcomes:**

| App card state | Wallet behavior |
|---|---|
| Valid chain to governance root, no revocation, no annotations | Proceed to user prompt |
| Valid chain, advisory annotations (6xx/7xx equivalent) | Warn user with yellow/orange advisory; allow proceed or cancel |
| Valid chain, blocking annotation (8xx/9xx equivalent) | Block; refuse to issue sub-card; show user the reason |
| Chain does not reach governance app-certification policy | Block; refuse to issue sub-card |

The wallet caches annotation board results with a short TTL (recommended: 5 minutes).

### Step 3: User Authorizes Sub-Card

The wallet presents a consent screen showing:

- App identity (name, version, publisher — resolved from the app's card)
- The requested `capabilities` whitelist, with human-readable labels per type
- Any annotation board status
- Optional `valid_until` (the user may set a shorter duration than the app requested)

The user approves or denies.

**Wallet self-signing exception.** When the requesting app is the wallet itself (i.e. `app_card` is the wallet's own card), this step is skipped. The user already trusts the wallet with their primary key; additional consent is not required.

### Step 4: Wallet Countersigns

The holder's primary card key signs canonical RFC 8785 JSON of the partially-signed document (including `app_signature` and both parent-pubkey fields `holder_primary_card_pubkey` and `app_card_pubkey`, without `holder_signature`) → `holder_signature`. The completed `SubCardDocument` is posted to IPFS.

### Step 5: Press Validates the App Card Chain and Registers On-Chain

The completed `SubCardDocument` is submitted to an approved press for the primary card's policy. Before calling `RegisterSubCard`, the press:

1. Fetches the `SubCardDocument` from IPFS (or receives it directly) and verifies `app_signature` against `app_card_pubkey`.
2. Applies the binding check: confirms `keccak256(app_card_pubkey)` equals the `app_card` pointer address. A mismatch is a hard rejection.
3. Walks the `app_card` chain using `app_card_pubkey` (deriving `HKDF-SHA3-256(app_card_pubkey, info="card-content-v1")` to decrypt the app card, then continuing via the app card's `ancestry_pubkeys`) to confirm it reaches the governance authority's app-certification policy root. Rejects the registration request if the chain does not reach a trusted root.

This **app-chain verification is press-side and registration-time only**. Runtime verifiers (wallets, relying parties evaluating a sub-card-signed statement) do not independently re-walk the `app_card` certification chain — they rely on the press having validated it here, evidenced by the `sub_card_doc_cid` pointer on the on-chain `SubCardEntry`.

The press then calls `RegisterSubCard` on the Arbitrum One registry contract, creating a `SubCardEntry` (see `protocol-objects.md §15`) that stores `master_card_address`, `registration_log_head`, and `sub_card_doc_cid` (the CID of the IPFS SubCardDocument). The app card address is **not** stored on-chain — it lives in the IPFS document at `sub_card_doc_cid`.

**Gas** is paid from the app's pre-funded gas account with the press (see `registry_contract.md §4.12`). The press rejects the registration request if the app's gas balance is insufficient before submitting any transaction. The app is responsible for maintaining a funded balance; the issuing organization's press does not cover sub-card registration costs.

The sub-card is now a live, independently-verifiable credential in the registry.

**Step 5b: Holder posts the `active_subcards` directory entry.** Registration on-chain (`RegisterSubCard`) and the holder's own `active_subcards` directory (`protocol-objects.md §1.1`) are updated separately: after (or alongside) the press's `RegisterSubCard` call, the holder submits a code-510 `UpdateIntentPayload` against their own master card, adding the new sub-card's `recipient_pubkey` to `active_subcards`. This entry is signed by the holder's primary card key — the same key that produced `holder_signature` on the `SubCardDocument` in Step 4 — and is processed via the standard update flow (`card_updates.md`). A sub-card that is on-chain registered but never added to `active_subcards` fails the runtime verifier's directory check (§16 Verifier chain walk, step 8) even though `SubCardRegistrations[sub_card_address].active` is true — the wallet MUST post the code-510 entry as part of completing sub-card issuance, not as an optional follow-up.

**Step 5c: Press notifies existing subcards of the new sibling.** When the press accepts the code-510 `LogEntry`, it sends a `subcard_sibling_added` message (`messaging_protocol.md §9`) to all existing subcards previously listed in `active_subcards` (not including the newly-added one). This alerts the holder's other devices that a new sibling has been registered, enabling detection of unauthorized additions — a key anti-compromise signal if an attacker gains access to the holder's key.

---

## Sub-Card Key Management

### Non-Exportability

The sub-card private key is generated inside the hardware keystore and is scoped to the app's signing identity:

- **iOS:** Key is created in the Secure Enclave using `kSecAttrTokenIDSecureEnclave` with `.applicationTag` set to an app-specific identifier. The key cannot be read, exported, or accessed by any other app or process, including the OS.
- **Android:** Key is generated with `KeyPairGenerator` using the `AndroidKeyStore` provider with `setIsStrongBoxBacked(true)` for the highest assurance tier. The key cannot be extracted.

Signing operations are executed by the platform keystore API; private key bytes are never exposed to app code.

### Attestation Tiers

App attestation verifies that the sub-card key was generated inside genuine, unmodified app code on genuine device hardware — not inside a modified binary or an emulated environment. The protocol defines two tiers:

| Tier | Mechanism | Guarantees |
|---|---|---|
| **T1** | Hardware-backed key storage only (iOS Secure Enclave / Android StrongBox) | The private key was generated inside hardware; it cannot be extracted. Does not verify the app binary. |
| **T2** | Full app attestation (iOS App Attest + DCAP / Android Play Integrity) | Both the private key is hardware-bound AND the app binary is the genuine published version running on a non-rooted, non-emulated device. |

**T2 is the default and required for all sub-cards.** The `SubCardDocument` MUST include an `attestation_level` field with value `"T2"` unless the governing policy explicitly accepts `"T1"`.

**T1 is available as a policy exception.** Some devices — including older hardware and Android devices without Google Play Services (an estimated 25–30% of Android devices globally) — cannot generate a Play Integrity token or an App Attest certificate. Policy bodies that serve populations where this is significant may explicitly declare that they accept T1-attested sub-cards. This is a policy decision, not a protocol default; absent explicit acceptance, T2 is required.

**How attestation is presented in a SubCardDocument.** When T2 attestation is used, the app requests an App Attest (iOS) or Play Integrity (Android) assertion scoped to the newly-generated sub-card public key hash. The assertion is attached to the `SubCardDocument` before it is sent to the wallet. The wallet verifies the assertion before countersigning. The `attestation_level` field records the tier used; the `attestation_proof` field carries the raw assertion or certificate (for independent audit).

When T1 is used (permitted by policy), `attestation_level: "T1"` is recorded and `attestation_proof` is omitted. The wallet still verifies hardware-backed key provenance via the platform keystore API.

### Approved Keystore Library

All sub-card key operations MUST go through the **approved card keystore library** (`card-keystore-lib`), whose current version and SHA-256 hash are published in the protocol's trust-and-safety registry. The library:

- Wraps the platform keystore API (Secure Enclave / Android Keystore)
- Enforces the non-exportability invariant
- Exposes only sign, verify, and generate operations — no key export path

Apps are expected to declare this dependency with a pinned version hash in their build system. The absence of this library, or the presence of a keystore API call outside the library's code paths, is a finding in a trust-and-safety audit.

### Backup

The sub-card private key is hardware-bound and cannot be backed up directly. This is intentional: sub-cards are per-device and per-installation.

If the app is uninstalled, reinstalled, or moved to a new device, the sub-card key is permanently lost. The app must generate a new keypair and request a new sub-card. The wallet should revoke the old sub-card with code 811 (installation key lost or uninstalled) when issuing a replacement.

---

## Capabilities

The `capabilities` field on a `SubCardDocument` is a **whitelist array** of message type strings. A sub-card may only produce valid signatures for messages whose `type` appears in this list.

Examples:

```json
"capabilities": ["auth_response"]
```

```json
"capabilities": ["auth_response", "exchange_offer", "note"]
```

An app declares the capabilities it needs at request time. The wallet presents this list to the user at consent time. The wallet may grant a subset of what was requested but never more. The user may also further restrict the capability set during the consent flow.

Verifiers must check that a sub-card signature's message type appears in the sub-card's `capabilities` before accepting the signature. A signature from a sub-card on a message type not in its whitelist is invalid, regardless of the cryptographic validity of the signature.

---

## Limitations

`capabilities` is a coarse whitelist — it says *which* message types a sub-card may sign, but nothing about their content. `limitations` (`protocol-objects.md §16`) generalizes this: arbitrary, additional constraints on the *content* of what a sub-card signs, expressed in the same predicate/`field_requirements` grammar the protocol already uses for `update_policy` and card-pointer field validation (`card_protocol_spec.md` §The Predicate System, §The Field Type System) — not a new, parallel constraint language.

Each `limitations` entry has:
- `applies_to` (optional) — the message type(s) this entry constrains; absent means it applies to every type in `capabilities`.
- `field_requirements` — a list of `{ "field": "<dot-path into the signed message payload>", "regex": "<pattern>" }` pairs, evaluated against the payload of the statement being signed (the same `{ field, regex }` shape already used for `card-pointer`/`cid` field validation elsewhere, retargeted from "fields of a referenced card" to "fields of the message being signed").

A verifier evaluating a sub-card signature checks every `limitations` entry whose `applies_to` includes (or is absent, matching) the message's type; if any `field_requirements` pair fails to match, the signature is rejected — with the same rigor as the `capabilities` check.

**Worked example 1 — field_requirements-style content constraint.** Restrict the `note` field length and character set on a note-writing sub-card, mitigating the note-writing-as-surveillance risk identified in `plans/subcard_redteam_plan.md` (Finding S-5):

```json
"capabilities": ["note"],
"limitations": [
  {
    "applies_to": ["note"],
    "field_requirements": [
      { "field": "payload.note", "regex": "^[\\s\\S]{0,280}$" }
    ]
  }
]
```

This does not fully resolve S-5 (a 280-character note can still carry behavioral surveillance data), but it bounds the size and lets a policy pair it with a wallet-side content preview requirement — see `plans/subcard_redteam_plan.md` Finding S-5 for the full mitigation, of which this is one part.

**Worked example 2 — predicate-style time-window constraint.** Restrict an `exchange_offer`-signing sub-card to a specific calendar window by matching the message's own timestamp field:

```json
"capabilities": ["exchange_offer"],
"limitations": [
  {
    "applies_to": ["exchange_offer"],
    "field_requirements": [
      { "field": "payload.timestamp", "regex": "^2026-(0[7-9]|1[0-2])-" }
    ]
  }
]
```

This example restricts signing to July–December 2026 by matching the ISO 8601 prefix. It illustrates the mechanism's reach and its limit: `field_requirements` regex constraints are evaluated per-message and statelessly (consistent with the rest of the protocol's fully-offline, independently-re-derivable verification model — `card_validation.md`), so they can express calendar/time-of-day windows against a timestamp field, but they **cannot** express count-based rate limits (e.g., "at most 10 signatures per day") — that would require a verifier to track signing history across messages, which no part of this protocol does. Rate-limiting a sub-card is out of scope for `limitations` in this protocol version; a wallet-side mitigation (e.g., revoking a sub-card that misbehaves) remains the available lever.

**Acceptance criteria for `limitations` are listed alongside the rest of this spec's acceptance criteria below.**

---

## Sub-Card Revocation

Sub-cards follow the standard 8xx/9xx revocation model.

- **Wallet revokes (8xx):** The user withdraws the app's authorization — equivalent to revoking an OAuth grant. Code 801 (voluntary surrender) for explicit user-initiated revocation; code 811 if the device containing the sub-card key is lost.
- **App revokes (8xx):** The app is being uninstalled or migrating to a new device. Code 811 (installation key lost or uninstalled).
- **Automatic revocation on annotation escalation:** If an app's card receives a blocking annotation (8xx/9xx equivalent) after sub-card issuance, the wallet SHOULD automatically revoke all sub-cards for that app on next sync and notify the user.

Sub-card revocations are submitted to an approved press (for the primary card's policy), as with all card updates.

### Authorization for Deregistration

Sub-card deregistration (the on-chain `DeregisterSubCard` call that marks a sub-card inactive) requires a signature from the holder's **primary card key** — not from the sub-card key itself, and not from the app. The press verifies this signature off-chain before submitting the transaction; gas is paid from the requesting app's pre-funded account with the press. If the app's balance is insufficient, the issuing organization's press sponsors the cost so that deregistration is never blocked by a depleted balance (stranding an active sub-card key is a security risk). See `registry_contract.md §4.12`.

Deregistration is paired with a code-511 `UpdateIntentPayload` against the holder's master card, deleting the sub-card's pubkey from `active_subcards`. Both changes — the on-chain `active` flag and the IPFS `active_subcards` entry — should be made together; a sub-card removed from one but not the other is rejected by the runtime verifier regardless (§16 Verifier chain walk, step 8 and step 10 are independent hard-rejection checks), but leaving the two out of sync is a hygiene issue the wallet should avoid, not something to rely on the verifier to paper over.

This means sub-card keys cannot unilaterally deregister themselves. An app that wants to revoke its own sub-card (e.g., on uninstall) must request deregistration through the press, which requires the holder's primary key to be available. In practice, the holder's wallet signs the deregistration request; the app triggers the flow by notifying the wallet.

### Deregistration After Key Recovery

If the holder's primary card key is lost and later recovered:

1. The holder should treat all previously authorized sub-cards as potentially compromised — the old primary key that authorized them may have been accessible to an attacker during the window of loss.
2. After recovery, the holder should deregister all existing sub-cards (using the newly recovered primary key).
3. Sub-card keys are hardware-bound and non-exportable — the sub-cards themselves were not compromised by the loss of the primary key. However, an attacker who held the old primary key could have deregistered and re-registered their own sub-cards, so all existing sub-card bindings should be considered suspect.
4. Each app should be prompted to re-request a new sub-card, which the holder approves with the recovered key.

The press handles deregistration of multiple sub-cards in sequence; the holder signs each individually or the wallet produces a batch of signed deregistration requests.

---

## Trust-and-Safety Integration

### App Card Issuance

An app must obtain an **app card** before it can request sub-cards. The certifier that issues the app card:

1. Evaluates the app against the protocol's user data-protection norms.
2. Reviews the app's build configuration to confirm dependency pinning on `card-keystore-lib`.
3. Audits keystore interaction code paths.
4. Issues an app card under the governance authority's app-certification policy.

The app card's chain is verifiable by any wallet or verifier without contacting the certifier.

### Ongoing Compliance

Third-party annotators post annotations on the app's card:

| Annotation type | Wallet behavior at new sub-card requests | Wallet behavior for existing sub-cards |
|---|---|---|
| Advisory (6xx/7xx equivalent) | Warn user; allow proceed or cancel | No automatic action; shown on next wallet sync |
| Blocking (8xx/9xx equivalent) | Refuse; show reason | Auto-revoke all sub-cards on next sync; notify user |

### Wallet Enforcement

The wallet is the enforcement point. It:

- Refuses to countersign sub-card documents whose `app_card` chain does not reach the governance root.
- Refuses to countersign for apps with blocking annotations on their card.
- Warns users about apps with advisory annotations.
- Automatically revokes sub-cards for apps that receive blocking annotations after sub-card issuance, on next wallet sync.

---

## Acceptance Criteria

- [ ] The wallet refuses to countersign a `SubCardDocument` whose `app_card` chain does not reach the governance authority's app-certification policy root.
- [ ] The press re-verifies the `app_card` chain (using `app_card_pubkey` and `ancestry_pubkeys`) before submitting `RegisterSubCard`; the press rejects registration if the chain does not reach the governance app-certification root.
- [ ] The wallet refuses to countersign for apps with a revocation-equivalent annotation on their card; the user is shown the reason.
- [ ] The sub-card private key is generated inside hardware-backed keystore storage, scoped to the app's signing identity.
- [ ] The sub-card private key is never exposed in plaintext outside the hardware keystore, even to the app that holds it.
- [ ] Both `app_signature` (app card key) and `holder_signature` (holder primary card key) are present and independently verifiable in every completed `SubCardDocument`.
- [ ] A runtime verifier can confirm a statement signed with a sub-card chains to the holder's primary card without contacting the wallet or the app, by reading `holder_primary_card_pubkey` from the decrypted sub-card document, applying the keccak256 binding check, decrypting the master card, and then continuing the chain walk to a trusted root via the master card's own `ancestry_pubkeys`. The runtime verifier does NOT re-walk the `app_card` certification chain — it relies on the press having validated this at registration time.
- [ ] The on-chain `SubCardEntry` for every registered sub-card carries `sub_card_doc_cid` — the CID of the IPFS `SubCardDocument` containing the app card address, app card pubkey, app signature, and holder signature.
- [ ] Verifiers reject sub-card signatures on message types not present in the sub-card's `capabilities` whitelist.
- [ ] Verifiers reject sub-card signatures where `valid_until` has passed.
- [ ] Revoking a sub-card does not affect the holder's primary card or other sub-cards held by other apps.
- [ ] A user can list all active sub-cards for a given primary card from the wallet UI.
- [ ] A wallet that discovers a blocking annotation for an app automatically revokes all that app's sub-cards on next sync and notifies the user.
- [ ] An app receives only the capabilities the user authorized; it cannot escalate to un-granted capabilities post-issuance.
- [ ] The wallet self-signing flow (wallet creates its own sub-cards without user approval) uses the same `SubCardDocument` schema as third-party apps.
- [ ] A `SubCardDocument` with `attestation_level: "T2"` is accepted only if the `attestation_proof` verifies against the platform's attestation service and the attested key hash matches `recipient_pubkey`.
- [ ] A `SubCardDocument` with `attestation_level: "T1"` is rejected unless the governing policy explicitly declares T1 acceptable.
- [ ] The wallet blocks issuance if the `attestation_level` is missing or unrecognized.
- [ ] A runtime verifier rejects a sub-card signature whenever the sub-card's registry address (`keccak256` of its public key) is absent from the master card's `active_subcards` field, **even if** `SubCardRegistrations[sub_card_address].active` is `true` on-chain — the two checks are independent and both must pass.
- [ ] Sub-card issuance is not considered complete until the holder has posted a code-510 entry adding the new sub-card's pubkey to `active_subcards` on their own master card.
- [ ] Sub-card deregistration is paired with a code-511 entry removing the sub-card's pubkey from `active_subcards`.
- [ ] A code-510, 511, or 512 entry on a master card's log is accepted only when signed by that card's own holder key; an issuer-signed (or any other party's) 510/511/512 intent is rejected regardless of the governing policy's `update_policy`.
- [ ] A verifier rejects a sub-card-signed statement whose payload violates any `limitations` entry whose `applies_to` matches (or is absent for) the statement's message type.
- [ ] A verifier accepts a sub-card-signed statement that satisfies every applicable `limitations` entry, with the same message otherwise valid.
- [ ] A `SubCardDocument` with no `limitations` field is treated as having no additional content constraints (only `capabilities` applies) — absence must not be treated as a rejection.

---

## Open Questions

- **[Design — SM-SHARE-ALL]** Should the wallet support a "share all cards" option, or should per-card selection be mandatory? The latter is more privacy-preserving but may be friction-heavy for apps that legitimately need access to many cards.
- **[Engineering — SM-OFFLINE]** How should the wallet handle a sub-card request that arrives while the user is offline? Queue and present on next open, or reject with a retry instruction?
- ~~**[Engineering — SM-GAS]** Gas sponsorship: should the wallet offer to sponsor gas for sub-card registration, or is it always the app's responsibility?~~ ✅ **RESOLVED 2026-06-14 (updated 2026-06-16)** — Gas for `RegisterSubCard` is always the requesting app's responsibility; the press rejects the request if the balance is insufficient. Gas for `DeregisterSubCard` is the requesting app's responsibility; if the app balance is insufficient, the issuing organization's press sponsors the cost — deregistration must never be blocked by a depleted balance, since stranding an active sub-card key is a security risk. The wallet does not sponsor sub-card registration gas. See `registry_contract.md §4.12`.
- **[Trust-and-Safety — SM-CADENCE]** What is the minimum audit cadence for apps to maintain their app card's standing? Per-version? Per-major-version? Time-based (every 90 days)?
- **[Design — SM-RENEW]** When a user sets `valid_until` on a sub-card, should the wallet send a renewal reminder before expiry, or should the app re-request authorization?
- **[Security — SM-SPAM]** The app pays gas for sub-card registration. Could a malicious app exploit this to spam the registry? Rate limiting per app card should be considered.
