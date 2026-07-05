# Client SDK — Strategic Plan

**Date:** 2026-07-03
**Status:** Draft
**Companion document:** [implementation-plan.md](./implementation-plan.md)
**Spec references:**
- `specs/process_specs/card_offering_and_acceptance.md`
- `specs/process_specs/open_offer_creation.md`
- `specs/process_specs/open_offer_acceptance_new_wallet.md`
- `specs/process_specs/open_offer_acceptance_existing_wallet.md`
- `specs/process_specs/wallet_backup_and_recovery.md`
- `specs/messaging_protocol.md`
- `specs/process_specs/message_routing.md`
- `specs/process_specs/notification_relay.md`
- `specs/process_specs/oblivious_transport.md`
- `specs/object_specs/relay.md`
- `specs/object_specs/press.md`
- `specs/object_specs/card_verifier.md`
- `specs/subcards.md`
- `specs/process_specs/subcard_creation_policy.md`
- `specs/process_specs/card_updates.md`
- `specs/ARCHITECTURE.md`

---

## What This SDK Is

The client SDK (`@membership-card-protocol/client-sdk`) is the single library that a website frontend or a React Native app links against to perform every on-device function the protocol specs assign to "the client" or "the holder's device." It is the counterpart, on the holder's side, to the wallet-service backend (`plans/wallet-service/`) and the press (`press/`) — where those services implement the always-online, server-side half of each flow, this SDK implements the holder-side half: key generation, local key storage orchestration, offer review and countersigning, keyring encryption, message encryption, and relay/UUID bookkeeping.

Four functional areas, per the request that scoped this plan:

1. **Card offer creation and acceptance**, including the keypair generation each flow requires (fresh per-card keypair, device sub-card keypair, master keypair on first wallet setup).
2. **Backup encryption, sending, and retrieval** — wrapping the keyring decryption key under a synced passkey and/or YubiKey, registering with the backup service, and running the recovery flow.
3. **Sending and receiving messages**, including the UUID pool lifecycle needed to receive them privately through the relay.
4. **Submitting accepted offers to a press** — both targeted (`card_offering_and_acceptance.md`) and open-offer (`open_offer_acceptance_*.md`) claim submission.
5. **Requesting, accepting, and revoking sub-cards** (`specs/subcards.md`) — both directions the wallet plays: acting as the *requesting app* when the wallet mints its own device sub-card at setup (`subcards.md`'s "wallet self-signing" path), and acting as *the wallet* that receives a third-party app's sub-card request, validates the app card's certification chain, presents the capability whitelist for user consent, countersigns with the primary card key, and later revokes (8xx) or deregisters the sub-card, including the primary-key-signed deregistration and post-recovery mass-deregistration flows in `subcards.md §Deregistration After Key Recovery`. **Out of scope for now:** the EAS third-party annotation-board layer (`subcards.md §Ongoing Compliance`) — advisory/blocking annotation lookups and annotation-triggered auto-revocation are deferred; see OQ-SDK-11.

A sixth area follows directly from the above and is treated as first-class scope, not an add-on: **verification is delegated to `@membership-card-protocol/verifier`**, the existing package the press already uses (`press.md §5.0`). The SDK does not reimplement chain-walking, revocation checking, or policy-compliance evaluation — every point in the specs where the client must verify something before displaying or trusting it (offer issuer chain, press authorization, recipient predicate, message sender, **and an app card's certification chain before countersigning a sub-card request**) goes through a `CardVerifier` instance the SDK constructs and owns, exactly as the press does. (Annotation-lookup, `verifyCard`'s Stage 6, is not invoked for now — see OQ-SDK-11.)

A seventh, cross-cutting concern applies to nearly every wallet-service-*and press*-facing call the SDK makes, not just messaging: **the device must be able to talk to its wallet service, and directly to a press during card creation and card/sub-card updates, without either operator learning the device's network identity.** This plan originally scoped that as Tor integration, then as a wallet-service-only oblivious-relay redesign; it now covers presses too, since the client talks directly to a press for claim submission, update intents, and sub-card registration/deregistration (the wallet service explicitly does not proxy this — see `plans/wallet-service/strategic-plan.md`'s "What this service explicitly does NOT do"), which is the same IP-correlation exposure in a different direction. See Goal 7 below and OQ-SDK-4.

