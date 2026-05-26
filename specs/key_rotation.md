# Key Rotation — Feature Specification

**Version:** 0.1 (draft)
**Date:** 2026-05-25
**Status:** Draft

> **Terminology note.** This spec uses "mark" to refer to what the rest of the codebase currently calls a "chitt." The rename is in progress; treat the terms as interchangeable.

---

## Overview

Key rotation is the process of replacing a cryptographic key in active use with a newly generated key, while preserving the continuity of the identity or credential that key represents. In the mark protocol, there are five distinct categories of key material — each with different custodians, threat models, and rotation procedures.

This spec defines the rotation flows for each category, the on-log artifacts those flows produce, and the invariants verifiers depend on. It is a companion to `specs/submarks.md` (per-installation mark keys) and `chitt_protocol_spec.md §3` (keychain setup and YubiKey recovery).

---

## Key Material Categories

| Category | Custodian | Storage | Rotation trigger |
|---|---|---|---|
| Master mark key | Holder | Encrypted keyring blob on IPFS | Periodic hygiene; key compromise |
| Device sub-mark key | Holder | Secure device storage (Secure Enclave / TPM) | Device loss; device replacement; routine rotation |
| Per-installation mark key | App installation | Hardware keystore, scoped to app signing identity | App uninstall; device migration; re-registration |
| Press sub-mark key | Press operator | Operator-managed; hardware-backed recommended | Periodic rotation; operator compromise |
| Auditor ML-KEM key | Auditor | Auditor-managed | Periodic rotation; key compromise |

---

## 1. Device Sub-Mark Key Rotation

### 1.1 Scope and Motivation

Each device the holder uses holds a sub-mark private key in secure device storage (Secure Enclave on Apple, TPM on others). This key handles all routine signing operations. The master mark key is never used for routine operations; it is cold except when creating or revoking sub-marks.

Sub-mark keys are rotated when:

- A device is lost or stolen (emergency rotation)
- A device is intentionally replaced or wiped
- A holder performs routine credential hygiene

### 1.2 Planned Rotation Flow

The holder, acting from any device with an active sub-mark, initiates rotation:

1. **Generate new sub-mark key.** On the target device (the device that will hold the new sub-mark), generate a fresh ML-DSA-44 keypair in secure device storage.
2. **Register new sub-mark.** Using the master mark key (fetched from the keyring by the wallet client), issue a new sub-mark registration: a signed statement from the master key attesting the new sub-mark public key and the device identifier. Append this registration to the keyring blob and upload the new blob to IPFS.
3. **Revoke old sub-mark.** Using the master key or any active sub-mark key, submit a revocation intent for the old sub-mark with code **801** (voluntary surrender) and `notify_holder: false`, since the holder is the initiator. The press processes the revocation and appends the log entry to the old sub-mark's append-only log.
4. **Update UMBRAL re-encryption keys.** The message server generates new proxy re-encryption keys for the new sub-mark using UMBRAL. The old sub-mark's queue is flushed; the message server stops accepting delivery to the old sub-mark.

**Atomicity note.** Steps 2 and 3 are not atomic. During the window between registration and revocation, both the old and new sub-mark keys are valid. This window should be minimized. Verifiers should accept signatures from either sub-mark during this window; signatures from the revoked sub-mark are valid for statements whose timestamps precede the revocation's `effective_date`.

### 1.3 Emergency Rotation (Device Loss or Compromise)

When a device is lost or stolen, the holder has no access to the sub-mark key on the lost device. Emergency rotation requires only the master mark key:

1. Using any surviving device (or a recovery device after YubiKey recovery), fetch and decrypt the keyring blob from IPFS.
2. Using the master mark key, submit a revocation intent for the lost device's sub-mark with code **811** (device sub-mark lost or stolen, this mark only). Use `effective_date: <now>` to immediately invalidate the sub-mark.
3. Optionally: generate a replacement sub-mark on the surviving/recovery device as in the planned flow, steps 1–4 above.

