# Key Rotation — Feature Specification

**Version:** 0.2 (draft)
**Date:** 2026-06-14
**Status:** Draft
**Amends:** v0.1 — §5 updated for press dual-key model (secp256r1 on-chain + ML-DSA-44 IPFS); §5.5 added for on-chain key scheme upgrade path per ADR-012.

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

---

## Overview

Key rotation is the process of replacing a cryptographic key in active use with a newly generated key, while preserving the continuity of the identity or credential that key represents. In the card protocol, there are four distinct categories of key material — each with different custodians, threat models, and rotation procedures.

This spec defines the rotation flows for each category, the on-log artifacts those flows produce, and the invariants verifiers depend on. It is a companion to `specs/subcards.md` (sub-card key management) and `card_protocol_spec.md §3` (keychain setup and YubiKey recovery).

---

## Key Material Categories

| Category | Custodian | Storage | Rotation trigger |
|---|---|---|---|
| Master card key | Holder | Encrypted keyring blob on IPFS | Periodic hygiene; key compromise |
| Sub-card key | Holder / App | Secure device storage (Secure Enclave / TEE / TPM), scoped to app signing identity | Device loss; device replacement; app uninstall; migration; routine rotation |
| Press sub-card key | Press operator | Operator-managed; hardware-backed recommended | Periodic rotation; operator compromise |
| Auditor ML-KEM key | Auditor | Auditor-managed | Periodic rotation; key compromise |

---

## 1. Sub-Card Key Rotation

### 1.1 Scope and Motivation

Sub-cards are device-bound, app-specific credentials. Each app on each device holds a sub-card private key in hardware-backed secure storage (Secure Enclave on iOS, StrongBox / TEE-backed Keystore on Android), scoped to the app's signing identity. The wallet is itself an app and holds its own sub-cards for routine operations (message signing, authentication, etc.). This key handles all routine signing operations for that app+device combination. The master card key (primary card key) is never used for routine operations; it is cold except when authorizing new sub-card creation.

Sub-card keys are rotated when:

- A device is lost or stolen (emergency rotation)
- A device is intentionally replaced or wiped
- An app is uninstalled and reinstalled
- A holder performs routine credential hygiene

### 1.2 Planned Rotation Flow

The holder, acting from any device with an active sub-card (or from the wallet using the primary card key), initiates rotation:

1. **Generate new sub-card key.** On the target device, generate a fresh ML-DSA-44 keypair in hardware-backed secure storage. The private key is scoped to the requesting app's signing identity and is non-exportable.
2. **Request sub-card authorization.** The app constructs a `SubCardDocument` (see `protocol-objects.md §16`), signs it with the app's card key, and submits it to the wallet. The wallet validates the app card chain to the governance root, presents the capability whitelist to the user, and countersigns with the primary card key. The completed `SubCardDocument` is posted to IPFS and registered on-chain.
3. **Revoke old sub-card.** Using the primary card key or any active sub-card key, submit a revocation intent for the old sub-card with code **801** (voluntary surrender) and `notify_holder: false`, since the holder is the initiator. The press processes the revocation and appends the log entry to the old sub-card's append-only log.
4. **Update UMBRAL re-encryption keys.** The message server generates new proxy re-encryption keys for the new sub-card using UMBRAL. The old sub-card's queue is flushed; the message server stops accepting delivery to the old sub-card.

**Atomicity note.** Steps 2 and 3 are not atomic. During the window between registration and revocation, both the old and new sub-card keys are valid. This window should be minimized. Verifiers should accept signatures from either sub-card during this window; signatures from the revoked sub-card are valid for statements whose timestamps precede the revocation's `effective_date`.

### 1.3 Emergency Rotation (Device Loss or Compromise)

When a device is lost or stolen, the holder has no access to the sub-card key on the lost device. Emergency rotation requires only the primary card key:

1. Using any surviving device (or a recovery device after YubiKey recovery), fetch and decrypt the keyring blob from IPFS.
2. Using the primary card key, submit a revocation intent for the lost device's sub-card with code **811** (sub-card lost or stolen, this card only). Use `effective_date: <now>` to immediately invalidate the sub-card.
3. Optionally: generate a replacement sub-card on the surviving/recovery device as in the planned flow, steps 1–4 above.

**If the holder has no surviving active device** (both the device and passkey access are gone simultaneously), the YubiKey recovery flow (`card_protocol_spec.md §3`) is required first to recover keyring access before sub-card rotation can proceed.

### 1.4 Acceptance Criteria

- [ ] A sub-card revoked with code 811 and `effective_date: now` is rejected by verifiers for statements whose timestamps are at or after the `effective_date`.
- [ ] Statements signed by the sub-card before the `effective_date` remain verifiable.
- [ ] After primary-card-key-based sub-card revocation, the message server stops queuing inbound messages to the revoked sub-card within one delivery cycle.
- [ ] The wallet client prevents routine use of the primary card key; sub-card key operations on active devices do not require decrypting the keyring blob.