**What this SDK explicitly does NOT do:** hold any card holder's private key on a server, run the wallet service's routing/backup/relay endpoints (those are `plans/wallet-service/` and `relay/`), or perform press-side validation (that's `press/`). It is a client library — everything it does executes inside the holder's browser tab or the RN app process, calling out to whichever wallet service, relay, and press endpoints the consuming app configures. For sub-cards specifically, this SDK implements the **wallet's** side of the protocol (validate, consent, countersign, revoke/deregister) plus the wallet's own self-issued device sub-card; whether it also needs to serve a **third-party app's** side of that same flow (generating a hardware-backed keypair via `card-keystore-lib` to request a sub-card *from* some other wallet) is an open question — see OQ-SDK-10.

---

## Goals

### 1. One SDK, two runtimes, no forked protocol logic

A developer building either the reference web wallet or a React Native wallet app should be able to import one package and get correct, spec-conformant behavior for every flow in scope — without the protocol logic (canonicalization, signing order, key derivation, envelope construction) being duplicated or subtly diverging between a web build and a native build.

### 2. Correct key generation and custody at every step the specs require it

Every flow that mints a keypair — master card key at first setup, device sub-card key per device, fresh per-card key at each offer acceptance, fresh per-card key at each open-offer claim — must generate the right key at the right time, store it through the right abstraction (keyring for recoverable keys, secure device storage for the sub-card key), and never leave a private key in a state where it could be lost before it's durably recoverable (specs are explicit that the new card's private key must be in the keyring *before* countersigning).

### 3. Backup and recovery that matches the spec's security model exactly

`wallet_backup_and_recovery.md`'s security guarantee — that neither the passkey output nor `service_secret` alone can decrypt the keyring — depends entirely on the client performing key derivation, wrapping, and unwrapping exactly as specified. An SDK bug here (e.g., caching a derived key insecurely, or wrapping with the wrong input) silently breaks a security property the rest of the protocol assumes holds.

### 4. Privacy-preserving messaging that upholds the unlinkability contract

`notification_relay.md` places real weight on the client: per-card session separation, staggered registration timing, and (by default, not opt-in) anonymizing transport for wallet UUID registration. These aren't relay or wallet-service behaviors — they're client behaviors the spec assumes the client enforces. If the SDK batches registrations or skips staggering to simplify the implementation, it breaks a privacy property the server-side specs were carefully designed around.

### 5. Sub-card requests, acceptance, and revocation handled correctly in both directions

The wallet plays two distinct roles in the sub-card protocol (`subcards.md`), and the SDK must implement both without conflating them: it is *a* requesting app when it mints its own device sub-card at setup (the "wallet self-signing" path, no user consent step), and it is *the* wallet of record for every other app's sub-card requests — the party that validates the requesting app's certification chain, surfaces the capability whitelist for user consent, countersigns with the primary card key, and later revokes or deregisters. Getting this wrong in either direction is a real security gap: skipping app-chain validation on inbound requests means countersigning delegations to potentially uncertified apps; mishandling the wallet's own self-signing path means either an unnecessary consent prompt for an operation the user already implicitly authorized, or (worse) skipping a check that should still apply.

### 6. Verification the client can trust, without re-deriving trust logic

Chain walking, revocation checking, and policy compliance are exactly the kind of logic that must not silently diverge between the verifier package, the press, and the client — a client that reimplements this independently risks disagreeing with the press about whether an offer, message, or sub-card request is valid, in either direction (falsely trusting something the protocol would reject, or falsely rejecting something valid). Reusing `@membership-card-protocol/verifier` as the client's verification engine keeps one source of truth for "is this card/chain/signature valid" across every component in the system — including the app-card certification chain check that gates every inbound sub-card request. (Third-party annotation lookup, the verifier's Stage 6, is out of scope for now — see OQ-SDK-11.)

### 7. Network-level privacy for wallet-service *and press* facing traffic, without a Tor dependency

Almost every call this SDK makes to a wallet service — account creation, `service_secret` retrieval, keyring updates, backup registration/recovery, sub-card registration/deregistration, UUID pool registration — currently assumes a direct HTTPS connection from the device. The same is true of the calls the SDK makes directly to a press during card creation and updates: claim submission, targeted-offer finalization, card update/revocation intents, and sub-card registration/deregistration submission. In both cases, the operator on the other end sees the device's IP address on every call, regardless of how carefully the *content* of those calls is protected. This goal covers eliminating that exposure structurally, for both classes of traffic, rather than treating the press as a separate problem from the wallet service just because it's a different service. See Goal 4 for the separate (and still-required) content/timing-level unlinkability work, and OQ-SDK-4 for the resulting oblivious-relay design and its press extension.

---

## Rationale

### Why one SDK instead of two platform-specific implementations

The protocol's cryptographic primitives (ML-DSA-44, ML-KEM-768, keccak256, HKDF-SHA3-256, AES-256-GCM, RFC 8785 canonicalization) are all pure-JS-implementable via `@noble/*` packages with no native bindings required — the verifier package already establishes this precedent (`card_verifier.md §12`). That means the actual protocol logic (assembling documents, deriving keys, canonical signing, envelope construction) has no reason to differ between web and React Native. The only things that legitimately differ between the two runtimes are I/O primitives: secure key storage, platform passkey/WebAuthn APIs, and realtime transport (native `EventSource`/`WebSocket` on web vs. RN equivalents). Isolating exactly those three concerns behind injected provider interfaces — the same architectural pattern the verifier package already uses for `RpcProvider`/`IpfsProvider` (`card_verifier.md §2, §4`) — lets one SDK core run correctly on both platforms.