**If the holder has no surviving active device** (both the device and passkey access are gone simultaneously), the YubiKey recovery flow (`chitt_protocol_spec.md §3`) is required first to recover keyring access before sub-mark rotation can proceed.

### 1.4 Acceptance Criteria

- [ ] A sub-mark revoked with code 811 and `effective_date: now` is rejected by verifiers for statements whose timestamps are at or after the `effective_date`.
- [ ] Statements signed by the sub-mark before the `effective_date` remain verifiable.
- [ ] After master key-based sub-mark revocation, the message server stops queuing inbound messages to the revoked sub-mark within one delivery cycle.
- [ ] The wallet client prevents routine use of the master mark key; sub-mark key operations on active devices do not require decrypting the keyring blob.

---

## 2. Per-Installation Mark Key Rotation

Per-installation mark keys are sub-marks delegated from the holder's wallet to a specific app installation. They are hardware-bound to the app's signing identity and cannot be exported.

See `specs/submarks.md §Sub-Mark Key Management` for non-exportability guarantees and the approved keystore library requirement.

### 2.1 Normal Rotation (Reinstallation or Migration)

When an app is uninstalled and reinstalled, or installed on a new device:

1. The app's old per-installation mark key is permanently lost (hardware-bound, cannot be backed up).
2. The app generates a new per-installation mark at first launch on the new installation.
3. The app initiates the sub-mark request flow (`specs/submarks.md §Sub-Mark Request Flow`) from the beginning.
4. The holder's wallet presents the consent flow again for the new installation.
5. On approval, the new sub-mark is issued. The new sub-mark is a distinct mark from the old one; it has its own registry entry and log.
6. The holder's wallet submits an 8xx revocation for the old sub-mark, code **811** (installation lost or uninstalled). The wallet should perform this automatically on migration — see `specs/submarks.md §Sub-Mark Revocation`.

### 2.2 No In-Place Key Rotation

Per-installation marks cannot be rotated in place. Because the private key is hardware-bound and non-exportable, there is no path to transfer signing authority from one installation mark key to another within the same sub-mark record. The rotation mechanism is always: revoke old sub-mark → re-run sub-mark request flow → issue new sub-mark.

This is a deliberate consequence of the hardware binding invariant: if in-place rotation were permitted, it would require the app to submit a new public key without proving hardware custody of the new key at the moment of rotation.

### 2.3 Acceptance Criteria

- [ ] An app that has been uninstalled and reinstalled must complete the full sub-mark request flow before signing statements with the new installation's key.
- [ ] The wallet automatically revokes stale per-installation sub-marks when it issues a replacement sub-mark for the same app identity on a new installation.
- [ ] A verifier who encounters a statement signed by a revoked per-installation sub-mark can determine the revocation's effective date and decline to accept statements timestamped at or after it.

---

## 3. Master Mark Key Rotation

### 3.1 Motivation and Constraints

The master mark key's public key is recorded as `recipient_pubkey` in each mark the holder holds. `recipient_pubkey` is a protocol-required field that **cannot be modified by any update after issuance**, regardless of the mark's update policy. This immutability is a foundational trust property: verifiers need a stable identity anchor; a mutable public key would allow silent substitution attacks.

Master key rotation therefore cannot update existing marks in place. Instead, it uses a **linked-successor** pattern: a new mark is issued with the new public key, the old mark posts a link to the successor, and the old mark is subsequently revoked.

### 3.2 The Linked-Successor Pattern

The protocol supports a built-in `successor` field on all marks. Unlike user-defined fields (which are defined in the mark's governing policy), `successor` is a protocol-level field whose semantics are understood by all verifiers:

| Field | Type | Update policy |
|---|---|---|
| `successor` | `mark-pointer` | `{ "is_holder": true }` |

A mark with a `successor` pointer is still considered valid until it receives an explicit 8xx revocation. The successor link is informational and advisory; the revocation is what changes the active status. Verifiers who encounter a revoked mark with a `successor` pointer should:

1. Follow the pointer to the successor mark.
2. Confirm the successor's `recipient_pubkey` belongs to the same real-world entity (via the holder's own signed rotation statement — see §3.3).
3. Treat the successor as the canonical mark for that holder going forward.

