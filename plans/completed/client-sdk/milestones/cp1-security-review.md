# Clarification Checkpoint CP-1 — Backup/Recovery Security Review

**Date:** 2026-07-04
**Scope:** `client-sdk/packages/client-sdk/src/wallet/{kdf,keyring,setupWallet,backupRegistration,recovery,subCardDeregistration}.ts` and the `PasskeyProvider`/`YubiKeyProvider` interfaces — the KDF computation, both backup-wrapping paths (synced passkey, YubiKey), and memory-retention behavior across Steps 2.1–2.5. Pairs with `plans/wallet-service/implementation-plan.md`'s CP-2 for the same flow's server side (not conducted here — this review is client-sdk-only).
**Reviewer:** Same agent that implemented Steps 2.1–2.5, conducting an independent re-read rather than a second reviewer. This is a real limitation — see "Caveats" below.

## Finding 1 (CRITICAL): the device-bound passkey's KDF input is transmitted to, and stored by, the wallet service — the server alone can derive `decryption_key`

`kdf.ts`'s `devicePasskeyOutputFromRegistration` computes `device_passkey_output = keccak256(attestationObject)`, where `attestationObject` is the raw value `PasskeyProvider.register()` returns for the device-bound passkey created in `setupWallet.ts` Step 2.

`setupWallet.ts` (line ~217) derives `device_passkey_output` from `registration.attestationObject`, then (line ~258) submits **the same, byte-identical `attestationObject`** to the wallet service as `webauthn_public_key` in the `POST /accounts` request body:

```ts
const devicePasskeyOutput = devicePasskeyOutputFromRegistration(registration.attestationObject);
...
webauthn_public_key: bytesToBase64Url(registration.attestationObject),
```

The wallet service persists `webauthn_public_key` verbatim, as plaintext base64url text (`wallet-service/server/db/accounts.ts`'s `webauthn_public_key` column — confirmed by reading `accounts-create.ts`'s insert path; no hashing or transformation is applied server-side).

