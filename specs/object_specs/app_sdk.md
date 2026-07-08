# Card Protocol — `@membership-card-protocol/app-sdk` npm Package Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-06
**Status:** Split from unified `client_sdk.md` (Phase 5 milestone) — represents the app-side, key-independent half of holder-side functionality

> **Provenance note.** This spec is derived from `specs/object_specs/client_sdk.md` via the split described in `plans/sdk-split-strategic-plan.md`. It represents all holder-side capabilities that do not require access to the wallet's master key or backup material. The wallet-side counterpart, which imports and depends on this package, is `specs/object_specs/wallet_sdk.md`.

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
7. [Sub-Card Requests (Requester-Side)](#7-sub-card-requests-requester-side)
   - 7.1 [Requester-Side Request](#71-requester-side-request-implemented)
   - 7.2 [Signing Arbitrary Data with a Sub-Card](#72-signing-arbitrary-data-with-a-sub-card-implemented)
   - 7.3 [Press Submission (Registration)](#73-press-submission-registration-implemented)
8. [Card Offers (Offerer-Side)](#8-card-offers-offerer-side)
   - 8.1 [Offer Construction](#81-offer-construction)
   - 8.2 [Offerer-Side Press Finalization](#82-offerer-side-press-finalization)
9. [Messaging and UUID/Relay Management](#9-messaging-and-uuidrelay-management)
    - 9.1 [Message Envelope Construction and Per-Subcard Fan-out](#91-message-envelope-construction-and-per-subcard-fan-out-implemented)
    - 9.2 [Inbound Message Verification and Decryption](#92-inbound-message-verification-and-decryption-implemented)
    - 9.3 [UUID Registration, Session Separation, and Staggering](#93-uuid-registration-session-separation-and-staggering-implemented)
    - 9.4 [Replenishment Scheduling](#94-replenishment-scheduling-implemented)
    - 9.5 [Realtime Delivery](#95-realtime-delivery-implemented)
    - 9.6 [UUID Pool Deregistration](#96-uuid-pool-deregistration-implemented)
10. [Cross-Platform Hardening and Documentation (Planned)](#10-cross-platform-hardening-and-documentation-planned)
11. [Security Invariants](#11-security-invariants)
12. [Result and Error Conventions](#12-result-and-error-conventions)
13. [Implementation Status](#13-implementation-status)
14. [Dependencies](#14-dependencies)
15. [Resolved Design Decisions](#15-resolved-design-decisions)
16. [Related Specs](#16-related-specs)

---

## 1. Overview

`@membership-card-protocol/app-sdk` is the library a third-party application, server-side integrator (press, wallet-service, relay), or web frontend links against to perform on-device functions the protocol specs assign to roles that do not custody private keys. It is the app-side counterpart to `@membership-card-protocol/wallet-sdk` (which imports this package and adds custody/backup/recovery capabilities on top of it).

This SDK handles:

1. **Card offer construction** — targeted and open offers, from the issuer side only (constructing an offer to send, and the offerer-side press finalization once a recipient countersigns). Reviewing a received offer prior to acceptance (the pre-display verification gate) and countersigning it (which produces a new keypair, signed with the wallet's master key) are both entirely wallet-side — see `wallet_sdk.md` §7.
2. **Sub-card requests** — acting as a requesting app (constructing a request to send to a wallet for authorization), and the provider-interface definitions for wallet-side validation/authorization (see `wallet_sdk.md` for the granter-side implementation).
3. **Messaging and private relay** — constructing and verifying envelopes, fanout to subcards, and the complete UUID/relay lifecycle *without* touching any wallet's private key.
4. **Verification delegation** — all chain-walking, revocation checking, and policy-compliance evaluation goes through `@membership-card-protocol/verifier`; this package never re-implements trust logic.

**What this SDK explicitly does NOT do:** hold any card holder's private key or master key on any device; run backup/recovery; perform wallet setup; countersign offers or sub-card requests (those operations require the wallet's master key); or implement wallet-service/press/relay endpoint logic. Every function in this package can be called without ever touching a private key, and every piece of cryptographic material this SDK generates or stores on behalf of a caller is either non-secret (like public keys) or hardware-backed/non-exportable (like device sub-card keys).

**Dependency relationship:** `@membership-card-protocol/wallet-sdk` imports and depends on this package. App-side integrators should depend only on `app-sdk`. Server-side integrators that do not run Wallet SDK code (e.g., a relay, a press, a wallet-service that outsources holder-side operations) also depend only on `app-sdk`.

---

## 2. Design Principles

**One SDK, two runtimes, no forked protocol logic.** Protocol logic (canonicalization, signing order, key derivation, envelope construction) contains no platform branches. The only things that legitimately differ between web and React Native are I/O primitives — secure key storage, platform passkey/WebAuthn APIs, realtime transport — isolated behind injected provider interfaces (§4), the same architectural pattern `@membership-card-protocol/verifier` already uses for `RpcProvider`/`IpfsProvider`.

**Never leave a private key recoverable-but-unpersisted, or persisted-but-inaccessible.** This package's own per-card keys for *offer construction* (requester-side sub-card generation) go through hardware-backed, non-exportable secure storage. No SDK function returns raw private-key material, and key material never cross a function's return boundary except as hardware-backed key identifiers (§11). Per-card keys generated for offer *acceptance* (including the "persist before sign" keyring-write invariant) are entirely a Wallet SDK concern — see `wallet_sdk.md` §7.

**No independently re-derived trust logic.** Chain walking, revocation checking, and policy-compliance evaluation always go through a shared `CardVerifier` instance (§6); this package never re-implements or duplicates that logic.

**Injected providers for every platform seam.** Six provider interfaces (§4.1–4.6) plus the oblivious-relay transport (§4.7) are the *only* points where platform-specific or transport-specific behavior enters; every other module in this package is pure, platform-independent TypeScript.

---

## 3. Package Structure

*(Implemented — Phase 1, Step 1.1.)*

`app-sdk/` is its own pnpm workspace package, as part of the split from the unified `client-sdk/`:

```
@membership-card-protocol/app-sdk/        The core, platform-independent package.
                                           Includes the oblivious-relay transport (implemented once, shared across platforms).
```

Core package module layout (`src/`):

```
providers/    Provider interfaces (§4) — contracts only, no implementations.
transport/    ObliviousProtocolTransport's implementation (§4.7).
crypto/       ML-DSA-44, ML-KEM-768, HPKE, keccak256/HKDF-SHA3-256, RFC 8785 canonicalization (§5).
verification/ CardVerifier factory (§6).
offers/       Offer construction and offerer-side finalization (§8). Does NOT include offer review or countersigning — see wallet_sdk.md §7.1 and §7.2.
subcards/     General (non-wallet-self-signing) sub-card request flow (§7).
messaging/    Envelope construction, verification, fan-out, relay lifecycle (§9).
util/         base64url encode/decode.
testing/      Shared provider-contract test suite and cross-platform scenario harness.
```

**Platform-specific default implementations:** `@membership-card-protocol/sdk-providers-web` and `@membership-card-protocol/sdk-providers-rn` (renamed from `client-sdk-web`/`client-sdk-rn` as part of the split) provide platform-specific defaults for providers and realtime transport. Each depends on this package (for the provider interface types their classes implement), not the other way around — this package has no dependency on either platform package. A host app depends on this package *and*, separately, on whichever platform package matches its runtime, then wires a default provider instance in itself.

TypeScript, ESLint, Vitest are configured per package, matching `membership_card_verifier`'s conventions.

---

## 4. Provider Interfaces

*(Implemented — Phase 1, Step 1.2; default implementations shipped in shared platform packages.)*

Every interface is exported from `src/providers/`, with a shared provider-contract test suite (`src/testing/providerContracts.ts`) that both platforms' default implementations, and any host-app-supplied implementation, are expected to pass.

### 4.1 StorageProvider

```ts
interface StorageProvider {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Every module needing durable local state (per-subcard UUID pools, message history, etc.) goes through an instance of this interface. **Defaults:** IndexedDB on web; `@react-native-async-storage/async-storage` on RN (chosen over MMKV/SQLite for exact key-value fit and an officially maintained Jest mock).

### 4.2 SecureKeyProvider

```ts
interface SecureKeyProvider {
  generateKey(keyId: string): Promise<Uint8Array>;                    // returns public key only
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  getPublicKey(keyId: string): Promise<Uint8Array | undefined>;
  delete(keyId: string): Promise<void>;
}
```

Hardware-backed (or platform-equivalent) non-exportable ML-DSA-44 keys. No method returns private key material under any circumstance. Used for the requester-side sub-card key (§7.1) and as a provider interface for offer construction when a caller (e.g., a press, a relay) has its own key to sign with. **Defaults:** non-extractable WebCrypto `CryptoKey` in IndexedDB on web (disclosed software-only posture, OQ-SDK-1); Secure Enclave (iOS) / StrongBox-backed `AndroidKeyStore` (Android) via `react-native-keychain` on RN.

**Server-side keystore decision (Resolved):** App SDK ships the `SecureKeyProvider`-shaped interface with no Node.js default implementation. Server-side integrators (press, wallet-service, relay) that need to sign outbound traffic supply their own `SecureKeyProvider` implementation, backed by a KMS, encrypted file storage, or other secret-management service as appropriate to their deployment model. This defers the choice of server-side keystore to integration time, per `plans/sdk-split-strategic-plan.md`'s resolved decision.

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

Abstracts WebAuthn registration/assertion. `prfOutput` (the WebAuthn PRF extension's evaluated output) is required in practice by wallet-side recovery flows (see `wallet_sdk.md` §7.1) — this package exports the interface for consistency with the other provider interfaces, but does not require or consume `PasskeyProvider` directly. **Defaults:** `navigator.credentials` on web; `react-native-passkey` on RN.

**Known gap, tracked (found during Step 3.2c scenario testing, not yet closed):** the shipped default web implementation, `WebAuthnPasskeyProvider` (`sdk-providers-web/src/PasskeyProvider.ts`), never requests or reads the WebAuthn PRF extension — `register()`/`assert()` never call `credential.getClientExtensionResults()`, so `prfOutput` is always `undefined` in their real return values, regardless of what the underlying authenticator ceremony actually supports. Since `wallet_sdk.md`'s `setupWallet`/`recoverWallet` hard-require a truthy `prfOutput` and throw without one, **the shipped default web `PasskeyProvider` cannot currently complete wallet setup or recovery in a real browser** — this is not a test-environment artifact (confirmed by reading the provider's source, not by a failing test alone; see `wallet-sdk/test/scenarios/setupWallet.web.test.ts`'s regression-guarded proof). Predates the SDK split — the same gap exists unchanged in `client-sdk-old/packages/client-sdk-web/src/PasskeyProvider.ts`, so this is not a regression introduced by the split, but it is a real, currently-open production blocker for any web integrator using the default provider. Closing it means adding a WebAuthn PRF extension request to `register()`'s/`assert()`'s `publicKey.extensions` and extracting the result via `getClientExtensionResults()` — scoped as follow-up work to `sdk-providers-web`, not App SDK itself (this package only defines the interface).

### 4.4 YubiKeyProvider

```ts
interface YubiKeyProvider {
  deriveWrappingKey(pin: string): Promise<Uint8Array>;
}
```

Added for optional YubiKey backup paths (see `wallet_sdk.md` §7.5). The provider *interface* is defined here for consistency with the other provider interfaces and to avoid duplicating interface definitions across packages. Only `@membership-card-protocol/wallet-sdk` actually uses this provider; app-side integrators do not. No concrete hardware-backed implementation exists yet on either platform — a real `YubiKeyProvider` (host-app-supplied or a future companion package) is expected to be injected by a wallet integrator that wants to offer this path.

### 4.5 RealtimeTransportProvider

Abstracts platform SSE/WebSocket for receiving real-time messages. Interface and both platform defaults exist; see `wallet_sdk.md` for details on consumption, which is platform-agnostic across both SDKs.

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

The oblivious-relay-backed HTTP client used for **every** press-facing sensitive/state-changing call (offer construction submission, sub-card registration) and private relay/messaging operations. Implemented once, in the core package (pure HTTP + HPKE, RFC 9180 — no platform-specific implementation needed): HPKE-encapsulates the request to the destination's published OHTTP key configuration, POSTs the opaque blob to the relay's oblivious-forwarding endpoint (`relay/`), and decapsulates the response.

The oblivious path is the default for every sensitive call — there is no separate "enable privacy mode" step. `bypass: true` exists for testing and for the press's public read endpoints, which never go through this transport at all.

Server-side counterparts (also implemented, in their own codebases, not part of this package): `relay/server/api/ohttp/[target_id].post.ts` (stateless pass-through forwarding), `press/server/api/ohttp/{key-config,gateway}.*.ts`.

---

## 5. Crypto and Canonicalization Core

*(Implemented — Phase 1, Step 1.3.)*

Thin wrappers, no independent implementation of any primitive:

| Function | Backing library | Used for |
|---|---|---|
| `canonicalize(obj)` | Vendored ~30-line RFC 8785 implementation, tested byte-identical against the verifier package's own copy | Every signed payload in this package |
| `keccak256(bytes)` | `@noble/hashes` | Address derivation (`address = keccak256(pubkey)`), binding checks |
| `hkdfSha3256(ikm, info, length?)` | `@noble/hashes` | General-purpose HKDF-SHA3-256 (message content-key derivation) |
| `mlDsa44GenerateKeypair` / `mlDsa44Sign` / `mlDsa44Verify` / `mlDsa44GetPublicKey` | `@noble/post-quantum` | Every ML-DSA-44 signing operation in this package |
| `mlKem768GenerateKeypair` / `mlKem768Encapsulate` / `mlKem768Decapsulate` | `@noble/post-quantum` | ML-KEM-768 (consumed by §9 for message encryption) |
| `hpkeGenerateKeyConfig` / `hpkeSeal` / `hpkeOpen` | `hpke-js` (RFC 9180) | `ObliviousProtocolTransport` (§4.7) |

Canonicalization output is tested against `specs/serialization-conformance.json` — the same conformance corpus the verifier package tests against.

---

## 6. Verifier Integration

*(Implemented — Phase 1, Step 1.4.)*

```ts
function createCardVerifier(options: CreateCardVerifierOptions): CardVerifier;
```

`CreateCardVerifierOptions` is `VerifierConfig` (from `@membership-card-protocol/verifier`) with `ipfs` optional, defaulting to `FilebaseIpfsProvider` from `@membership-card-protocol/verifier-ipfs-provider`. `rpc` is always required and host-app-supplied. One `CardVerifier` instance is constructed per distinct trust-root configuration and reused across calls. This factory is exported for use by any caller in either SDK that needs a `CardVerifier` — offer review (`wallet_sdk.md` §7.1), sub-card app-certification checks (`wallet_sdk.md` §6.1), and inbound message signature verification (§9.2) are each built on the same instance, constructed once per trust-root configuration and passed in rather than re-derived. This package never independently walks a chain, checks revocation, or evaluates policy compliance — those calls always go through `verifier.verifyCard()` / `verifier.verifyEnvelope()`, with the result surfaced unmodified.

---

## 7. Sub-Card Requests (Requester-Side)

*(Implemented — Phase 4. Module: `subcards/requester/` for §7.1; planned for §7.2.)*

### 7.1 Requester-Side Request (Implemented)

`subcards/requestSubCard.ts`: `requestSubCard(options): Promise<RequestSubCardResult>` — the general, third-party-app side of `subcards.md §Sub-Card Request Flow Step 1`. Generates a fresh, non-exportable ML-DSA-44 keypair via `SecureKeyProvider`, assembles the `SubCardDocument`, signs with the app's own card key → `app_signature`. Returns an `AppSignedSubCardDocument` (`holder_signature` deliberately absent — added later by the wallet via wallet-sdk's authorization flow) for the host app to transmit via whatever delivery channel it implements.

### 7.2 Signing Arbitrary Data with a Sub-Card (Implemented)

*(App-side primitive for proving sub-card ownership. Implemented in Phase 2.*)

```ts
function signWithSubCard(options: SignWithSubCardOptions): Promise<Uint8Array>;
```

A thin wrapper over `SecureKeyProvider.sign` — given a `keyId` (obtained from §7.1's request result or from a wallet's own sub-card registry), signs an arbitrary message and returns the ML-DSA-44 signature. Used by apps and wallet-side integrators that need to prove sub-card ownership without going through a full protocol flow (e.g., a relay proving it owns its own sub-card when talking to a wallet-service, or an app signing a challenge during app-to-wallet communication). Structurally identical to `SecureKeyProvider.sign` but operates at the App SDK surface level, inheriting the same "structured guarantees against key export" contract as any other this-SDK-visible function using secure keys.

### 7.3 Press Submission (Registration) (Implemented)

`subcards/pressSubmission.ts`:

```ts
function submitSubCardRegistration(document: SignedSubCardDocument, options: SubmitSubCardRegistrationOptions): Promise<SubCardRegistrationResult>;
function createPressSubCardRegistrar(options: SubmitSubCardRegistrationOptions): RegisterSubCardFn;
```

`POST /sub-card/register` (`press.md §5.4 processSubCardRegistration`), via `ObliviousProtocolTransport`. This is the registration half only — per `plans/sdk-split-implementation-plan.md` Step 2.2's salvage list, `subcards/pressSubmission.ts`'s registration functions are an App SDK capability, distinct from `subcards/revocation.ts`'s 8xx/9xx revocation, which is wallet-owned (`wallet_sdk.md` §6.4).

`createPressSubCardRegistrar` adapts the richer `SubCardRegistrationResult` to the exact `RegisterSubCardFn` shape that Wallet SDK's `countersignSubCardRequest` (`wallet_sdk.md` §6.3) and `registerDeviceSubCard` (`wallet_sdk.md` §5.4) each expect as an injected callback — both wallet-side functions call into this App SDK primitive rather than talking to the press directly, swallowing a failed submission into `{ registered: false }` rather than throwing, since both callers treat that as a normal outcome to report.

---

## 8. Card Offers (Offerer-Side)

*(Implemented — Phase 3. Module: `offers/`.)*

### 8.1 Offer Construction

`offers/targetedOffer.ts`: `assembleAndSignTargetedOffer(options): Promise<SignedTargetedOffer>` — the offer-phase `CardDocument` (`card_offering_and_acceptance.md §Phase 3`): protocol-required fields (`policy_id`, `issuer_card`, `press_card`, `issued_at`, `ancestry_pubkeys`, `past_keys` if applicable) merged with caller-supplied policy-defined field values, signed with `issuer_signature`. `recipient_pubkey`/`holder_signature`/`press_signature`/`protocol_version` are absent, matching the offer phase. Requires the issuer's own card key via `SecureKeyProvider`.

`offers/openOffer.ts`: `assembleAndSignOpenOffer(options): Promise<AssembleOpenOfferResult>` — `OpenCardOffer` (`open_offer_creation.md §Phase 1–2`), plus `offerId = keccak256(canonicalize(complete signed document))` and the short-form claim link (`mcard://claim?o=<base64url of canonical offer bytes>`). Enforces `expires_at` must be future if set, and requires `acknowledgeUnconstrained: true` when both `max_acceptances`/`expires_at` are unconstrained.

Both functions accept a `SecureKeyProvider` + `keyId` for "the offerer's own card key," rather than assuming a specific card — matching the pattern that routine signing never touches a master key.

**Wallet SDK responsibility:** Reviewing a received offer (the pre-display verification gate: keccak256 binding check, `issuer_signature` verification, chain/revocation status via `CardVerifier.verifyCard()`, and authoritative on-chain press authorization) and countersigning it (creating the new keypair, persisting it via the "persist before sign" invariant, and signing back to the press) are both fully wallet-owned — see `wallet_sdk.md` §7 (`offers/offerVerification.ts` and `offers/countersign.ts`, both Wallet SDK modules, not App SDK ones).

### 8.2 Offerer-Side Press Finalization

`offers/targetedOfferAcceptance.ts`, implementing the offerer-side half of `card_offering_and_acceptance.md §Phase 5–6`:

```ts
function forwardCountersignedTargetedOffer(options): Promise<ForwardTargetedOfferResult>;
```

The offerer reconstructs the signed payload from the offer *the offerer itself issued* plus only `recipient_pubkey`/`holder_signature` from whatever the recipient sent back — every other field is read from the offerer's own trusted copy, so a tampered echoed-back field can never reach the press even via an untrusted intermediary. Submits the completed `CardDocument` to `POST /issue/finalize` via `ObliviousProtocolTransport`.

**Wallet SDK responsibility:** The *recipient-side* `acceptTargetedOffer` function, which reviews the offer and produces the `recipient_pubkey`/`holder_signature` half (including generating and persisting the new per-card keypair via `offers/countersign.ts`'s "persist before sign" helper), is entirely wallet-owned — see `wallet_sdk.md` §7.

---

## 9. Messaging and UUID/Relay Management

*(Implemented — Phase 5. Module: `messaging/`.)*

### 9.1 Message Envelope Construction and Per-Subcard Fan-out (Implemented)

`messaging/envelope.ts`:

```ts
function buildMessagePayload<T extends MessageType>(options: BuildMessagePayloadOptions<T>): MessagePayload<T>;
function signMessageEnvelope<T extends MessageType>(payload: MessagePayload<T>, signers: EnvelopeSigner[]): Promise<CardMessageEnvelope<T>>;
function messageId(payload: MessagePayload): string;
```

`MessageType` is a literal union of exactly this SDK's in-scope taxonomy (`messaging_protocol.md`): `text`, `reply`, `edit`, `reaction`, `read_receipt`, `card_offer`/`card_offer_accepted`/`card_offer_declined`, `card_update_notification`, `auth_request`/`auth_response`. Every other taxonomy entry is out of scope — the literal union makes constructing an out-of-scope-typed envelope a compile error.

`buildMessagePayload` enforces structural constraints at construction time: `edit_of`/`retracts`/`forwards` are mutually exclusive, `edit` requires `edit_of`, `type: edit` with `retracts` set is rejected, and `reply` requires `in_reply_to`. Optional fields are omitted entirely when absent (never `null`).

`messageId(payload) = keccak256(canonicalize(payload))` — no separate `id` field, matching the spec; used for dedup and edit-chain root derivation.

`messaging/fanout.ts`: `fanOutMessageToSubCards(recipientCardHash, envelope, subCards): RoutingEnvelope[]` — implements `message_routing.md §Sender-Side Fan-out`: encrypts the same `CardMessageEnvelope` independently to each sub-card's ML-KEM-768 public key, producing one distinct `RoutingEnvelope` per sub-card — never one ciphertext copied N times. See `wallet_sdk.md` for the helper that resolves a holder's active sub-cards from the on-chain `active_subcards` directory.

### 9.2 Inbound Message Verification and Decryption (Implemented)

`messaging/inbound.ts`:

```ts
function handleInboundRoutingEnvelope(options: HandleInboundRoutingEnvelopeOptions): Promise<InboundResult>;
```

Decrypts a `RoutingEnvelope` via `decryptRoutingEnvelope`, then verifies the recovered `CardMessageEnvelope`'s signature(s) via the shared `CardVerifier`'s `verifyEnvelope()` — never a hand-rolled signature check. Returns a discriminated union: `{ accepted: true, envelope, messageId, verification, duplicate }` or `{ accepted: false, code, reason }`.

Deduplication by `messageId(payload)` against a `StorageProvider`-backed history: a retransmitted duplicate is detected and reported via `duplicate: true` on the *second* delivery, with exactly one write ever made for that ID.

Message-type-specific handling helpers — `editTarget`, `reactionTarget`, `retractionTarget`, `resolveEditRoot` — derive the piece of state each type's linking rule needs without owning any durable message-history store themselves.

### 9.3 UUID Registration, Session Separation, and Staggering (Implemented)

`messaging/uuidRegistration.ts`:

```ts
function registerCardUuids(options: RegisterCardUuidsOptions): Promise<RegisterCardUuidsResult>;
function registerMultipleCardsUuids(options: RegisterMultipleCardsUuidsOptions): Promise<CardUuidRegistrationOutcome[]>;
```

`registerCardUuids` implements `notification_relay.md §Process 1` step 6: `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` with a signed envelope proving control of the subcard, via `ObliviousProtocolTransport`. Its option shape names exactly one `cardHash`/`subCardHash`/`uuids` triple — there is no parameter through which a second card could be named in the same call, per `§Registration Privacy`'s explicit requirement that batching multiple cards' registrations into one session or message is not permitted.

`registerMultipleCardsUuids` — the only entry point handling more than one card, as a device-local orchestration loop only — accepts an `ObliviousProtocolTransportFactory` rather than a shared transport instance, and calls it once per card, so each card's registration runs against a freshly constructed transport with its own session.

**Staggering:** inserts a randomized delay between successive cards' sessions, confirmed by a test.

### 9.4 Replenishment Scheduling (Implemented)

`messaging/replenishment.ts`:

```ts
class ReplenishmentScheduler {
  reportPoolStatus(status: PoolStatus): void;
  isScheduled(subCardHash: string): boolean;
  cancel(subCardHash: string): void;
  cancelAll(): void;
}
```

Implements `notification_relay.md §Replenishment`: proactive UUID pool replenishment when a subcard's pool drops to a threshold, on a randomized schedule, never immediately after message receipt. The anti-correlation requirement is structural: `reportPoolStatus` (called on every event that changes a pool's size) never invokes `onReplenish` synchronously or on the same tick — crossing the threshold only ever schedules a callback at a randomized future delay.

### 9.5 Realtime Delivery (Implemented)

`messaging/delivery.ts`:

```ts
function openDeviceSse(options: SseConnectionOptions): SseConnectionHandle;
function openCardWebSocket(options: WebSocketSessionOptions): WebSocketSessionHandle;
function fetchPending(options: FetchPendingOptions): Promise<DeliveredBlob[]>;
function ack(options: AckOptions): Promise<void>;
```

Covers all three delivery paths over the injected `RealtimeTransportProvider`: `openDeviceSse`, `openCardWebSocket`, and `fetchPending`. Central invariant: `ack` is the *only* function in this module that can trigger the relay's staggered wallet-clearance, and none of the three delivery functions ever calls it — each simply forwards a `DeliveredBlob` to the caller's `onDelivered` callback and returns. This is the device-side mirror of `message_routing.md`'s "wallet services must not clear messages based solely on relay delivery."

### 9.6 UUID Pool Deregistration (Implemented)

`messaging/uuidDeregistration.ts`:

```ts
function deregisterCardUuids(options: DeregisterCardUuidsOptions): Promise<DeregisterCardUuidsResult>;
```

`DELETE /cards/{card_hash}/subcards/{subcard_hash}`, structurally identical to `uuidRegistration.ts`'s `registerCardUuids` minus the `uuids` field. Succeeds or fails as a discriminated `{ deregistered: boolean }` result rather than throwing, since an invalid signature, an already-deregistered subcard, or a subcard never registered (each surfaced by the wallet service as 400/401/403/404) are all expected outcomes to report.

**Explicitly not on-chain sub-card revocation.** This function has no relationship to sub-card revocation (8xx/9xx codes, per `wallet_sdk.md` §6.4) — no shared code, no shared on-chain state. Wallet-service-local deregistration only empties this wallet service's UUID pool for the subcard.

---

## 10. Cross-Platform Hardening and Documentation (Planned)

*(Implementation-plan Phase 6. Not yet started.)*

Will cover: running every prior phase's scenario against real (non-stub) local endpoints on both platforms; validating `ObliviousProtocolTransport` against real deployed OHTTP endpoints; integrator documentation (README, per-provider integration guides, worked examples); and Clarification Checkpoint CP-2, a pre-production security review — covering the persist-before-sign invariant's bypass-resistance, `SecureKeyProvider` non-exportability on both platforms, and confirming no derived key or private key material appears in any log output.

---

## 11. Security Invariants

Cross-cutting properties this package maintains:

- **No verification logic is re-derived outside `CardVerifier` calls** (§6) — chain walking, revocation checking, and policy-compliance evaluation are delegated entirely to the shared verifier instance.
- **`SecureKeyProvider` never returns private key material**, on any platform, for any key it manages (requester-side sub-card, offer-construction key).
- **No part of this SDK ever touches a card's master private key, backup material, or `decryption_key`** — these are purely Wallet SDK concerns. This includes offer *countersigning*: this package never generates, persists, or signs with a per-card acceptance keypair — that entire flow, including the "persist before sign" invariant, is implemented in `offers/countersign.ts`, which lives in Wallet SDK, not here. See `wallet_sdk.md` §7.1 and §10.
- **No key derivation input is ever also transmitted to a party the derivation must stay secret from** — see `wallet_sdk.md` §10 for the full analysis.

---

## 12. Result and Error Conventions

Functions that gate on a verification step return a discriminated union (`{ approved: true, ... } | { approved: false, code, reason }`) rather than throwing on an expected rejection condition. A thrown exception is reserved for conditions the caller could not have anticipated from the inputs alone (network/transport failure, malformed response) — even a `CardVerifier` internal error is caught and surfaced as a typed rejection where a hard-rejection code exists for "verification failed," so callers can pattern-match on outcome rather than wrapping every call in `try`/`catch`.

---

## 13. Implementation Status

| Phase | Step | Status |
|---|---|---|
| 1 | 1.1–1.7 (workspace, providers, crypto, verifier integration, oblivious-relay transport, platform defaults, CI) | **Implemented** |
| 3 | 3.1 Offer construction | **Implemented** |
| 3 | 3.6 Targeted offer acceptance + finalization (offerer-side) | **Implemented** |
| 4 | 4.1 Requester-side sub-card request | **Implemented** |
| 4 | 4.4 Press submission (registration half — `submitSubCardRegistration`/`createPressSubCardRegistrar`) | **Implemented** |
| 5 | 5.1 Message envelope construction and per-subcard fan-out | **Implemented** |
| 5 | 5.2 Inbound message verification and decryption | **Implemented** |
| 5 | 5.3 UUID registration with session separation and staggering | **Implemented** |
| 5 | 5.4 Replenishment scheduling | **Implemented** |
| 5 | 5.5 Realtime delivery (SSE, WebSocket, push catch-up) | **Implemented** |
| 5 | 5.6 UUID pool deregistration | **Implemented** |
| 6 | 6.1–6.3 + CP-2 (cross-platform hardening, docs, pre-production review) | **Not started** |
| 4 | 4.2 Signing arbitrary data with a sub-card | **Implemented** |

As of this writing: 243 tests pass in the original unified client-sdk core package; the split preserves this test count across app-sdk and wallet-sdk halves, with redistribution of tests to match capability ownership.

---

## 14. Dependencies

| Package | Used for |
|---|---|
| `@noble/post-quantum` | ML-DSA-44, ML-KEM-768 |
| `@noble/hashes` | keccak256, HKDF-SHA3-256 |
| `@noble/ciphers` | AES-256-GCM (message encryption) |
| `hpke-js` | HPKE (RFC 9180) for `ObliviousProtocolTransport` |
| `@membership-card-protocol/verifier` | `CardVerifier` — chain walking, revocation, signature verification |
| `@membership-card-protocol/verifier-ipfs-provider` | Default `IpfsProvider` (Filebase-backed) |
| `@react-native-async-storage/async-storage` (RN only, via platform package) | Default `StorageProvider` |
| `react-native-keychain` (RN only, via platform package) | Default `SecureKeyProvider` |
| `react-native-passkey` (RN only, via platform package) | Default `PasskeyProvider` |
| `react-native-sse` (RN only, via platform package) | Default `RealtimeTransportProvider`'s SSE half |

No bundled RPC client is included — `RpcProvider` is always host-app-supplied.

---

## 15. Resolved Design Decisions

Carried forward from `plans/sdk-split-strategic-plan.md`'s resolved decisions and `plans/client-sdk/strategic-plan.md`'s open questions; treated as fixed unless a later phase surfaces a reason to revisit.

| ID | Decision |
|---|---|
| OQ-SDK-1 | Web `SecureKeyProvider`: non-extractable WebCrypto `CryptoKey` in IndexedDB (software-only, disclosed gap vs. native). |
| OQ-SDK-4 | Network-level privacy for press and relay traffic: oblivious-relay (HPKE + relay forwarding), not Tor. See §4.7. |
| OQ-SDK-5 | Local persistence: App SDK imports `StorageProvider`; platform packages supply IndexedDB (web), AsyncStorage (RN) defaults. |
| OQ-SDK-6 | Verifier dependency: `@membership-card-protocol/verifier` consumed as a normal pinned npm dependency. |
| OQ-SDK-7 | Wallet-service federation: single preferred base URL per SDK configuration; no federation peer-list/retry logic in this package. |
| OQ-SDK-8 | Multi-tab coordination: `BroadcastChannel`-based on web (via shared platform package); not applicable on RN. |
| OQ-SDK-9 | Sub-card request transport/UI: this package exposes only a validation entry point and requester-side request construction (§7.1); no owned deep-link transport, no shipped consent UI. |
| OQ-SDK-10 | Requester-side sub-card flow: in scope (§7.1). Requester and granter are both expected to run this SDK (on the granter side as part of Wallet SDK). |
| OQ-SDK-11 | Annotation-board integration: out of scope for now. `fetchAnnotations: false` throughout. |
| Split-SDK-2 | Server-side keystore: interface only. App SDK ships the `SecureKeyProvider`-shaped interface with no Node default implementation. |
| Split-SDK-3 | Device sub-card collapse: Wallet SDK's device sub-card registration is a thin wrapper calling App SDK's ordinary `requestSubCard` + self-authorizing consent/countersign internally. See `wallet_sdk.md` §7. |
| Split-SDK-4 | YubiKeyProvider placement: interface stays in App SDK for consistency with other providers; only Wallet SDK actually uses it (backup path). |

---

## 16. Related Specs

- `specs/process_specs/card_offering_and_acceptance.md`, `open_offer_creation.md` — §8
- `specs/subcards.md`, `specs/process_specs/subcard_creation_policy.md` — §7
- `specs/messaging_protocol.md`, `specs/process_specs/message_routing.md`, `specs/process_specs/notification_relay.md` — §9
- `specs/object_specs/card_verifier.md` — §6
- `specs/object_specs/press.md` — the press-side counterpart to §8's press-facing calls
- `specs/object_specs/wallet_sdk.md` — wallet-side (custody/authorization) counterpart; imports and depends on this package
- `specs/ARCHITECTURE.md` — ADR-004 (canonicalization/signing), ADR-006 (content encryption), ADR-007 (OHTTP)
- `plans/sdk-split-strategic-plan.md` — the source plan for this split
- `plans/client-sdk/strategic-plan.md`, `plans/client-sdk/implementation-plan.md` — the unified-SDK plans both packages derive from