**The `successor` field is appended with a 1xx log entry.** Code **100** (linked successor — planned key rotation) or code **101** (linked successor — emergency, prior key potentially compromised).

### 3.3 Planned Master Key Rotation Flow

**Prerequisites:** The holder has access to their master mark key (keyring is decryptable) and at least one active device sub-mark.

1. **Generate new master keypair.** The wallet generates a fresh ML-DSA-44 keypair for the new master key. The new private key is stored in the keyring blob.

2. **Request new marks.** For each mark the holder holds, initiate the full issuance flow to receive a new mark with the new public key from the relevant press. The new marks are independent mark registry entries.

3. **Produce a rotation statement.** The holder signs a **key rotation statement** with both the old master key and the new master key:

   ```json
   {
     "statement_type": "key_rotation",
     "old_pubkey": "<base64url ML-DSA-44 public key being retired>",
     "new_pubkey": "<base64url ML-DSA-44 public key replacing it>",
     "rotation_code": 100,
     "old_marks": ["<mutable pointer 1>", "<mutable pointer 2>", ...],
     "new_marks": ["<mutable pointer 1>", "<mutable pointer 2>", ...],
     "timestamp": "<ISO 8601>",
     "old_key_signature": "<ML-DSA-44 sig over canonical CBOR, signed by old master key>",
     "new_key_signature": "<ML-DSA-44 sig over canonical CBOR, signed by new master key>"
   }
   ```

   This dual-signed statement is stored on IPFS. Its CID is the rotation evidence that verifiers can check to confirm the successor relationship was established by the same entity.

4. **Post successor links.** For each old mark, submit a 1xx (code 100) update intent:
   - `code: 100`
   - `field_updates: [{ "field": "successor", "value": "<new mark mutable pointer>" }]`
   - Include the rotation statement CID in the update's `updater_message` field.
   - Sign with the old master key (or an active sub-mark, depending on the update policy).

5. **Revoke old marks.** After all successor links are posted, revoke each old mark with code **801** (voluntary surrender), with an `effective_date` set to the current time.

6. **Update keyring.** Re-encrypt the keyring blob with the new master key added and the old master key flagged as retired. Upload to IPFS. Update backup registration if using YubiKey recovery.

7. **Re-register sub-marks.** Existing device sub-marks are registered to the old master key. Issue new sub-marks from the new master key for each active device. Revoke the old sub-marks.

**Ordering note.** Steps 3–5 (successor links) should be completed before step 5 (revocations) to ensure verifiers can follow the successor chain without encountering a revoked mark with no forward pointer.

### 3.4 Emergency Master Key Rotation (Key Compromised)

If the master key is believed to be compromised:

1. Use any active device sub-mark (if the device is still secure) or YubiKey recovery to access the keyring.
2. Immediately revoke all marks with code **810** (signing key compromised). Set `effective_date: <now>` on each revocation. This invalidates all statements signed after `effective_date`.
3. Proceed with the planned rotation flow (§3.3), but use code **101** (linked successor — emergency) for the `successor` field updates and record the compromise in the rotation statement.
4. Issue a loud revocation 9xx (code **910**: full wallet compromise suspected) only if there is evidence that the compromise extends beyond the master key to the full wallet, including device sub-marks.

**If a device is also compromised:** Treat the device sub-marks as compromised. Revoke all device sub-marks with code 811 immediately. If recovery requires YubiKey, complete YubiKey recovery first, then proceed with master key rotation.

**Statement validity after key compromise.** Statements signed with a compromised key before the revocation's `effective_date` are provisionally valid but should be treated with lower trust by relying parties — the rotation statement's `rotation_code: 101` signals that the prior period's signatures may be at risk. Relying parties with high-stakes decisions may choose to require re-attestation under the new key.

### 3.5 Acceptance Criteria