### 1.5 Reinstallation and Migration

When an app is uninstalled and reinstalled, or moved to a new device, the sub-card key is permanently lost — it is hardware-bound to the app's signing identity on the original installation and cannot be exported or backed up.

See `specs/subcards.md §Sub-Card Key Management` for non-exportability guarantees and the approved keystore library requirement.

**Flow:**

1. The old sub-card key is permanently lost on the original installation (hardware-bound).
2. On first launch of the new installation, the app generates a new sub-card keypair in hardware-backed secure storage.
3. The app initiates the sub-card request flow (`specs/subcards.md §Sub-Card Request Flow`) from the beginning.
4. The holder's wallet presents the consent flow again for the new installation.
5. On approval, the new sub-card is issued — a distinct card from the old one, with its own registry entry and log.
6. The holder's wallet submits a code **811** (sub-card lost or uninstalled) revocation for the old sub-card. The wallet should perform this automatically on migration — see `specs/subcards.md §Sub-Card Revocation`.

**No in-place rotation.** Sub-cards cannot be rotated in place. Because the private key is hardware-bound and non-exportable, there is no path to transfer signing authority from one sub-card key to another within the same sub-card record. The rotation mechanism is always: revoke old sub-card → re-run sub-card request flow → issue new sub-card. If in-place rotation were permitted, it would require the app to submit a new public key without proving hardware custody of the new key at the moment of rotation.

**Additional acceptance criteria (reinstallation):**
- [ ] An app that has been uninstalled and reinstalled must complete the full sub-card request flow before signing statements with the new installation's key.
- [ ] The wallet automatically revokes stale sub-cards when it issues a replacement sub-card for the same app identity on a new installation.
- [ ] A verifier who encounters a statement signed by a revoked sub-card can determine the revocation's effective date and decline to accept statements timestamped at or after it.

---

## 2. Master Card Key Rotation

### 2.1 Motivation and Constraints

The master card key's public key is recorded as `recipient_pubkey` in each card the holder holds. `recipient_pubkey` is a protocol-required field that **cannot be modified by any update after issuance**, regardless of the card's update policy. This immutability is a foundational trust property: verifiers need a stable identity anchor; a mutable public key would allow silent substitution attacks.

Master key rotation therefore cannot update existing cards in place. Instead, it uses a **linked-successor** pattern: a new card is issued with the new public key, the old card posts a link to the successor, and the old card is subsequently revoked.

### 2.2 The Linked-Successor Pattern

The protocol supports a built-in `successor` field on all cards. Unlike user-defined fields (which are defined in the card's governing policy), `successor` is a protocol-level field whose semantics are understood by all verifiers:

| Field | Type | Update policy |
|---|---|---|
| `successor` | `card-pointer` | `{ "is_holder": true }` |

A card with a `successor` pointer is still considered valid until it receives an explicit 8xx revocation. The successor link is informational and advisory; the revocation is what changes the active status. Verifiers who encounter a revoked card with a `successor` pointer should:

1. Follow the pointer to the successor card.
2. Confirm the successor's `recipient_pubkey` belongs to the same real-world entity (via the holder's own signed rotation statement — see §2.3).
3. Treat the successor as the canonical card for that holder going forward.

**The `successor` field is appended with a 1xx log entry.** Code **100** (linked successor — planned key rotation) or code **101** (linked successor — emergency, prior key potentially compromised).

### 2.3 Address Transitions on Master Key Rotation

Because a card's registry address is `keccak256(recipient_pubkey)`, rotating the master key produces a new address. The old address is not deleted — it remains in the registry as a revoked entry with a `forward_to` field. This section defines the address-level continuity mechanism that complements the card-level `successor` link (§2.2).

**Three-layer continuity chain on key rotation:**

| Layer | What it is | Where it lives |
|---|---|---|
| Card-level successor | `successor` field in old card's IPFS log | IPFS (card content) |
| Registry-level forward | `forward_to` in old `CardEntry` on-chain | Arbitrum One |
| On-chain event archive | `AddressTransition(old_address, new_address)` event | Arbitrum One |

The registry-level forward and on-chain event are the resilient fallbacks if the old card's IPFS content becomes unpinned and the `successor` field is unreachable. See `registry_contract.md §3.1` and `§4.13` for the `forward_to` field and `RegisterAddressForward` operation.

**`past_keys` in the new card document.** Because IPFS content is encrypted with `HKDF-SHA3-256(recipient_pubkey)` (see `ARCHITECTURE.md` ADR-006), content produced under an old key is decryptable only with that old key. The new card's document includes a `past_keys` array listing all prior public keys with their validity windows:

```json
"past_keys": [
  {
    "pubkey":      "<base64url ML-DSA-44 public key>",
    "valid_from":  "<ISO 8601>",
    "rotated_at":  "<ISO 8601>"
  }
]
```

A party who holds the new public key and needs to read historical content can use the `past_keys` entries to derive the content keys for earlier log entries. A party who holds only an old public key can still decrypt historical content directly; they can follow the registry-level `forward_to` to discover the new address but cannot read the new card's content without the new public key.

**Ordering constraint.** The address forward (step 4a below) must be registered on-chain **before** the old card is revoked (step 5). Writing the forward requires the old secp256r1 key; once the old card's registry entry is revoked, the key is still valid for this one operation during the rotation window. Revoke first, then forward — is not permitted.

---

### 2.4 Planned Master Key Rotation Flow

**Prerequisites:** The holder has access to their master card key (keyring is decryptable) and at least one active sub-card.

1. **Generate new master keypair.** The wallet generates a fresh ML-DSA-44 keypair for the new master key. The new private key is stored in the keyring blob.

2. **Request new cards.** For each card the holder holds, initiate the full issuance flow to receive a new card with the new public key from the relevant press. The new cards are independent card registry entries and include the `past_keys` array (§2.3) populated from the holder's existing key history.

3. **Produce a rotation statement.** The holder signs a **key rotation statement** with both the old master key and the new master key:

   ```json
   {
     "statement_type": "key_rotation",
     "old_pubkey": "<base64url ML-DSA-44 public key being retired>",
     "new_pubkey": "<base64url ML-DSA-44 public key replacing it>",
     "rotation_code": 100,
     "old_cards": ["<mutable pointer 1>", "<mutable pointer 2>", ...],
     "new_cards": ["<mutable pointer 1>", "<mutable pointer 2>", ...],
     "timestamp": "<ISO 8601>",
     "old_key_signature": "<ML-DSA-44 sig over canonical RFC 8785 JSON, signed by old master key>",
     "new_key_signature": "<ML-DSA-44 sig over canonical RFC 8785 JSON, signed by new master key>"
   }
   ```

   This dual-signed statement is stored on IPFS. Its CID is the rotation evidence that verifiers can check to confirm the successor relationship was established by the same entity.

4. **Post successor links.** For each old card, submit a 1xx (code 100) update intent:
   - `code: 100`
   - `field_updates: [{ "field": "successor", "value": "<new card mutable pointer>" }]`
   - Include the rotation statement CID in the update's `updater_message` field.
   - Sign with the old master key (or an active sub-card, depending on the update policy).

4a. **Register address forward on-chain.** For each old card, call `RegisterAddressForward` on the registry contract (see `registry_contract.md §4.13`), providing `old_address` and `new_address`. This stores `forward_to` in the old `CardEntry` and emits an `AddressTransition` event. Must be signed with the old secp256r1 key and must be submitted **before** the old card is revoked (step 5). This step is required; failure to complete it before revocation leaves the old address without a registry-level forward.

5. **Revoke old cards.** After all successor links (step 4) and address forwards (step 4a) are posted, revoke each old card with code **801** (voluntary surrender), with an `effective_date` set to the current time.

6. **Update keyring.** Re-encrypt the keyring blob with the new master key added and the old master key flagged as retired. Upload to IPFS. Update backup registration if using YubiKey recovery.

7. **Re-register sub-cards.** Existing sub-cards are registered to the old master key. Issue new sub-cards from the new master key for each active device. Revoke the old sub-cards.

**Ordering note.** Steps 3 → 4 → 4a → 5 must be executed in order: rotation statement first, then successor links and address forwards, then revocations. The address forward (4a) requires the old key and must precede revocation.

### 2.5 Emergency Master Key Rotation (Key Compromised)

If the master key is believed to be compromised:

1. Use any active sub-card (if the device is still secure) or YubiKey recovery to access the keyring.
2. Immediately revoke all cards with code **810** (signing key compromised). Set `effective_date: <now>` on each revocation. This invalidates all statements signed after `effective_date`.
3. Proceed with the planned rotation flow (§2.4), but use code **101** (linked successor — emergency) for the `successor` field updates and record the compromise in the rotation statement.

**Address forward under compromise.** If the old key is believed compromised, the address forward written in step 4a is signed by the potentially-compromised key. Parties who discover the old address via chain inspection should treat the `forward_to` registry field with caution and cross-check it against the on-chain `AddressTransition` event timestamp and the rotation statement CID. The dual-signed rotation statement (§2.4 step 3) is the authoritative continuity proof regardless of key compromise status.
4. Issue a loud revocation 9xx (code **910**: full wallet compromise suspected) only if there is evidence that the compromise extends beyond the master key to the full wallet, including sub-cards.

