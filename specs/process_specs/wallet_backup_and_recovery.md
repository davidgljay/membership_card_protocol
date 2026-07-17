# Wallet Backup and Recovery — Process Spec

**Version:** 0.4 (draft)  
**Date:** 2026-07-04  
**Status:** Draft  

> **Terminology note.** This spec now uses "card" as the canonical term per the Naming Convention.

**Changelog (spec-consistency Phase 2):** Fix #2 — reworded §Keyring Storage and Replication to say keyring broadcast reuses the same peer list (not the same channel/endpoint) as `CardBindingAnnouncement` fanout, citing `wallet.md §7.5`'s actual separate `/federation/keyrings*` endpoints; Fix #56 — added a UUID registration step to Process 3 for newly-registered device sub-cards (`notification_relay.md §Process 1`); Fix #60 — updated Process 1 Steps 3-6 and Process 3 Step 10 to describe the real two-call service_secret/keyring bootstrap sequence (`wallet.md §7.2-7.3`; `wallet_sdk.md §5.3/§5.6`); Fix #61 — reworded the Error Paths "attacker completed recovery" row to reflect the default issuer-only 9xx authorization model; Fix #62 — corrected Process 3 Step 12's sub-card revocation code selection (811 vs. 810) per `subcard_creation_policy.md`/`wallet_sdk.md §6.4`. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

**Changes from v0.3:** Corrected the backup-registration wire format (Process 1, Steps 13-14) to match the implemented field names (`wrapped_blob`, `cancellation_pubkey`), and named the master card key as the cancellation credential.

**Changes from v0.2:** The keyring blob no longer lives on IPFS (see `ARCHITECTURE.md` ADR-009-AMEND). It is stored in traditional, deletable storage and replicated across every wallet service in the federation, identified by `keyring_id` (a content hash) instead of an IPFS CID. Rotation now triggers a synchronized delete of the superseded version across the federation, rather than relying on IPFS unpinning.

---

## Overview

A card holder's wallet contains the private keys for every card they control. Loss of the wallet means loss of access to all cards and any services authenticated with them. This spec covers four processes: initial wallet setup with backup registration, synced passkey recovery (default), YubiKey recovery (opt-in upgrade), and post-recovery re-registration.

The security model: the wallet is encrypted with a key that requires both a passkey (device-bound) and a service secret (held by the primary service). Neither alone is sufficient to decrypt. The encrypted keyring is replicated across every wallet service in the federation (see "Keyring Storage and Replication" below), so recovery does not depend on any single operator remaining available. Recovery is enabled by a wrapped copy of the decryption key held at the backup service, unwrappable by a second credential the holder registers at setup.

---

## Keyring Storage and Replication