- [ ] A mark with a `successor` pointer and a subsequent 8xx revocation is recognized by verifiers as superseded; verifiers follow the pointer to the successor mark.
- [ ] A dual-signed rotation statement with both old and new master key signatures is verifiable by any party with access to IPFS.
- [ ] After emergency rotation (code 810), statements signed by the old key before `effective_date` are treated as provisionally valid; statements at or after `effective_date` are rejected.
- [ ] The wallet prevents re-use of a retired master key after rotation completes.
- [ ] A verifier who encounters a mark with `successor` but no revocation entry treats the mark as active and the successor link as advisory only.

---

## 4. Keyring Re-encryption (Passkey or Service Secret Rotation)

### 4.1 Motivation

The keyring blob is encrypted with a key derived from `passkey + service_secret`. Re-encryption is needed when:

- The holder changes their passkey (new device ecosystem, passkey migration)
- The holder migrates to a new primary service (service_secret changes)
- The holder rotates their YubiKey backup registration

Re-encryption does not rotate any mark keys. It changes the protection layer around the existing keys.

### 4.2 Re-encryption Flow

1. The wallet client fetches the current keyring blob from IPFS and decrypts it using the current `passkey + service_secret`.
2. The client derives a new encryption key from the new `passkey + service_secret` combination.
3. The client re-encrypts the keyring blob with the new key and uploads it to IPFS. The new CID replaces the keyring pointer.
4. The primary service updates its stored `service_secret` to reflect the new value.
5. If updating the YubiKey backup: the client produces a new wrapped decryption key blob (the decryption key wrapped under the YubiKey-derived key) and sends it to the backup service to replace the prior blob.

**The keyring blob itself does not need to change** in terms of content — only the encryption wrapper changes. The IPFS CID will change because the ciphertext changes. The wallet updates its internal record of the current keyring CID.

### 4.3 Acceptance Criteria

- [ ] Re-encryption does not alter or remove any keys from the keyring blob's plaintext content.
- [ ] After re-encryption, the old encrypted blob is unreachable by the old `passkey + service_secret` (because the IPFS CID pointer has moved).
- [ ] YubiKey recovery after a backup re-registration produces the same plaintext keyring as before re-registration.

---

## 5. Full Wallet Compromise Response

### 5.1 Definition

A full wallet compromise occurs when an attacker has obtained or may have obtained:

- The master mark key, AND
- One or more device sub-mark keys

This is the highest-severity scenario. Code **910** (loud revocation — full wallet compromise suspected) signals publicly that all marks held by this identity should be treated as untrusted from `effective_date` forward, regardless of whether the attacker has been observed signing anything.

### 5.2 Response Flow

1. **Revoke all marks loudly.** For each mark the holder controls, submit a 9xx revocation intent (code 910) to any approved press. Set `effective_date: <now>`. The press's `revocation_permissions` must permit 9xx by the holder (the default permits 9xx by the issuer only — if this policy blocks the holder from issuing 9xx against their own marks, the holder must contact the issuer to perform the revocations, or the trust-and-safety governance body must act). The spec **recommends** that policies permit holders to issue 9xx on their own marks with `code: 910`.

2. **Revoke all sub-marks.** Revoke all device sub-marks (811) and all per-installation sub-marks (811). Because the device sub-mark keys may be compromised, use the YubiKey recovery path if necessary.

3. **Notify relying parties.** The wallet should send notifications to all services and parties where the holder has authenticated using a compromised mark, informing them of the revocation and `effective_date`.

4. **Bootstrap new identity.** After revocation is complete, the holder proceeds with full master key rotation (§3.3), issuing new marks under the new key. The new marks have no automatic trust inheritance from the old marks — each issuer must re-issue under the new public key. This is intentional: the compromise may have affected what the holder consented to, and relying parties should make a fresh assessment.

### 5.3 Code 9xx Authorization for Self-Revocation

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

### 5.4 Acceptance Criteria

