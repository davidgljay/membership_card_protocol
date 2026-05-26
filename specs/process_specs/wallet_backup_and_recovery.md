# Wallet Backup and Recovery — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-05-25  
**Status:** Draft  

> **Terminology note.** This spec uses "mark" for "chitt" and "wallet" for "keyring." The rename is in progress; treat the terms as interchangeable.

---

## Overview

A mark holder's wallet contains the private keys for every mark they control. Loss of the wallet means loss of access to all marks and any services authenticated with them. This spec covers three processes: initial wallet setup with backup registration, YubiKey-based recovery, and post-recovery re-registration.

The security model: the wallet is encrypted on IPFS with a key that requires both a passkey (device-bound) and a service secret (held by the primary service). Neither alone is sufficient to decrypt. A YubiKey backup holds a wrapped copy of the decryption key, enabling independent recovery if the primary service is unavailable or the user's device is lost.

---

## Actors

| Actor | Role |
|---|---|
| **Holder** | The mark owner setting up or recovering their wallet |
| **Primary service** | Holds `service_secret`; never sees the wallet's plaintext or decryption key |
| **Backup service** | Holds an encrypted blob containing the wrapped keyring decryption key; manages the 72-hour cancellation window |
| **YubiKey** | Hardware token held by the holder; used to unwrap the decryption key at recovery time |

---

## Process 1: Initial Wallet Setup

This flow runs when a new holder creates their first wallet, or when an existing holder sets up wallet infrastructure on a new primary service.

### Steps

**Wallet creation:**

1. The client generates a **master mark keypair** (ML-DSA-44):
   - Private key is held in memory only during this step.
   - The keypair will serve as the holder's root identity.

2. The user creates a **passkey** via the device authenticator (WebAuthn platform authenticator — Face ID, Touch ID, Windows Hello, etc.). The passkey is bound to this device and this application origin.

3. The primary service generates a `service_secret` — a random 256-bit value stored server-side, associated with the holder's account. The service never sees any key material.

4. The **keyring decryption key** is derived:
   ```
   decryption_key = KDF(passkey_output, service_secret)
   ```
   Neither `passkey_output` alone nor `service_secret` alone can reconstruct `decryption_key`.

5. The keyring is initialized as an append-only encrypted blob:
   - The blob contains the master mark private key, keyed by mark address.
   - The blob is encrypted with `decryption_key` (AES-GCM).
   - The encrypted blob is posted to IPFS.
   - The IPFS CID is stored by the primary service, associated with the holder's account.

6. The master mark private key is cleared from memory after the keyring is posted.

**Device sub-mark setup:**

7. The client generates a **device sub-mark keypair** in secure device storage:
   - Apple devices: Secure Enclave.
   - Other devices: TPM-backed Keystore.
   - The private key is scoped to this application and cannot be exported.

8. The master mark key is accessed from the keyring (decrypted using `decryption_key`):
   - The master key signs a sub-mark registration binding the device sub-mark to the master.
   - The master key is cleared from memory after signing.

9. The sub-mark registration is posted on Arbitrum One, linking the sub-mark's registry address to the master mark's registry address.

10. Routine operations (signing messages, accepting marks) now use the device sub-mark key. The master key remains in the encrypted keyring and is accessed only for high-stakes operations (creating new sub-marks, key rotation).

**YubiKey backup registration (strongly recommended):**

11. The holder is prompted to register a YubiKey backup. Steps:
    - The holder inserts their YubiKey.
    - The client derives a wrapping key from the YubiKey (PIN required): the YubiKey computes a device-scoped derivation; the result is used as a wrapping key.
    - The client wraps `decryption_key`: `wrapped_decryption_key = AES-GCM.Encrypt(yubikey_derived_key, decryption_key)`.
    - The client sends the encrypted blob to the backup service: `{ wrapped_decryption_key, keyring_cid, notification_channels, cancellation_credentials }`.
    - The backup service stores the blob and returns a **backup registration mark** (proof of registration). The backup service never sees `decryption_key` in plaintext.

12. The holder stores the YubiKey in a safe, separate location from their primary device.

---

## Process 2: YubiKey Recovery

This flow runs when the holder needs to recover their wallet — for example, after losing their primary device or losing access to their primary service.

### Preconditions

- The holder has a registered YubiKey and knows its PIN.
- The backup service is reachable.
- The holder has configured at least one notification channel (Nym gateway, email, or SMS).

### Steps

**Initiation:**

1. The holder presents their YubiKey to the backup service (via the wallet client or a recovery web interface).