**If a device is also compromised:** Treat all sub-cards as compromised. Revoke all sub-cards with code 811 immediately. If recovery requires YubiKey, complete YubiKey recovery first, then proceed with master key rotation.

**Statement validity after key compromise.** Statements signed with a compromised key before the revocation's `effective_date` are provisionally valid but should be treated with lower trust by relying parties — the rotation statement's `rotation_code: 101` signals that the prior period's signatures may be at risk. Relying parties with high-stakes decisions may choose to require re-attestation under the new key.

### 2.6 Issuer-Initiated Card Recovery Rotation

**Motivation.** A holder who has lost access to both their sub-card keys and their keyring passkey (and has no surviving YubiKey backup) cannot self-recover via any path in this spec. They must contact the issuer of each card they hold and request a replacement. This section defines the protocol by which an issuer may initiate a key rotation on behalf of a holder who has lost key access.

**Risk model.** Issuer-initiated recovery grants the issuer momentary power to redirect a holder's credential to a new key — a key that could, in a malicious scenario, be controlled by the issuer rather than the holder. The protocol mitigates this risk with three safeguards:

1. A **72-hour pending window** before the rotation takes effect, during which the holder can cancel.
2. A **mandatory notification message** sent by the press to the holder's card at the start of the window.
3. An **auditable log entry** (code 102) posted immediately on the old card, visible to any party monitoring the card's log.

**Prerequisites.** The issuer must satisfy `{ "is_issuer": true }` for the target card (i.e., the target card was issued by a press operating under a policy authorized by this issuer). The holder must have established contact with the issuer via an out-of-band channel, and the issuer must apply whatever identity-verification procedure their policy requires.

**Flow.**

1. **Holder contacts issuer.** The holder contacts the issuer out-of-band (email, phone, in-person) to request a recovery rotation. The issuer verifies the holder's identity per their policy.

2. **Issuer issues a replacement card.** The issuer creates a new card for the holder under the same (or equivalent) policy, with the holder's new public key generated during the recovery session.

3. **Issuer submits a code-102 recovery rotation request to the press.** The intent contains:
   - `code: 102`
   - `field_updates: [{ "field": "successor", "value": "<new card mutable pointer>" }]`
   - `pending_until: <ISO 8601 — exactly 72 hours from the submission timestamp>`

4. **Press validates and posts the pending entry.** The press:
   - Confirms the issuer satisfies `{ "is_issuer": true }` for the target card.
   - Posts a code-102 log entry on the old card containing the proposed `successor` value and `pending_until`. The rotation is **not yet effective**.
   - **Immediately sends a `recovery_rotation_notification` message** to the holder's card via the messaging protocol. The message must include: the issuer's card pointer, the proposed successor card pointer, the `pending_until` deadline, and the CID of the pending code-102 log entry (so the holder can reference it in a cancellation).

5. **72-hour pending window.** During this window:
   - Verifiers who read the old card's log see the code-102 entry but treat the `successor` value as pending and not effective. The old card is still considered active with no successor.
   - The holder may cancel by submitting a **code-103 log entry** (recovery rotation cancelled) to any approved press, signed by any holder-authorized key (master or active sub-card). The code-103 entry must reference the pending code-102 entry's log CID. A successful cancellation permanently nullifies the pending rotation.

6. **After 72 hours without cancellation.** The rotation becomes effective: verifiers treat the code-102 `successor` pointer as equivalent to a code-100 entry. The old card may subsequently be revoked by the issuer with an 8xx or 9xx entry.

7. **Optional holder co-signature.** The holder, now operating with their new key, may sign a `key_rotation_statement` (§7.3) with the new key to provide a holder-side continuity attestation. Recommended but not required for the rotation to be valid.

**Notification delivery note.** If the holder has truly lost all key access, they cannot actively receive messaging protocol messages. The notification therefore serves primarily as a disclosure to auditors, verifying parties, and monitoring services watching the card's log. Monitoring services should alert the holder via out-of-band channels when they detect a pending code-102 entry on a card they watch.

**Cancellation by self-recovery.** If the holder independently recovers key access (e.g., locates their YubiKey) during the 72-hour window, they should immediately post a code-103 cancellation. This prevents an issuer from using the recovery path to seize a card from a holder who has not actually lost access.

---

### 2.7 Acceptance Criteria