- [ ] A mark revoked with code 910 causes verifiers to reject all statements signed by that mark at or after `effective_date`, including sub-mark-signed statements that chain to the compromised master mark.
- [ ] A policy that includes the recommended `revocation_permissions` override accepts holder-signed 910 intents.
- [ ] After a 910 revocation, the wallet blocks all further signing operations using the compromised mark's key material until the holder explicitly confirms a new master key has been installed.

---

## 6. Press Sub-Mark Key Rotation

### 6.1 Motivation

Press sub-marks are authorized to write to the Arbitrum One registry on behalf of a policy. A press with a compromised sub-mark key can write fraudulent marks to the registry. Press key rotation is therefore a high-priority operational security concern.

### 6.2 Planned Press Key Rotation

1. **Generate new keypair.** The press generates a fresh ML-DSA-44 keypair for the new sub-mark key.
2. **Issue new press sub-mark.** The press operator requests a new press sub-mark from the policy holder. The new sub-mark has a new mutable pointer and the new public key as `recipient_pubkey`.
3. **Update `approved_presses`.** The policy holder submits a 3xx update intent to add the new press sub-mark pointer to the policy's `approved_presses` array.
4. **Update `PressAuthorizations` on-chain.** The policy governance body updates the `PressAuthorizations` table on Arbitrum One to register the new press sub-mark key as active for this policy.
5. **Drain and switch.** The press completes any in-flight issuance operations with the old key, then switches to signing with the new key.
6. **Revoke old press sub-mark.** The old press sub-mark is revoked (code 801) and removed from `approved_presses` via a further 3xx update to the policy.
7. **Update `PressAuthorizations` on-chain.** Remove or deactivate the old press sub-mark key from the `PressAuthorizations` table.

**Previously issued marks are unaffected.** The old press sub-mark's signature on historical marks remains valid because those marks were issued while the sub-mark was active.

### 6.3 Emergency Press Key Rotation (Suspected Compromise)

1. Immediately deactivate the old press sub-mark in the `PressAuthorizations` table. This blocks further registry writes from the compromised key even before the press sub-mark itself is formally revoked.
2. Investigate what marks, if any, were fraudulently issued using the compromised key. Coordinate with the policy holder to revoke fraudulent marks.
3. Issue new press sub-mark and proceed with standard rotation (steps 2–7 above).

**Detecting fraudulent issuances.** The press's signed issuance log (encrypted to auditors) provides a record of what the press legitimately issued. Any registry entry not present in that log is a candidate for fraudulent issuance. Auditors play a critical role in post-compromise forensics.

### 6.4 Acceptance Criteria

- [ ] After the old press sub-mark is removed from `PressAuthorizations`, the Arbitrum One registry contract rejects further writes from the old key.
- [ ] Previously issued marks remain verifiable after the press key rotation.
- [ ] The window between the `PressAuthorizations` deactivation and the formal sub-mark revocation is minimized; the on-chain deactivation is the effective security boundary.

---

## 7. Auditor ML-KEM Key Rotation

Auditor key rotation is triggered by:

- Periodic hygiene
- Compromise of the auditor's ML-KEM private key

**The rotation procedure is already specified in `chitt_protocol_spec.md §2` under *Audit Epoch Lifecycle, Auditor key rotation within an epoch*.** The key points:

1. The current audit epoch closes; the auditor produces an `AuditEpochCommitment` under their old key.
2. The auditor destroys the old epoch AEK.
3. A new epoch opens with the auditor's new ML-KEM public key.
4. The old ML-KEM private key can be destroyed after the commitment is published and the CID is confirmed on-chain.

This spec does not re-define this flow. See `chitt_protocol_spec.md §2` for the canonical procedure.

---

## 8. Key Rotation Log Entry Supplement

### 8.1 New Protocol-Level Field: `successor`

All marks implicitly support a `successor` field. This is not defined in any policy's `field_definitions` — it is a protocol-reserved field whose update semantics are enforced by the press and verifiers regardless of policy content.