2. The backup service simultaneously sends recovery initiation notifications to all configured channels:
   - Nym gateway (if configured).
   - Email.
   - SMS.
   - Secondary contacts (if configured).

   Notifications include: timestamp, backup service identity, and a cancellation link/code.

**Cancellation window:**

3. The backup service waits **72 hours** for a valid cancellation. A cancellation is valid if it is signed by any registered cancellation credential.

4. If a cancellation is received:
   - The backup service aborts the recovery and notifies the holder via all channels.
   - The holder must rotate their backup registration (Steps 11–12 of Process 1) and treat the old YubiKey as potentially compromised.
   - If the old YubiKey was used by an attacker, the holder should also rotate any sub-marks registered under the recovered wallet.

**Key release (after 72-hour window):**

5. If no cancellation is received after 72 hours, the backup service releases:
   - The CID of the encrypted keyring blob on IPFS.
   - The `wrapped_decryption_key` blob.

**Decryption:**

6. The holder's client fetches the encrypted keyring blob from IPFS using the released CID.

7. The holder presents the YubiKey (PIN required). The client sends the `wrapped_decryption_key` to the YubiKey. The YubiKey decapsulates it locally and returns the `decryption_key`. The private key of the YubiKey never leaves the device.

8. The client decrypts the keyring blob using `decryption_key`. The full wallet — master mark private keys and all associated mark private keys — is now accessible.

9. Recovery is complete. The holder has restored access to all marks.

---

## Process 3: Post-Recovery Re-registration

After recovery, the holder should re-establish their wallet on a new primary service to restore the dual-factor security model.

### Steps

10. The holder registers with a **new primary service**:
    - Creates a new passkey on the new device.
    - The new service generates a new `service_secret`.
    - A new `decryption_key` is derived from the new passkey and service secret.
    - The keyring blob is re-encrypted with the new `decryption_key` and re-posted to IPFS.

11. The holder registers new **device sub-marks** for their new device(s):
    - Generate a new device sub-mark keypair in the new device's secure storage.
    - Access the master key from the recovered keyring.
    - Sign a new sub-mark registration and post it on Arbitrum One.
    - Clear the master key from memory.

12. **Deregister potentially-compromised sub-marks:**
    - For each device sub-mark that was active on the lost device: submit a revocation intent (code 811 — device sub-mark lost or stolen) via the mark update flow (see `mark_updates.md`).
    - This prevents any party who obtained the old device from using its sub-mark for future operations.

13. **Update YubiKey backup registration:**
    - Register the YubiKey backup again under the new `decryption_key` (Process 1, Steps 11–12).
    - The old backup registration (which wrapped the old `decryption_key`) should be revoked at the backup service.

---

## Postconditions

- The holder's wallet is accessible from the new device.
- All compromised device sub-marks are revoked.
- The wallet is protected again by the dual-factor encryption model (new passkey + new service secret).
- A new YubiKey backup is registered against the new decryption key.

---

## Key Security Properties

| Property | Mechanism |
|---|---|
| Primary service cannot read the wallet | `decryption_key = KDF(passkey_output, service_secret)`; service holds only `service_secret` |
| Backup service cannot read the wallet | Backup service holds `wrapped_decryption_key`; unwrapping requires the YubiKey |
| YubiKey theft cannot immediately compromise wallet | 72-hour cancellation window; multi-channel notification allows the holder to abort |
| Lost YubiKey + lost device is out of scope v1 | Designing a safe recovery path for this case is a future consideration |
| Master key is cold during routine operations | All routine signing uses device sub-mark keys; master key accessed only for sub-mark creation and rotation |

---

## Error Paths

| Condition | Resolution |
|---|---|
| Passkey creation fails | Use a different device or browser; passkey is device- and origin-bound |
| Primary service unavailable during setup | Cannot complete wallet setup without a service secret; choose an available primary service |
| YubiKey PIN forgotten | YubiKey recovery is blocked; holder must set up a new YubiKey backup registration; old recovery path is lost |
| Keyring IPFS CID unavailable during recovery | Retry IPFS fetch; if permanently unavailable, the keyring blob must be re-derived from any surviving private key material (last resort manual recovery) |
| Cancellation window expires and holder did not intend recovery | Holder must immediately rotate all mark sub-marks that may have been exposed; treat master keys as compromised; issue successor marks as needed |
| Recovery completed by attacker before holder notices | Holder must issue 910 (full wallet compromise suspected) revocations on all marks and work with each policy's issuer to obtain successor marks |

---

## Related Specs

- `open_offer_acceptance_new_wallet.md` — wallet creation as part of first mark acceptance
- `mark_updates.md` — submitting sub-mark revocation intents post-recovery
- `chitt_protocol_spec.md §3` — full feature spec for keychain setup and backup