- [ ] A card with a `successor` pointer and a subsequent 8xx revocation is recognized by verifiers as superseded; verifiers follow the pointer to the successor card.
- [ ] A dual-signed rotation statement with both old and new master key signatures is verifiable by any party with access to IPFS.
- [ ] After emergency rotation (code 810), statements signed by the old key before `effective_date` are treated as provisionally valid; statements at or after `effective_date` are rejected.
- [ ] The wallet prevents re-use of a retired master key after rotation completes.
- [ ] A verifier who encounters a card with `successor` but no revocation entry treats the card as active and the successor link as advisory only.
- [ ] `RegisterAddressForward` is rejected if called after the old card has been revoked (8xx or 9xx entry exists in the log).
- [ ] The `AddressTransition` event is emitted on-chain at the time `RegisterAddressForward` is processed, with the correct `old_address` and `new_address` values.
- [ ] A client who resolves an old address via `forward_to` and then cross-checks against chain events can confirm the forward is authentic without fetching old IPFS content.
- [ ] The new card document includes a `past_keys` entry for every prior public key held by the same holder, with correct `valid_from` and `rotated_at` timestamps.
- [ ] A party holding an old public key can derive its content key (`HKDF-SHA3-256(old_pubkey, info="card-content-v1")`) and decrypt historical log entries from the old key's validity window.
- [ ] A code-102 entry's `successor` pointer is not treated as effective until `pending_until` is reached and no code-103 entry referencing it exists in the log.
- [ ] A code-103 entry that references a code-102 entry permanently nullifies the pending rotation; the old card remains active with no successor.
- [ ] The press sends a `recovery_rotation_notification` message to the holder's card immediately upon posting a code-102 entry.
- [ ] After `pending_until` elapses without a code-103 cancellation, verifiers treat the code-102 `successor` pointer identically to a code-100 entry.

---

## 3. Keyring Re-encryption (Passkey or Service Secret Rotation)

### 3.1 Motivation

The keyring blob is encrypted with a key derived from `passkey + service_secret`. Re-encryption is needed when:

- The holder changes their passkey (new device ecosystem, passkey migration)
- The holder migrates to a new primary service (service_secret changes)
- The holder rotates their YubiKey backup registration

Re-encryption does not rotate any card keys. It changes the protection layer around the existing keys.

### 3.2 Re-encryption Flow

1. The wallet client fetches the current keyring blob from IPFS and decrypts it using the current `passkey + service_secret`.
2. The client derives a new encryption key from the new `passkey + service_secret` combination.
3. The client re-encrypts the keyring blob with the new key and uploads it to IPFS. The new CID replaces the keyring pointer.
4. The primary service updates its stored `service_secret` to reflect the new value.
5. If updating the YubiKey backup: the client produces a new wrapped decryption key blob (the decryption key wrapped under the YubiKey-derived key) and sends it to the backup service to replace the prior blob.

**The keyring blob itself does not need to change** in terms of content — only the encryption wrapper changes. The IPFS CID will change because the ciphertext changes. The wallet updates its internal record of the current keyring CID.

### 3.3 Acceptance Criteria

- [ ] Re-encryption does not alter or remove any keys from the keyring blob's plaintext content.
- [ ] After re-encryption, the old encrypted blob is unreachable by the old `passkey + service_secret` (because the IPFS CID pointer has moved).
- [ ] YubiKey recovery after a backup re-registration produces the same plaintext keyring as before re-registration.

---

## 4. Full Wallet Compromise Response

### 4.1 Definition

A full wallet compromise occurs when an attacker has obtained or may have obtained:

- The master card key, AND
- One or more sub-card keys

This is the highest-severity scenario. Code **910** (loud revocation — full wallet compromise suspected) signals publicly that all cards held by this identity should be treated as untrusted from `effective_date` forward, regardless of whether the attacker has been observed signing anything.

### 4.2 Response Flow

1. **Revoke all cards loudly.** For each card the holder controls, submit a 9xx revocation intent (code 910) to any approved press. Set `effective_date: <now>`. The press's `revocation_permissions` must permit 9xx by the holder (the default permits 9xx by the issuer only — if this policy blocks the holder from issuing 9xx against their own cards, the holder must contact the issuer to perform the revocations, or the trust-and-safety governance body must act). The spec **recommends** that policies permit holders to issue 9xx on their own cards with `code: 910`.

2. **Revoke all sub-cards.** Revoke all sub-cards (code 811). Because sub-card keys may be compromised, use the YubiKey recovery path if necessary.

3. **Notify relying parties.** The wallet should send notifications to all services and parties where the holder has authenticated using a compromised card, informing them of the revocation and `effective_date`.

4. **Bootstrap new identity.** After revocation is complete, the holder proceeds with full master key rotation (§2.3), issuing new cards under the new key. The new cards have no automatic trust inheritance from the old cards — each issuer must re-issue under the new public key. This is intentional: the compromise may have affected what the holder consented to, and relying parties should make a fresh assessment.

### 4.3 Code 9xx Authorization for Self-Revocation

The default `revocation_permissions` in the protocol is `9xx: { "is_issuer": true }`, meaning issuers control loud revocations, not holders. For the 910 self-compromise use case, the recommended policy override is:

```json
"revocation_permissions": {
  "8xx": { "any_of": [{ "is_holder": true }, { "is_issuer": true }] },
  "9xx": {
    "any_of": [
      { "is_issuer": true },
      { "all_of": [
        { "is_holder": true },
        { "code_equals": 910 }
      ]}
    ]
  }
}
```

