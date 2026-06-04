# Log Auditing — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt" and "press" for the issuance service. The rename is in progress; treat the terms as interchangeable.

---

## Overview

Every mark issuance is recorded in an encrypted press log appended to the policy mark. Audit access is organized into time-bounded **epochs**, each secured by a single Audit Encryption Key (AEK). At epoch close, the auditor decrypts all entries, produces a signed commitment, and destroys the AEK — providing forward secrecy bounded at the epoch level. Once an epoch is closed, its entries are permanently undecryptable by anyone.

This spec covers three processes: opening an epoch, auditing and closing an epoch, and the special cases that trigger early epoch closure (auditor changes, key rotations).

---

## Actors

| Actor | Role |
|---|---|
| **Press** | Generates and distributes the epoch AEK; encrypts issuance records; posts epoch entries to the policy log |
| **Auditor** | Holds a mark whose pointer appears in the policy's `auditors` array; receives wrapped AEK; decrypts and audits entries at epoch close; produces the `AuditEpochCommitment` |
| **Administrator** | Manages auditor membership in the policy's `auditors` field; receives the commitment CID |

---

## Preconditions

- A valid policy mark is live with at least one entry in its `auditors` array.
- Each auditor holds an active ML-KEM (FIPS 203) keypair. The auditor's public key is resolvable from their mark.
- The press has a live audit epoch (or is prepared to open one) before logging any issuance.

---

## Process 1: Opening an Epoch

An epoch must be opened before the first issuance record can be posted. A new epoch must also be opened whenever the current epoch closes.

### Steps

1. The press generates a fresh 256-bit random AEK for the new epoch.

2. For each active auditor in the policy's `auditors` array:
   - Run `ML-KEM.Encaps(auditor_pubkey)` → `(kem_ciphertext, kem_shared_secret)`.
   - Derive a wrapping key: `HKDF-SHA3-256(kem_shared_secret, "audit-epoch-aek-v1")`.
   - Compute `wrapped_aek = AES-GCM.Encrypt(wrapping_key, AEK)` with a fresh nonce.
   - Record the `auditor_mark` pointer, `kem_ciphertext`, and `wrapped_aek` as one entry in `auditor_key_packages`.

3. The press assembles and signs an `AuditEpochEntry` with `status: "open"`:
   ```json
   {
     "type":           "audit_epoch_entry",
     "status":         "open",
     "epoch_id":       "<string — e.g. ISO year '2026' for annual, or sequential integer>",
     "epoch_start":    "<ISO 8601 timestamp>",
     "auditor_key_packages": [ ... ],
     "press_signature": "<ML-DSA-44 sig over canonical CBOR of all above fields>"
   }
   ```

4. The press posts the `AuditEpochEntry` to the policy mark's IPFS append-only log and updates the policy mark's Arbitrum One registry pointer to the new log head.

5. The press discards the raw AEK from memory immediately after distributing the wrapped copies. The press retains only the encrypted per-entry records; it cannot read the AEK in plaintext at any future point.

6. The epoch is now open. The press encrypts each subsequent `PressIssuanceRecord` under this AEK:
   ```
   nonce = fresh 96-bit random value
   ciphertext = AES-GCM.Encrypt(AEK, PressIssuanceRecord, nonce)
   ```
   Each encrypted entry stored on IPFS carries `epoch_id` in plaintext (so auditors know which epoch key to use) alongside `nonce` and `ciphertext`.

---

## Process 2: Auditing and Closing an Epoch

### Epoch close triggers

An epoch closes on any of the following:
- **Calendar boundary:** The epoch's defined period ends (annual epochs close 31 December UTC).
- **Auditor key rotation:** An auditor updates their ML-KEM public key.
- **Auditor added or removed:** Any change to the `auditors` array closes the current epoch and opens a new one with the updated auditor set.

### Steps

**Auditor side:**

1. Upon receiving a close signal (from the press via HTTPS, or upon detecting the trigger condition), the auditor fetches all encrypted `PressIssuanceRecord` entries for the closing epoch from the policy log.

2. For each entry, the auditor decrypts:
   - Locate their own `auditor_key_packages` entry in the epoch's `AuditEpochEntry`.
   - Decapsulate: `kem_shared_secret = ML-KEM.Decaps(kem_ciphertext, auditor_private_key)`.
   - Derive wrapping key: `HKDF-SHA3-256(kem_shared_secret, "audit-epoch-aek-v1")`.
   - Unwrap: `AEK = AES-GCM.Decrypt(wrapping_key, wrapped_aek)`.
   - Decrypt each entry: `PressIssuanceRecord = AES-GCM.Decrypt(AEK, ciphertext, nonce)`.

3. The auditor reviews the decrypted records for policy compliance (e.g., that issuances match expected predicates, that no unauthorized press wrote to the log, that entry counts are consistent).