### Why key generation timing is a strategic concern, not an implementation detail

Several specs call out a specific ordering constraint: the new card's private key goes into the keyring *before* the client countersigns (`card_offering_and_acceptance.md` step 15, `open_offer_acceptance_new_wallet.md` step 11, `open_offer_acceptance_existing_wallet.md` step 6), specifically so the key is recoverable via backup even if the device is lost between signing and card receipt. This is easy to get backwards if the SDK's internal state machine is designed around "sign, then persist" instead of "persist, then sign" — and the failure mode (an unrecoverable, already-committed card) is not something a later patch can fix. This ordering has to be a designed-in invariant of the SDK's offer-acceptance state machine, not something left to each call site to remember.

### Why backup/recovery correctness is worth calling out separately from "implement the spec"

The whole security model in `wallet_backup_and_recovery.md` rests on `decryption_key = KDF(device_passkey_output, service_secret)` being computed identically, every time, from primitives that never touch the network in plaintext. The SDK is the only place this computation happens — the wallet service only ever sees `service_secret` and opaque wrapped blobs, never `decryption_key` or the passkey output. Any client-side deviation here (wrong KDF, wrong input order, memory retention beyond the spec's "clear master key from memory after signing" instruction) is invisible to server-side testing and only shows up as a security incident. This is why backup/recovery gets Phase-level attention and its own clarification checkpoint in the implementation plan, not just a spec-to-code translation pass.

### Why sub-card request handling belongs in the SDK core rather than being left to each host app

`subcards.md` places specific, security-relevant obligations on "the wallet": verify `app_signature`, apply both keccak256 binding checks, walk the app card's chain to the governance app-certification root, check the app card's revocation log, and only then present consent and countersign (`subcards.md §Sub-Card Request Flow` Steps 2–4). (The same flow also calls for querying the EAS annotation board before presenting consent; that check is deferred for now per OQ-SDK-11, so this plan's v1 validation gate is signature + binding checks + chain walk + revocation log only — not annotation standing.) If each host app (web wallet, RN wallet) reimplemented this validation sequence independently, the risk is the same as with chain verification generally: one implementation skips a check, or gets the binding-check order wrong, and silently countersigns a delegation it shouldn't have. This is exactly the class of logic this plan already commits to centralizing (see Goal 6) — the sub-card acceptance flow is not a new architectural pattern, it's another consumer of the same `CardVerifier` instance, configured with the governance app-certification policy root as a trusted root, the same way the press's `verifyAppCertificationChain` (`press.md §5.4`) already does it server-side. The SDK's job is to run that check, refuse to countersign on failure, and hand the host app only the validated capability whitelist and app identity needed to render a consent screen — not to leave the validation itself as an exercise for whoever builds the UI.

The revocation and deregistration half of this is equally spec-heavy: an 8xx revocation may be signed by either the user's active sub-card or the app's installation card (`subcard_creation_policy.md §Revocation — 8xx`), but on-chain deregistration always requires the **primary card key**, routed through a press, with gas sponsored by the app or (if the app's balance is insufficient) by the issuing press so that deregistration is never blocked (`subcards.md §Authorization for Deregistration`). Post-recovery, every existing sub-card should be treated as suspect and re-authorized (`subcards.md §Deregistration After Key Recovery`) — a batch operation the SDK needs to support directly, since it follows the same recovery flow this plan already covers under Goal 3.

### Why the SDK is responsible for enforcing relay privacy behaviors, not just calling the relay's API

`notification_relay.md §Registration Privacy` is explicit that per-card session separation and timing stagger are the *client's* responsibility — the relay and wallet service can't enforce this from their side because, from their side, a batched registration and a staggered one are indistinguishable in terms of what data crosses the wire per request. If the client SDK exposes a naive `registerAllCards()` convenience method that happens to fire requests back-to-back, it silently defeats the unlinkability property multiple other specs were designed around, even though every individual API call is spec-compliant. This means the SDK's relay-facing module needs its own scheduling/session logic, not just thin HTTP wrappers — this holds regardless of which transport carries the requests (see Goal 7 for the transport-level, IP-hiding half of this problem, which is separate from and doesn't substitute for this content/timing-level unlinkability work).

### Why network-level privacy is redesigned around the relay + OHTTP instead of Tor

The original plan for hiding the device's network identity from the wallet service was Tor integration (per `notification_relay.md §Registration Privacy`'s framing of Tor as the expected default transport). On reflection, that requirement is really an instance of a problem the protocol already has a first-class answer for elsewhere: `ARCHITECTURE.md` ADR-007 and `message_routing.md §Transport Extensibility` already define OHTTP (RFC 9458) as an optional upgrade for wallet-to-wallet message routing, specifically because it hides the requester's network identity from the destination by routing an encrypted request through a relay that can't read it. Applying the same primitive to *device-to-wallet-service* traffic — not just wallet-to-wallet — turns out to be a better fit than Tor for this SDK's actual constraints: it's plain HTTPS plus an HPKE encryption step (no native SOCKS proxy, no per-platform asymmetry, no circuit-build latency, no app-store scrutiny of embedded proxy behavior), and it reuses infrastructure (the relay) this system already operates, rather than depending on the health of an external, un-owned network. See Goal 7 and OQ-SDK-4 for the resulting design.

### Why this same mechanism extends to direct client-to-press traffic, not just the wallet service

Once the oblivious-relay mechanism exists, restricting it to "wallet-service-facing" traffic only would be an arbitrary line, not a principled one. The client SDK talks directly to a press for exactly the same reason it talks directly to the wallet service — because the wallet-service spec explicitly excludes press communication from its own scope, leaving the device as the party that makes those calls (`plans/wallet-service/strategic-plan.md`'s "What this service explicitly does NOT do" lists "card offer construction, press communication... On-device card operations stay on-device"). A press operator watching its own access logs is in exactly the same position the wallet-service operator would have been in without Goal 7: able to correlate a device's IP with which policies it creates cards under, how often, and when — even though the press already necessarily sees card *content* in plaintext to validate it (that's a separate, accepted property of the press's role, not something this goal tries to change). Extending the same transport to the press's sensitive endpoints closes this gap using the identical mechanism, not a second bespoke one — one client-side abstraction, parameterized by destination, rather than a wallet-service-specific one and a press-specific one built independently.

### Why verification goes through the existing verifier package instead of a client-side reimplementation

`card_verifier.md` already defines exactly the chain-walk, revocation, and policy-compliance logic the client needs at several points: verifying an offer's issuer chain before display (`card_offering_and_acceptance.md` step 12, `open_offer_acceptance_new_wallet.md` step 2), verifying a press's on-chain authorization before trusting an offer, and (per this plan's explicit added scope) verifying inbound messages and card presentations generally. The press already consumes this package this way (`press.md §5.0`) rather than reimplementing the checks locally, specifically so that verification logic has one implementation shared across every component that needs it. The SDK should follow the same pattern: construct a `CardVerifier` once, with client-appropriate `RpcProvider`/`IpfsProvider` implementations (likely the existing `@membership-card-protocol/verifier-rpc-provider` and `-ipfs-provider` companion packages, or thin wrappers suited to a browser/RN network stack), and call `verifier.verifyCard()` / `verifier.verifyEnvelope()` wherever the specs call for chain or signature verification. Reimplementing any of this independently in the SDK would create a second, divergence-prone copy of security-critical logic.

---

## Key Objectives

### Goal 1: One SDK, two runtimes

- A single `@membership-card-protocol/client-sdk` package (plus any thin platform-adapter packages it requires) builds and passes its full test suite in both a browser (or browser-like, e.g. jsdom/Playwright) environment and a React Native (or React Native-simulated, e.g. Hermes) environment.
- No protocol-logic file (canonicalization, signing, envelope construction, key derivation) contains a platform branch (`if (Platform.OS === ...)` or `typeof window`); all platform variance is confined to injected provider implementations.
- The same integration test scenario (e.g., "create wallet → accept open offer → send a message") passes against both a web test harness and an RN test harness using the same core SDK calls.

### Goal 2: Correct key generation and custody

- Every keypair-generating operation in scope (master keypair, device sub-card keypair, per-card acceptance keypair, per-open-offer-claim keypair) is implemented as a single, spec-cited function with a test asserting it is called exactly once per flow and never reused across cards (per the explicit "do not reuse" instructions in `open_offer_acceptance_existing_wallet.md` step 5 and elsewhere).
- A test suite asserts the "persist before sign" ordering: for every keypair generated during offer acceptance, the keyring update (or keyring-blob-pending-write state) completes before the corresponding countersignature is produced.
- Device sub-card keys are only ever handled through the injected secure-storage provider interface — no code path holds a sub-card private key in a plain JS variable longer than the single signing operation that needs it.

### Goal 3: Backup/recovery correctness

- The KDF computation (`decryption_key = KDF(device_passkey_output, service_secret)`) and both wrapping paths (synced-passkey, YubiKey) each have unit tests with fixed test vectors confirming byte-for-byte reproducibility.
- An end-to-end test drives the full recovery flow against a stub backup service: registration → simulated 72-hour release → keyring fetch from a non-primary federation member → decryption → re-registration — and confirms the recovered keyring matches the original.
- A security-focused review (this plan's Clarification Checkpoint CP-1) confirms no derived key or passkey output is logged, retained beyond the operation that needs it, or transmitted anywhere.

### Goal 4: Privacy-preserving messaging

- UUID registration for two different cards on the same device, in an integration test, never appears in the same HTTP session/connection and is separated by the SDK's configured stagger window — verified by inspecting request-level session/connection identity in the test harness.
- The relay module exposes no "register all cards" convenience API that would make batching the default, easy path.
- A message sent to a card with multiple registered sub-cards produces one independently-encrypted envelope per sub-card (per `message_routing.md §Sender-Side Fan-out`), verified by a test that confirms N distinct ciphertexts for N sub-cards, not one ciphertext replicated N times.
- UUID pool replenishment triggers on the spec's threshold (≤3 remaining) and on a randomized schedule, never immediately after message receipt (per `notification_relay.md`'s explicit anti-correlation instruction).

### Goal 5: Sub-card request, acceptance, and revocation

- Inbound sub-card requests are rejected (no consent prompt shown) if any of the following fail, each backed by a test with a deliberately malformed fixture: `app_signature` verification, either keccak256 binding check (`holder_primary_card_pubkey`, `app_card_pubkey`), or the app card's chain reaching the governance app-certification root via the shared `CardVerifier`.
- A test confirms the wallet's own device-sub-card self-signing path (`subcards.md`'s "wallet self-signing exception") skips the user-consent prompt but still runs every other validation step (chain walk, revocation check) identically to a third-party request.
- The consent data handed to the host app for rendering (app identity, requested vs. grantable capabilities, `valid_until`) is a single typed structure produced by the SDK — no host app needs to independently re-derive app identity or capability labels from raw chain data. (Annotation-board status is omitted from this structure for now, per OQ-SDK-11 — the field can be added back without breaking the shape when that work is picked up.)
- User-initiated (8xx, code 801) and app-initiated (8xx, code 811) revocation are both implemented and tested; both correctly use whichever active signing key (user's current sub-card, or the app's installation card) `subcard_creation_policy.md` authorizes for that revocation type — the SDK never attempts a 9xx revocation, which is out of scope by design (governance-only).
- Sub-card deregistration always requires and is signed by the primary card key, routed through a press, per `subcards.md §Authorization for Deregistration`; a test confirms the SDK refuses to build a deregistration request signed by any other key.
- Post-recovery, a single SDK-exposed operation re-derives the list of previously-active sub-cards and produces a batch of primary-key-signed deregistration requests (`subcards.md §Deregistration After Key Recovery`), verified end-to-end in the same recovery test harness used for Goal 3.
- **Deferred (OQ-SDK-11, out of scope for now):** annotation-board lookups and annotation-triggered auto-revocation of sub-cards (`subcards.md §Trust-and-Safety Integration`). v1 validation is signature + binding checks + certification chain walk + revocation log only.

### Goal 6: Verification via the shared verifier package

- The SDK's only dependency for chain-walking, revocation-checking, or policy-compliance logic is `@membership-card-protocol/verifier`; a code-search check (part of the Phase milestone review) confirms no parallel implementation of these algorithms exists in the SDK.
- Every point in the offer-acceptance, sub-card-acceptance, and message-receiving flows where a spec calls for chain or signature verification (offer issuer chain, press on-chain authorization, inbound message sender chain, **app card certification chain for sub-card requests**) is backed by a `verifier.verifyCard()` or `verifier.verifyEnvelope()` call, with a test asserting the SDK surfaces a hard rejection (no display, no auto-trust, no countersign) when the verifier reports `chain_reaches_trusted_root: false` or a signature/decryption hard-reject.
- The sub-card app-chain check (Goal 5) reuses the same `CardVerifier` instance configured with the governance app-certification policy root in `trustedRoots` and `fetchAnnotations: false` (annotation lookup deferred, OQ-SDK-11) — not a second, separately-configured verifier instance or a hand-rolled equivalent of `press.md`'s `verifyAppCertificationChain`.
- The SDK's `RpcProvider`/`IpfsProvider` implementations for the verifier are either the existing companion packages or documented, tested adapters suited to a browser/RN network stack (no bundled ethers/viem version forced on the consuming app beyond what the provider needs).

### Goal 7: Oblivious relay transport for wallet-service *and press* facing traffic

- Every SDK call that would otherwise be a direct device→wallet-service HTTPS request (account creation, `service_secret` retrieval, keyring updates, backup registration/recovery, sub-card registration/deregistration, UUID pool registration/deregistration) **and** every direct device→press HTTPS request for the press's sensitive/state-changing endpoints (`/issue`, `/issue/finalize`, `/open-offer/claim`, `/update`, `/sub-card/register`, `/sub-card/deregister`) is instead routed through the relay as an oblivious forwarder by default: the request body is HPKE-encapsulated to the destination's published OHTTP key configuration before it ever leaves the device, and the relay forwards the encapsulated blob without being able to decrypt it.
- The press's public, non-sensitive read endpoints (`/press`, `/health`, `/app-gas/:address`) are explicitly excluded from oblivious routing — there's no device-correlation benefit to hiding IP on a call that returns public metadata, and adding the relay hop there is pure latency cost with no privacy upside.
- A test harness confirms the relay, given a captured oblivious request (destined for either a wallet service or a press), cannot recover any plaintext field — only the destination's own gateway, holding the corresponding HPKE private key, can decapsulate it.
- A test harness confirms both the wallet service and a press, given a forwarded request, observe only the relay's IP address as the connecting peer — never the originating device's.
- The SDK's networking layer exposes this as the default transport, for both destination types, with no separate "anonymizing mode" toggle the host app must remember to enable — falling back to direct HTTPS is the explicit opt-out, not the default.
- This mechanism is implemented once, in the SDK core, parameterized by destination (wallet service or a specific press) rather than built as two independent transports, and used identically on web and React Native — no platform-specific proxy library, native module, or per-platform behavioral difference, unlike the Tor-based design this replaces.

---

## Open Questions

The following need answers before (or explicitly deferred into) the implementation plan. Several of these mirror open questions the wallet-service strategic plan already had to resolve for its side of the same flows — this plan resolves the client-side counterpart of each.

**OQ-SDK-1: Secure key storage abstraction for the device sub-card key. — RESOLVED**

Resolved: the web default is a non-extractable WebCrypto `CryptoKey` persisted via IndexedDB (software-only; no hardware backing), and this is documented as a disclosed, deliberate security-posture difference from native builds — not a bug to fix later. This is consistent with the product framing established here: **the web build's primary role is initial card acceptance** (a person follows a claim link, accepts a card, and gets a device sub-card entirely in-browser, with no app install required for that first step). The web build should carry clear, persistent messaging that recommends installing the native app for stronger key custody going forward, rather than positioning the web build as an equivalent-security long-term wallet. Native (RN) continues to use actual Secure Enclave / StrongBox-backed storage per the spec.

**OQ-SDK-2: Passkey/WebAuthn provider for React Native. — RESOLVED**

Resolved: the SDK accepts an injected `PasskeyProvider`, with `react-native-passkey` shipped as the default RN implementation (a host app can supply its own to override). This is the general pattern for every platform-variant concern in this SDK, not just passkeys: **the SDK is explicitly built with first-class, configurable support for both React Native and web frontends**, via injected providers with sensible per-platform defaults rather than either platform being a second-class citizen or requiring the host app to supply everything itself.

**OQ-SDK-3: Realtime transport abstraction for the relay (SSE/WebSocket). — RESOLVED**

Resolved: the SDK ships a default RN SSE implementation (e.g. via `react-native-sse` or an equivalent fetch-streaming-based polyfill) so foreground message delivery is timely on RN, matching web's native `EventSource` behavior — RN does not fall back to `GET /pending` polling as its primary foreground mechanism. `GET /pending` remains the catch-up path on both platforms after a silent push or app relaunch, per `notification_relay.md` Process 5.

**OQ-SDK-4: Network-level privacy for device↔wallet-service communication. — RESOLVED (redesigned around the relay + OHTTP, not Tor)**

The underlying need — the wallet service must not learn which device (by IP) is making a given request — was originally scoped as Tor integration. Revisited design, proposed and adopted:

**Pattern: always talk to the wallet service through the relay, using OHTTP-style oblivious forwarding, not Tor.** Concretely:

1. Before sending, the device encrypts the request body via HPKE (RFC 9180) to the wallet service's published OHTTP key configuration — the same primitive `ARCHITECTURE.md` ADR-007 and `message_routing.md §Transport Extensibility` already define for wallet-to-wallet OHTTP transport (`transport_flags 0x02`), just applied to device-to-wallet-service traffic instead of wallet-to-wallet traffic.
2. The device sends the encapsulated (opaque, HPKE-encrypted) request to the relay's oblivious-forwarding endpoint over ordinary HTTPS. The relay cannot decrypt it — it only knows which wallet-service gateway to forward the opaque blob to.
3. The relay forwards the still-encapsulated request to the wallet service's OHTTP gateway over the relay's own HTTPS connection. The wallet service sees the relay's IP as the connecting peer, never the device's.
4. The wallet service's gateway decapsulates, dispatches to its normal handler, encapsulates the response, and the relay forwards the response back to the device along the same path.

**Why this is a better fit than Tor for this SDK specifically:**

- **Uniform across web and React Native.** It's plain HTTPS plus an HPKE encapsulation step — no native SOCKS proxy, no per-platform proxy library, no circuit-building. This directly resolves the asymmetry Tor had (workable-ish on Android via Orbot, hard on iOS, essentially infeasible on web) — the same client code runs on all three targets.
- **No new external dependency.** It reuses infrastructure this system already operates (the relay) rather than depending on the health, availability, or potential blocking of an external Tor network the protocol doesn't control.
- **Lower and more predictable latency.** One extra HTTPS hop through infrastructure the wallet-service operator likely already has good connectivity to, versus Tor's multi-hop circuit-building (typically 1–3+ seconds before first byte).
- **No app-store risk.** Nothing about this looks like an embedded VPN/proxy from a platform review standpoint — it's application-layer encryption over normal HTTPS calls.

**Honest caveat — this protection is conditional on relay/wallet-service operator separation.** If the relay and the wallet service are run by the same operator (or the operators collude), the relay operator trivially sees the device's IP on the inbound leg and can just as trivially correlate it with the (now-decapsulated) request it forwards — the encryption hides content from the relay, not the fact that a specific IP connected to it. `notification_relay.md §Relay Service Trust Model` already frames operator separation as "defense-in-depth" rather than load-bearing for the properties it currently protects (UUID↔card unlinkability); for *this* specific property (hiding device IP from the wallet service), operator separation is not optional defense-in-depth — it is the property. This should be stated plainly in documentation for anyone deploying a wallet service + relay pair, not left implicit.

**Decision:** adopt this as the default transport for all wallet-service-facing **and press-facing** SDK traffic (see Goal 7), implemented once in the SDK core (no platform-specific adapter package needed, unlike the Tor design this replaces), parameterized by destination rather than duplicated per destination type. Per-card session separation and timing stagger (Goal 4, unchanged) remain required regardless — this transport solves IP-level correlation, not content/timing-level correlation, and the two are complementary, not substitutes for each other.

**Extension to the press:** the same mechanism applies to the client's direct calls to a press (claim submission, targeted-offer finalization, update/revocation intents, sub-card registration/deregistration submission) for the reason described above (the wallet service explicitly doesn't proxy these). Scope is deliberately narrower than "every press endpoint": only the state-changing endpoints that carry information worth correlating (`/issue`, `/issue/finalize`, `/open-offer/claim`, `/update`, `/sub-card/register`, `/sub-card/deregister`) go through the oblivious path; public reads (`/press`, `/health`, `/app-gas/:address`) stay direct HTTPS, since there's nothing sensitive to protect on those calls and no reason to pay the relay-hop latency cost. Unlike the wallet service (a single configured instance per OQ-SDK-7), a policy may name multiple approved presses, and a given offer or update names one specific press — so the client resolves and caches each relevant press's OHTTP key configuration and relay-registration target on demand, rather than assuming one fixed press destination the way it assumes one fixed wallet service.

**Scope note (server-side, both destinations):** this requires corresponding server-side support — an oblivious-forwarding endpoint on the relay, an OHTTP gateway endpoint on the wallet service, and an OHTTP gateway endpoint on the press — see the implementation plan (Phase 1, Steps 1.4a–1.4d), which covers all four codebases (`client-sdk/`, `relay/`, `wallet-service/`, `press/`) directly rather than leaving the server-side halves as an external dependency.

**OQ-SDK-5: Local persistence abstraction (card list, keyring cache, UUID pools, message history). — RESOLVED**

Resolved: the SDK defines its own minimal `StorageProvider` interface (get/set/delete, used consistently by every module that needs durable local state — card list, cached encrypted keyring, per-subcard UUID pools, message/edit history for deduplication), rather than taking a specific storage library as a hard dependency. The SDK ships default implementations and documentation for both platforms (web: IndexedDB-backed; RN: a documented choice among AsyncStorage/MMKV/SQLite, selected during Phase 1 scaffolding — see implementation plan) and documents how a host app can substitute its own (e.g., an app that already has a SQLite/WatermelonDB layer it wants the SDK to use instead).

**OQ-SDK-6: Distribution and dependency path to `@membership-card-protocol/verifier`. — RESOLVED**

Resolved: `@membership-card-protocol/verifier` (and its companion `-rpc-provider` / `-ipfs-provider` packages) has been published. `client-sdk` depends on it as a normal published npm dependency, pinned by version like any other third-party package — no workspace/path/git linkage back into `membership_card_verifier/` is needed.

**OQ-SDK-7: Wallet service multi-federation awareness in the SDK's API surface. — RESOLVED**

Resolved: the SDK is configured with a single preferred wallet-service base URL. A given SDK deployment is expected to be tied to a particular wallet-service operator (the normal case: an app built on this SDK ships pointed at one operator's wallet service), not federation-aware multi-endpoint retry logic. If a future consuming app needs to fail over across federation members, that's a host-app-level concern layered on top of the SDK's single-endpoint configuration, not something the SDK's core API needs to model.

**OQ-SDK-8: Session/state model across app restarts and multi-tab/multi-instance use. — RESOLVED**

Resolved: multi-tab coordination is in scope and assumed necessary on web (RN's single-foreground-instance model needs no equivalent). The SDK implements a `BroadcastChannel`-based (or equivalent) lock so that two tabs sharing the same keyring/`StorageProvider` cannot independently consume the same UUID from a pool or race a keyring update against each other.

**OQ-SDK-9: Inbound sub-card request delivery and consent UI boundary. — RESOLVED**

Resolved: the SDK exposes only an entry-point function (`handleSubCardRequest(rawRequestPayload)` or equivalent) that performs validation and returns the typed consent data structure from Goal 5. It does not own or ship any deep-link/universal-link transport, and it does not ship any default consent-screen UI for either platform — request delivery and all UI rendering are entirely the host app's responsibility.

**OQ-SDK-10: `card-keystore-lib` relationship — is the requesting-app side of the sub-card flow in scope at all? — RESOLVED**

Resolved: yes, the requesting-app side is in scope. The expected topology is symmetric — both the app requesting a sub-card and the wallet granting it are typically built on this same SDK — so the SDK includes the requester-side flow too: generating the fresh ML-DSA-44 keypair inside hardware-backed storage (via the same injected secure-storage provider used elsewhere in the SDK, satisfying the non-exportability requirement `subcards.md §Approved Keystore Library` describes for `card-keystore-lib`), assembling and signing the `SubCardDocument`, and delivering it to a wallet. Whether the SDK's own secure-storage provider *is* the pinned `card-keystore-lib` or a compatible equivalent that satisfies the same non-exportability/attestation properties is an implementation-plan-level decision (see Phase covering sub-cards).

**OQ-SDK-11: Annotation board polling cadence for already-issued sub-cards. — OUT OF SCOPE FOR NOW**

For reference, the "annotation board" is the EAS (Ethereum Attestation Service) annotation layer described in `ARCHITECTURE.md` ADR-008 and implemented client-side via the verifier package's Stage 6 (`card_verifier.md §7.6`): third-party annotators (auditors, certifiers, trust-and-safety reviewers) can post signed statements against a card — including an app's card — without needing that card's cooperation. For app cards specifically, these annotations are how `subcards.md §Ongoing Compliance` implements ongoing oversight: an advisory annotation (6xx/7xx-equivalent) is a soft warning; a blocking annotation (8xx/9xx-equivalent) should trigger automatic revocation of that app's sub-card on "next wallet sync."

**Decision: deferred entirely for now.** This SDK's v1 sub-card validation (Goal 5, Goal 6) is signature verification + both keccak256 binding checks + the app card's certification chain walk + the app card's own revocation log — all run through the shared `CardVerifier` with `fetchAnnotations: false`. No annotation-board lookup, no advisory-warning surfacing, and no annotation-triggered auto-revocation are implemented in this pass. If/when this is picked back up, it's a config flip (`fetchAnnotations: true` plus a scheduling decision) rather than new verification logic, since Stage 6 already exists in the verifier package this SDK depends on.

---

## Related Specs

- `specs/process_specs/oblivious_transport.md` — the formal process spec for the Goal 7 / OQ-SDK-4 oblivious-relay design; covers the envelope format (CP-0), key-configuration discovery, relay target registry, scope table, and the operator-separation caveat in one place, independent of this plan's phased implementation steps
- `plans/wallet-service/strategic-plan.md`, `plans/wallet-service/implementation-plan.md` — the server-side counterpart this SDK's calls target
- `specs/object_specs/card_verifier.md` — the verifier package this SDK integrates rather than reimplements
- `specs/object_specs/press.md` — the press endpoints the SDK submits accepted offers, open-offer claims, and sub-card registrations/deregistrations to
- `specs/subcards.md`, `specs/process_specs/subcard_creation_policy.md` — sub-card request, consent, countersigning, and revocation/deregistration rules this SDK implements from the wallet side
- `specs/process_specs/card_updates.md` — the general update-intent flow that both card and sub-card revocations are submitted through
- `specs/ARCHITECTURE.md` ADR-004, ADR-006, ADR-007, ADR-009, ADR-009-AMEND — cryptographic primitives, address model, transport, and key management this SDK must implement client-side
