# Phase 2 Milestone Review — Wallet Setup, Backup, Recovery, and Sub-Card Lifecycle

**Date:** 2026-07-04
**Scope:** `client-sdk/packages/client-sdk/src/wallet/` — initial wallet setup (Step 2.1), device sub-card issuance (Step 2.2), backup registration (Step 2.3), recovery and re-registration (Step 2.4), post-recovery sub-card deregistration (Step 2.5), and CP-1's security review.

## Summary

`setupWallet()` drives the full `wallet_backup_and_recovery.md §Process 1` flow end-to-end against a stubbed wallet service: master keypair generation, device-bound passkey, the two-call `service_secret` bootstrap, `decryption_key` derivation, keyring encryption/storage, always-on synced-passkey backup registration, opt-in YubiKey backup, and device sub-card issuance — with `decryption_key` and the master private key never crossing the function's return boundary. `recovery.ts` covers both recovery tiers (`§Process 2a`/`§Process 2b`) and post-recovery re-registration (`§Process 3`) plus batch sub-card deregistration (`subcards.md §Deregistration After Key Recovery`), verified by an end-to-end test that drives setup → simulated device loss → recovery initiation → cancellation (separately) → window expiry → key release → keyring fetch from a stub non-primary wallet-service instance → decrypt → re-registration → sub-card deregistration against a stub press, confirming the recovered keyring matches the original bit-for-bit before re-encryption. 146 tests pass across the package; build/typecheck/lint are clean across the whole `client-sdk` workspace (`client-sdk`, `client-sdk-web`, `client-sdk-rn`).

Two real, pre-existing protocol bugs were found and fixed while building this phase, not by inspection alone but because the end-to-end recovery test's more realistic stub (matching the real wallet-service's actual behavior rather than a convenient fixture) surfaced them as failures:

1. **`PUT /accounts/{card_hash}/keyring` rotated `service_secret` unconditionally on every call**, decoupled from whatever the client had just encrypted its submitted blob with — meaning the account's stored keyring became permanently undecryptable via any secret the server would later hand back. Fixed in `wallet-service` with an opt-in `rotate_service_secret: false` flag; `setupWallet`/`recoverWallet` updated to use it.
2. **(CP-1) `device_passkey_output` was derived from `attestationObject`**, the exact same bytes `setupWallet` also sends to (and the wallet service stores as) `webauthn_public_key` — meaning the wallet service, already holding `service_secret`, could independently recompute `decryption_key` without the device ever being involved again. This collapsed the "neither factor alone suffices" property the whole phase is built on. Fixed by switching to the WebAuthn PRF extension output (`prfOutput`, never transmitted anywhere by this SDK) for both the device-bound and synced-passkey derivations — the same primitive the synced-passkey path already needed for its own, separate reason (recoverability from a later `assert()`). A regression test (`setupWallet.test.ts`'s "CP-1 regression") confirms a simulated colluding wallet service, given everything it actually receives, cannot reconstruct `decryption_key`.

## CP-1 — Backup/Recovery Security Review

Conducted; full findings in `plans/client-sdk/milestones/cp1-security-review.md`. Finding 1 (above) was critical and has been remediated and re-tested. Two lower-severity findings remain open, tracked there rather than fixed in this phase:

- Transient secrets other than `masterSecretKey` (`decryptionKey`, `devicePasskeyOutput`, wrapping keys, `serviceSecret`) are not explicitly zeroed after use, unlike `masterSecretKey` — relies on GC timing rather than explicit clearing.
- If the keyring ever grows beyond its current single (master-key) entry, only the entry aliased by `masterSecretKey` gets cleared by the existing `finally` blocks.

The review's own caveat: it was conducted by the same agent that wrote the code, not a genuinely independent second reviewer — a real limitation given `wallet_backup_and_recovery.md`'s own framing of this checkpoint. Re-review by an independent party before production use is recommended, particularly given how Finding 1 was the kind of cross-component interaction a same-author re-read is least likely to catch.

## What was **not** built in this phase (explicitly out of scope, not gaps)

- A general "unlock the wallet's master key again after setup" primitive — `cancelRecovery` takes `masterSecretKey` as a direct parameter, deferring how a legitimate holder reconstructs it to the caller. No prior step needed this (routine signing uses the device sub-card key), and building it is a materially new feature.
- Real `PasskeyProvider`/`YubiKeyProvider` hardware-backed implementations with actual WebAuthn PRF / YubiKey backends — both remain interfaces with fakes in tests; concrete implementations are for the platform packages (`client-sdk-web`/`client-sdk-rn`) or a future YubiKey integration package.
- The deregistration primitive (`subCardDeregistration.ts`) is built ahead of Phase 4 Step 4.4 per that step's own explicit allowance, and Phase 4 should reuse it rather than rebuild it.

## Next

Phase 3 (card offer creation, acceptance, and press submission) proceeds next.
