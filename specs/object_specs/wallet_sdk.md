# Card Protocol — `@membership-card-protocol/wallet-sdk` npm Package Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-06
**Status:** Split from unified `client_sdk.md` (Phase 5 milestone) — represents the wallet-side, key-custody half of holder-side functionality

> **Provenance note.** This spec is derived from `specs/object_specs/client_sdk.md` via the split described in `plans/sdk-split-strategic-plan.md`. It represents all holder-side capabilities that require access to the wallet's master key and backup material, plus the authorization/countersigning side of flows that are initiated by App SDK code. This package imports and depends on `@membership-card-protocol/app-sdk`; see that spec for the app-side capabilities.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [Package Structure](#3-package-structure)
4. [Provider Interfaces (Inherited)](#4-provider-interfaces-inherited)
5. [Wallet Setup, Keyring, and Backup/Recovery](#5-wallet-setup-keyring-and-backuprecovery)
   - 5.1 [Key Derivation](#51-key-derivation)
   - 5.2 [Keyring](#52-keyring)
   - 5.3 [setupWallet](#53-setupwallet)
   - 5.4 [Device Sub-Card Registration](#54-device-sub-card-registration)
   - 5.5 [Backup Registration](#55-backup-registration)
   - 5.6 [Recovery and Re-Registration](#56-recovery-and-re-registration)
   - 5.7 [Post-Recovery Sub-Card Deregistration](#57-post-recovery-sub-card-deregistration)
6. [Sub-Card Authorization (Granter-Side)](#6-sub-card-authorization-granter-side)
   - 6.1 [Wallet-Side Validation](#61-wallet-side-validation-implemented)
   - 6.2 [Consent Assembly](#62-consent-assembly-implemented)
   - 6.3 [Countersigning Sub-Card Requests](#63-countersigning-sub-card-requests-implemented)
   - 6.4 [Sub-Card Revocation](#64-sub-card-revocation-implemented)
   - 6.5 [Sub-Card Deregistration](#65-sub-card-deregistration-implemented-ahead-of-schedule)
   - 6.6 [Active Sub-Cards Directory Maintenance](#66-active-sub-cards-directory-maintenance-planned)
7. [Card Offers (Recipient-Side Acceptance)](#7-card-offers-recipient-side-acceptance)
   - 7.1 [Offer Review](#71-offer-review)
   - 7.2 [Countersigning](#72-countersigning)
   - 7.3 [New-Wallet Open-Offer Acceptance](#73-new-wallet-open-offer-acceptance)
   - 7.4 [Existing-Wallet Open-Offer Acceptance](#74-existing-wallet-open-offer-acceptance)
   - 7.5 [Targeted Offer Acceptance](#75-targeted-offer-acceptance)
8. [Messaging Helpers (Active Sub-Card Resolution)](#8-messaging-helpers-active-sub-card-resolution)
   - 8.1 [Resolving Active Sub-Cards from On-Chain Registry](#81-resolving-active-sub-cards-from-on-chain-registry-implemented)
9. [Cross-Platform Hardening and Documentation (Planned)](#9-cross-platform-hardening-and-documentation-planned)
10. [Security Invariants](#10-security-invariants)
11. [Result and Error Conventions](#11-result-and-error-conventions)
12. [Implementation Status](#12-implementation-status)
13. [Dependencies](#13-dependencies)
14. [Resolved Design Decisions](#14-resolved-design-decisions)
15. [Related Specs](#15-related-specs)

---

## 1. Overview

`@membership-card-protocol/wallet-sdk` is the library a wallet integrator (a mobile app that holds cards, a native or web wallet app, or a wallet-service backend) links against to perform on-device functions the protocol specs assign to "the wallet" — the entity that holds custody of the master key. It is the wallet-side counterpart to `@membership-card-protocol/app-sdk` (which it imports and depends on) and together they form the complete holder-side SDK.

This SDK handles:

1. **Master key generation and wallet setup** — creating the initial `decryption_key`, keyring, and backup registrations (passkey and/or YubiKey wrapping).
2. **Keyring and backup/recovery** — encrypting/decrypting the `decryption_key` and card private keys, running the full recovery flow across wallet services and synced passphrases, and re-registering after recovery.
3. **Sub-card request authorization** — validating third-party apps' requests, assembling consent screens, and countersigning authorized requests with the master key.
4. **Card offer acceptance** — reviewing offers (the pre-display verification gate, built on App SDK's `CardVerifier`), generating and persisting new per-card keypairs, countersigning acceptance, and submitting claims to the press.
5. **Sub-card lifecycle** — revoking sub-cards, deregistering them from relay pools, and managing active sub-card state.

**What this SDK explicitly does NOT do:** delegate key custody to any third party; run wallet-service backend endpoints (`plans/wallet-service/`); use the `decryption_key` or master key outside of the functions that directly require them; or expose those keys to untrusted code paths.

**Dependency relationship:** This package imports `@membership-card-protocol/app-sdk`. Every wallet integrator depends on `wallet-sdk` (which transitively brings in `app-sdk`). App-side integrators that do not run wallet code should depend only on `app-sdk`.

---

## 2. Design Principles

**Wallet SDK = App SDK + Key Custody.** This package re-exports every public interface, type, and function from App SDK (provider interfaces, verifier integration, messaging, UUID management) and adds the wallet-specific layer of key generation, backup, recovery, offer review/countersigning, and authorization on top of it. No module is duplicated or reimplemented — App SDK owns offer construction and offerer-side finalization; this package owns offer review and countersigning, in addition to everything else key-custody-related.

**One SDK, two runtimes, no forked protocol logic.** Protocol logic (key derivation, canonicalization, signing order, backup/recovery orchestration) contains no platform branches. Platform differences (passkey APIs, secure enclave access, keyring storage) are isolated behind App SDK's provider interfaces.

**Never leave a private key recoverable-but-unpersisted, or persisted-but-inaccessible.** The master key is a local variable in `setupWallet` and `recoverWallet` only — never returned, never logged, cleared in a `finally` block (§5.3, §5.6). Per-card acceptance keys generated during offer countersigning (§7.2, this package's own `offers/countersign.ts`) go through the recoverable keyring, with a non-exported helper structurally enforcing "persist before sign." Requester-side sub-card keys go through hardware-backed secure storage (App SDK's `SecureKeyProvider`). §10 security invariants list the structural guarantees.

**No independently re-derived trust logic.** Chain walking, revocation checking, policy-compliance evaluation, and app-card certification validation all go through App SDK's shared `CardVerifier` instance; this package never re-derives or duplicates that logic.

**Injected providers for every platform seam.** Six provider interfaces (inherited from App SDK) plus the oblivious-relay transport are the *only* points where platform-specific behavior enters; every other module in this package is pure, platform-independent TypeScript.

---

## 3. Package Structure

*(Restructured as part of the split from unified `client-sdk/`. Module layout builds on App SDK.)*

`wallet-sdk/` is its own pnpm workspace package:

```
@membership-card-protocol/wallet-sdk/     The core, platform-independent package.
                                           Depends on @membership-card-protocol/app-sdk.
```

Core package module layout (`src/`):

```
wallet/       Wallet setup, keyring, backup/recovery, device sub-card, deregistration (§5).
offers/       Offer review (`offerVerification.ts`), countersigning (`countersign.ts`), and all three acceptance paths (§7) — all owned here. Reuses only offer construction and offerer-side press finalization from App SDK.
subcards/     Wallet-side sub-card request validation, consent, and countersigning (§6). Reuses requester-side from App SDK.
(re-exported from app-sdk/)
  providers/  Provider interfaces (§4).
  crypto/     Crypto primitives.
  verification/ CardVerifier factory.
  messaging/  Envelope construction, fan-out, relay lifecycle.
  ...
```

The split preserves the original unified client-sdk's test coverage, with tests redistributed to match capability ownership: wallet-specific tests (setup, backup, recovery, authorization, acceptance) move to wallet-sdk; app-specific tests (offer construction, requester-side requests, messaging fan-out) move to app-sdk.

---

## 4. Provider Interfaces (Inherited)

*(Defined and shipped in App SDK.)*

This package imports all six provider interfaces, the `ObliviousProtocolTransport`, and all other provider-adjacent logic from App SDK. See `app_sdk.md` §4 for the complete interface definitions.

**Key providers for wallet-specific flows:**

- `SecureKeyProvider` — used for the master key's ML-DSA-44 signing during offer countersigning and sub-card authorization (via `masterSecretKey` parameters passed through function signatures).
- `PasskeyProvider` — used by `setupWallet` (§5.3) and `recoverWallet` (§5.6) for passkey-based factors.
- `YubiKeyProvider` — optional, for YubiKey-backed backup wrapping (§5.5) and recovery (§5.6).
- `StorageProvider` — used for keyring and backup state persistence.
- `RealtimeTransportProvider` — used for SSE/WebSocket messaging delivery during active wallet sessions.

Platform-specific default implementations are provided by `@membership-card-protocol/sdk-providers-web` and `@membership-card-protocol/sdk-providers-rn` (renamed from `client-sdk-web`/`client-sdk-rn` as part of the split). Both depend on App SDK, not on this package — this package has no dependency on either platform package, same as App SDK. A wallet integrator depends on this package *and*, separately, on whichever platform package matches its runtime.

---

## 5. Wallet Setup, Keyring, and Backup/Recovery

*(Implemented — Phase 2. Module: `wallet/`.)*

### 5.1 Key Derivation

`wallet/kdf.ts`:

```ts
function deriveDecryptionKey(devicePasskeyOutput: Uint8Array, serviceSecret: Uint8Array): Uint8Array;
function passkeyOutputFromPrf(prfOutput: Uint8Array): Uint8Array;
```

`decryption_key = HKDF-SHA3-256(ikm=devicePasskeyOutput, salt=serviceSecret, info='card-protocol-wallet-decryption-key-v1')` — folding both factors via HKDF's dedicated `salt` slot so neither factor alone can reconstruct the output. `passkeyOutputFromPrf` is `keccak256(prfOutput)`, used for **both** the device-bound passkey's output and the synced-passkey backup wrapping key — the same operation, since a WebAuthn PRF output is what makes either reproducible.

### 5.2 Keyring

`wallet/keyring.ts`: `encryptKeyring(entries, decryptionKey)` / `decryptKeyring(blob, decryptionKey)` — AES-256-GCM, fresh random 12-byte nonce prepended to ciphertext (self-contained blob). `computeKeyringId(blob) = keccak256(blob)`. `KeyringEntry = { cardAddress: string; privateKey: Uint8Array }` — one entry per card private key the holder controls (master key at genesis; per-offer-acceptance keys appended during acceptance flows, §7).

### 5.3 setupWallet

`wallet/setupWallet.ts`:

```ts
function setupWallet<T = void>(options: WalletSetupOptions<T>): Promise<WalletSetupResult<T>>;
```

Implements `wallet_backup_and_recovery.md §Process 1` Steps 1–14 as one continuous function: master ML-DSA-44 keypair generation → device-bound passkey → the two-call `service_secret` bootstrap (`POST /accounts/challenge` → `POST /accounts`) → re-encrypt under the real `decryption_key` → `PUT /accounts/{card_hash}/keyring` with `rotate_service_secret: false` → keyring persistence → synced-passkey backup registration (always) → optional YubiKey backup → device sub-card generation and registration (§5.4).

`decryption_key` and the master private key are local variables scoped to this function's body only — never returned, logged, or exposed. An optional generic `postSetupHook?: (decryptionKey) => Promise<T>` runs inside this same scope, after keyring/backups/sub-card are established but before the master key is cleared — the mechanism that open-offer new-wallet flows (§7.3) use to "invoke wallet setup inline" without duplicating this function or exposing `decryption_key` to a second function.

**Known gap, tracked (found during Step 3.2c scenario testing):** `setupWallet` requires `registration.prfOutput` to be truthy immediately after the device-bound passkey `register()` call, and throws a named error otherwise (`kdf.ts`'s `passkeyOutputFromPrf` has no fallback derivation). The shipped default web `PasskeyProvider` (`sdk-providers-web`'s `WebAuthnPasskeyProvider`) never populates `prfOutput` — see `app_sdk.md` §4.3 for the full gap description. In practice, **`setupWallet` cannot complete against the default web provider today**; a caller must supply a `PasskeyProvider` implementation that actually requests and extracts the WebAuthn PRF extension until `sdk-providers-web` closes this gap. Same applies to `recoverWallet` (§5.6), which has the identical requirement.

### 5.4 Device Sub-Card Registration (Collapsed)

`wallet/deviceSubCard.ts`: `registerDeviceSubCard(options): Promise<DeviceSubCardResult>`

*(Per the strategic plan's resolved decision Split-SDK-3 on the deviceSubCard collapse — implemented.)*

The wallet's own "self-signing" sub-card path, per `subcards.md`'s wallet-self-signing exception — refactored via the collapse decision to avoid duplicating App SDK's request/consent/countersign logic.

**Implementation:** This function is a thin wrapper over App SDK's ordinary request/consent/countersign pipeline:

1. Calls App SDK's `requestSubCard` with the wallet's own master card (`issuer_card`) and app identity, obtaining an `AppSignedSubCardDocument`.
2. Validates the request via this package's own `handleSubCardRequest` (same wallet-side checks any third-party sub-card would go through).
3. Assembles consent via this package's own `assembleSubCardConsent` — the wallet is both requester and granter, so it self-authorizes the request with `decision.approvedCapabilities === requestedCapabilities` (no actual UI/consent step).
4. Countersigns via this package's own `countersignSubCardRequest` with the wallet's `masterSecretKey`.
5. Submits the result via the press-submission path (App SDK's press-registration integration).

The wallet is both requester and granter here, so it avoids the UI consent step but still goes through the ordinary protocol pipeline, not a parallel self-signing shortcut. This ensures the device sub-card's lifecycle is identical to any other sub-card from a protocol perspective — a closed case for protocol-design consistency and security review.

Hardcodes `attestation_level: 'T1'` (no App Attest/Play Integrity attestation provider exists yet).

### 5.5 Backup Registration

`wallet/backupRegistration.ts`: `wrapDecryptionKey`/`unwrapDecryptionKey` (AES-256-GCM, self-contained-blob shape) and `registerBackup(options): Promise<BackupRegistrationResult>` — `POST /accounts/{card_hash}/backups`, Bearer-session-token-authenticated. Both synced-passkey and YubiKey paths wrap `decryption_key` under a wrapping key the wallet service never sees.

### 5.6 Recovery and Re-Registration

`wallet/recovery.ts`, implementing `wallet_backup_and_recovery.md §Process 2a/2b` (synced-passkey / YubiKey recovery) and `§Process 3` (re-registration):

```ts
function initiateRecovery(transport, cardHash, backupId): Promise<InitiateRecoveryResult>;
function cancelRecovery(transport, recoveryId, masterSecretKey): Promise<CancelRecoveryResult>;
function releaseRecoveryKey(transport, recoveryId): Promise<ReleaseRecoveryKeyOutcome>;
function fetchKeyringBlob(transport, keyringId): Promise<Uint8Array>;
function recoverWallet(options: RecoverWalletOptions): Promise<RecoverWalletResult>;
```

`recoverWallet` is the large orchestrator, mirroring `setupWallet`'s structure: unwrap the released `wrapped_blob` → fetch keyring by ID → decrypt → (optionally) batch-deregister previously-active sub-cards (§5.7) → re-register (new device-bound passkey, new `decryption_key`, new `keyring_id`, via the same provisional/final two-call bootstrap §5.3 uses) → new device sub-card.

`cancelRecovery` takes `masterSecretKey` as a direct parameter — this package has no general "unlock the wallet again after initial setup" primitive, so the caller is responsible for however it reconstructs its own master key to authorize a cancellation.

### 5.7 Post-Recovery Sub-Card Deregistration

`wallet/subCardDeregistration.ts` — see §6.5 (built ahead of its originally-planned Phase 4 step, since Phase 2's recovery flow needed it).

---

## 6. Sub-Card Authorization (Granter-Side)

*(Implemented — Phase 4. Module: `subcards/` for the wallet-side authorization path. Reuses App SDK's `requestSubCard` for the requester-side half.)*

### 6.1 Wallet-Side Validation (Implemented)

`subcards/handleSubCardRequest.ts`:

```ts
function handleSubCardRequest(options: HandleSubCardRequestOptions): Promise<HandleSubCardRequestResult>;
```

Per `subcards.md §Sub-Card Request Flow Step 2`: verify `app_signature`; apply keccak256 binding checks (`holder_primary_card_pubkey`, `app_card_pubkey`); confirm the app card's chain reaches the governance app-certification policy root and is currently valid, via App SDK's shared `CardVerifier` (inherited and re-exported). Returns `{ valid: true, request, appCardVerification }` or `{ valid: false, code, reason }` — never a throw for an expected rejection.

**CardVerifier instance decision (re-confirmed):** This function takes a `CardVerifier` as a direct parameter, expecting the caller to pass the **same shared instance** used everywhere else in both SDKs.

No annotation-board check and no attestation-proof verification are in scope.

### 6.2 Consent Assembly (Implemented)

`subcards/consent.ts`:

```ts
function assembleSubCardConsent(options: AssembleSubCardConsentOptions): SubCardConsentData;
```

Assembles the consent screen's data on a successful §6.1 validation: app identity (caller-supplied), `requestedCapabilities` (from the request), `grantableCapabilities` (`requestedCapabilities` intersected with the wallet's own configured capability whitelist), and a caller-supplied `suggestedValidUntil`.

### 6.3 Countersigning Sub-Card Requests (Implemented)

`subcards/countersign.ts`:

```ts
function countersignSubCardRequest(options: CountersignSubCardRequestOptions): Promise<CountersignSubCardRequestOutcome>;
```

Signs the request with the wallet's `masterSecretKey` — producing the `holder_signature` that completes the `SubCardDocument`. **Critical invariant** (from the original spec): requires `decision.approvedCapabilities` to **exactly** match `consentData.requestedCapabilities` — silently narrowing `capabilities` would make the stored document's own `app_signature` fail verification later. Returns `{ countersigned: false, reason }` if the approved set does not match, never a partial signature.

**Self-signing exception:** This module is not used at all when the requesting app is the wallet itself — `wallet/deviceSubCard.ts` (§5.4) handles that entire path via the collapse pattern (calling App SDK's request/consent/countersign back-to-back internally, since the wallet is both requester and granter).

`registerSubCard: RegisterSubCardFn` is an injected stub for real press-submission, standing in until App SDK's `createPressSubCardRegistrar` (`app_sdk.md` §7.3) is wired in as the real implementation.

### 6.4 Sub-Card Revocation (Implemented)

`subcards/revocation.ts`:

```ts
type SubCardRevocationCode = 800 | 801 | 810 | 811;
function revokeSubCard(options: RevokeSubCardOptions): Promise<RevokeSubCardResult>;
```

8xx revocation (`subcard_creation_policy.md §Revocation`; `card_updates.md`) via the general card-update-intent flow. User-initiated (code 801) is signed by the wallet's own device sub-card (via `deviceSubCard.ts`'s routine-signing key); app-initiated (code 811) is signed by the requesting app's own installation card — both expressed as an `UpdateIntentSigner` since the press resolves the signer's actual public key itself.

**Structural 9xx exclusion:** `SubCardRevocationCode` is a literal union of exactly `800 | 801 | 810 | 811` — no value of that type can name a 9xx code, so no caller can construct one even by mistake.

### 6.5 Sub-Card Deregistration (Implemented, Ahead of Schedule)

`wallet/subCardDeregistration.ts` — built during Phase 2 (Step 2.5) since post-recovery batch deregistration needed it:

```ts
function deregisterSubCard(options: DeregisterSubCardOptions): Promise<DeregisterSubCardResult>;
function deregisterSubCardsAfterRecovery(transport, masterSecretKey, previouslyActiveSubCards): Promise<SubCardDeregistrationOutcome[]>;
```

Per `subcards.md §Authorization for Deregistration`: deregistration requires and is signed by the **primary card key only**, structurally enforced — `deregisterSubCard` has no "signer" callback parameter, only a direct `masterSecretKey: Uint8Array` argument, so there is no code path that could sign with anything else.

**Explicitly not sub-card revocation.** This is wallet-service-local UUID pool deregistration (App SDK's concern, §9.6 in app_sdk.md), distinct from 8xx/9xx revocation (this section). A sub-card can be deregistered from the relay pool and then re-registered immediately, with no impact on the sub-card's on-chain status.

### 6.6 Active Sub-Cards Directory Maintenance (Implemented)

*(Codes 510/511 posting; distinct from §8.1's read-only `resolveActiveSubCardTargets` helper.)*

Per `update_codes.md §5xx` and `card_updates.md §Sub-Card Directory Updates`: the holder posts code-510 (add) and code-511 (remove) update-intent entries against their own master card to maintain the `active_subcards` field. Both are implemented via two exported functions in `subcards/activeSubcardsUpdate.ts`:

```ts
function postSubCardAddedToDirectory(options: PostSubCardAddedOptions): Promise<ActiveSubcardsUpdateResult>;
function postSubCardRemovedFromDirectory(options: PostSubCardRemovedOptions): Promise<ActiveSubcardsUpdateResult>;
```

Both:
- **Sign with the master key only** — `masterSecretKey: Uint8Array` is a direct parameter (no injectable signer callback), mirroring `deregisterSubCard`'s structural enforcement of primary-key-only signing.
- **Use the `POST /update` code-update-intent path** — same transport pattern as §6.4's `revokeSubCard`, with `field_updates: [{ field: 'active_subcards', value: <full new array> }]` payload shape per the spec.
- **Target the master card itself** — `target_card === updater_card`, both pointing at the holder's own card.

Code-510 appends one pubkey; code-511 filters out exactly one pubkey (no-op if absent, allowing idempotent resubmission). Code-512 (atomic rotation) is out of scope for this step.

**Caller-composes-explicitly:** These two primitives exist and are exported for direct caller use. Callers that want to maintain `active_subcards` must explicitly invoke these functions alongside registration/deregistration flows — they are not implicitly wired in. This is the same composition pattern used elsewhere in this package (e.g., `deregisterSubCardsAfterRecovery` in §6.5 composes multiple primitives explicitly).

This capability is distinct from — and a prerequisite for making non-trivial — this package's own `resolveActiveSubCardTargets` (§8.1): §8.1 only *reads* `active_subcards`, whereas this section *writes* it. Until callers wire in explicit use of these functions, `active_subcards` is not reliably populated.

---

## 7. Card Offers (Recipient-Side Acceptance)

*(Implemented — Phase 3. Module: `offers/`.)*

### 7.1 Offer Review

`offers/offerVerification.ts`: `reviewTargetedOffer` / `reviewOpenOffer` — the pre-display verification gate. This module is fully owned by this package — per `plans/sdk-split-strategic-plan.md` line 60's capability table ("Offer review + countersign + acceptance (recipient side)" → Wallet SDK) and `plans/sdk-split-implementation-plan.md` Step 2.3's salvage list, which explicitly names `offers/offerVerification.ts` as a Wallet SDK module (Step 2.2's App SDK salvage list does not include it). Per the original `client_sdk.md` §8.2:

1. keccak256 binding check (`ancestry_pubkeys[0]`/`issuer_card` for targeted offers; `issuer_pubkey`/`issuer_card` for open offers).
2. `issuer_signature` verification.
3. Chain-reaches-trusted-root and revocation status, via App SDK's `CardVerifier.verifyCard()` (`app_sdk.md` §6).
4. Authoritative on-chain press authorization via `RpcProvider.getPressAuthorization`, with the policy's `approved_presses` as an advisory-only cross-check.

Every code path returns `{ approved: true, offer, issuerVerification, pressAdvisoryWarning? }` or `{ approved: false, code, reason }` — never a partially-populated offer object, and never an uncaught exception. This package imports App SDK's `CardVerifier` factory to build the verifier instance passed into these functions, but the review logic itself — including the two binding checks and the on-chain press-authorization call — lives here, not in App SDK.

### 7.2 Countersigning

Offer *countersigning* (generating a new per-card keypair, persisting it, and signing the acceptance) is fully owned by this package — `offers/countersign.ts` is a Wallet SDK module, not an App SDK one, per `plans/sdk-split-strategic-plan.md`'s capability table and `plans/sdk-split-implementation-plan.md` Step 2.3's salvage list. It exports a **non-exported** internal helper that enforces the "persist before sign" invariant structurally: generate a fresh, in-memory (not `SecureKeyProvider` — this key must be backup-recoverable) ML-DSA-44 keypair, decrypt the current keyring via caller-supplied `decryptionKey`, append the new entry, re-encrypt, and `await` a `StorageProvider.set` — only then returning the keypair to the calling function for signing. Since the helper is not exported, there is no code path in this package that can produce a countersignature without a prior confirmed keyring write. This package wraps that helper for each acceptance path (§7.3–7.5):

```ts
function acceptTargetedOfferAndCountersign(approved: ApprovedTargetedOffer, keyringWrite: KeyringWriteOptions): Promise<AcceptTargetedOfferResult>;
function acceptOpenOfferAndCountersign(approved: ApprovedOpenOffer, keyringWrite: KeyringWriteOptions): Promise<AcceptOpenOfferResult>;
```

Both require an already-`review*`-approved input type (from this package's own §7.1 functions), not a raw offer.

### 7.3 New-Wallet Open-Offer Acceptance

`offers/newWalletOpenOfferAcceptance.ts`: `acceptOpenOfferForNewWallet(options): Promise<AcceptOpenOfferForNewWalletResult>` — `open_offer_acceptance_new_wallet.md` end-to-end: offer review (§7.1) → wallet setup (§5.3, invoked via `setupWallet`'s `postSetupHook`) → countersign (§7.2) → `POST /open-offer/claim` (via App SDK's oblivious transport) → SCIP. A rejected offer never triggers wallet setup or any network side effect.

### 7.4 Existing-Wallet Open-Offer Acceptance

`offers/existingWalletOpenOfferAcceptance.ts`: `acceptOpenOfferForExistingWallet(options): Promise<AcceptOpenOfferForExistingWalletResult>` — `open_offer_acceptance_existing_wallet.md` end-to-end: offer review (§7.1) → countersign (§7.2, keyring update only) → claim submission. No `passkeyProvider` field exists on this function's option surface (structural guarantee against creating a second passkey); `decryptionKey` is a required direct parameter this module never derives itself.

### 7.5 Targeted Offer Acceptance

`offers/targetedOfferAcceptance.ts` — the recipient-side half, implementing `card_offering_and_acceptance.md §Phase 5–6`:

```ts
function acceptTargetedOffer(options): Promise<TargetedOfferAcceptanceResult>;
```

Review (via this package's own `reviewTargetedOffer`, §7.1) + countersign (via this package's own `offers/countersign.ts`, §7.2). Returns the countersigned card for out-of-band delivery back to the offerer. The offerer then calls App SDK's `forwardCountersignedTargetedOffer` (app_sdk.md §8.2) to finalize with the press.

---

## 8. Messaging Helpers (Active Sub-Card Resolution)

*(Implemented — salvaged from `client-sdk-old` during the split's platform-package reconciliation step, having been built ahead of the original spec's own schedule the same way §6.5's deregistration was. Module: `messaging/`.)*

### 8.1 Resolving Active Sub-Cards from On-Chain Registry (Implemented)

```ts
function resolveActiveSubCardTargets(masterCard: CardDocument): SubCardMessageTarget[];
// SubCardMessageTarget = { pubkey: string; address: string /* keccak256(pubkey), lowercase hex without 0x prefix */ }
```

Given an already-decrypted master `CardDocument`, reads `active_subcards` (`protocol-objects.md §1.1`) and returns one `SubCardMessageTarget` per entry, deriving `address = keccak256(pubkey)` for each. `pubkey` is the base64url-encoded public key exactly as stored in `active_subcards`, not raw bytes — matching how every other signature/pubkey field in this SDK's protocol documents is represented on the wire. A card with no `active_subcards` field, or a non-array value in that field, returns `[]` rather than throwing.

This function bridges wallet state (master card ownership) with App SDK's `fanOutMessageToSubCards` (app_sdk.md §9.1) — a wallet can pass `resolveActiveSubCardTargets(masterCard)` directly as the `subCards` parameter to fan-out a message to all active sub-cards.

This is the **read side** of the `active_subcards` directory only. §6.6's code-510/511 posting gap (the **write side**, maintaining `active_subcards` on registration/deregistration) is still planned — until it's closed, `active_subcards` is not reliably populated in practice, even though this read-side helper itself is complete and tested. Both sides are tracked together in `subcard-registry-implementation-plan.md` Steps 4.1–4.2.

---

## 9. Cross-Platform Hardening and Documentation (Planned)

*(Implementation-plan Phase 6. Not yet started.)*

Will cover: running every prior phase's scenario against real (non-stub) local wallet-service/press instances on both platforms; integrator documentation (README, per-provider guides, worked examples); and Clarification Checkpoint CP-2, a pre-production security review — covering the persist-before-sign invariant's bypass-resistance, the master key's confinement to `setupWallet`/`recoverWallet`, the sub-card 9xx-exclusion and primary-key-only-deregistration checks, and confirming no transient secrets appear in any log output.

---

## 10. Security Invariants

Cross-cutting properties this package maintains:

- **`decryption_key` and the master private key never cross a function's return boundary.** `setupWallet` and `recoverWallet` are the *only* functions that ever hold them, and both clear the master key in a `finally` block. Every other function that needs `decryption_key` or `masterSecretKey` (e.g., offer countersigning, sub-card authorization) receives it as a direct parameter from a caller that obtained it some other way — this package has no general "unlock the wallet again after initial setup" primitive (documented gap, not silently assumed away).
- **Persist before sign**, for every per-card keypair generated during offer acceptance — structurally enforced via a non-exported helper in this package's own `offers/countersign.ts` (§7.2), not a call-site convention and not imported from App SDK.
- **No verification logic is re-derived outside `CardVerifier` calls** — chain walking, revocation checking, and policy-compliance evaluation are delegated to the shared verifier instance inherited from App SDK.
- **No key derivation input is ever also transmitted to a party the derivation must stay secret from.** The `passkeyOutputFromPrf` correction from the unified spec's CP-1 security review — neither the device passkey's PRF output nor the synced-passkey PRF output is ever sent to the wallet service or any other server (§5.1 reiterates this property).
- **Deregistration requires the primary card key, structurally, not just by policy** (§6.5) — no signer-substitution is possible via any exported function's type signature.
- **`SecureKeyProvider` never returns private key material**, on any platform — requester-side sub-card keys (App SDK) and master key usage (this package) both go through hardware-backed or scoped-local key material.

Two lower-severity, explicitly tracked gaps from the CP-1 review (not yet closed): transient secrets other than the master key (`decryptionKey`, wrapping keys, `serviceSecret`) are not explicitly zeroed after use in every function that handles them (relies on GC); and if the keyring ever grows to hold more than one entry that needs clearing on a given code path, only the entry aliased by whatever local variable gets `.fill(0)`-ed is actually cleared.

---

## 11. Result and Error Conventions

Functions that gate on a verification step return a discriminated union (`{ approved: true, ... } | { approved: false, code, reason }`) rather than throwing on an expected rejection condition. A thrown exception is reserved for conditions the caller could not have anticipated from the inputs alone (network/transport failure, a malformed response) — even a `CardVerifier` internal error is caught and surfaced as a typed rejection, so callers can pattern-match on outcome rather than wrapping every call in `try`/`catch`.

---

## 12. Implementation Status

| Phase | Step | Status |
|---|---|---|
| 1 | 1.1–1.7 (workspace, providers, crypto, verifier, transport, platform defaults, CI) | **Implemented** |
| 2 | 2.1 Wallet setup | **Implemented** |
| 2 | 2.2 Device sub-card (collapsed, thin wrapper over App SDK's `requestSubCard`) | **Implemented** |
| 2 | 2.3 Backup registration | **Implemented** |
| 2 | 2.4 Recovery and re-registration | **Implemented** |
| 2 | 2.5 Post-recovery deregistration | **Implemented** |
| 2 | CP-1 security review | **Done** — critical finding fixed; two lower-severity findings tracked open |
| 3 | 3.2 Offer review (`offers/offerVerification.ts`, wallet-owned) | **Implemented** |
| 3 | 3.3 Countersigning (`offers/countersign.ts`, wallet-owned) | **Implemented** |
| 3 | 3.4 New-wallet open-offer acceptance | **Implemented** |
| 3 | 3.5 Existing-wallet open-offer acceptance | **Implemented** |
| 3 | 3.6 Targeted offer acceptance (recipient side) | **Implemented** |
| 4 | 4.2 Wallet-side validation | **Implemented** |
| 4 | 4.3 Consent structure + countersigning | **Implemented** |
| 4 | 4.4 Sub-card revocation (8xx codes) | **Implemented** |
| 4 | Milestone review | **Done** |
| 5 | — (messaging/UUID delivery is App SDK responsibility) | **Implemented in App SDK** |
| 5 | Milestone review | **Done** |
| 6 | 6.1–6.3 + CP-2 (cross-platform hardening, docs, pre-production review) | **Not started** |
| — | §6.6 `active_subcards` directory maintenance (code-510/511 posting, caller-composed) | **Implemented** |
| — | §8.1 `resolveActiveSubCardTargets` helper (read side) | **Implemented** — salvaged during Step 2.4 platform-package reconciliation |

As of this writing: 243 tests pass in the original unified client-sdk; the split preserves this test count, redistributing by capability ownership.

---

## 13. Dependencies

| Package | Used for |
|---|---|
| `@membership-card-protocol/app-sdk` | Provider interfaces, `CardVerifier` factory, offer construction, offerer-side press finalization, messaging, UUID/relay, sub-card request (requester side), sub-card press submission, crypto primitives |
| `@noble/post-quantum` | ML-DSA-44 (via app-sdk, used directly for master key operations) |
| `@noble/hashes` | keccak256, HKDF-SHA3-256 (via app-sdk, used directly for KDF) |
| `@noble/ciphers` | AES-256-GCM (keyring, backup wrapping) |
| `@membership-card-protocol/verifier` | `CardVerifier` (inherited from app-sdk) |
| `@membership-card-protocol/verifier-ipfs-provider` | Default `IpfsProvider` (inherited from app-sdk) |
| `@react-native-async-storage/async-storage` (RN only, via platform package) | Default `StorageProvider` |
| `react-native-keychain` (RN only, via platform package) | Default `SecureKeyProvider` |
| `react-native-passkey` (RN only, via platform package) | Default `PasskeyProvider` |
| `react-native-sse` (RN only, via platform package) | Default `RealtimeTransportProvider`'s SSE half |

No bundled RPC client is included — `RpcProvider` is always host-app-supplied.

---

## 14. Resolved Design Decisions

Carried forward from `plans/sdk-split-strategic-plan.md`'s resolved decisions and `plans/client-sdk/strategic-plan.md`'s open questions; treated as fixed unless a later phase surfaces a reason to revisit.

| ID | Decision |
|---|---|
| OQ-SDK-1 | Web `SecureKeyProvider`: non-extractable WebCrypto `CryptoKey` in IndexedDB (software-only, disclosed gap vs. native). |
| OQ-SDK-2 | RN `PasskeyProvider`: injected; `react-native-passkey` shipped default. |
| OQ-SDK-3 | RN realtime transport: default RN SSE implementation shipped; `GET /pending` remains catch-up path on both platforms. |
| OQ-SDK-4 | Network-level privacy: oblivious-relay (HPKE + relay forwarding), not Tor. |
| OQ-SDK-5 | Local persistence: `StorageProvider`; IndexedDB (web), AsyncStorage (RN). |
| OQ-SDK-6 | Verifier dependency: `@membership-card-protocol/verifier` consumed as a normal pinned npm dependency. |
| OQ-SDK-7 | Wallet-service federation: single preferred base URL per SDK configuration; no peer-list/retry logic. |
| OQ-SDK-8 | Multi-tab coordination: `BroadcastChannel`-based on web; not applicable on RN. |
| OQ-SDK-10 | Requester-side sub-card flow: in scope (App SDK §7.1). Requester and granter both run this SDK (granter as Wallet SDK). |
| OQ-SDK-11 | Annotation-board integration: out of scope. `fetchAnnotations: false` throughout. |
| Split-SDK-2 | Server-side keystore: interface only in App SDK. Server integrators supply their own `SecureKeyProvider` backing. |
| Split-SDK-3 | Device sub-card collapse: Wallet SDK's device sub-card registration is a thin wrapper calling App SDK's `requestSubCard` + self-authorizing consent/countersign internally. |
| Split-SDK-4 | YubiKeyProvider placement: interface stays in App SDK for consistency; only Wallet SDK actually uses it (backup path). |

---

## 15. Related Specs

- `specs/process_specs/card_offering_and_acceptance.md`, `open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md` — §7
- `specs/process_specs/wallet_backup_and_recovery.md` — §5
- `specs/subcards.md`, `specs/process_specs/subcard_creation_policy.md` — §6
- `specs/object_specs/card_verifier.md` — verifier integration (inherited from App SDK)
- `specs/object_specs/app_sdk.md` — app-side (non-custody) counterpart; this package imports it
- `specs/object_specs/press.md` — the press-side counterpart
- `specs/ARCHITECTURE.md` — ADR-004 (canonicalization/signing), ADR-006 (content encryption), ADR-007 (OHTTP), ADR-009 (keyring storage)
- `plans/sdk-split-strategic-plan.md` — the source plan for this split
- `plans/client-sdk/strategic-plan.md`, `plans/client-sdk/implementation-plan.md` — the unified-SDK plans both packages derive from