4. The auditor produces an `AuditEpochCommitment`:
   ```json
   {
     "type":             "audit_epoch_commitment",
     "epoch_id":         "<matches the closing epoch>",
     "policy_mark":      "<mutable pointer of the policy mark>",
     "auditor_mark":     "<mutable pointer of this auditor's mark>",
     "period_start":     "<ISO 8601 — matches epoch_start from the opening AuditEpochEntry>",
     "period_end":       "<ISO 8601>",
     "entry_count":      <integer — number of PressIssuanceRecord entries decrypted>,
     "entries_hash":     "<base64url — SHA3-256 of concatenated CIDs of all decrypted entries in log order>",
     "findings":         "<free text — 'no issues found' if clean; otherwise describe anomalies>",
     "auditor_signature":"<ML-DSA-44 sig over canonical CBOR of all above fields>"
   }
   ```

5. The auditor publishes the `AuditEpochCommitment` to IPFS.

6. The auditor sends the commitment CID to the press via HTTPS.

7. **The auditor destroys the epoch AEK.** This step is irreversible. Entries from this epoch are now permanently undecryptable by anyone, including the auditor.

**Press side:**

8. On receiving the commitment CID from the auditor, the press posts an `AuditEpochEntry` with `status: "closed"` to the policy log:
   ```json
   {
     "type":           "audit_epoch_entry",
     "status":         "closed",
     "epoch_id":       "<matching epoch>",
     "epoch_end":      "<ISO 8601>",
     "commitment_cid": "<CID of the AuditEpochCommitment>",
     "close_reason":   "calendar_boundary | key_rotation | auditor_change",
     "press_signature":"<ML-DSA-44 sig>"
   }
   ```

9. The press opens a new epoch immediately if issuances are ongoing (Process 1 above).

---

## Process 3: Special Close Triggers

### Auditor key rotation

When an auditor rotates their ML-KEM public key:

1. The auditor updates their mark via the standard update flow (see `mark_updates.md`). The press observes the key update on Arbitrum One.
2. The press stops posting new issuance entries under the old epoch AEK.
3. The epoch closes per Process 2 above. The rotating auditor produces the commitment under their old key before the AEK is destroyed.
4. The press opens a new epoch with key packages generated under the auditor's new public key (Process 1).
5. The press must not post any new issuance entries under the old epoch AEK after observing the key update.

### Auditor added

When a new auditor is added to `approved_presses` via a policy field update:

1. The current epoch closes. All existing auditors produce commitments; AEKs are destroyed.
2. The press opens a new epoch with key packages for all active auditors, including the new one.
3. The new auditor has no access to prior epochs — their AEKs were destroyed before the auditor joined. This is by design: audit access is not retroactively granted.

### Auditor removed

When an auditor is removed from `auditors` via a policy field update:

1. The current epoch closes. The departing auditor must produce a final commitment for the closing epoch.
2. The press opens a new epoch with key packages for the remaining auditors only.
3. The departing auditor receives no wrapped AEK for the new epoch and cannot decrypt any subsequent entries.

---

## Postconditions

- Each closed epoch's `AuditEpochCommitment` is published on IPFS and its CID is recorded in the policy log.
- The epoch AEK is destroyed; entries from the closed epoch are permanently undecryptable.
- A verifier who later obtains the decrypted entries can compute `SHA3-256(concat of entry CIDs)` and confirm it matches `entries_hash` in the commitment.
- The commitment proves the auditor processed all entries in sequence but does not prove they correctly classified each one.

---

## Forward Secrecy Boundary

- A compromised auditor key exposes only the **current open epoch's** AEK.
- Prior epochs' AEKs have been destroyed; those entries are permanently inaccessible.
- Shorter epoch durations (e.g., quarterly) reduce the maximum exposure window at the cost of more frequent commitment operations.

---

## Error Paths

| Condition | Resolution |
|---|---|
| Auditor cannot decapsulate the AEK (wrong private key or corrupted package) | Press re-wraps and reposts an `AuditEpochEntry` update with a corrected key package for that auditor |
| Auditor finds entry count in log does not match expected issuance count | Record in `findings`; notify the administrator; do not destroy the AEK until discrepancy is resolved |
| Press posts issuance entries after epoch close signal | Protocol violation; those entries are not covered by any commitment; the press must correct with a new open epoch |
| Commitment CID never received from auditor (auditor unresponsive) | Press escalates to administrator; administrator may remove the unresponsive auditor via a policy update, which triggers an epoch close with a new auditor set |

---

## Related Specs

- `mark_offering_and_acceptance.md` — where issuance records are generated and encrypted
- `policy_creation.md` — where auditors are defined in the policy
- `mark_updates.md` — used to add/remove auditors and trigger epoch close
- `chitt_protocol_spec.md §2` — Audit Epoch Lifecycle section
- `protocol-objects.md §11` — `PressIssuanceRecord` object reference
- `protocol-objects.md §12` — `AuditEpochEntry` object reference
- `protocol-objects.md §13` — `AuditEpochCommitment` object reference
