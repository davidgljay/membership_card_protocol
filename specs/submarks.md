# Sub-Marks — Feature Specification

**Version:** 0.1 (draft)
**Date:** 2026-05-25
**Status:** Draft

> **Terminology note.** This spec uses the term "mark" to refer to what the rest of the codebase currently calls a "chitt." The rename is in progress; treat the terms as interchangeable. "Sub-mark" is the new concept introduced here; it has no prior name in the spec.

---

## Overview

A **sub-mark** is a mark delegated from a user's wallet to a specific application installation. Sub-marks are the mechanism by which apps may sign statements on a user's behalf, access marks the user has selected, and receive encrypted backups — while being structurally prevented from exfiltrating the user's master key or unauthorized marks.

Sub-marks differ from device sub-chitts (defined in `chitt_protocol_spec.md §3`) along two dimensions:

| | Device sub-chitt | Sub-mark |
|---|---|---|
| Scope | One device, all marks | One app installation, selected marks |
| Delegated by | User (master key operation) | Wallet (on behalf of user) |
| Key lives in | Secure device storage (shared with wallet) | Secure storage scoped to the app installation |
| Initiating party | User sets up a new device | App requests authorization |
| Trust model | Fully trusted (user's own device) | Conditionally trusted (app is a third party) |

The sub-mark mechanism enables a trust-and-safety ecosystem to audit applications without blocking their operation: a wallet only issues sub-marks to apps that are registered and in good standing, creating an ambient gate against unvetted software.

---

## Background: The Per-Installation Mark

When a user installs an app that participates in the mark protocol, the app generates a **per-installation mark** at first launch:

- A fresh ML-DSA-44 keypair is generated inside the device's hardware keystore (Secure Enclave on iOS, StrongBox / TEE-backed Keystore on Android).
- The private key is scoped to the app's signing identity — it cannot be read or exported by any other app on the device.
- The installation mark's public key is the app's identity for the purposes of sub-mark exchange.
- There is one installation mark per app installation. Uninstalling and reinstalling generates a new installation mark.

The installation mark is **not** a mark in the registry sense; it does not have a mutable pointer or appear on-chain. It is an ephemeral identity used as the secure channel endpoint for the sub-mark offer exchange.

---

## Sub-Mark Request Flow

### Step 1: App Requests Authorization

The app sends a **sub-mark request** to the user's wallet. The request contains:

```json
{
  "request_type": "submark_request",
  "app_id": "<reverse-domain identifier, e.g. com.example.myapp>",
  "app_version": "<semver string>",
  "installation_mark_pubkey": "<base64url ML-DSA-44 public key of the installation mark>",
  "app_attestation": "<platform attestation proving the app is unmodified — iOS App Attest cert chain or Android Play Integrity token>",
  "requested_mark_predicates": [
    {
      "description": "<human-readable reason the app wants this mark>",
      "predicate": <chitt-predicate expression — see chitt_protocol_spec.md §Background>
    }
  ],
  "delivery_channel": "https",
  "delivery_address": "<HTTPS callback URL for offer delivery>",
  "timestamp": "<ISO 8601>",
  "request_signature": "<ML-DSA-44 signature over canonical CBOR of above fields, signed by installation_mark_pubkey>"
}
```

**Delivery channel.** The app specifies an HTTPS callback URL to receive the offer. The wallet POSTs the offer to that address; the app must be listening.

**App attestation.** A platform-native integrity proof that the requesting binary is the authentic, unmodified app — not a repackaged or patched version. iOS uses App Attest; Android uses Play Integrity. The wallet verifies this proof before proceeding. An app that cannot produce a valid attestation is rejected.

### Step 2: Wallet Checks the Trust-and-Safety Registry

Before presenting the request to the user, the wallet queries the **annotation boards** for the requesting app:

1. Looks up the app's `app_id` and version in the trust-and-safety annotation layer (EAS on Arbitrum One, using a known schema for app safety records).
2. Checks for:
   - Registration: Is this app registered with the protocol?
   - Standing: Does the app have any outstanding safety annotations (equivalent to 6xx, 7xx, 8xx, or 9xx marks against the app's record)?
   - Keystore audit status: Has the app's current version been audited to confirm it uses only the approved keystore library?

**Outcomes:**

| State | Wallet behavior |
|---|---|
| Registered, in good standing, audited | Proceed to user prompt |
| Registered, in good standing, not audited | Warn user with yellow advisory; allow user to proceed or cancel |
| Registered, safety annotations present (6xx/7xx) | Warn user with orange advisory showing the annotation; allow user to proceed or cancel |
| Registered, revocation-equivalent annotation (8xx/9xx) | Block; refuse to issue sub-mark; show user the reason |
| Not registered | Warn user with strong advisory ("This app is not registered with the mark protocol"); allow user to cancel or override with explicit consent |

The wallet caches annotation board results with a short TTL (recommended: 5 minutes) to avoid per-request latency while keeping the safety signal fresh.

### Step 3: User Authorizes Sub-Marks

The wallet presents a consent screen showing:

- App identity (name, publisher, version, attestation status)
- The marks the app is requesting, with human-readable descriptions
- The annotation board status (if advisory or warning)
- Which of the user's marks satisfy each requested predicate

The user selects which marks to make available to the app. The user may grant fewer marks than requested; partial authorization is valid.

The user may also set a **scope duration** — an optional `valid_until` on the sub-mark that causes it to expire without an explicit revocation.

### Step 4: Wallet Constructs Sub-Mark Offers

For each mark the user authorized, the wallet constructs a **sub-mark offer**:

```json
{
  "offer_type": "submark_offer",
  "parent_mark": "<mutable pointer of the parent mark being delegated>",
  "app_id": "<app identifier>",
  "installation_mark_pubkey": "<base64url — the app's installation mark public key>",
  "delegated_capabilities": {
    "can_sign_statements": true,
    "can_receive_encrypted_backup": true,
    "note_writing": true,
    "update_mark_content": false,
    "revocation_8xx": true,
    "revocation_9xx": false
  },
  "valid_until": "<ISO 8601 or null>",
  "submark_pubkey_placeholder": null,
  "wallet_signature": "<ML-DSA-44 signature over canonical CBOR of above fields, signed by the parent mark's active sub-chitt key>"
}
```

The offer is encrypted to the app's installation mark public key using ML-KEM, so only the app with the matching private key can read it.

The offers are delivered to the `delivery_address` specified in the app's request.

### Step 5: App Validates Offers and Generates Sub-Mark Keys

The app receives the encrypted offers, decrypts them using its installation mark private key, and for each offer:

1. Verifies the wallet's signature over the offer payload.
2. Walks the parent mark's chain to a trusted root and confirms the signing sub-chitt is active.
3. Checks that the offered capabilities are consistent with the app's request (the wallet may grant fewer than requested; the app must not request more than offered).
4. Generates a fresh ML-DSA-44 keypair for this sub-mark inside the hardware keystore, scoped to the app's signing identity.
5. Fills in `submark_pubkey_placeholder` with the new public key.
6. Signs the completed offer with the new sub-mark private key (producing `submark_acceptance_signature`).
7. Returns the completed and signed offer to the wallet.

### Step 6: Wallet Countersigns and Returns

The wallet receives the app's completed offers. For each one:

1. Verifies the app's `submark_acceptance_signature` against the `submark_pubkey` it just generated.
2. Countersigns the completed offer with the parent mark's active sub-chitt key (producing `wallet_countersignature`).
3. Returns the doubly-signed offer to the app.

The completed sub-mark offer is now a two-party document: the wallet signed the initial offer, and the app signed its acceptance using the new sub-mark key. Both signatures are present.

### Step 7: App Submits to Press

The app sends the completed sub-mark offer to an approved press for the parent mark's policy. The app pays the gas cost for the on-chain registration.

The press:

1. Verifies both signatures on the sub-mark offer.
2. Confirms the parent mark is active (not revoked).
3. Confirms the sub-mark capabilities are within the bounds permitted by the parent mark's policy.
4. Registers the sub-mark on Arbitrum One, creating a new registry entry with the sub-mark's public key.
5. Posts the sub-mark document to IPFS.
6. Logs the issuance in the parent mark's press log (encrypted to auditors).
7. Returns a SCIP to the app.

The sub-mark is now a live, independently-verifiable mark in the registry.

---

## Sub-Mark Key Management

### Non-Exportability

The sub-mark private key is generated inside the hardware keystore and is scoped to the app's signing identity. Specifically:

- **iOS:** Key is created in the Secure Enclave using `kSecAttrTokenIDSecureEnclave` with `.applicationTag` set to an app-specific identifier. The key cannot be read, exported, or accessed by any other app or process, including the OS.
- **Android:** Key is generated with `KeyPairGenerator` using the `AndroidKeyStore` provider, with `setKeyValidityStart`, `setUserAuthenticationRequired` (if applicable), and `setIsStrongBoxBacked(true)` for the highest assurance tier. The key cannot be extracted.

Signing operations (signing statements, producing authentication responses) are executed by the platform keystore API; the private key bytes are never exposed to app code.

### Approved Keystore Library

To enable third-party auditability, all sub-mark key operations in the app MUST go through the **approved mark keystore library** (`mark-keystore-lib`), whose current version and SHA-256 hash are published in the trust-and-safety registry. The library:

- Wraps the platform keystore API (Secure Enclave / Android Keystore)
- Enforces the non-exportability invariant
- Exposes only sign, verify, and generate operations — no key export path

Apps are expected to declare this dependency with a pinned version hash in their build system. The absence of this library, or the presence of a keystore API call outside the library's code paths, is a finding in a trust-and-safety audit.

### Backup

The sub-mark private key is hardware-bound and cannot be backed up directly. If the app is uninstalled, the sub-mark key is lost. This is intentional: the sub-mark is per-installation.

If a user reinstalls the app (or installs it on a new device), the app generates a new installation mark and requests new sub-marks from the wallet. The old sub-marks should be revoked (8xx — device/installation lost) by the wallet at migration time.

---

## Sub-Mark Capabilities

Sub-marks have a fixed capability set determined at issuance and recorded in the sub-mark's policy fields. The wallet grants capabilities; the policy enforces upper bounds.

| Capability | Meaning | Default |
|---|---|---|
| `can_sign_statements` | App may sign statements using this mark | true |
| `can_receive_encrypted_backup` | App may receive an encrypted export of the parent mark's data, decryptable with the passkey | false |
| `note_writing` | App may submit 2xx and 4xx notes to the parent mark's log | true |
| `update_mark_content` | App may submit 1xx–7xx field updates to the parent mark | false |
| `revocation_8xx` | App may submit an 8xx (quiet) revocation to the parent mark | true |
| `revocation_9xx` | App may submit a 9xx (loud) revocation to the parent mark | false |

The `update_mark_content: false` and `revocation_9xx: false` defaults reflect the principle that apps should annotate, not control. An app can note that something occurred; it cannot unilaterally change the mark's content or issue a loud revocation.

---

## Sub-Mark Revocation

Sub-marks follow the same 8xx/9xx revocation model as all marks. Both the app and the wallet may revoke a sub-mark:

- **App revokes (8xx):** The app's installation is being uninstalled, or the app is rotating to a new installation mark. Code 811 (device sub-chitt lost or stolen, adapted for sub-mark context).
- **Wallet revokes (8xx):** The user is withdrawing the app's authorization — equivalent to revoking an OAuth grant.
- **Trust-and-safety revokes (8xx):** If a safety annotation escalates to a 9xx-equivalent finding against an app, the wallet MAY automatically revoke all sub-marks for that app.

Sub-mark revocations are submitted to an approved press, as with all mark updates. The press validates the revocation authorization against the `revocation_permissions` in the sub-mark's policy.

---

## Trust-and-Safety Integration

### App Registration

An app that wishes to participate in the sub-mark ecosystem MUST:

1. Register with the mark protocol governance body, providing the app's identifier, publisher identity, and a public key for the app's trust-and-safety record.
2. Publish its build system configuration showing dependency hash pinning for `mark-keystore-lib`.
3. Submit its codebase for keystore interaction audit (automated static analysis + human review of keystore call paths).

Registration creates an EAS annotation record for the app, referenced by `app_id` and `app_version`.

### Ongoing Compliance

The trust-and-safety ecosystem maintains continuous scanning for:

- **New versions:** Automated analysis runs on each new app version. Findings are published as annotations on the app's EAS record.
- **Audit status:** Versions that have not been audited are flagged with a 4xx-equivalent advisory.
- **Policy violations:** Verified violations result in 6xx–9xx annotations, with corresponding wallet behavior (warn, block).

### Wallet Enforcement

The wallet is the enforcement point. It:

- Refuses to issue sub-marks to unregistered or blocked apps.
- Warns users about unaudited or advisory-flagged apps.
- Automatically revokes sub-marks for apps that receive blocking annotations after sub-mark issuance, on next wallet sync.

---

## Acceptance Criteria

- [ ] An app without a valid platform attestation (App Attest / Play Integrity) is rejected before the wallet presents a consent prompt.
- [ ] An app with an 8xx/9xx safety annotation is blocked from receiving sub-marks; the wallet shows the user the reason.
- [ ] The sub-mark private key is generated inside hardware-backed keystore storage, scoped to the app's signing identity.
- [ ] The sub-mark private key is never exposed in plaintext outside the hardware keystore, even to the app that holds it.
- [ ] Both the wallet signature (offer) and the app signature (acceptance) are present and independently verifiable in every completed sub-mark.
- [ ] A verifier can confirm a statement signed with a sub-mark chains to the parent mark without contacting the wallet or the app.
- [ ] The app pays gas for the sub-mark registration on Arbitrum One.
- [ ] Revoking a sub-mark (8xx) does not affect the parent mark or other sub-marks held by other apps.
- [ ] A user can list all active sub-marks for a given parent mark from the wallet UI.
- [ ] A wallet that discovers a blocking safety annotation for an app automatically revokes all sub-marks for that app on next sync, and notifies the user.
- [ ] An app that requests capabilities beyond those the user authorized receives only the authorized subset; it cannot escalate to un-granted capabilities post-issuance.

---

## Open Questions

- **[Design]** Should the wallet support a "share all marks" option, or should per-mark selection be mandatory? The latter is more privacy-preserving but may be friction-heavy for apps that legitimately need access to many marks.
- **[Engineering]** How should the wallet handle a sub-mark request that arrives when the user is offline? Queue and present on next open, or reject with a retry instruction?
- **[Engineering]** Gas sponsorship: should the wallet offer to sponsor gas for sub-mark registration, or is it always the app's responsibility?
- **[Trust-and-Safety]** What is the minimum audit cadence for apps to remain "audited" status? Per-version? Per-major-version? Time-based (every 90 days)?
- **[Design]** When a user selects "valid_until" on a sub-mark, should the wallet send a renewal reminder before expiry, or should the app re-request authorization?
- **[Security]** The app pays gas for sub-mark registration. Could a malicious app exploit this to spam the registry? Rate limiting per installation mark should be considered.