This allows holders to issue 910 (full wallet compromise) but not other 9xx codes.

### 4.4 Acceptance Criteria

- [ ] A card revoked with code 910 causes verifiers to reject all statements signed by that card at or after `effective_date`, including sub-card-signed statements that chain to the compromised master card.
- [ ] A policy that includes the recommended `revocation_permissions` override accepts holder-signed 910 intents.
- [ ] After a 910 revocation, the wallet blocks all further signing operations using the compromised card's key material until the holder explicitly confirms a new master key has been installed.

---

## 5. Press Sub-Card Key Rotation

### 5.1 Motivation

Press sub-cards are authorized to write to the Arbitrum One registry on behalf of a policy. A press with a compromised sub-card key can write fraudulent cards to the registry. Press key rotation is therefore a high-priority operational security concern.

### 5.2 Planned Press Key Rotation

Press sub-cards carry two independent public keys with separate roles:
- **ML-DSA-44 key** (`recipient_pubkey` in the CardDocument on IPFS) — used for IPFS content signatures (offer signatures, etc.). Rotated by issuing a new press sub-card with a new ML-DSA-44 keypair.
- **secp256r1 key** (registered on-chain in `PressAuthorizations`) — used for on-chain write authorization (`RegisterCard`, `UpdateCardHead`, etc.). Rotated independently via `AuthorizePress`.

These can be rotated independently. The procedures below apply to both; where they differ, each step notes which key is affected.

**Full press rotation (both keys):**

1. **Generate new keypairs.** The press generates a fresh secp256r1 keypair (for on-chain writes) and a fresh ML-DSA-44 keypair (for IPFS content). Both private keys are stored in operator-managed hardware-backed storage.
2. **Issue new press sub-card.** The press operator requests a new press sub-card from the policy holder. The new sub-card has a new mutable pointer and the new ML-DSA-44 public key as `recipient_pubkey`.
3. **Update `approved_presses`.** The policy holder submits a 3xx update intent to add the new press sub-card pointer to the policy's `approved_presses` array.
4. **Update `PressAuthorizations` on-chain.** The policy governance body calls `AuthorizePress` with the new `press_pubkey` (secp256r1, 64 bytes x||y) and `mldsa44_key_hash` (keccak256 of the new ML-DSA-44 pubkey). This registers both the new secp256r1 on-chain key and the hash of the new ML-DSA-44 IPFS key.
5. **Drain and switch.** The press completes any in-flight issuance operations with the old keys, then switches to signing with the new keys for both on-chain writes and IPFS content.
6. **Revoke old press sub-card.** The old press sub-card is revoked (code 801) and removed from `approved_presses` via a further 3xx update to the policy.
7. **Deactivate old entry on-chain.** Call `RevokePress` to deactivate the old press address in `PressAuthorizations`. The entry is retained with `active = false` for the audit trail.

**Rotating only the secp256r1 on-chain key** (e.g., routine key hygiene without reissuing the press sub-card): call `AuthorizePress` with the same `press_address` and new `press_pubkey`. The `press_public_key` is overwritten; the `mldsa44_key_hash` and all other fields are preserved.

**Previously issued cards are unaffected.** The old press sub-card's IPFS-stored ML-DSA-44 signature on historical cards remains valid because those cards were issued while the sub-card was active.

### 5.3 Emergency Press Key Rotation (Suspected Compromise)

1. Immediately call `RevokePress` on-chain to deactivate the old press address in `PressAuthorizations`. This blocks further registry writes using the compromised secp256r1 key even before the press sub-card itself is formally revoked.
2. Investigate what cards, if any, were fraudulently issued using the compromised key. Coordinate with the policy holder to revoke fraudulent cards.
3. Issue new press sub-card and proceed with standard rotation (steps 1–7 above).

**Detecting fraudulent issuances.** The press's signed issuance log (encrypted to auditors) provides a record of what the press legitimately issued. Any registry entry not present in that log is a candidate for fraudulent issuance. Auditors play a critical role in post-compromise forensics.

### 5.4 Acceptance Criteria

- [ ] After the old press sub-card is removed from `PressAuthorizations`, the Arbitrum One registry contract rejects further writes from the old secp256r1 key.
- [ ] Previously issued cards remain verifiable after the press key rotation.
- [ ] The window between the `PressAuthorizations` deactivation and the formal sub-card revocation is minimized; the on-chain deactivation is the effective security boundary.
- [ ] Rotating only the secp256r1 on-chain key does not affect the press sub-card's ML-DSA-44 IPFS identity key or previously issued IPFS content.

---

### 5.5 On-Chain Key Scheme Upgrade (secp256r1 → ML-DSA-44)

