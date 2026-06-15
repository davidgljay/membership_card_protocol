Keyring Recovery Flow

Overview
A holder's private keys live in a keyring — an append-only encrypted blob stored on IPFS. The keyring is decryptable with a key derived from a passkey combined with a service secret held by the primary service. A separate YubiKey-wrapped decryption key provides a recovery path that is fully independent of the primary service.

The Restated Flow
1. User registers on the primary service, which holds the keyring as an encrypted blob on IPFS. The keyring is decryptable only with a key derived from passkey + service_secret. The service never sees plaintext keys.

2. User registers with one or more backup services, presenting their YubiKey. The backup service stores an encrypted blob containing the keyring decryption key, wrapped under the YubiKey-derived key. The backup service returns a Card — a signed credential proving this registration exists — and records the user's notification channels and cancellation credentials.

3. Primary service goes down. User goes to a backup service with their YubiKey.

4. Backup service sends notifications to all configured channels simultaneously (Nym to the Card's gateway, email, SMS, secondary contacts, whatever was configured at registration). It waits 72 hours for a cancellation signed by any registered cancellation credential.

5. If cancellation is received from any registered credential, the service silently aborts and notifies the Card holder with instructions to rotate their backup registration (generate a new YubiKey-wrapped backup, deregister the old one, treat the old YubiKey as potentially compromised).

6. If no cancellation is received after 72 hours, the service releases the CID of the encrypted keyring blob on IPFS, plus the wrapped decryption key blob. The user's device presents the wrapped blob to the YubiKey (PIN required), the YubiKey unwraps it locally, and the resulting decryption key fetches and decrypts the keyring from IPFS. No passkey required. No primary service required.

7. User is now back in possession of their keyring and all the private keys it contains. They re-register with a new primary service, create a new passkey, re-encrypt the keyring under the new passkey + new_service_secret combination, and optionally rotate their YubiKey backup registration to use a fresh wrapped key.

What the Keyring Contains
The keyring is an append-only encrypted blob. It holds:

The master private key for each Card the holder controls
The private keys for any sub-Cards registered to those master Cards
Metadata associating each key with its corresponding Card mutable pointer

Because the keyring is append-only, recovering it restores the full set of keys the holder had at the time of last backup, without any destructive operations on prior entries.

What This Design Achieves

Primary service going down is fully recoverable, independently, with no coordination from the primary service.
Stolen YubiKey is protected by PIN (8 attempts before wipe) plus the 72-hour window plus multi-channel notifications plus cancellation from any recovery credential.
Stolen YubiKey plus silent notification window (user somehow doesn't notice for 72 hours across all channels and has no guardian who can cancel) is the residual risk. For most users this is acceptable; for high-value users, extend the window and add more notification channels.
The backup service never sees the keyring plaintext, never sees the decryption key, and can only mount a denial-of-service attack (refusing to release), not a theft attack.
No passkey required for recovery — the recovery path is fully independent of both the passkey and the primary service.

The Card as proof of registration: the Card returned by the backup service at registration serves double duty — it's a proof of registration that can be verified on-chain, and it provides a Nym gateway address for the 72-hour notification. The recovery system is built on the Card protocol's own primitives rather than a separate identity system.

What This Design Does Not Cover
On-chain state: if any Card's mutable pointer or append-only log requires on-chain transactions (e.g. revoking a sub-Card, posting a new log entry), recovering the keyring restores the signing keys but does not automatically replay any pending on-chain operations. Those must be re-initiated after recovery.

Sub-Card deregistration: after recovery, the holder should audit their active sub-Cards and deregister any that were registered on devices that may have been compromised as part of whatever event triggered the recovery.