The keyring blob (the append-only encrypted store of the holder's master card private keys, ADR-009) is stored using ordinary, deletable storage — not IPFS — at **every wallet service in the federation**:

- The blob is identified by `keyring_id = keccak256(encrypted_blob)`, a content hash used as a lookup key and integrity check, not an IPFS CID.
- Whenever a holder's primary service creates or updates the keyring (initial setup, or re-encryption after rotation/recovery), it stores the blob locally and broadcasts it — alongside its `keyring_id` — to every other wallet service in the federation. This broadcast reuses the same **peer list** already maintained for `CardBindingAnnouncement` fanout (`specs/process_specs/message_routing.md §Wallet Service Registry`), but is structurally separate from that fanout: it is sent via its own dedicated endpoints, `POST /federation/keyrings` (replicate) and `POST /federation/keyrings/delete` (delete the superseded version), each authenticated by the same peer-wallet-service signature scheme (`wallet.md §6.5`) and documented as distinct message shapes/verification functions in `wallet.md §7.5`. Each receiving operator stores its own copy, keyed by `keyring_id` and associated with the holder's `card_hash`.
- When the keyring is replaced (re-encrypted under a new `decryption_key`, e.g. during post-recovery re-registration), the broadcast also instructs every federation member to **delete its copy of the previous `keyring_id`**. Unlike the prior IPFS-based design, this deletion is a deliberate, synchronized operation across the whole federation, not a best-effort unpin that other parties may have already cached around.
- At recovery time, the holder's client may fetch the keyring blob by `keyring_id` from **any** reachable wallet service holding a replica — not necessarily the original primary service. This is what preserves the "recovery is independent of the primary service" property without using IPFS.

**Recovery tiers:**

| Tier | Mechanism | Security | Setup friction | Recovery friction |
|---|---|---|---|---|
| Default | Synced passkey (iCloud / Google) | Medium | None — automatic | Low — any device on same account |
| Upgrade | YubiKey | High | Hardware required | Low — present YubiKey + PIN |

Both tiers use the same 72-hour cancellation window and notification flow. They can be registered simultaneously; either suffices to recover.

---

## Actors

| Actor | Role |
|---|---|
| **Holder** | The card owner setting up or recovering their wallet |
| **Primary service** | Holds `service_secret`; never sees the wallet's plaintext or decryption key |
| **Backup service** | Holds wrapped decryption key blob(s); manages the 72-hour cancellation window |
| **Synced passkey** | A WebAuthn platform credential backed up to iCloud Keychain or Google Password Manager; syncs to any device on the same account; requires biometric auth to use |
| **YubiKey** | Hardware token held by the holder; opt-in upgrade over synced passkey |

---

## Process 1: Initial Wallet Setup

This flow runs when a new holder creates their first wallet, or when an existing holder sets up wallet infrastructure on a new primary service.

### Steps

**Wallet creation:**

1. The client generates a **master card keypair** (ML-DSA-44):
   - Private key is held in memory only during this step.
   - The keypair will serve as the holder's root identity.

2. The user creates a **device-bound passkey** via the device authenticator (WebAuthn platform authenticator — Face ID, Touch ID, Windows Hello, etc.). This passkey is bound to this device and this application origin; it is used for daily operations and is not backed up.

3. The client calls `POST /accounts/challenge` to obtain a challenge, then signs it with the freshly generated master card key and calls `POST /accounts` — the first call of a required **two-call bootstrap sequence** (`wallet.md §7.2-7.3`). This call registers the account and WebAuthn credential and submits a provisional `encrypted_keyring_blob` (necessarily provisional — see Step 4 — since the real `decryption_key` cannot be computed until this call returns). The primary service generates a `service_secret` — a random 256-bit value stored server-side, associated with the holder's account — and returns it, along with `keyring_id` and a session token, in the response. The service never sees any key material.

4. The **keyring decryption key** is derived:
   ```
   decryption_key = KDF(device_passkey_output, service_secret)
   ```
   Neither `device_passkey_output` alone nor `service_secret` alone can reconstruct `decryption_key`. This is the real `decryption_key`; it cannot be computed until Step 3's `service_secret` is known, which is why Step 3's submitted blob was provisional.

5. The keyring is finalized as an append-only encrypted blob:
   - The blob contains the master card private key, keyed by card address.
   - The blob is re-encrypted with the real `decryption_key` from Step 4 (AES-GCM).
   - The client makes the **second** bootstrap call, `PUT /accounts/{card_hash}/keyring`, with the re-encrypted blob and `rotate_service_secret: false` — installing the final blob under a new `keyring_id` without triggering a second, uninvited `service_secret` rotation (`wallet.md §7.3`). The primary service stores the blob and broadcasts it to every other wallet service in the federation (see "Keyring Storage and Replication" above).
   - `keyring_id` is stored by the primary service, associated with the holder's account.

6. The master card private key is cleared from memory after the keyring is posted.

**Device sub-card setup:**

7. The client generates a **device sub-card keypair** in secure device storage:
   - Apple devices: Secure Enclave.
   - Other devices: TPM-backed Keystore.
   - The private key is scoped to this application and cannot be exported.

8. The master card key is accessed from the keyring (decrypted using `decryption_key`):
   - The master key signs a sub-card registration binding the device sub-card to the master.
   - The master key is cleared from memory after signing.

9. The sub-card registration is posted on Arbitrum One, linking the sub-card's registry address to the master card's registry address.

10. Routine operations (signing messages, accepting cards) now use the device sub-card key. The master key remains in the encrypted keyring and is accessed only for high-stakes operations (creating new sub-cards, key rotation).

**Synced passkey backup registration (default — automatic):**

11. The client automatically creates a **synced passkey** against the same application origin. Unlike the device-bound passkey in Step 2, this passkey is stored in iCloud Keychain (Apple) or Google Password Manager (Android) and syncs to any device logged into the same account. Biometric auth is required to use it on any device.

12. The client wraps `decryption_key` with the synced passkey output:
    ```
    wrapped_decryption_key_cloud = AES-GCM.Encrypt(synced_passkey_output, decryption_key)
    ```

13. The client sends the encrypted blob to the backup service:
    ```
    { type: "synced_passkey", wrapped_blob, keyring_id, notification_channels, cancellation_pubkey }
    ```
    `cancellation_pubkey` is the holder's master card key (ML-DSA-44 public key) — the credential used to authorize cancellation in Process 2a/2b below. The backup service stores the blob and returns a **backup registration confirmation**. The backup service never sees `decryption_key` in plaintext.

**YubiKey backup registration (opt-in upgrade):**

14. The holder may optionally register a YubiKey for higher-security recovery. Steps:
    - The holder inserts their YubiKey.
    - The client derives a wrapping key from the YubiKey (PIN required): the YubiKey computes a device-scoped derivation; the result is used as a wrapping key.
    - The client wraps `decryption_key`: `wrapped_decryption_key_yubikey = AES-GCM.Encrypt(yubikey_derived_key, decryption_key)`.
    - The client sends the encrypted blob to the backup service:
      ```
      { type: "yubikey", wrapped_blob, keyring_id, notification_channels, cancellation_pubkey }
      ```
    - The backup service stores this blob alongside (or instead of) the synced passkey blob.

15. The holder stores the YubiKey in a safe, separate location from their primary device.

Both blobs may be registered simultaneously. Either suffices for recovery independently.

---

## Process 2a: Synced Passkey Recovery (Default)

This flow runs when the holder has lost their primary device and has a synced passkey registered. It is available to all holders by default.

### Preconditions

- The holder has a synced passkey registered (automatic for all wallets created under this spec).
- The holder's Apple or Google account is accessible on the new device.
- The backup service is reachable.
- At least one notification channel is configured.

### Steps

**Initiation:**

1. On the new device, the holder signs into their Apple or Google account. The synced passkey replicates automatically via iCloud Keychain or Google Password Manager.

2. The holder opens the wallet app and initiates recovery. The app contacts the backup service and identifies the account.

3. The backup service simultaneously sends recovery initiation notifications to all configured channels:
   - Email.
   - SMS.
   - HTTPS webhook (if configured).
   - Secondary contacts (if configured).

   Notifications include: timestamp, backup service identity, recovery method used ("synced passkey"), and a cancellation link/code.

**Cancellation window:**

4. The backup service waits **72 hours** for a valid cancellation. A cancellation is valid if it is signed by the registered cancellation credential — the holder's master card key (`cancellation_pubkey`, registered at backup time, Process 1 Step 13).

5. If a cancellation is received:
   - The backup service aborts the recovery and notifies the holder via all channels.
   - The holder should treat their Apple/Google account as potentially compromised and rotate their account credentials.
   - The holder should also rotate any sub-cards registered under the wallet.

**Key release (after 72-hour window):**

6. If no cancellation is received after 72 hours, the backup service releases:
   - The `keyring_id` of the encrypted keyring blob.
   - The `wrapped_decryption_key_cloud` blob.

**Decryption:**

7. The holder's client fetches the encrypted keyring blob by `keyring_id` from any reachable wallet service in the federation — the original primary service is not required, since the blob is replicated across all federation members (see "Keyring Storage and Replication").

8. The app requests the synced passkey. The device prompts biometric auth (Face ID, Touch ID, fingerprint). On success, the synced passkey output unwraps `decryption_key`:
   ```
   decryption_key = AES-GCM.Decrypt(synced_passkey_output, wrapped_decryption_key_cloud)
   ```
   The synced passkey private key never leaves the device.

9. The client decrypts the keyring blob using `decryption_key`. The full wallet — master card private keys and all associated card private keys — is now accessible.

10. Recovery is complete. Proceed to Process 3 (post-recovery re-registration).

### Security notes

- An attacker who compromises the holder's Apple/Google account can initiate this recovery flow. The 72-hour window and multi-channel notification give the holder time to cancel.
- After account entry, biometric auth is enforced on the attacker's device (their biometrics), so the synced passkey is usable — account compromise is a meaningful threat.
- The `service_secret` from the primary service is still required to re-derive `decryption_key` for the new daily-use passkey during re-registration (Process 3), providing a second factor an account attacker must also compromise.
- Holders with high-security needs should register a YubiKey (Process 2b) and optionally disable the synced passkey recovery path.

---

## Process 2b: YubiKey Recovery (Opt-In Upgrade)

This flow runs when the holder has a YubiKey registered and prefers the higher-security recovery path, or when their synced passkey is unavailable (e.g., they have switched Apple/Google accounts).

### Preconditions

- The holder has a registered YubiKey and knows its PIN.
- The backup service is reachable.
- At least one notification channel is configured.

### Steps

**Initiation:**

1. The holder presents their YubiKey to the backup service (via the wallet client or a recovery web interface).

2. The backup service simultaneously sends recovery initiation notifications to all configured channels:
   - Email.
   - SMS.
   - HTTPS webhook (if configured).
   - Secondary contacts (if configured).

   Notifications include: timestamp, backup service identity, recovery method used ("YubiKey"), and a cancellation link/code.

**Cancellation window:**

3. The backup service waits **72 hours** for a valid cancellation. A cancellation is valid if it is signed by the registered cancellation credential — the holder's master card key (`cancellation_pubkey`, registered at backup time, Process 1 Step 14).

4. If a cancellation is received:
   - The backup service aborts the recovery and notifies the holder via all channels.
   - The holder must treat the old YubiKey as potentially compromised and register a new one.
   - The holder should also rotate any sub-cards registered under the wallet.

**Key release (after 72-hour window):**

5. If no cancellation is received after 72 hours, the backup service releases:
   - The `keyring_id` of the encrypted keyring blob.
   - The `wrapped_decryption_key_yubikey` blob.

**Decryption:**

6. The holder's client fetches the encrypted keyring blob by `keyring_id` from any reachable wallet service in the federation — the original primary service is not required.

7. The holder presents the YubiKey (PIN required). The client sends the `wrapped_decryption_key_yubikey` to the YubiKey. The YubiKey decapsulates it locally and returns the `decryption_key`. The private key of the YubiKey never leaves the device.

8. The client decrypts the keyring blob using `decryption_key`. The full wallet is now accessible.

9. Recovery is complete. Proceed to Process 3 (post-recovery re-registration).

---

## Process 3: Post-Recovery Re-registration

After either recovery path, the holder re-establishes their wallet on a new primary service to restore the dual-factor encryption model.

### Steps

10. The holder registers with a **new primary service**, via the same two-call bootstrap sequence used in Process 1 Steps 3–5 (`wallet.md §7.2-7.3`; `wallet_sdk.md §5.3/§5.6`):
    - Creates a new device-bound passkey on the new device.
    - First call: registers/re-registers with the new service, which mints a new `service_secret` (`rotate_service_secret: true`, the default), invalidating every session token previously issued for this `card_hash`.
    - A new `decryption_key` is derived from the new passkey and the new `service_secret`.
    - The keyring blob is re-encrypted under the new `decryption_key`. Second call: `PUT /accounts/{card_hash}/keyring` with `rotate_service_secret: false` installs this re-encrypted blob under a new `keyring_id` without triggering a further, uninvited rotation of the `service_secret` it was just encrypted under. This second call also broadcasts the new blob to every wallet service in the federation and instructs all federation members to delete their copy of the previous `keyring_id`.

11. The holder registers new **device sub-cards** for their new device(s):
    - Generate a new device sub-card keypair in the new device's secure storage.
    - Access the master key from the recovered keyring.
    - Sign a new sub-card registration and post it on Arbitrum One.
    - Clear the master key from memory.
    - For each newly-registered sub-card, run UUID pool registration against the new wallet service (`notification_relay.md §Process 1`, `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`). Without this step, the new sub-card is active on-chain but has no UUID pool at any wallet service and cannot receive messages.

12. **Deregister potentially-compromised sub-cards:**
    - For each device sub-card that was active on the lost device: submit a revocation intent via the card update flow (see `card_updates.md`), selecting the code based on the scenario (`subcard_creation_policy.md`; `wallet_sdk.md §6.4`) — code **811** ("app installation lost or uninstalled") if there is no reason to suspect the sub-card's signing key was extracted before the device was lost, or code **810** ("sub-card's signing key compromised") if key compromise is suspected. A lost-or-stolen device more often warrants 810 than 811, since the device leaving the holder's control is itself grounds for suspecting key exposure; the holder should default to 810 unless they have specific reason for confidence the key was never at risk.

13. **Update backup registrations:**
    - Register a new synced passkey blob under the new `decryption_key` (Process 1, Steps 11–13).
    - If a YubiKey is registered, re-wrap under the new `decryption_key` (Process 1, Steps 14–15).
    - Revoke the old backup registrations at the backup service.

---

## Postconditions

- The holder's wallet is accessible from the new device.
- All compromised device sub-cards are revoked.
- The wallet is protected again by the dual-factor encryption model (new passkey + new service secret).
- Backup registration(s) are updated under the new decryption key.

---

## Key Security Properties

| Property | Mechanism |
|---|---|
| Primary service cannot read the wallet | `decryption_key = KDF(passkey_output, service_secret)`; service holds only `service_secret` |
| Backup service cannot read the wallet | Backup service holds wrapped blobs only; unwrapping requires the holder's synced passkey or YubiKey |
| Synced passkey theft requires Apple/Google account access | Account compromise is needed to access the synced passkey; biometric auth is then enforced on the attacker's device |
| YubiKey theft cannot immediately compromise wallet | 72-hour cancellation window; multi-channel notification allows the holder to abort |
| Account compromise alone does not decrypt the wallet | `service_secret` from the primary service is still required during re-registration |
| Lost synced passkey + lost device | Holder must switch recovery to YubiKey path, or re-enroll after regaining Apple/Google account access |
| Lost YubiKey + lost device (no synced passkey) | No recovery path; synced passkey default prevents this for most users |
| Master key is cold during routine operations | All routine signing uses device sub-card keys; master key accessed only for sub-card creation and rotation |

---

## Error Paths

| Condition | Resolution |
|---|---|
| Passkey creation fails | Use a different device or browser; passkey is device- and origin-bound |
| Primary service unavailable during setup | Cannot complete wallet setup without a service secret; choose an available primary service |
| Synced passkey unavailable (e.g., account switched) | Use YubiKey recovery path if registered; otherwise recover Apple/Google account first |
| YubiKey PIN forgotten | YubiKey recovery is blocked; use synced passkey recovery path instead |
| Keyring blob unavailable from any federation member | Retry against other wallet services in the federation holding a replica; if no federation member has it (last resort), the keyring blob must be re-derived from any surviving private key material (manual recovery) |
| Cancellation window expires and holder did not intend recovery | Holder must immediately rotate all card sub-cards that may have been exposed; treat master keys as compromised; issue successor cards as needed |
| Recovery completed by attacker before holder notices | Under the default authorization model (`card_updates.md §Phase 3 Step 7`: 9xx by issuer only, absent a policy override), the holder cannot unilaterally post a 910 revocation. The holder must request a 910 (full wallet compromise suspected) revocation from each affected card's policy issuer and work with them to obtain successor cards; this may differ if a specific policy's `revocation_permissions` grants broader 9xx authority. |

---

## Related Specs

- `open_offer_acceptance_new_wallet.md` — wallet creation as part of first card acceptance
- `open_offer_acceptance_existing_wallet.md` — keyring update flow for existing holders, including recovery-triggered keyring updates
- `card_updates.md` — submitting sub-card revocation intents post-recovery
- `card_protocol_spec.md §3` — full feature spec for keychain setup and backup
- `specs/object_specs/wallet.md` — wallet service wire protocol (challenge/response, session tokens, keyring/recovery endpoints) implementing this spec's processes