This section documents the press-initiated portion of the ADR-012 three-phase upgrade from secp256r1 to ML-DSA-44 for on-chain write authorization. Governance decisions (activating Phase 2, setting Phase 3 deadline) are described in `ARCHITECTURE.md ADR-012`.

**Background.** At authorization time (§5.2 step 4), a press registers both a secp256r1 key for on-chain use and a `mldsa44_key_hash` (keccak256 of its ML-DSA-44 public key) for the future upgrade. No additional re-registration is required when the upgrade is triggered — the hash already on-chain binds the upgrade to the correct ML-DSA-44 key.

**When to act.** Governance activates Phase 2 by upgrading the verifier module to accept both secp256r1 and ML-DSA-44 signatures. All presses must complete their individual `RotateOnChainKeyScheme` rotation before the Phase 3 deadline. After the deadline, the contract accepts only ML-DSA-44 for new writes; secp256r1 is accepted only for rotation operations during the grace period.

**Per-press upgrade flow:**

1. **Retrieve ML-DSA-44 public key.** The press retrieves the full ML-DSA-44 public key (1312 bytes) corresponding to the `mldsa44_key_hash` it registered at authorization time. This is the same ML-DSA-44 key used for IPFS content signatures — no new key generation is needed.
2. **Construct and sign the rotation payload.** The press constructs:
   ```json
   {
     "op":                 "rotate_on_chain_key_scheme",
     "press_address":      "<base64url — bytes32>",
     "policy_address":     "<base64url — bytes32>",
     "new_mldsa44_pubkey": "<base64url — 1312 bytes, the full ML-DSA-44 public key>",
     "nonce":              "<base64url>",
     "deadline_block":     <uint64 — block number cutoff for this payload>
   }
   ```
   The payload is signed with **both**:
   - `secp256r1_sig` — secp256r1 signature (r||s) over keccak256(payload), using the current registered secp256r1 private key
   - `mldsa44_sig` — ML-DSA-44 signature over keccak256(payload), using the new ML-DSA-44 private key (proves possession)
3. **Submit `RotateOnChainKeyScheme`.** Call the contract (see `registry_contract.md §4.11`). The contract verifies both signatures, confirms `keccak256(new_mldsa44_pubkey) == mldsa44_key_hash`, and migrates the press's `key_scheme` to `1` (ML-DSA-44).
4. **Confirm and switch.** After the transaction confirms, the press switches all new on-chain writes to use ML-DSA-44 signatures.

**No disruption to IPFS operations.** The ML-DSA-44 key was already in use for IPFS content signing before this upgrade. The upgrade simply promotes it to on-chain authorization use as well.

**Presses that miss the Phase 3 deadline** become write-locked. They can still submit a `RotateOnChainKeyScheme` transaction during the grace period (the contract accepts secp256r1 signatures for rotation-only purposes during this window). After the grace period closes, the press must contact governance to restore write access via a fresh `AuthorizePress` with a new ML-DSA-44 key.

### 5.6 Acceptance Criteria (Key Scheme Upgrade)

- [ ] A `RotateOnChainKeyScheme` call rejected because `keccak256(new_mldsa44_pubkey) != mldsa44_key_hash` returns error E-26.
- [ ] A `RotateOnChainKeyScheme` call while `key_scheme_phase == 0` (Phase 1) returns error E-24.
- [ ] After a successful `RotateOnChainKeyScheme`, the contract accepts ML-DSA-44 write signatures from the press and rejects secp256r1 write signatures.
- [ ] Previously issued cards and their IPFS-stored content are unaffected by the on-chain key scheme upgrade.
- [ ] A press that has not yet upgraded can still rotate its secp256r1 key during Phase 2 via `AuthorizePress`.

---

## 6. Auditor ML-KEM Key Rotation

Auditor key rotation is triggered by:

- Periodic hygiene
- Compromise of the auditor's ML-KEM private key

**The rotation procedure is already specified in `card_protocol_spec.md §2` under *Audit Epoch Lifecycle, Auditor key rotation within an epoch*.** The key points:

1. The current audit epoch closes; the auditor produces an `AuditEpochCommitment` under their old key.
2. The auditor destroys the old epoch AEK.
3. A new epoch opens with the auditor's new ML-KEM public key.
4. The old ML-KEM private key can be destroyed after the commitment is published and the CID is confirmed on-chain.

This spec does not re-define this flow. See `card_protocol_spec.md §2` for the canonical procedure.

---

## 7. Key Rotation Log Entry Supplement

### 7.1 New Protocol-Level Field: `successor`

All cards implicitly support a `successor` field. This is not defined in any policy's `field_definitions` — it is a protocol-reserved field whose update semantics are enforced by the press and verifiers regardless of policy content.