| Field | Type | Update policy | Meaning |
|---|---|---|---|
| `successor` | `mark-pointer` | `{ "is_holder": true }` | Mutable pointer of the mark that supersedes this one |

The `successor` field may be appended at most once. Once set, it is immutable. Attempts to overwrite an existing `successor` value are rejected by the press.

### 8.2 1xx Update Codes for Key Rotation

| Code | Meaning |
|---|---|
| 100 | Linked successor — planned key rotation |
| 101 | Linked successor — emergency rotation (prior key potentially compromised) |

These codes are distinguished for auditors and relying parties: a 100 in a mark's log signals routine housekeeping; a 101 signals that the prior key period's signatures should be treated with elevated skepticism.

### 8.3 Key Rotation Statement (IPFS Document)

The dual-signed key rotation statement produced in §3.3 is a CBOR document with the following structure:

```json
{
  "doc_type": "mark_key_rotation_statement",
  "rotation_code": 100 | 101,
  "old_pubkey": "<base64url ML-DSA-44 public key being retired>",
  "new_pubkey": "<base64url ML-DSA-44 public key replacing it>",
  "old_marks": ["<mutable pointer>", ...],
  "new_marks": ["<mutable pointer>", ...],
  "timestamp": "<ISO 8601>",
  "old_key_signature": "<ML-DSA-44 sig over canonical CBOR of above fields minus both sigs>",
  "new_key_signature": "<ML-DSA-44 sig over canonical CBOR of above fields minus both sigs>"
}
```

Both signatures are computed over the same payload (the document without either signature field). The canonical CBOR is deterministic per RFC 8949 §4.2.

---

## 9. Open Questions

- **[Design]** How should verifiers handle a mark chain where a sub-mark was signed by a key that was later revealed to have been compromised (code 101)? Should they require re-attestation under the new key for high-stakes verifications, or should all pre-`effective_date` statements remain fully trusted?

- **[Engineering]** When a holder revokes all marks with code 910 (full wallet compromise), should the wallet client automatically initiate a new identity bootstrap, or should the holder explicitly trigger this step?

- **[Policy]** Is the recommended `revocation_permissions` override (allowing holder-issued 910 codes) appropriate for all policy types, or should high-stakes policies (e.g., root-of-trust marks) block holder-issued loud revocations?

- **[Engineering]** The `successor` field update requires an approved press. In a full wallet compromise scenario where the press is unavailable, the holder cannot post the successor link. Should a direct-write path to the registry be supported for holder-signed 9xx and `successor` updates, bypassing the press? This conflicts with the design principle that all updates go through an approved press.

- **[Security]** For the press emergency rotation, is deactivating the `PressAuthorizations` on-chain entry sufficient as an immediate countermeasure, or should the protocol support a signed "press compromise notification" that verifiers can check when evaluating previously-issued marks?

- **[Design]** Should the key rotation statement be posted to the old mark's log as an additional payload, or is it sufficient to reference the statement CID in the `updater_message` field of the 1xx entry?

---

## 10. Acceptance Criteria (Summary)

All individual section acceptance criteria apply. The following are cross-cutting:

- [ ] A verifier who walks a mark chain that terminates in a revoked mark with a `successor` pointer correctly identifies the successor as the current mark, provided the rotation statement is dual-signed and verifiable.
- [ ] The press rejects an attempt to set the `successor` field on a mark that already has `successor` set.
- [ ] A mark revoked with code 810 (key compromised) causes all statements signed by that key after `effective_date` to be rejected by compliant verifiers.
- [ ] A mark revoked with code 910 (full wallet compromise) causes verifiers to reject not only the master mark's signatures but also all sub-mark signatures that chain to the compromised master, for statements at or after `effective_date`.
- [ ] Rotation flows that require the master mark key are blocked by the wallet client if the keyring blob cannot be decrypted (e.g., passkey unavailable).
- [ ] Key rotation operations produce auditable on-log artifacts (1xx entries, rotation statement CID) such that a post-hoc verifier can reconstruct the full rotation history without contacting the holder or press.