**Impact:** the wallet service already generates and holds `service_secret` (that's its entire role in the dual-factor model). Since it also now holds the exact bytes needed to recompute `device_passkey_output` (`keccak256(webauthn_public_key)`), it can compute `decryption_key = KDF(device_passkey_output, service_secret)` **entirely on its own**, without the device, the passkey, or biometric auth ever being involved again. This defeats `wallet_backup_and_recovery.md`'s foundational security claim — "neither `device_passkey_output` alone nor `service_secret` alone can reconstruct `decryption_key`" — for every wallet created via the current `setupWallet`. The keyring blob's AES-GCM encryption provides **no protection at all** against the wallet service itself, or against anyone who reads its database (a breach, a subpoena, a malicious operator, a federation peer that receives replicated account state). This is worse than a missing defense-in-depth layer: it's the collapse of the two-party trust boundary the entire backup/recovery design (Steps 2.1–2.5) is built on top of.

The synced-passkey and YubiKey paths (Step 2.3/2.4) do **not** have this flaw: `syncedPasskeyOutputFromPrf`'s input (`prfOutput`) is never transmitted anywhere — `backupRegistration.ts`'s wire body sends only the AES-GCM-wrapped `decryption_key`, never the wrapping key or its ingredients. Only the device-bound passkey's derivation (Step 2.1, unchanged since before this session) has the leak.

**Root cause:** `attestationObject` was chosen for two unrelated purposes by two different, individually-reasonable decisions — `kdf.ts`'s doc comment picked it as "the one field available at registration that's device-bound and secret-ish," while `setupWallet.ts`'s own doc comment (Step 2.1) picked it as a stand-in for a properly-parsed WebAuthn COSE public key to store server-side (explicitly flagged there as a placeholder: *"a real COSE extraction should replace this once Step 2.2 needs to verify against it"*). Neither decision's doc comment cross-referenced the other, so the interaction — the same bytes serving as both "secret KDF input" and "value handed to the party the KDF input must stay secret from" — went unnoticed until this review.

**Recommended fix:** apply the same remediation already used for the synced-passkey path (Step 2.4's PRF fix): derive `device_passkey_output` from `PasskeyProvider.register()`'s `prfOutput` field instead of `attestationObject`, and stop sending anything derived from `prfOutput` to the wallet service. `webauthn_public_key` should carry a properly-parsed COSE public key (or some other value that is *not* the KDF input) — closing Step 2.1's own long-standing placeholder gap at the same time. This requires changing already-shipped, tested Step 2.1 code (`kdf.ts`, `setupWallet.ts`) and touches the wire contract with `wallet-service`'s `POST /accounts`, so it needs the same kind of decision `rotate_service_secret` did before landing.

## Finding 2 (MEDIUM): transient secret material is not consistently zeroed after use

`setupWallet.ts` and `recovery.ts` both zero `masterSecretKey` in a `finally` block (`masterSecretKey.fill(0)`). No other transient `Uint8Array` secret gets the same treatment:

- `decryptionKey` (both files) — used to encrypt/decrypt the keyring blob, then left to fall out of scope.
- `devicePasskeyOutput` (both files), `syncedPasskeyOutput`/`wrappingKey` (`recovery.ts`), the YubiKey-derived wrapping key (`setupWallet.ts`, `recovery.ts`) — same.
- `serviceSecret`/`newServiceSecret` (both files) — same.

None of these are logged or returned, so there's no *exposure* bug here — but relying on V8's garbage collector to eventually overwrite this memory is weaker than the explicit zeroing already applied to `masterSecretKey`, and the inconsistency itself is a code-smell: a future reader has no signal for which secrets need to survive a `.fill(0)` pass and which don't. `crypto/hpke.ts` and `wallet/keyring.ts` have the same gap for their own transient key material (out of this review's stated scope, but the same pattern).

**Recommended fix:** either zero every transient secret Uint8Array in the same `finally` blocks that already exist (cheap, consistent), or explicitly document why `masterSecretKey` alone warrants it (e.g., "it's the one value whose compromise is catastrophic and irreversible, unlike a `decryptionKey` that's rotated on next recovery") if the asymmetry is intentional. Low urgency relative to Finding 1, but worth resolving before CP-2 (pre-production review).

## Finding 3 (LOW/informational): non-master keyring entries would not be zeroed if the keyring ever grows beyond one entry

`recoverWallet` zeroes `masterSecretKey`, which aliases `masterEntry.privateKey` — one element of the `entries` array `decryptKeyring` returns. Today the keyring only ever contains a single entry (the master key; `keyring.ts`'s own doc says so explicitly), so this is currently a non-issue. If a future step appends additional card private keys to the same keyring (the doc comment anticipates this — "later steps... append further entries"), those entries' private keys would not be cleared by the existing `finally` block. Flagging now so it isn't missed when that step lands.

## Finding 4 (informational, not a defect): `cancelRecovery`'s master-key acquisition is an acknowledged open gap

`cancelRecovery` (Step 2.4) takes `masterSecretKey` as a direct parameter rather than deriving it itself — documented at the time as deferring "how does a legitimate holder reconstruct their own master key to authorize a cancellation" to the caller, since no "unlock the wallet again after setup" primitive exists anywhere in the SDK yet. This review didn't find a way to close that gap without building a materially new feature (day-2 wallet unlock), which is out of Steps 2.1–2.5's scope. Re-flagging here so it's visible at the checkpoint rather than only in a code comment.

## Reviewed and found sound

- **AES-GCM wrapping** (`backupRegistration.ts`'s `wrapDecryptionKey`/`unwrapDecryptionKey`, `keyring.ts`'s `encryptKeyring`/`decryptKeyring`): fresh random 12-byte nonce per call, standard authenticated encryption via `@noble/ciphers`, nonce prepended to ciphertext (self-contained blob, no side channel needed). Tag verification failure throws (no silent corruption).
- **`rotate_service_secret: false`** (the wallet-service fix from this session): both call sites that use it are already master-signature-authenticated, so the flag doesn't introduce a new privilege an attacker could reach without already holding the master key — it changes bookkeeping semantics, not the auth boundary.
- **`deregisterSubCard`'s authorization enforcement** (Step 2.5): structural, not a runtime check — the function has no signer parameter other than `masterSecretKey`, so there is no SDK-exposed code path that could construct a deregistration request signed by a sub-card or app key. Confirmed by both a positive test (signature verifies against the master public key, not the sub-card's) and an explicit arity check.
- **`GET /keyrings/{keyring_id}`** being unauthenticated/federation-wide: sound *in isolation* — the blob is meant to be opaque ciphertext recoverable by anyone holding `decryption_key`. Finding 1 above is what actually breaks this property, not the fetch endpoint's lack of auth.

## Caveats

- This review was conducted by the same agent that wrote the code under review, not a second, independent party. `subcards.md`/`wallet_backup_and_recovery.md`'s own framing of CP-1 as an "independent security review" is not fully satisfied by this — a second reviewer (human or a separate agent session with no prior context) re-reading `kdf.ts`, `backupRegistration.ts`, and `recovery.ts` cold would be more likely to catch a Finding-1-shaped issue than the author re-checking their own reasoning.
- `PasskeyProvider`/`YubiKeyProvider` have no concrete hardware-backed implementation yet (both are Phase 1 stubs / Step 2.4 additions with no real WebAuthn PRF or YubiKey backend behind them) — this review covers the SDK's own logic, not real authenticator behavior, since there's nothing concrete to review yet.
- This review does not cover the wallet-service's own handling of `service_secret`/`webauthn_public_key` at rest (envelope encryption, KMS backend posture) — that's CP-2's territory in the wallet-service plan.

## Disposition

Given Finding 1's severity — it collapses the security property Steps 2.1–2.5 were built to establish — this checkpoint should **not** be considered closed, and none of this phase's code should be used against real key material or a production wallet service, until Finding 1 is remediated and re-reviewed (ideally by an actually-independent reviewer, per the caveat above).
