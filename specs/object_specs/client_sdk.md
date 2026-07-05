# Card Protocol — `@membership-card-protocol/client-sdk` npm Package Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-04
**Status:** Draft — written after Phases 1–3 and Step 4.1 of implementation; reflects code as built plus the remaining planned surface from `plans/client-sdk/strategic-plan.md` and `plans/client-sdk/implementation-plan.md`

> **Provenance note.** Unlike this repo's other `object_specs/` entries, no pre-existing spec defined "the client SDK" as a first-class object — the process specs (`card_offering_and_acceptance.md`, `open_offer_acceptance_*.md`, `wallet_backup_and_recovery.md`, `subcards.md`, `messaging_protocol.md`, `notification_relay.md`, `message_routing.md`) describe behavior in terms of roles ("the client," "the wallet," "the holder's device"), not in terms of this package. This document consolidates those role-level requirements, as implemented (or planned) by `client-sdk/`, into one reference — it does not introduce new protocol behavior beyond what those specs and `plans/client-sdk/{strategic,implementation}-plan.md` already establish. Sections are marked **Implemented** or **Planned** throughout; see §14 for a step-by-step status table.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Design Principles](#2-design-principles)
3. [Package Structure](#3-package-structure)
4. [Provider Interfaces](#4-provider-interfaces)
   - 4.1 [StorageProvider](#41-storageprovider)
   - 4.2 [SecureKeyProvider](#42-securekeyprovider)
   - 4.3 [PasskeyProvider](#43-passkeyprovider)
   - 4.4 [YubiKeyProvider](#44-yubikeyprovider)
   - 4.5 [RealtimeTransportProvider](#45-realtimetransportprovider)
   - 4.6 [MultiInstanceLock](#46-multiinstancelock)
   - 4.7 [ObliviousProtocolTransport](#47-obliviousprotocoltransport)
5. [Crypto and Canonicalization Core](#5-crypto-and-canonicalization-core)
6. [Verifier Integration](#6-verifier-integration)
7. [Wallet Setup, Keyring, and Backup/Recovery](#7-wallet-setup-keyring-and-backuprecovery)
   - 7.1 [Key Derivation](#71-key-derivation)
   - 7.2 [Keyring](#72-keyring)
   - 7.3 [setupWallet](#73-setupwallet)
   - 7.4 [Device Sub-Card](#74-device-sub-card)
   - 7.5 [Backup Registration](#75-backup-registration)
   - 7.6 [Recovery and Re-Registration](#76-recovery-and-re-registration)
   - 7.7 [Post-Recovery Sub-Card Deregistration](#77-post-recovery-sub-card-deregistration)
8. [Card Offers](#8-card-offers)
   - 8.1 [Offer Construction](#81-offer-construction)
   - 8.2 [Offer Verification](#82-offer-verification)
   - 8.3 [Countersigning](#83-countersigning)
   - 8.4 [New-Wallet Open-Offer Acceptance](#84-new-wallet-open-offer-acceptance)
   - 8.5 [Existing-Wallet Open-Offer Acceptance](#85-existing-wallet-open-offer-acceptance)
   - 8.6 [Targeted Offer Acceptance and Press Finalization](#86-targeted-offer-acceptance-and-press-finalization)
9. [Sub-Cards](#9-sub-cards)
   - 9.1 [Requester-Side Request](#91-requester-side-request-implemented)
   - 9.2 [Wallet-Side Validation](#92-wallet-side-validation-implemented)
   - 9.3 [Consent and Countersigning](#93-consent-and-countersigning-implemented)
   - 9.4 [Press Submission and Revocation](#94-press-submission-and-revocation-implemented)
   - 9.5 [Deregistration](#95-deregistration-implemented-ahead-of-schedule)
10. [Messaging and UUID/Relay Management](#10-messaging-and-uuidrelay-management)
    - 10.1 [Message Envelope Construction and Per-Subcard Fan-out](#101-message-envelope-construction-and-per-subcard-fan-out-implemented)
    - 10.2 [Inbound Message Verification and Decryption](#102-inbound-message-verification-and-decryption-implemented)
    - 10.3 [UUID Registration, Session Separation, and Staggering](#103-uuid-registration-session-separation-and-staggering-implemented)
    - 10.4 [Replenishment Scheduling](#104-replenishment-scheduling-planned)
    - 10.5 [Realtime Delivery](#105-realtime-delivery-planned)
    - 10.6 [UUID Pool Deregistration](#106-uuid-pool-deregistration-planned)
11. [Cross-Platform Hardening and Documentation (Planned)](#11-cross-platform-hardening-and-documentation-planned)
12. [Security Invariants](#12-security-invariants)
13. [Result and Error Conventions](#13-result-and-error-conventions)
14. [Implementation Status](#14-implementation-status)
15. [Dependencies](#15-dependencies)
16. [Resolved Design Decisions](#16-resolved-design-decisions)

---

## 1. Overview

`@membership-card-protocol/client-sdk` is the library a website frontend or React Native app links against to perform every on-device function the protocol specs assign to "the client" or "the holder's device." It is the holder-side counterpart to the wallet-service backend (`plans/wallet-service/`) and the press (`press/`): those services implement the always-online, server-side half of each flow; this SDK implements the holder-side half — key generation, local key storage orchestration, offer review and countersigning, keyring encryption, sub-card lifecycle, and (planned) message encryption and relay/UUID bookkeeping.

Functional areas, per `strategic-plan.md`'s scoping:

1. **Card offer creation and acceptance** — targeted and open-offer, including every keypair generation each flow requires (fresh per-card keypair, device sub-card keypair, master keypair at first setup). **Implemented.**
2. **Backup encryption, sending, and retrieval** — wrapping the keyring decryption key under a synced passkey and/or YubiKey, registering with the backup service, and running the recovery flow. **Implemented.**
3. **Requesting, accepting, and revoking sub-cards** — both directions the wallet plays: acting as *a* requesting app (the wallet's own device sub-card, self-signing path) and acting as *the* wallet of record for third-party apps' sub-card requests (validate, consent, countersign, revoke/deregister). **Partially implemented** — see §9.
4. **Sending and receiving messages**, including UUID pool lifecycle management for private relay delivery. **Planned** — see §10.

A fifth, cross-cutting area is treated as first-class scope, not an add-on: **verification is delegated to `@membership-card-protocol/verifier`** (§6) — this package never reimplements chain-walking, revocation checking, or policy-compliance evaluation.

A sixth, cross-cutting concern applies to nearly every wallet-service- and press-facing call: **the device must be able to talk to its wallet service, and directly to a press during card creation and updates, without either operator learning the device's network identity.** This is the oblivious-relay transport (§4.7).

**What this SDK explicitly does NOT do:** hold any card holder's private key on a server, run the wallet service's routing/backup/relay endpoints (`plans/wallet-service/`, `relay/`), or perform press-side validation (`press/`). Every function in this package executes inside the holder's browser tab or the RN app process.

---

## 2. Design Principles

**One SDK, two runtimes, no forked protocol logic.** Protocol logic (canonicalization, signing order, key derivation, envelope construction) contains no platform branches. The only things that legitimately differ between web and React Native are I/O primitives — secure key storage, platform passkey/WebAuthn APIs, realtime transport — isolated behind injected provider interfaces (§4), the same architectural pattern `@membership-card-protocol/verifier` already uses for `RpcProvider`/`IpfsProvider`.

**Persist before sign.** Every flow that mints a new per-card keypair writes it into the recoverable keyring, with the write confirmed, *before* producing any signature with that key — enforced structurally (§7.3, §8.3), not left as a convention for call sites to remember.

**No independently re-derived trust logic.** Chain walking, revocation checking, and policy-compliance evaluation always go through a shared `CardVerifier` instance (§6); this package never re-implements or duplicates that logic, including for the app-card certification chain a sub-card request must satisfy (§9.2).

**Injected providers for every platform seam.** Six provider interfaces (§4.1–4.6) plus the oblivious-relay transport (§4.7) are the *only* points where platform-specific or transport-specific behavior enters; every other module in this package is pure, platform-independent TypeScript.

**Never leave a private key recoverable-but-unpersisted, or persisted-but-inaccessible.** Per-card keys (offer acceptance, sub-card requests) go through the recoverable keyring; the device sub-card key and any requester-side sub-card key go through hardware-backed, non-exportable secure storage. Neither kind of key is ever returned from any SDK-facing API as raw private-key material, and the wallet's `decryption_key` / master private key never cross a function's return boundary (§12).

---

## 3. Package Structure

*(Implemented — Phase 1, Step 1.1.)*

`client-sdk/` is its own pnpm workspace, mirroring `membership_card_verifier/`'s conventions:

```
client-sdk/
  packages/
    client-sdk/        @membership-card-protocol/client-sdk — the core, platform-independent package.
                        Includes the oblivious-relay transport (implemented once, shared across platforms).
    client-sdk-web/     Web default provider implementations.
    client-sdk-rn/      React Native default provider implementations.
```

Core package module layout (`packages/client-sdk/src/`):

```
providers/    Provider interfaces (§4) — contracts only, no implementations.
transport/    ObliviousProtocolTransport's implementation (§4.7).
crypto/       ML-DSA-44, ML-KEM-768, HPKE, keccak256/HKDF-SHA3-256, RFC 8785 canonicalization (§5).
verification/ CardVerifier factory (§6).
wallet/       Wallet setup, keyring, backup/recovery, device sub-card, deregistration (§7).
offers/       Offer construction, verification, countersigning, and all three acceptance paths (§8).
subcards/     General (non-wallet-self-signing) sub-card request flow (§9).
util/         base64url encode/decode.
testing/      Shared provider-contract test suite and cross-platform scenario harness.
```

TypeScript, ESLint, Vitest are configured per package, matching `membership_card_verifier`'s conventions. `packages/client-sdk-web` uses Vitest under a browser-like environment; `packages/client-sdk-rn` uses Jest with an RN preset.

---

## 4. Provider Interfaces

*(Implemented — Phase 1, Step 1.2; default implementations Steps 1.5/1.6.)*

Every interface is exported from `packages/client-sdk/src/providers/`, with a shared provider-contract test suite (`src/testing/providerContracts.ts`) that both platforms' default implementations, and any host-app-supplied implementation, are expected to pass.

### 4.1 StorageProvider

```ts
interface StorageProvider {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Every module needing durable local state (cached encrypted keyring, per-subcard UUID pools, message history — once §10 is built) goes through an instance of this interface. **Defaults:** IndexedDB on web; `@react-native-async-storage/async-storage` on RN (chosen over MMKV/SQLite for exact key-value fit and an officially maintained Jest mock — see that file's doc comment for the full evaluation).

### 4.2 SecureKeyProvider

```ts
interface SecureKeyProvider {
  generateKey(keyId: string): Promise<Uint8Array>;                    // returns public key only
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  getPublicKey(keyId: string): Promise<Uint8Array | undefined>;
  delete(keyId: string): Promise<void>;
}
```

Hardware-backed (or platform-equivalent) non-exportable ML-DSA-44 keys. No method returns private key material under any circumstance — this is the structural guarantee `subcards.md §Sub-Card Key Management`'s non-exportability requirement rests on. Used for the device sub-card key (§7.4) and the requester-side sub-card key (§9.1) — never for per-card acceptance keys, which belong in the recoverable keyring instead (§2, §12). **Defaults:** non-extractable WebCrypto `CryptoKey` in IndexedDB on web (disclosed software-only posture, OQ-SDK-1); Secure Enclave (iOS) / StrongBox-backed `AndroidKeyStore` (Android) via `react-native-keychain` on RN.

### 4.3 PasskeyProvider

```ts
interface PasskeyProvider {
  register(challenge: Uint8Array): Promise<{
    credentialId: Uint8Array;
    attestationObject: Uint8Array;
    clientDataJSON: Uint8Array;
    prfOutput?: Uint8Array;
  }>;
  assert(challenge: Uint8Array, credentialId?: Uint8Array): Promise<{
    credentialId: Uint8Array;
    authenticatorData: Uint8Array;
    clientDataJSON: Uint8Array;
    signature: Uint8Array;
    prfOutput?: Uint8Array;
  }>;
}
```

Abstracts WebAuthn registration/assertion. `prfOutput` (the WebAuthn PRF extension's evaluated output) is required in practice — `setupWallet` and `recovery.ts` throw if a `PasskeyProvider` implementation omits it — because it is the only value from either ceremony that is (a) never transmitted to the wallet service and (b) reproducible from a later `assert()` against the same credential. This was a mid-Phase-2 correction: an earlier design derived key material from `attestationObject`, which is also submitted to the wallet service as `webauthn_public_key`, undermining the "neither factor alone suffices" security property (see §12, and `plans/client-sdk/milestones/cp1-security-review.md`). **Defaults:** `navigator.credentials` on web; `react-native-passkey` on RN.

### 4.4 YubiKeyProvider

```ts
interface YubiKeyProvider {
  deriveWrappingKey(pin: string): Promise<Uint8Array>;
}
```

Added in Phase 2 Step 2.3 (not part of Phase 1's original six providers) for the opt-in YubiKey backup path (§7.5, §7.6). No concrete hardware-backed implementation exists yet on either platform — both platform packages currently only implement the six Phase 1 providers; a real `YubiKeyProvider` (host-app-supplied or a future companion package) is expected to be injected by whichever app wants to offer this path.

### 4.5 RealtimeTransportProvider

SSE-shaped subscribe/unsubscribe plus WebSocket connect, abstracting native `EventSource`/`WebSocket` (web) vs. RN equivalents (`react-native-sse` + native `WebSocket` on RN). Consumed by §10 (messaging), which is planned but not yet implemented; the interface and both platform defaults exist today.

### 4.6 MultiInstanceLock

Acquire/release a named lock. **Defaults:** `BroadcastChannel`-based on web (multi-tab coordination, OQ-SDK-8); a no-op on RN (single-foreground-instance model has no equivalent to coordinate).

### 4.7 ObliviousProtocolTransport

```ts
type ObliviousDestination = { kind: 'wallet_service' } | { kind: 'press'; baseUrl: string };

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Uint8Array;
  headers?: Record<string, string>;
  bypass?: boolean;   // direct HTTPS, for testing and explicit host-app opt-out
}

interface ObliviousResponse { status: number; headers: Record<string, string>; body: Uint8Array; }

interface ObliviousProtocolTransport {
  request(destination: ObliviousDestination, options: RequestOptions): Promise<ObliviousResponse>;
}
```

The oblivious-relay-backed HTTP client used for **every** wallet-service-facing call (account creation, `service_secret` retrieval, keyring operations, backup/recovery, sub-card registration/deregistration, and — once §10 lands — UUID registration) and **every** press-facing sensitive/state-changing call (claim submission, offer finalization, update/revocation intents, sub-card registration/deregistration submission). Implemented once, in the core package (pure HTTP + HPKE, RFC 9180 — no platform-specific implementation needed): HPKE-encapsulates the request to the destination's published OHTTP key configuration, POSTs the opaque blob to the relay's oblivious-forwarding endpoint (`relay/`, a separate codebase this plan also touched — see `plans/client-sdk/implementation-plan.md` Step 1.4b), and decapsulates the response. `{ kind: 'wallet_service' }` resolves to a single fixed base URL per SDK configuration (OQ-SDK-7 — no federation-peer routing in this package); `{ kind: 'press', baseUrl }` is resolved per call, since a policy may name multiple approved presses.

The oblivious path is the default for every sensitive call — there is no separate "enable privacy mode" step. `bypass: true` exists for testing and for the press's public read endpoints (`/press`, `/health`, `/app-gas/:address`), which never go through this transport at all.

Server-side counterparts (also implemented, in their own codebases, not part of this package): `relay/server/api/ohttp/[target_id].post.ts` (stateless pass-through forwarding), `wallet-service/server/routes/ohttp/{key-config,gateway}.*.ts`, `press/server/api/ohttp/{key-config,gateway}.*.ts`.

---

## 5. Crypto and Canonicalization Core

*(Implemented — Phase 1, Step 1.3.)*

Thin wrappers, no independent implementation of any primitive:

| Function | Backing library | Used for |
|---|---|---|
| `canonicalize(obj)` | Vendored ~30-line RFC 8785 implementation, tested byte-identical against the verifier package's own copy | Every signed payload in this package |
| `keccak256(bytes)` | `@noble/hashes` | Address derivation (`address = keccak256(pubkey)`), binding checks |
| `hkdfSha3256(ikm, info, length?)` | `@noble/hashes` | General-purpose HKDF-SHA3-256 (content-key derivation shape; the wallet KDF, §7.1, calls the underlying primitive directly instead, for its dedicated-`salt` construction) |
| `mlDsa44GenerateKeypair` / `mlDsa44Sign` / `mlDsa44Verify` / `mlDsa44GetPublicKey` | `@noble/post-quantum` | Every ML-DSA-44 signing operation in this package |
| `mlKem768GenerateKeypair` / `mlKem768Encapsulate` / `mlKem768Decapsulate` | `@noble/post-quantum` | ML-KEM-768 (consumed by §10 once messaging is built; primitives exist today) |
| `hpkeGenerateKeyConfig` / `hpkeSeal` / `hpkeOpen` | `hpke-js` (RFC 9180) | `ObliviousProtocolTransport` (§4.7) |

Canonicalization output is tested against `specs/serialization-conformance.json` — the same conformance corpus the verifier package tests against — so the two never silently diverge.

---

## 6. Verifier Integration

*(Implemented — Phase 1, Step 1.4.)*

```ts
function createCardVerifier(options: CreateCardVerifierOptions): CardVerifier;
```

`CreateCardVerifierOptions` is `VerifierConfig` (from `@membership-card-protocol/verifier`) with `ipfs` optional, defaulting to `FilebaseIpfsProvider` from `@membership-card-protocol/verifier-ipfs-provider`. `rpc` is always required and host-app-supplied — this package never bundles a chain client. One `CardVerifier` instance is constructed per distinct trust-root configuration a caller needs and reused across calls, mirroring `press.md §5.0`'s pattern exactly. Every point in the specs where this package must verify something before displaying or trusting it — offer issuer chain (§8.2), press on-chain authorization (§8.2), and (once built) message sender chain, app-card certification chain for sub-card requests (§9.2) — calls `verifier.verifyCard()` or `verifier.verifyEnvelope()` and surfaces the result unmodified. This package never independently walks a chain, checks revocation, or evaluates policy compliance (confirmed by code-search at the Phase 3 milestone review — see `plans/client-sdk/milestones/phase-3-summary.md`).

`fetchAnnotations: false` throughout — the EAS third-party annotation-board layer (`verifyCard`'s Stage 6) is out of scope for now (OQ-SDK-11).

---

## 7. Wallet Setup, Keyring, and Backup/Recovery

*(Implemented — Phase 2. Module: `wallet/`.)*

### 7.1 Key Derivation

`wallet/kdf.ts`:

```ts
function deriveDecryptionKey(devicePasskeyOutput: Uint8Array, serviceSecret: Uint8Array): Uint8Array;
function passkeyOutputFromPrf(prfOutput: Uint8Array): Uint8Array;
```

`decryption_key = HKDF-SHA3-256(ikm=devicePasskeyOutput, salt=serviceSecret, info='card-protocol-wallet-decryption-key-v1')` — folding both factors in via HKDF's dedicated `salt` slot so neither factor alone can reconstruct the output, matching `wallet_backup_and_recovery.md`'s explicit security property. `passkeyOutputFromPrf` is `keccak256(prfOutput)`, used for **both** the device-bound passkey's output and the synced-passkey backup wrapping key — the same operation, since a WebAuthn PRF output is what makes either reproducible where it needs to be (see §4.3, §12).

### 7.2 Keyring

`wallet/keyring.ts`: `encryptKeyring(entries, decryptionKey)` / `decryptKeyring(blob, decryptionKey)` — AES-256-GCM, fresh random 12-byte nonce prepended to ciphertext (self-contained blob). `computeKeyringId(blob) = keccak256(blob)`. `KeyringEntry = { cardAddress: string; privateKey: Uint8Array }` — one entry per card private key the holder controls (master key at genesis; per-offer-acceptance keys appended later, §8.3).

### 7.3 setupWallet

`wallet/setupWallet.ts`:

```ts
function setupWallet<T = void>(options: WalletSetupOptions<T>): Promise<WalletSetupResult<T>>;
```

Implements `wallet_backup_and_recovery.md §Process 1` Steps 1–14 as one continuous function: master ML-DSA-44 keypair generation → device-bound passkey → the two-call `service_secret` bootstrap (`POST /accounts/challenge` → `POST /accounts` with a provisional passkey-only-encrypted blob → re-encrypt under the real `decryption_key` → `PUT /accounts/{card_hash}/keyring` with `rotate_service_secret: false`, so the account's authoritative secret matches what the client actually encrypted with — a real protocol bug found and fixed during Phase 2, not present in the original wallet-service design) → keyring persistence via `StorageProvider` → synced-passkey backup registration (always) → optional YubiKey backup → device sub-card generation and registration (§7.4).

`decryption_key` and the master private key are local variables scoped to this function's body only — never returned, logged, or exposed via any field of `WalletSetupResult`. An optional generic `postSetupHook?: (decryptionKey) => Promise<T>` runs inside this same scope, after the keyring/backups/sub-card are established but before the master key is cleared — the mechanism §8.4's new-wallet acceptance flow uses to "invoke wallet setup inline" without duplicating this function's body or exposing `decryption_key` to a second function.

### 7.4 Device Sub-Card

`wallet/deviceSubCard.ts`: `registerDeviceSubCard(options): Promise<DeviceSubCardResult>` — the wallet's own "self-signing" sub-card path (`subcards.md`'s wallet-self-signing exception: the requesting app *is* the wallet, so the user-consent step, §9.3, is skipped). Assembles and dual-signs a `SubCardDocument` (`app_signature` via the injected `WalletAppCardIdentity`, `holder_signature` via the in-scope master key), hardcoding `attestation_level: 'T1'` (no App Attest/Play Integrity provider exists yet in this package). `registerSubCard: RegisterSubCardFn` is an injected stub standing in for Phase 4's real press-submission primitive (§9.4).

### 7.5 Backup Registration

`wallet/backupRegistration.ts`: `wrapDecryptionKey`/`unwrapDecryptionKey` (AES-256-GCM, same self-contained-blob shape as §7.2) and `registerBackup(options): Promise<BackupRegistrationResult>` — `POST /accounts/{card_hash}/backups`, Bearer-session-token-authenticated. Both the synced-passkey and YubiKey paths wrap `decryption_key` under a wrapping key the wallet service never sees.

### 7.6 Recovery and Re-Registration

`wallet/recovery.ts`, implementing `wallet_backup_and_recovery.md §Process 2a/2b` (synced-passkey / YubiKey recovery) and `§Process 3` (re-registration):

```ts
function initiateRecovery(transport, cardHash, backupId): Promise<InitiateRecoveryResult>;
function cancelRecovery(transport, recoveryId, masterSecretKey): Promise<CancelRecoveryResult>;
function releaseRecoveryKey(transport, recoveryId): Promise<ReleaseRecoveryKeyOutcome>;   // discriminated union, not throw-based — 425/410 are expected outcomes
function fetchKeyringBlob(transport, keyringId): Promise<Uint8Array>;                      // callable against any federation member
function recoverWallet(options: RecoverWalletOptions): Promise<RecoverWalletResult>;
```

`recoverWallet` is the one large orchestrator, mirroring `setupWallet`'s structure: unwrap the released `wrapped_blob` → fetch the keyring by ID → decrypt → (optionally) batch-deregister previously-active sub-cards (§7.7) → re-register (new device-bound passkey, new `decryption_key`, new `keyring_id`, via the same provisional/final two-call bootstrap §7.3 uses) → new device sub-card. `cancelRecovery` takes `masterSecretKey` as a direct caller-supplied parameter — this package has no general "unlock the wallet's master key again after initial setup" primitive (an acknowledged, documented gap; see §14), so the caller is responsible for however it reconstructs its own master key to authorize a cancellation.

### 7.7 Post-Recovery Sub-Card Deregistration

`wallet/subCardDeregistration.ts` — see §9.5 (built ahead of its originally-planned Phase 4 step, since Phase 2's recovery flow needed it).

---

## 8. Card Offers

*(Implemented — Phase 3. Module: `offers/`.)*

### 8.1 Offer Construction

`offers/targetedOffer.ts`: `assembleAndSignTargetedOffer(options): Promise<SignedTargetedOffer>` — the offer-phase `CardDocument` (`card_offering_and_acceptance.md §Phase 3`): protocol-required fields (`policy_id`, `issuer_card`, `press_card`, `issued_at`, `ancestry_pubkeys`, `past_keys` if applicable) merged with caller-supplied policy-defined field values, signed with `issuer_signature`. `recipient_pubkey`/`holder_signature`/`press_signature`/`protocol_version` are absent, matching the offer phase.

`offers/openOffer.ts`: `assembleAndSignOpenOffer(options): Promise<AssembleOpenOfferResult>` — `OpenCardOffer` (`open_offer_creation.md §Phase 1–2`), plus `offerId = keccak256(canonicalize(complete signed document))` and the short-form claim link (`mcard://claim?o=<base64url of canonical offer bytes>`). Enforces `expires_at` must be future if set, and requires `acknowledgeUnconstrained: true` when both `max_acceptances`/`expires_at` are unconstrained.

Both accept a `SecureKeyProvider` + `keyId` for "the offerer's own card key," rather than assuming a specific card — matching the "routine signing never touches the master key" pattern established in §7.4.

### 8.2 Offer Verification

`offers/offerVerification.ts`: `reviewTargetedOffer` / `reviewOpenOffer` — the pre-display verification gate shared by every acceptance path (`card_offering_and_acceptance.md` step 12; `open_offer_acceptance_*.md §Phase 1` step 2):

1. keccak256 binding check (`ancestry_pubkeys[0]`/`issuer_card` for targeted offers; `issuer_pubkey`/`issuer_card` for open offers — both treated as untrusted hints per `protocol-objects.md`).
2. `issuer_signature` verification.
3. Chain-reaches-trusted-root and revocation status, via `CardVerifier.verifyCard()` (§6) — never independently derived.
4. Authoritative on-chain press authorization via `RpcProvider.getPressAuthorization`, with the policy's `approved_presses` as an advisory-only cross-check.

Every code path returns `{ approved: true, offer, issuerVerification, pressAdvisoryWarning? }` or `{ approved: false, code, reason }` — never a partially-populated offer object, and never an uncaught exception (even a `CardVerifier` error surfaces as a typed rejection).

`policyAddress` (for the authoritative press check) and `policyApprovedPresses` (advisory) are caller-supplied — resolving a `policy_id` CID to its on-chain address, and fetching+decrypting the policy card, are out of this step's scope (documented gap; `CardVerifier`'s public surface has no primitive for either).

### 8.3 Countersigning

`offers/countersign.ts` — the "persist before sign" invariant (`card_offering_and_acceptance.md §Phase 5` step 15; `open_offer_acceptance_*.md`'s equivalent steps):

```ts
function acceptTargetedOfferAndCountersign(approved: ApprovedTargetedOffer, keyringWrite: KeyringWriteOptions): Promise<AcceptTargetedOfferResult>;
function acceptOpenOfferAndCountersign(approved: ApprovedOpenOffer, keyringWrite: KeyringWriteOptions): Promise<AcceptOpenOfferResult>;
```

Both call a **non-exported** internal helper that generates a fresh, in-memory (not `SecureKeyProvider` — this key must be backup-recoverable) ML-DSA-44 keypair, decrypts the current keyring via caller-supplied `decryptionKey`, appends the new entry, re-encrypts, and `await`s a `StorageProvider.set` — only then returning the keypair to the calling function for signing. Since the helper is not exported, there is no code path in this package that can produce a countersignature without a prior confirmed keyring write. Both functions additionally require an already-`review*`-approved input type (§8.2), not a raw offer.

### 8.4 New-Wallet Open-Offer Acceptance

`offers/newWalletOpenOfferAcceptance.ts`: `acceptOpenOfferForNewWallet(options): Promise<AcceptOpenOfferForNewWalletResult>` — `open_offer_acceptance_new_wallet.md` end-to-end: offer review (§8.2) → wallet setup (§7.3, invoked via `setupWallet`'s `postSetupHook`) → countersign (§8.3) → `POST /open-offer/claim` (`offers/openOfferClaim.ts`'s `submitOpenOfferClaim`, via `ObliviousProtocolTransport` targeting the offer's named press) → SCIP. A rejected offer never triggers wallet setup or any network side effect.

### 8.5 Existing-Wallet Open-Offer Acceptance

`offers/existingWalletOpenOfferAcceptance.ts`: `acceptOpenOfferForExistingWallet(options): Promise<AcceptOpenOfferForExistingWalletResult>` — `open_offer_acceptance_existing_wallet.md` end-to-end: offer review → countersign (keyring update only) → claim submission. No `passkeyProvider` field exists on this function's option surface at all (structural guarantee against creating a second passkey); `decryptionKey` is a required direct parameter this module never derives itself (no `kdf.ts` import), matching the spec's own postcondition that the existing credential was used, not re-derived.

### 8.6 Targeted Offer Acceptance and Press Finalization

`offers/targetedOfferAcceptance.ts`, implementing `card_offering_and_acceptance.md §Phase 5–6`:

```ts
function acceptTargetedOffer(options): Promise<TargetedOfferAcceptanceResult>;               // recipient side: review + countersign, reusing §8.2/§8.3
function forwardCountersignedTargetedOffer(options): Promise<ForwardTargetedOfferResult>;    // offerer side: validate + POST /issue/finalize
```

Unlike the open-offer paths, the recipient never talks to the press directly for a targeted issuance — the spec is explicit that "the offerer... forwards it to the press." `acceptTargetedOffer` returns the countersigned card for out-of-band delivery back to the offerer (this package does not own that delivery channel, matching the existing precedent for offer distribution generally). `forwardCountersignedTargetedOffer` reconstructs the signed payload from the offer *the offerer itself issued* plus only `recipient_pubkey`/`holder_signature` from whatever the recipient sent back — every other field is read from the offerer's own trusted copy, so a tampered echoed-back field can never reach the press even via an untrusted intermediary.

---

## 9. Sub-Cards

*(Implemented — Phase 4, all sub-sections. Module: `subcards/` for the general/requester-side flow; `wallet/deviceSubCard.ts` and `wallet/subCardDeregistration.ts` for the wallet's own self-signing and deregistration cases, per §7.4/§7.7. A full request → validate → consent → countersign → register → revoke loop passes end-to-end against a stub press/registry; see `plans/client-sdk/milestones/phase-4-summary.md`.)*

### 9.1 Requester-Side Request (Implemented)

`subcards/requestSubCard.ts`: `requestSubCard(options): Promise<RequestSubCardResult>` — the general, third-party-app side of `subcards.md §Sub-Card Request Flow Step 1`, generalizing what §7.4 already does for the wallet's own case. Generates a fresh, non-exportable ML-DSA-44 keypair via `SecureKeyProvider`, assembles the `SubCardDocument`, signs with the app's own card key → `app_signature`. Returns an `AppSignedSubCardDocument` (`holder_signature` deliberately absent — added later, §9.3) for the host app to transmit via whatever delivery channel it implements — per OQ-SDK-9, this package does not own sub-card request delivery.

### 9.2 Wallet-Side Validation (Implemented)

`subcards/handleSubCardRequest.ts`:

```ts
function handleSubCardRequest(options: HandleSubCardRequestOptions): Promise<HandleSubCardRequestResult>;
```

Per OQ-SDK-9, the sole entry point for inbound sub-card requests (`subcards.md §Sub-Card Request Flow Step 2`): verify `app_signature`; apply both keccak256 binding checks (`holder_primary_card_pubkey`, `app_card_pubkey`); confirm the app card's chain reaches the governance app-certification policy root and is currently valid (not revoked), via the shared `CardVerifier` (§6). Returns `{ valid: true, request, appCardVerification }` or `{ valid: false, code, reason }` — never a throw for an expected rejection condition, matching §13's conventions; a `CardVerifier` error is caught and surfaced as `code: 'verification_error'`.

**`CardVerifier` instance decision** (resolved): this function takes a `CardVerifier` as a direct parameter rather than constructing one, and expects the caller to pass the **same shared instance** used everywhere else in this package (§6, §8.2) — not a second, narrower instance scoped only to app-certification. `verifyCard()`'s trusted-root check (`trustedRoots.includes(address) || isPolicyAuthorizer(address)`) is a flat membership test with no per-call scoping concept, so a single instance constructed with `trustedRoots` containing the *union* of every root this package needs to recognize (policy trusted roots for offer verification, the governance app-certification root for this check) provides everything a second instance would, at lower operational cost. Mirrors `press.md §5.4`'s `verifyAppCertificationChain`, which documents the identical pattern server-side.

No annotation-board check (`fetchAnnotations: false`, OQ-SDK-11 — this function never reads `appCardVerification.annotations`) and no attestation-proof verification (no attestation provider exists in this package yet, same limitation as §7.4) are in scope.

### 9.3 Consent and Countersigning (Implemented)

`subcards/consent.ts`:

```ts
function assembleSubCardConsent(options: AssembleSubCardConsentOptions): SubCardConsentData;
```

Assembles the consent screen's data on a successful §9.2 validation: app identity (caller-supplied — resolving name/version/publisher means fetching and decrypting the app card's IPFS content, which `CardVerifier.verifyCard()` never exposes, so this is out of scope the same way `policyAddress` resolution was for §8.2), `requestedCapabilities` (verbatim from the request), `grantableCapabilities` (`requestedCapabilities` intersected with the wallet's own configured capability whitelist — informational for the consent UI), always-empty `annotationWarnings` (OQ-SDK-11), and a caller-supplied `suggestedValidUntil`.

`subcards/countersign.ts`:

```ts
function countersignSubCardRequest(options: CountersignSubCardRequestOptions): Promise<CountersignSubCardRequestOutcome>;
```

**Finding from implementation, not anticipated by the plan's own wording:** `subcards.md §Capabilities` states "the wallet may grant a subset of what was requested but never more," which reads as though the wallet can rewrite `capabilities` to a narrower list before countersigning. It cannot, without breaking the document: `app_signature` is computed by the requesting app over the *entire* document including `capabilities`, and `holder_signature` covers that same document plus `app_signature` — both signatures are over one fixed set of field values. Silently narrowing `capabilities` here would make the stored document's own `app_signature` fail to verify against its own `capabilities` field for any later verifier. `countersignSubCardRequest` therefore requires `decision.approvedCapabilities` to **exactly** match `consentData.requestedCapabilities` and returns `{ countersigned: false, reason }` — never a signature — otherwise; a wallet that wants to grant fewer capabilities than requested must reject the request and have the app resubmit a narrower one (which the app then signs itself), not silently edit an already-signed document.

**Self-signing exception, unchanged:** this module is not used at all when the requesting app is the wallet itself — `wallet/deviceSubCard.ts`'s `registerDeviceSubCard` (§7.4) already implements that entire path directly, with no request/validation/consent pipeline, since it was built before this step and needs none of it. "Wiring this back to §7.4" (the plan's own phrasing) means exactly this: the self-signing path's mechanism *is* §7.4's existing function, confirmed by a test that registers a device sub-card without ever constructing a `SubCardConsentData`.

`registerSubCard: RegisterSubCardFn` (reused from §7.4) is, as there, an injected stub standing in for §9.4's real press-submission primitive.

### 9.4 Press Submission and Revocation (Implemented)

`subcards/pressSubmission.ts`:

```ts
function submitSubCardRegistration(document: SignedSubCardDocument, options: SubmitSubCardRegistrationOptions): Promise<SubCardRegistrationResult>;
function createPressSubCardRegistrar(options: SubmitSubCardRegistrationOptions): RegisterSubCardFn;
```

`POST /sub-card/register` (`press.md §5.4 processSubCardRegistration`), via `ObliviousProtocolTransport`. `createPressSubCardRegistrar` adapts the richer result to the exact `RegisterSubCardFn` shape §7.4's `registerDeviceSubCard` and §9.3's `countersignSubCardRequest` already expected as an injected stub — this is the real implementation both were built ahead of, swallowing a failed submission into `{ registered: false }` rather than throwing, since both callers treat that as a normal outcome to report.

`subcards/revocation.ts`:

```ts
type SubCardRevocationCode = 800 | 801 | 810 | 811;
function revokeSubCard(options: RevokeSubCardOptions): Promise<RevokeSubCardResult>;
```

8xx revocation (`subcard_creation_policy.md §Revocation — 8xx`; `card_updates.md`) via the general card-update-intent flow, `POST /update` — not a sub-card-specific endpoint. User-initiated (code 801) is signed by the wallet's own device sub-card (§7.4's routine-signing key); app-initiated (code 811) is signed by the requesting app's own installation card — both expressed as an `UpdateIntentSigner` (`{ cardPointer, sign }`; `WalletAppCardIdentity` already satisfies this shape structurally), since the press resolves the signer's actual public key itself from `updater_card` (`press.md §5.3`), so this function never needs it directly.

**Structural 9xx exclusion** (the strategic plan's explicit scope requirement): `SubCardRevocationCode` is a literal union of exactly `800 | 801 | 810 | 811` — there is no value of that type naming a 9xx code, so no caller can construct one through this function's type signature even by mistake. Re-checked at runtime too (a thrown error if a caller bypasses TypeScript), confirmed by a test that force-casts a 9xx value past the type system and asserts `transport.request` is never called.

Deregistration is already built — see §9.5, not duplicated here.

### 9.5 Deregistration (Implemented, Ahead of Schedule)

`wallet/subCardDeregistration.ts` — originally planned as part of Step 4.4, built during Phase 2 (Step 2.5) instead, since post-recovery batch deregistration needed it immediately:

```ts
function deregisterSubCard(options: DeregisterSubCardOptions): Promise<DeregisterSubCardResult>;                                    // POST /sub-card/deregister
function deregisterSubCardsAfterRecovery(transport, masterSecretKey, previouslyActiveSubCards): Promise<SubCardDeregistrationOutcome[]>;
```

`subcards.md §Authorization for Deregistration`'s requirement — deregistration requires and is signed by the **primary card key only**, never the sub-card key or the app's installation card — is enforced structurally: `deregisterSubCard` has no "signer" callback parameter at all (unlike `registerSubCard`'s injected-callback shape), only a direct `masterSecretKey: Uint8Array` argument, so there is no SDK-exposed code path that could construct a deregistration request signed by anything else. `deregisterSubCardsAfterRecovery` batches this across multiple sub-cards (each potentially registered through a different press), continuing past a per-item failure rather than aborting the whole batch. Wired into `recoverWallet` (§7.6) as an optional step, run immediately after the master key is recovered and before re-registration.

---

## 10. Messaging and UUID/Relay Management

*(Implementation-plan Phase 5. Module: `messaging/`.)*

### 10.1 Message Envelope Construction and Per-Subcard Fan-out (Implemented)

`messaging/envelope.ts`:

```ts
function buildMessagePayload<T extends MessageType>(options: BuildMessagePayloadOptions<T>): MessagePayload<T>;
function signMessageEnvelope<T extends MessageType>(payload: MessagePayload<T>, signers: EnvelopeSigner[]): Promise<CardMessageEnvelope<T>>;
function messageId(payload: MessagePayload): string;
```

`MessageType` is a literal union of exactly this SDK's in-scope taxonomy (`messaging_protocol.md`): `text`, `reply`, `edit`, `reaction`, `read_receipt`, `card_offer`/`card_offer_accepted`/`card_offer_declined` (reusing §8's offer CIDs/signatures as `content` fields), `card_update_notification`, `auth_request`/`auth_response`. Every other taxonomy entry (`api.*`, `mcp.*`, `introduction`, `announcement`, `delete`, `flag`, `error`) is out of scope — the literal union makes constructing an out-of-scope-typed envelope a compile error, not just an undocumented gap. `MessageContentByType` maps each `type` to its own typed `content` shape, so `buildMessagePayload({ type: 'text', content: {...} })` gets compile-time checking against `TextContent`, not a bag of `unknown`.

`buildMessagePayload` enforces the spec's structural constraints at construction time rather than leaving them as caller conventions: `edit_of`/`retracts`/`forwards` are mutually exclusive, `edit` requires `edit_of`, `type: edit` with `retracts` set is rejected, and `reply` requires `in_reply_to`. Optional fields are omitted entirely when absent (never emitted as `null`), matching the spec's RFC 8785 field-ordering note. `messageId(payload) = keccak256(canonicalize(payload))` — there is no separate `id` field, matching the spec exactly; used for dedup (§10.2) and edit-chain root derivation.

The concrete envelope type is named `CardMessageEnvelope`, not `SignedMessageEnvelope`, specifically to avoid colliding with the verifier package's own `SignedMessageEnvelope` (its generic `{ payload: { message, timestamp, ... }, signatures }` shape for `CardVerifier.verifyEnvelope`, already re-exported unaliased from `verification/index.ts`) — re-exported as `MessageEnvelope` at this package's top level for readability.

`messaging/fanout.ts`: `fanOutMessageToSubCards(recipientCardHash, envelope, subCards): RoutingEnvelope[]` — implements `message_routing.md §Sender-Side Fan-out`: given the recipient's currently-registered sub-card list (resolved by the caller from the on-chain storage contract; this function does not itself talk to chain), encrypts the same `CardMessageEnvelope` independently to each sub-card's ML-KEM-768 public key, producing one distinct `RoutingEnvelope` (`{ to, subcard_hash, payload }`) per sub-card — never one ciphertext copied N times, confirmed by a test that fans out to 3 sub-cards and asserts all 3 `payload` values are pairwise distinct, then decrypts each independently with its own sub-card's ML-KEM secret key (`messaging/decrypt.ts`'s `decryptRoutingEnvelope`) and confirms it recovers the identical envelope — plus that cross-decrypting with a different sub-card's key never succeeds.

Since ML-KEM is a KEM, not an AEAD, the actual envelope bytes are encrypted with AES-256-GCM under a key derived via HKDF-SHA3-256 from the ML-KEM shared secret (mirroring the encapsulate-then-derive-then-AEAD shape `HpkeObliviousProtocolTransport` already uses via HPKE's native `export()`, adapted here since ML-KEM has no built-in equivalent). The resulting blob is self-contained (length-prefixed KEM ciphertext + AEAD nonce + AEAD ciphertext) so a recipient holding only the sub-card's ML-KEM secret key can decrypt with no additional side-channel metadata.

### 10.2 Inbound Message Verification and Decryption (Implemented)

`messaging/inbound.ts`:

```ts
function handleInboundRoutingEnvelope(options: HandleInboundRoutingEnvelopeOptions): Promise<InboundResult>;
```

Decrypts a `RoutingEnvelope` via `decryptRoutingEnvelope` (§10.1), then verifies the recovered `CardMessageEnvelope`'s signature(s) via the shared `CardVerifier`'s `verifyEnvelope()` (`card_verifier.md §6.1`) — never a hand-rolled signature check. Returns a discriminated union: `{ accepted: true, envelope, messageId, verification, duplicate }` or `{ accepted: false, code, reason }` for `decryption_failed`, `signature_invalid` (the verifier call itself threw), or `no_valid_signature` (the verifier ran but no signature in `verification.signatures` validated) — an envelope failing any of these must never be displayed, confirmed by a test that tampers with a signed payload post-signing and asserts the result is `{ accepted: false, code: 'no_valid_signature' }`, not a thrown exception and not a displayed message.

**Bridging to the verifier's generic envelope shape.** `CardVerifier.verifyEnvelope()` expects `{ payload: { message, protocol_version, timestamp, [key]: unknown }, signatures }` — a generic shape used for every kind of envelope the verifier package checks, not specific to this module's typed `MessagePayload`. The verifier's own Stage 1 (`verifyStage1`) canonicalizes and verifies over `payload` exactly as received, without reading or requiring a `message` field itself; passing a `CardMessageEnvelope` through a targeted cast therefore round-trips correctly without this package re-deriving or duplicating any verification logic — the cast bridges an interface-shape mismatch between two packages' unrelated type declarations, not a behavior gap.

Deduplication (`message_routing.md §UUID Re-registration and Retransmission` — "devices must deduplicate by message ID") is by `messageId(payload)` against a `StorageProvider`-backed history keyed `message-history:<id>`: a retransmitted duplicate (same message ID, arriving again after a simulated relay restart) is detected via a check-then-set against that store and reported via `duplicate: true` on the *second* delivery, with exactly one write ever made for that ID — confirmed by a test asserting `StorageProvider.set` is called once across two deliveries of the identical routing envelope.

Message-type-specific handling helpers — `editTarget`, `reactionTarget`, `retractionTarget`, `resolveEditRoot` — derive the piece of state each type's linking rule needs (`edit_of`, `content.target`, `retracts`, and the edit-chain root via `edit_of` pointer-following to the original, `edit_of`-less payload, respectively) without owning any durable message-history store themselves; a host app's own message-history/UI layer is expected to call these against whatever store it maintains.

### 10.3 UUID Registration, Session Separation, and Staggering (Implemented)

`messaging/uuidRegistration.ts`:

```ts
function registerCardUuids(options: RegisterCardUuidsOptions): Promise<RegisterCardUuidsResult>;
function registerMultipleCardsUuids(options: RegisterMultipleCardsUuidsOptions): Promise<CardUuidRegistrationOutcome[]>;
```

`registerCardUuids` implements `notification_relay.md §Process 1` step 6's wallet registration exactly: `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` with a signed envelope proving control of the subcard the UUIDs are being registered for (payload `{ card_hash, subcard_hash, uuids, timestamp, nonce }`, ML-DSA-44-signed), via `ObliviousProtocolTransport` (§4.7) by default. Its option shape names exactly one `cardHash`/`subCardHash`/`uuids` triple — there is no parameter through which a second card could be named in the same call, unlike an array-of-cards shape that would make batching representable even if discouraged only by convention.

**Structural session separation**, per `§Registration Privacy`'s explicit statement that batching multiple cards' registrations into one session or message is not permitted *regardless of transport* (an anonymizing transport hides network identity, not message content — a wallet service reading two `card_hash` values out of one envelope infers co-ownership from the payload itself). `registerMultipleCardsUuids` — the only entry point handling more than one card, and only as a device-local orchestration loop, never a batched wire request — accepts an `ObliviousProtocolTransportFactory` (`() => ObliviousProtocolTransport`) rather than a shared transport instance, and calls it once per card, so each card's registration runs against a freshly constructed transport with its own OHTTP key-config cache and (per the injected factory's own implementation) its own underlying connection. A test proves this via request-level session inspection: a tracked transport factory tags every request with a monotonic per-invocation session id, and the test confirms two cards' registrations used two disjoint session-id sets.

**Staggering**: `registerMultipleCardsUuids` inserts a randomized delay (configurable `minStaggerDelayMs`/`maxStaggerDelayMs`, defaulting to a unit-testable 1–3 second window rather than the spec's real-world minutes-to-hours range, which a production caller should raise) between successive cards' sessions, confirmed by a test asserting the elapsed wall-clock time between the last call of one card's session and the first call of the next is at least the configured minimum.

A second test confirms `registerCardUuids` succeeds identically against the same stub wallet service via both the oblivious-relay path and the transport's `bypass: true` direct-HTTPS mode — this step's job is purely the content/timing-level separation (session-per-card, staggering) on top of whichever transport mode is in effect, per the plan's framing that the oblivious path's IP-hiding and this step's co-ownership-inference prevention are complementary, not substitutable, protections (`specs/process_specs/oblivious_transport.md`'s overview makes the identical point for the general oblivious-transport case).

### 10.4 Replenishment Scheduling (Planned)

Will implement proactive UUID pool replenishment at a ≤3-remaining threshold, randomized timing, never immediately after message receipt (anti-correlation), per `notification_relay.md §Replenishment`.

### 10.5 Realtime Delivery (Planned)

Will implement SSE (foregrounded), per-card WebSocket (active chat), and silent-push-triggered `GET /pending` catch-up (backgrounded), with explicit-ack-only clearance — never treating relay delivery alone as clearance (`notification_relay.md §Process 3–5`).

### 10.6 UUID Pool Deregistration (Planned)

Will implement signed-envelope-authenticated `DELETE /cards/{card_hash}/subcards/{subcard_hash}`, structurally distinct from on-chain sub-card revocation (§9.4/§9.5).

None of Steps 5.2–5.6 is implemented today; `RealtimeTransportProvider` (§4.5) and the ML-KEM primitives (§5) they depend on already exist.

---

## 11. Cross-Platform Hardening and Documentation (Planned)

*(Implementation-plan Phase 6. Not yet started.)*

Will cover: running every prior phase's scenario against real (non-stub) local wallet-service/press/relay instances on both platforms; validating `ObliviousProtocolTransport` against real deployed OHTTP endpoints (latency measurement, fallback/error-surface documentation); integrator documentation (`client-sdk/README.md`, per-provider integration guides, a worked example on both platforms); and Clarification Checkpoint CP-2, a pre-production security review blocking production launch — covering the persist-before-sign invariant's bypass-resistance, `SecureKeyProvider` non-exportability on both platforms, the sub-card 9xx-exclusion and primary-key-only-deregistration checks, and confirming no derived key/passkey output/private key material appears in any log output.

---

## 12. Security Invariants

Cross-cutting properties this package maintains, independent of which module is involved:

- **`decryption_key` and the master private key never cross a function's return boundary.** `setupWallet` and `recoverWallet` are the only functions that ever hold them, and both clear the master key in a `finally` block. Every other function that needs `decryption_key` (§8.3, §8.5) receives it as a direct parameter from a caller that obtained it some other way — this package has no general "unlock the wallet again after initial setup" primitive (documented gap, not silently assumed away).
- **Persist before sign**, for every per-card keypair generated during offer acceptance (§8.3) — structurally enforced via a non-exported helper, not a call-site convention.
- **No key derivation input is ever also transmitted to a party the derivation must stay secret from.** The corrected form of §4.3/§7.1's `passkeyOutputFromPrf` — the CP-1 finding this session's security review caught and fixed.
- **Deregistration requires the primary card key, structurally, not just by policy** (§9.5) — no signer-substitution is possible via any exported function's type signature.
- **No verification logic is re-derived outside `CardVerifier` calls** (§6) — confirmed by code-search at the Phase 3 milestone (`plans/client-sdk/milestones/phase-3-summary.md`), and re-checked whenever a new verification-adjacent module is added (§9.2 will need the same confirmation once built).
- **`SecureKeyProvider` never returns private key material**, on any platform, for any key it manages (device sub-card, requester-side sub-card).

Two lower-severity, explicitly tracked gaps from the CP-1 review (not yet closed): transient secrets other than the master key (`decryptionKey`, wrapping keys, `serviceSecret`) are not explicitly zeroed after use in every function that handles them (relies on GC); and if the keyring ever grows to hold more than one entry that needs clearing on a given code path, only the entry aliased by whatever local variable gets `.fill(0)`-ed is actually cleared.

---

## 13. Result and Error Conventions

Established across §8 and reused wherever new verification/acceptance-style functions are added: functions that gate on a verification step return a discriminated union (`{ approved: true, ... } | { approved: false, code, reason }`, or the analogous `{ forwarded: true, ... } | { forwarded: false, reason }` shape for §8.6's offerer-side forward) rather than throwing on an expected rejection condition. A thrown exception is reserved for conditions the caller could not have anticipated from the inputs alone (a network/transport failure, a malformed response) — even a `CardVerifier` internal error is caught and surfaced as a typed rejection where a hard-rejection code already exists for "verification failed," so callers can pattern-match on outcome rather than wrapping every call in `try`/`catch`.

---

## 14. Implementation Status

| Phase | Step | Status |
|---|---|---|
| 1 | 1.1–1.7 (workspace, providers, crypto, verifier integration, oblivious-relay transport + relay/wallet-service/press gateways, web/RN default providers, CI) | **Done** |
| 2 | 2.1 Wallet setup | **Done** |
| 2 | 2.2 Device sub-card | **Done** |
| 2 | 2.3 Backup registration | **Done** |
| 2 | 2.4 Recovery and re-registration | **Done** |
| 2 | 2.5 Post-recovery deregistration | **Done** |
| 2 | CP-1 security review | **Done** — critical finding fixed (§4.3, §12); two lower-severity findings tracked open |
| 3 | 3.1 Offer construction | **Done** |
| 3 | 3.2 Offer verification | **Done** |
| 3 | 3.3 Countersigning | **Done** |
| 3 | 3.4 New-wallet open-offer acceptance | **Done** |
| 3 | 3.5 Existing-wallet open-offer acceptance | **Done** |
| 3 | 3.6 Targeted offer acceptance + finalization | **Done** |
| 4 | 4.1 Requester-side sub-card request | **Done** |
| 4 | 4.2 Wallet-side inbound validation | **Done** |
| 4 | 4.3 Consent structure + countersigning | **Done** |
| 4 | 4.4 Press submission + 8xx revocation | **Done** |
| 4 | Milestone review | **Done** |
| 5 | 5.1 Message envelope construction and per-subcard fan-out | **Done** |
| 5 | 5.2 Inbound message verification and decryption | **Done** |
| 5 | 5.3 UUID registration with session separation and staggering | **Done** |
| 5 | 5.4 Replenishment scheduling | Not started |
| 5 | 5.5 Realtime delivery (SSE, WebSocket, push catch-up) | Not started |
| 5 | 5.6 UUID pool deregistration | Not started |
| 5 | Milestone review | Not started |
| 6 | 6.1–6.3 + CP-2 (cross-platform hardening, docs, pre-production review) | **Not started** |

As of this writing: 226 tests pass in the `client-sdk` core package (24 in `client-sdk-web`, 21 in `client-sdk-rn`); build/typecheck/lint clean across the whole workspace.

---

## 15. Dependencies

| Package | Used for |
|---|---|
| `@noble/post-quantum` | ML-DSA-44, ML-KEM-768 |
| `@noble/hashes` | keccak256, HKDF-SHA3-256 |
| `@noble/ciphers` | AES-256-GCM (keyring, backup wrapping) |
| `hpke-js` | HPKE (RFC 9180) for `ObliviousProtocolTransport` |
| `@membership-card-protocol/verifier` | `CardVerifier` — chain walking, revocation, signature verification |
| `@membership-card-protocol/verifier-ipfs-provider` | Default `IpfsProvider` (Filebase-backed) |
| `@react-native-async-storage/async-storage` (RN only) | Default `StorageProvider` |
| `react-native-keychain` (RN only) | Default `SecureKeyProvider` |
| `react-native-passkey` (RN only) | Default `PasskeyProvider` |
| `react-native-sse` (RN only) | Default `RealtimeTransportProvider`'s SSE half |

No bundled RPC client is included — `RpcProvider` is always host-app-supplied, same as the verifier package's own convention.

---

## 16. Resolved Design Decisions

Carried forward from `plans/client-sdk/strategic-plan.md`'s open questions; treated as fixed unless a later phase surfaces a reason to revisit.

| ID | Decision |
|---|---|
| OQ-SDK-1 | Web `SecureKeyProvider`: non-extractable WebCrypto `CryptoKey` in IndexedDB (software-only, disclosed gap vs. native). |
| OQ-SDK-2 | RN `PasskeyProvider`: injected; `react-native-passkey` shipped default. |
| OQ-SDK-3 | RN realtime transport: default RN SSE implementation shipped; `GET /pending` remains the catch-up path on both platforms. |
| OQ-SDK-4 | Network-level privacy for wallet-service *and* press traffic: oblivious-relay (HPKE + relay forwarding), not Tor. See §4.7. |
| OQ-SDK-5 | Local persistence: SDK-owned `StorageProvider`; IndexedDB (web), AsyncStorage (RN). |
| OQ-SDK-6 | Verifier dependency: `@membership-card-protocol/verifier` consumed as a normal pinned npm dependency. |
| OQ-SDK-7 | Wallet-service federation: single preferred base URL per SDK configuration; no federation peer-list/retry logic in this package. |
| OQ-SDK-8 | Multi-tab coordination: in scope on web via `BroadcastChannel`; not applicable on RN. |
| OQ-SDK-9 | Sub-card request transport/UI: this package exposes only a validation entry point (`handleSubCardRequest`, §9.2); no owned deep-link transport, no shipped consent UI. |
| OQ-SDK-10 | Requester-side sub-card flow: in scope (§9.1). Requester and granter are both expected to run this SDK. |
| OQ-SDK-11 | Annotation-board integration: out of scope for now. No EAS lookup, advisory warnings, or annotation-triggered auto-revocation. `fetchAnnotations: false` throughout. |

---

## Related Specs

- `specs/process_specs/card_offering_and_acceptance.md`, `open_offer_creation.md`, `open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md` — §8
- `specs/process_specs/wallet_backup_and_recovery.md` — §7
- `specs/subcards.md`, `specs/process_specs/subcard_creation_policy.md` — §9
- `specs/messaging_protocol.md`, `specs/process_specs/message_routing.md`, `specs/process_specs/notification_relay.md` — §10 (planned)
- `specs/object_specs/card_verifier.md` — §6
- `specs/object_specs/press.md` — the press-side counterpart to §8/§9's press-facing calls
- `specs/ARCHITECTURE.md` — ADR-004 (canonicalization/signing), ADR-006 (content encryption), ADR-007 (OHTTP), ADR-009 (keyring storage)
- `plans/client-sdk/strategic-plan.md`, `plans/client-sdk/implementation-plan.md` — the source of record this spec was consolidated from
- `plans/client-sdk/milestones/` — phase-by-phase summaries and the CP-1 security review