| Field | Type | Authorization | Meaning |
|---|---|---|---|
| `successor` | `card-pointer` | Codes 100, 101: `{ "is_holder": true }`. Code 102: `{ "is_issuer": true }` with 72-hour pending window (see §2.6). | Mutable pointer of the card that supersedes this one. |

The `successor` field may be appended at most once. A code-102 entry is pending until `pending_until` is reached; if no code-103 cancellation is present at that point, the value becomes effective and immutable. Attempts to overwrite an already-effective `successor` value are rejected by the press.

### 7.2 1xx Update Codes for Key Rotation

The canonical definitions for these codes are in `specs/update_codes.md`. The codes used in this spec are:

| Code | Meaning |
|---|---|
| 100 | Linked successor — planned key rotation or advancement (holder-initiated) |
| 101 | Linked successor — emergency rotation (holder-initiated; prior key potentially compromised) |
| 102 | Linked successor — issuer-initiated card recovery (72-hour pending window; see §2.5) |
| 103 | Issuer-initiated recovery rotation cancelled by holder |

Codes 100 and 101 are distinguished for auditors: a 100 signals routine housekeeping; a 101 signals that the prior key period's signatures should be treated with elevated skepticism. Code 102 entries carry a `pending_until` field and are not effective until that timestamp is reached; a code-103 entry referencing a code-102 entry by log CID permanently nullifies the pending rotation.

### 7.3 Key Rotation Statement (IPFS Document)

The dual-signed key rotation statement produced in §2.3 is a JSON document with the following structure:

```json
{
  "statement_type": "key_rotation",
  "rotation_code": 100 | 101,
  "old_pubkey": "<base64url ML-DSA-44 public key being retired>",
  "new_pubkey": "<base64url ML-DSA-44 public key replacing it>",
  "old_cards": ["<mutable pointer>", ...],
  "new_cards": ["<mutable pointer>", ...],
  "timestamp": "<ISO 8601>",
  "old_key_signature": "<ML-DSA-44 sig over canonical RFC 8785 JSON of above fields minus both sigs>",
  "new_key_signature": "<ML-DSA-44 sig over canonical RFC 8785 JSON of above fields minus both sigs>"
}
```

Both signatures are computed over the same payload (the document without either signature field). The canonical form is deterministic per RFC 8785.

---

## 8. Open Questions

- **[Design]** How should verifiers handle a card chain where a sub-card was signed by a key that was later revealed to have been compromised (code 101)? Should they require re-attestation under the new key for high-stakes verifications, or should all pre-`effective_date` statements remain fully trusted?

- **[Engineering]** When a holder revokes all cards with code 910 (full wallet compromise), should the wallet client automatically initiate a new identity bootstrap, or should the holder explicitly trigger this step?

- **[Policy]** Is the recommended `revocation_permissions` override (allowing holder-issued 910 codes) appropriate for all policy types, or should high-stakes policies (e.g., root-of-trust cards) block holder-issued loud revocations?

- **[Engineering]** The `successor` field update requires an approved press. In a full wallet compromise scenario where the press is unavailable, the holder cannot post the successor link. Should a direct-write path to the registry be supported for holder-signed 9xx and `successor` updates, bypassing the press? This conflicts with the design principle that all updates go through an approved press.

- **[Security]** For the press emergency rotation, is deactivating the `PressAuthorizations` on-chain entry sufficient as an immediate countermeasure, or should the protocol support a signed "press compromise notification" that verifiers can check when evaluating previously-issued cards?

- **[Design]** Should the key rotation statement be posted to the old card's log as an additional payload, or is it sufficient to reference the statement CID in the `updater_message` field of the 1xx entry?

---

## 9. Acceptance Criteria (Summary)

All individual section acceptance criteria apply. The following are cross-cutting:

- [ ] A verifier who walks a card chain that terminates in a revoked card with a `successor` pointer correctly identifies the successor as the current card, provided the rotation statement is dual-signed and verifiable.
- [ ] The press rejects an attempt to set the `successor` field on a card that already has `successor` set.
- [ ] A card revoked with code 810 (key compromised) causes all statements signed by that key after `effective_date` to be rejected by compliant verifiers.
- [ ] A card revoked with code 910 (full wallet compromise) causes verifiers to reject not only the master card's signatures but also all sub-card signatures that chain to the compromised master, for statements at or after `effective_date`.
- [ ] Rotation flows that require the master card key are blocked by the wallet client if the keyring blob cannot be decrypted (e.g., passkey unavailable).
- [ ] Key rotation operations produce auditable on-log artifacts (1xx entries, rotation statement CID) such that a post-hoc verifier can reconstruct the full rotation history without contacting the holder or press.
- [ ] A press rejects a code-102 intent from any party that does not satisfy `{ "is_issuer": true }` for the target card.
- [ ] A press rejects a code-103 intent that does not include a valid log-CID reference to an open (not yet effective and not previously cancelled) code-102 entry on the same card.
