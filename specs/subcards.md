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
  "holder_primary_card": "<mutable pointer of the holder's primary card>",
  "app_card":            "<mutable pointer of this app's card>",
  "capabilities":        ["<message type>", "..."],
  "recipient_pubkey":    "<base64url — new ML-DSA-44 public key>",
  "issued_at":           "<ISO 8601>",
  "valid_until":         "<ISO 8601 — optional>"
}
```

The app signs canonical CBOR of this document with its app card key → `app_signature`. The partially-signed document is sent to the wallet.

**Delivery channel.** The app sends the request to the wallet via an HTTPS callback or platform deep link. The delivery mechanism is determined by the platform integration layer (see `messaging_protocol.md`).

### Step 2: Wallet Validates the App Card Chain

Before presenting the request to the user, the wallet:

1. Verifies `app_signature` against the app's card key.
2. Walks the `app_card` chain to confirm it reaches the governance authority's app-certification policy root.
3. Checks the app card's log for any revocation entries.
4. Queries the EAS annotation layer for third-party annotations on the app's card.

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

The holder's primary card key signs canonical CBOR of the partially-signed document (including `app_signature`, without `holder_signature`) → `holder_signature`. The completed `SubCardDocument` is posted to IPFS.

### Step 5: Registration On-Chain

The sub-card is registered on Arbitrum One, creating a `SubCardRegistration` entry (see `protocol-objects.md §15`) linking the sub-card's address to both `holder_primary_card` and `app_card`. Who submits the registration — the wallet, the app, or a press — is an open question (INC-10 / OQ-16); the on-chain verification logic is independent of the submitter.

The sub-card is now a live, independently-verifiable credential in the registry.

---

## Sub-Card Key Management

### Non-Exportability

The sub-card private key is generated inside the hardware keystore and is scoped to the app's signing identity:

- **iOS:** Key is created in the Secure Enclave using `kSecAttrTokenIDSecureEnclave` with `.applicationTag` set to an app-specific identifier. The key cannot be read, exported, or accessed by any other app or process, including the OS.
- **Android:** Key is generated with `KeyPairGenerator` using the `AndroidKeyStore` provider with `setIsStrongBoxBacked(true)` for the highest assurance tier. The key cannot be extracted.

Signing operations are executed by the platform keystore API; private key bytes are never exposed to app code.

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

## Sub-Card Revocation

Sub-cards follow the standard 8xx/9xx revocation model.

- **Wallet revokes (8xx):** The user withdraws the app's authorization — equivalent to revoking an OAuth grant. Code 801 (voluntary surrender) for explicit user-initiated revocation; code 811 if the device containing the sub-card key is lost.
- **App revokes (8xx):** The app is being uninstalled or migrating to a new device. Code 811 (installation key lost or uninstalled).
- **Automatic revocation on annotation escalation:** If an app's card receives a blocking annotation (8xx/9xx equivalent) after sub-card issuance, the wallet SHOULD automatically revoke all sub-cards for that app on next sync and notify the user.

Sub-card revocations are submitted to an approved press (for the primary card's policy), as with all card updates.

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
- [ ] The wallet refuses to countersign for apps with a revocation-equivalent annotation on their card; the user is shown the reason.
- [ ] The sub-card private key is generated inside hardware-backed keystore storage, scoped to the app's signing identity.
- [ ] The sub-card private key is never exposed in plaintext outside the hardware keystore, even to the app that holds it.
- [ ] Both `app_signature` (app card key) and `holder_signature` (holder primary card key) are present and independently verifiable in every completed `SubCardDocument`.
- [ ] A verifier can confirm a statement signed with a sub-card chains to the holder's primary card and the app's card without contacting the wallet or the app.
- [ ] Verifiers reject sub-card signatures on message types not present in the sub-card's `capabilities` whitelist.
- [ ] Verifiers reject sub-card signatures where `valid_until` has passed.
- [ ] Revoking a sub-card does not affect the holder's primary card or other sub-cards held by other apps.
- [ ] A user can list all active sub-cards for a given primary card from the wallet UI.
- [ ] A wallet that discovers a blocking annotation for an app automatically revokes all that app's sub-cards on next sync and notifies the user.
- [ ] An app receives only the capabilities the user authorized; it cannot escalate to un-granted capabilities post-issuance.
- [ ] The wallet self-signing flow (wallet creates its own sub-cards without user approval) uses the same `SubCardDocument` schema as third-party apps.

---

## Open Questions

- **[Design — SM-SHARE-ALL]** Should the wallet support a "share all cards" option, or should per-card selection be mandatory? The latter is more privacy-preserving but may be friction-heavy for apps that legitimately need access to many cards.
- **[Engineering — SM-OFFLINE]** How should the wallet handle a sub-card request that arrives while the user is offline? Queue and present on next open, or reject with a retry instruction?
- **[Engineering — SM-GAS]** Gas sponsorship: should the wallet offer to sponsor gas for sub-card registration, or is it always the app's responsibility? Intersects OQ-4.
- **[Trust-and-Safety — SM-CADENCE]** What is the minimum audit cadence for apps to maintain their app card's standing? Per-version? Per-major-version? Time-based (every 90 days)?
- **[Design — SM-RENEW]** When a user sets `valid_until` on a sub-card, should the wallet send a renewal reminder before expiry, or should the app re-request authorization?
- **[Security — SM-SPAM]** The app pays gas for sub-card registration. Could a malicious app exploit this to spam the registry? Rate limiting per app card should be considered.
