# Client SDK — Implementation Plan

**Strategic plan:** [strategic-plan.md](./strategic-plan.md)

---

## Resolved Design Decisions

Carried forward from the strategic plan's open questions — these shape Phase 1 scaffolding and are treated as fixed unless a phase surfaces a reason to revisit:

| Question | Decision |
|---|---|
| OQ-SDK-1: Web secure key storage | Non-extractable WebCrypto `CryptoKey` in IndexedDB (software-only). Web is the initial-acceptance surface; persistent in-product messaging recommends installing the native app for stronger custody. |
| OQ-SDK-2: RN passkey provider | Injected `PasskeyProvider`; `react-native-passkey` is the shipped default. Same injected-provider pattern applies to every platform-variant concern. |
| OQ-SDK-3: RN realtime transport | Default RN SSE implementation shipped (timely delivery); `GET /pending` remains the catch-up path on both platforms, not the RN primary. |
| OQ-SDK-4: Network-level privacy for wallet-service **and press** traffic | **Redesigned, no Tor.** Default transport for all wallet-service-facing calls, and the press's sensitive/state-changing endpoints, is an oblivious-relay pattern: HPKE-encrypt the request to the destination's OHTTP key config, send the opaque blob through the relay's oblivious-forwarding endpoint, destination sees only the relay's IP. All four sides are covered by this plan: client (Step 1.4a, in `client-sdk/`), relay (Step 1.4b, in `relay/`), wallet-service gateway (Step 1.4c, in `wallet-service/`), and press gateway (Step 1.4d, in `press/`) — using a lightweight HPKE-based envelope rather than strict RFC 9458 Binary HTTP (CP-0). The press's public read endpoints (`/press`, `/health`, `/app-gas/:address`) stay direct HTTPS. Per-card session separation + staggering remain mandatory regardless of transport. |
| OQ-SDK-5: Local persistence | SDK-owned `StorageProvider` interface; default IndexedDB (web) and a Phase 1-selected RN backend (AsyncStorage/MMKV/SQLite — decided in Step 1.4). |
| OQ-SDK-6: Verifier dependency | `@membership-card-protocol/verifier` (+ companion provider packages) is published; consumed as a normal pinned npm dependency. |
| OQ-SDK-7: Wallet-service federation | Single preferred wallet-service base URL per SDK configuration; no federation peer-list/retry logic in SDK core. |
| OQ-SDK-8: Multi-tab coordination | In scope on web via a `BroadcastChannel`-based lock; not applicable on RN. |
| OQ-SDK-9: Sub-card request transport/UI | SDK exposes only a validation entry point (`handleSubCardRequest`); no owned deep-link transport, no shipped consent UI. |
| OQ-SDK-10: Requester-side sub-card flow | In scope. Requester and granter are both expected to run this SDK. |
| OQ-SDK-11: Annotation-board integration | **Out of scope for now.** No EAS annotation lookup, advisory warnings, or annotation-triggered auto-revocation in this pass. Sub-card validation is signature + binding checks + certification chain walk + revocation log only (`fetchAnnotations: false`). |

---

## Phases

---

### Phase 1: Foundation and Provider Architecture

**Goal:** Monorepo scaffolded, every cross-platform seam defined as an injected provider interface (not yet all implemented), core crypto/canonicalization wired to the same primitives the verifier package uses, CI green on both a web (jsdom/Playwright) and an RN (Jest + RN preset) test target. This phase also touches three other codebases directly — `relay/` (Step 1.4b), `wallet-service/` (Step 1.4c), and `press/` (Step 1.4d) — to build the full oblivious-relay transport end-to-end for both destinations the SDK talks to; these are the only points in this plan where implementation work happens outside `client-sdk/` itself.

---

**Step 1.1 — Workspace and package scaffolding**
- What: Initialize `client-sdk/` as its own pnpm workspace (mirroring `membership_card_verifier/`'s structure): root `package.json` with `packageManager: pnpm@9.6.0`, `engines.node >= 22`, workspace packages under `packages/`: `packages/client-sdk` (the core package, `@membership-card-protocol/client-sdk` — includes the oblivious-relay transport module, since that's implemented once and shared across platforms, not platform-specific), `packages/client-sdk-web` (web default providers), `packages/client-sdk-rn` (RN default providers). TypeScript, ESLint, Prettier, Vitest configured per package, matching `membership_card_verifier`'s `tsconfig.json`/`vitest.config.ts` conventions.
- Who: Claude
- Context needed: `membership_card_verifier/packages/verifier/package.json`, `membership_card_verifier/packages/verifier/tsconfig.json` (conventions to mirror), `plans/client-sdk/strategic-plan.md §Resolved Design Decisions`
- Done when: `pnpm install` succeeds at the workspace root; `pnpm -r build` and `pnpm -r typecheck` succeed on empty packages; CI workflow scaffolded (lint → typecheck → test) but not yet meaningful.

**Step 1.2 — Core provider interfaces**
- What: Define, in `packages/client-sdk/src/providers/`, the full set of injected-provider interfaces the rest of the SDK will consume — no implementations yet, just contracts with doc comments citing the spec section each satisfies:
  - `StorageProvider` — `get(key)`, `set(key, value)`, `delete(key)`, namespaced by a caller-supplied prefix (card list, keyring cache, UUID pools, message history all use this).
  - `SecureKeyProvider` — generate/sign/verify for hardware-backed (or platform-equivalent) non-exportable keys; the interface the device sub-card key, and the requester-side sub-card key (OQ-SDK-10), both go through. Doc comment cites `wallet_backup_and_recovery.md` (Secure Enclave/TPM) and `subcards.md §Sub-Card Key Management` (non-exportability, attestation tiers).
  - `PasskeyProvider` — WebAuthn registration/assertion, abstracting `navigator.credentials` (web) vs. an injected RN implementation.
  - `RealtimeTransportProvider` — SSE-shaped subscribe/unsubscribe plus WebSocket connect, abstracting native `EventSource`/`WebSocket` (web) vs. RN equivalents.
  - `ObliviousProtocolTransport` — the oblivious-relay-backed HTTP client used for every wallet-service-facing call (account creation, `service_secret` retrieval, keyring ops, backup/recovery, sub-card registration/deregistration, UUID registration/deregistration) **and** every press-facing sensitive/state-changing call (claim submission, offer finalization, update/revocation intents, sub-card registration/deregistration submission): HPKE-encapsulates the request to the destination's OHTTP key config, POSTs the opaque blob to the relay's oblivious-forwarding endpoint, decapsulates the response. Parameterized by a destination descriptor (`{ kind: 'wallet_service' }` — resolved from SDK config, single fixed instance per OQ-SDK-7 — or `{ kind: 'press', baseUrl }` — resolved per offer/update, since a policy may name multiple approved presses) rather than hardcoded to one destination. Implemented once in the core package (pure HTTP + HPKE — no platform-specific implementation needed). Exposes an explicit direct-HTTPS bypass mode for testing, for the press's public read endpoints (which never go through this transport), and for hosts that intentionally opt out — but the oblivious path is the default for every sensitive call, with no separate "enable privacy mode" step required.
  - `MultiInstanceLock` — acquire/release a named lock, used for the web `BroadcastChannel` coordination (OQ-SDK-8); a no-op default on RN.
- Who: Claude
- Context needed: `plans/client-sdk/strategic-plan.md` (full — every Goal references at least one of these providers)
- Done when: All six interfaces are defined with full TSDoc, exported from the package root, and a "provider contract" test suite exists (initially empty/skeletal) that any concrete implementation (web, RN, or host-app-supplied) is expected to run against.

**Step 1.3 — Crypto and canonicalization core**
- What: Implement `packages/client-sdk/src/crypto/`: thin wrappers around `@noble/post-quantum` (ML-DSA-44 sign/verify, ML-KEM-768 encapsulate/decapsulate) and `@noble/hashes` (keccak256, HKDF-SHA3-256), plus canonical RFC 8785 serialization. Do not reimplement canonicalization independently — either depend on the verifier package's exported `canonicalize()` function directly (`card_verifier.md §10`) or vendor the identical ~30-line implementation with a test asserting byte-identical output against the verifier package's version, so the two never silently diverge.
- Who: Claude
- Context needed: `specs/object_specs/card_verifier.md §10, §11`, `specs/ARCHITECTURE.md ADR-004, ADR-010`
- Done when: Unit tests confirm ML-DSA-44 sign/verify round-trips, ML-KEM-768 encapsulate/decapsulate round-trips, and canonicalization output matches `specs/serialization-conformance.json` test vectors exactly (the same conformance corpus the verifier package tests against).

**Step 1.4 — Verifier integration**
- What: Construct a `CardVerifier` factory in `packages/client-sdk/src/verification/`, following the same pattern as `press.md §5.0`: the SDK instantiates one `CardVerifier` (or one per distinct trust-root configuration — see Step 4.2 for the sub-card app-certification-root variant) at initialization and exposes it internally to every module that needs chain/signature verification. `RpcProvider` and `IpfsProvider` implementations wrap whatever Arbitrum RPC client and IPFS gateway the host app configures — prefer the existing `@membership-card-protocol/verifier-rpc-provider` / `-ipfs-provider` companion packages where they fit a browser/RN network stack; otherwise write thin adapters, not new chain-walking logic.
- Who: Claude
- Context needed: `specs/object_specs/card_verifier.md §4, §5, §6` (provider interfaces, config, primary API), `specs/object_specs/press.md §5.0` (the pattern to mirror)
- Done when: A single shared `CardVerifier` instance is constructed from SDK config; a smoke test calls `verifier.verifyCard()` against a known-good test fixture (chain reaches trusted root) and a known-bad one (hard rejection), confirming the SDK surfaces the verifier's result unmodified rather than re-deriving any part of it.

**Step 1.4a — Oblivious-relay `ObliviousProtocolTransport`**
- What: Implement the core, platform-independent `ObliviousProtocolTransport` (per Step 1.2 and OQ-SDK-4's redesign, now covering both destinations): an HPKE (RFC 9180) encapsulation layer wrapping every wallet-service-facing **and press-sensitive-endpoint** request, a thin HTTP client that POSTs the encapsulated blob to the relay's oblivious-forwarding endpoint, and decapsulation of the response. Use an existing, audited HPKE library (e.g. `hpke-js` or equivalent) rather than implementing HPKE primitives from scratch. Each destination's OHTTP key configuration is fetched/cached the same way a TLS cert or JWKS endpoint would be (a well-known config endpoint on that destination, refreshed on a TTL) — the wallet service has exactly one such config (fixed instance, OQ-SDK-7); a press's config is fetched and cached per press base URL the first time the SDK needs to talk to that press. Every module built in later phases that talks to the wallet service (Phase 2 account/backup calls, Phase 4 sub-card registration/deregistration, Phase 5 UUID registration) or to a press's sensitive endpoints (Phase 3 claim/finalization, Phase 4 sub-card registration/deregistration submission, update/revocation intents) is built against this transport, not a raw `fetch()` call. Public press reads (`/press`, `/health`, `/app-gas/:address`) explicitly bypass this transport and use direct HTTPS.
- Who: Claude
- Context needed: `plans/client-sdk/strategic-plan.md §OQ-SDK-4` (full design, the press extension, and the honest operator-separation caveat), `specs/ARCHITECTURE.md ADR-007`, `specs/process_specs/message_routing.md §Transport Extensibility` (the existing OHTTP precedent this mirrors)
- Done when: A test using a stub relay and a stub wallet-service OHTTP gateway confirms: (a) the relay, given a captured request, cannot decrypt any field of it; (b) the destination gateway, given the forwarded request, sees the relay's IP as the connecting peer in the test harness's connection metadata, not a device-identifying one; (c) a full round trip (request → relay → destination → response → relay → device) completes correctly against both a wallet-service-shaped stub destination and a press-shaped stub destination; (d) the direct-HTTPS bypass mode is available and produces identical application-level results against the same stub destinations, for use in earlier-phase tests that don't need to exercise the oblivious path, and is the only path used for the press's public read endpoints.

**Step 1.4b — Relay: OHTTP oblivious-forwarding endpoint (generalized target registry)**
- What: This step modifies the **relay codebase** (`relay/`, a separate Nitro app/workspace from `client-sdk/` — not a `client-sdk` package), adding the server-side counterpart Step 1.4a's client talks to. Since this now needs to forward to two different kinds of destination (wallet services and presses), which share nothing in common with the push-specific `apns`/`fcm` fields on `AppConfig` (`relay/server/utils/app-registry.ts`), add a **new, decoupled registry** rather than extending `AppConfig`:
  1. `relay/server/utils/oblivious-targets.ts`: a small registry, structurally independent of `AppRegistry`, mapping `target_id → { ohttp_gateway_url: string }`. `target_id` is opaque to the relay — it may correspond to a wallet-service's existing `app_id` (reusing the identifier apps already have) or to a press's own identifier (e.g. its press-card mutable pointer, or a simpler operator-assigned string) — the relay does not need to know or care which. Loaded the same way as `AppRegistryFile` today (bundled JSON asset / `APP_REGISTRY_JSON`-equivalent env var, matching the existing provisional loading pattern rather than inventing a third one), with its own `validateObliviousTargets()` mirroring `validateAppRegistry`'s shape (checks `https://`, duplicate-ID detection).
  2. `relay/server/api/ohttp/[target_id].post.ts`: reads the raw request body as an opaque HPKE-encapsulated blob (`Content-Type: message/ohttp-req`, per RFC 9458) — the relay does not parse or interpret it — resolves `target_id` via the new registry, and returns 404 without forwarding if unknown.
  3. Forwards the encapsulated blob as-is via `fetch(ohttp_gateway_url, { method: 'POST', body: rawBlob, headers: { 'Content-Type': 'message/ohttp-req' } })` — a plain outbound HTTPS call the relay already knows how to make (it does the equivalent today for staggered wallet-clearance deletes).
  4. Returns the destination's `message/ohttp-res` response body back to the device unmodified.
  No Redis, KV, or Durable Object state is needed for this endpoint — it's a stateless pass-through, closer in shape to the existing `server/api/deliver/[uuid].post.ts` forwarding logic than to the stateful UUID-store endpoints. Add `relay/server/utils/oblivious-targets.test.ts` and `relay/server/api/ohttp/[target_id].post.ts.test.ts`, plus an integration-test scenario in `relay/server/integration-tests/`, following the existing test-file placement convention in that directory.
- Who: Claude
- Context needed: `relay/server/utils/app-registry.ts` (the loading/validation pattern being mirrored, not extended), `relay/server/api/deliver/[uuid].post.ts` and `relay/server/api/ack.post.ts` (existing outbound-fetch and route-handler conventions to mirror), `plans/client-sdk/strategic-plan.md §OQ-SDK-4`
- Done when: A request carrying an opaque test blob to `POST /ohttp/{target_id}` is forwarded byte-for-byte to the configured `ohttp_gateway_url` for both a wallet-service-shaped and a press-shaped registry entry, and the stub gateway's response is returned byte-for-byte to the caller; an unknown `target_id` returns 404 without attempting any forward; `relay/server/utils/oblivious-targets.test.ts` covers duplicate-ID and non-`https://` validation failures; this step's relay changes are committed to the `relay/` workspace (not `client-sdk/`), and Step 1.4a's client-side test suite is re-run against this real endpoint (in addition to its stub) to confirm interoperability for both destination kinds.

**Step 1.4c — Wallet service: OHTTP gateway endpoint**
- What: This step modifies the **wallet-service codebase** (`wallet-service/`, per `plans/wallet-service/`) — the other codebase, besides `relay/`, that this plan touches directly. Design decision (recommended over strict RFC 9458, and stated here rather than left implicit): implement a **lightweight, protocol-specific oblivious envelope** using real HPKE (via `hpke-js` or equivalent), not full RFC 9292 Binary HTTP encoding — the wallet service and client are both parts of this same protocol, so there's no external-interop reason to take on a Binary HTTP codec dependency. Concretely:
  1. Add `server/utils/ohttp-gateway.ts`: HPKE keypair generation/loading (store the private key via the existing `SecretsBackend`/`SecretsService` from `src/secrets/` — the same envelope-encryption machinery already built for `service_secret`, not a new secret-storage mechanism), and `decapsulate(blob) → { path, method, body }` / `encapsulate(response, context) → blob` functions built on the HPKE context established during decapsulation (the same context seals the response — this is not two independent encrypt/decrypt calls).
  2. Add `server/routes/ohttp/key-config.get.ts`: an unauthenticated endpoint returning the wallet service's current HPKE public key and suite identifiers as JSON, which `client-sdk`'s `ObliviousProtocolTransport` (Step 1.4a) fetches and caches on a TTL — the wallet-service-side counterpart of that step's "fetch/cache the OHTTP key configuration" requirement.
  3. Add `server/routes/ohttp/gateway.post.ts`: the single generic entry point. Decapsulates the request body, reads the resulting `{ path, method, body }` envelope, and dispatches **in-process** (a direct function call, not a second HTTP round-trip) to the corresponding existing handler's logic.
  4. Refactor each existing route this SDK's flows call through the oblivious path (at minimum: `server/routes/accounts/challenge.post.ts`, `server/routes/accounts/index.post.ts`, `server/routes/keyrings/[keyring_id].get.ts`, `server/routes/messages/index.post.ts`, plus `src/routes/subcard-uuid-registration.ts` and `src/routes/subcard-deregistration.ts`) so each route's core logic is a plain, exported function taking already-parsed input rather than reading directly off an `H3Event` — callable identically from its existing plaintext route file and from the new gateway's dispatcher. This is a refactor of existing code, not new business logic — the goal is that these functions produce byte-identical results whether invoked via the plaintext route or via the gateway.
  5. Encapsulate the handler's result back through the same HPKE context and return it from `gateway.post.ts`.
- Who: Claude
- Context needed: `wallet-service/src/secrets/*` (the `SecretsBackend`/`SecretsService` pattern to reuse for the HPKE private key), `wallet-service/server/routes/accounts/index.post.ts`, `wallet-service/server/routes/keyrings/[keyring_id].get.ts` (existing route-handler shape being refactored), `wallet-service/server/utils/auth.ts` (existing auth-middleware conventions — the gateway needs to apply the same per-route auth checks internally that the plaintext routes apply, just reached via a different entry point), `plans/client-sdk/strategic-plan.md §OQ-SDK-4`
- Done when: `GET /ohttp/key-config` returns a valid HPKE public key and suite IDs; a full round trip through `POST /ohttp/gateway` (encapsulated request in, encapsulated response out) produces a result byte-identical to calling the corresponding plaintext route directly with the same logical input, for each of the six refactored routes; auth checks (session token, master-card-signature, subcard-signature — whichever a given route requires) are enforced identically via both entry points, verified by a test that a request failing auth is rejected the same way through the gateway as through the plaintext route; this step's wallet-service changes are committed to the `wallet-service/` workspace, and Step 1.4a/1.4b's test suites are re-run end-to-end (device → relay → wallet-service gateway → real route logic → response back) to confirm full three-party interoperability.

**⚑ Clarification Checkpoint CP-0: OHTTP envelope design — RESOLVED**

Confirmed: lightweight custom HPKE envelope (`{ path, method, body }`, JSON, HPKE-sealed), not strict RFC 9458 Binary HTTP encoding. No Binary HTTP codec dependency is taken on. This applies uniformly to both destinations covered by this plan (wallet service, Step 1.4c; press, Step 1.4d). This is accepted as a deliberate non-interop trade-off — if a future need arises to interoperate with a third-party or public OHTTP relay/gateway, this wire format would need to be revisited at that time; not a concern for this closed, four-party system today.

**Step 1.4d — Press: OHTTP gateway endpoint**
- What: This step modifies the **press codebase** (`press/`, per the existing press implementation — a fourth codebase this plan touches, alongside `client-sdk/`, `relay/`, and `wallet-service/`). The press's existing architecture makes this meaningfully simpler than Step 1.4c's wallet-service gateway: the press already separates thin HTTP route wrappers (`server/api/*.post.ts`) from plain, exported handler functions (`src/handlers/{issue,open-offer,sub-card,update}.ts`, each shaped as `handle*(ctx, body): Promise<Response>`) — so there is **no refactor of existing routes needed**, only a new dispatcher that calls the same handler functions the existing routes already call.
  1. Add `press/src/ohttp-gateway.ts`: HPKE keypair generation/loading (store the private key alongside the press's other key material — see `press/src/config.ts`'s existing environment-variable-sourced key loading, e.g. `PRESS_MLDSA44_PRIVATE_KEY`/`PRESS_SECP256R1_PRIVATE_KEY` — add `PRESS_OHTTP_PRIVATE_KEY` following the same convention rather than inventing new secret-handling machinery), and `decapsulate(blob) → { path, method, body }` / `encapsulate(response, context) → blob` using the same HPKE library chosen in Step 1.4c, sharing an HPKE context between decapsulation and the corresponding response encapsulation.
  2. Add `press/server/api/ohttp/key-config.get.ts`: unauthenticated, returns the press's current HPKE public key and suite identifiers — `client-sdk`'s `ObliviousProtocolTransport` (Step 1.4a) fetches and caches this per press base URL.
  3. Add `press/server/api/ohttp/gateway.post.ts`: decapsulates the request body, reads `{ path, method, body }`, and dispatches **in-process** to the matching existing handler — `handleOpenOfferClaim`, `handleIssue`(-equivalent for `/issue` and `/issue/finalize`), `handleUpdate`, or the relevant `handleSubCard*` function from `src/handlers/sub-card.ts` — using `getCtx()` exactly as the existing thin routes do (see `press/server/api/open-offer/claim.post.ts` for the pattern: fetch context, call handler, map thrown `pressCode` errors to the same response shape). Only the six sensitive endpoints are wired to this dispatcher; `server/api/press.get.ts`, `server/api/health.get.ts`, and `server/api/app-gas/[address].get.ts` are deliberately not — they remain direct-HTTPS-only, consistent with the strategic plan's public-read exclusion.
  4. Encapsulate the handler's result (or thrown-error response) back through the same HPKE context and return it from `gateway.post.ts`.
- Who: Claude
- Context needed: `press/src/handlers/open-offer.ts`, `press/server/api/open-offer/claim.post.ts` (the handler/route separation being reused, not refactored), `press/src/config.ts` (existing key-loading convention to extend), `plans/client-sdk/strategic-plan.md §OQ-SDK-4` (press extension and public-read exclusion rationale)
- Done when: `GET /ohttp/key-config` returns a valid HPKE public key and suite IDs; a full round trip through `POST /ohttp/gateway` for each of the six sensitive endpoints produces a result byte-identical to calling the corresponding existing route directly with the same logical input (verified by invoking the same `src/handlers/*.ts` function both ways in a test and diffing the results); a request naming a path outside the six sensitive endpoints (e.g. attempting to reach `/press` through the gateway) is rejected by the dispatcher rather than silently forwarded; this step's press changes are committed to the `press/` workspace, and the full four-party path (device → relay → press gateway → existing handler → response back) is exercised end-to-end alongside Step 1.4c's equivalent wallet-service path.

**Step 1.5 — Default web providers**
- What: Implement `packages/client-sdk-web/`: `StorageProvider` (IndexedDB), `SecureKeyProvider` (non-extractable WebCrypto `CryptoKey`, per OQ-SDK-1 — doc comment states the disclosed security-posture gap vs. native), `PasskeyProvider` (`navigator.credentials`), `RealtimeTransportProvider` (native `EventSource` + `WebSocket`), `MultiInstanceLock` (`BroadcastChannel`-based, per OQ-SDK-8).
- Who: Claude
- Context needed: `packages/client-sdk/src/providers/*` (interfaces from Step 1.2)
- Done when: Each provider passes the Step 1.2 provider-contract test suite under a browser-like (Playwright or jsdom-with-IndexedDB-polyfill) test environment; a two-tab test (two `BroadcastChannel` contexts) confirms the lock prevents concurrent acquisition.

**Step 1.6 — Default React Native providers**
- What: Implement `packages/client-sdk-rn/`: `StorageProvider` (backend selected here — evaluate AsyncStorage, MMKV, and SQLite against this SDK's access patterns — key-value with moderate write volume for UUID pools and message history — and document the choice), `SecureKeyProvider` (Secure Enclave via `kSecAttrTokenIDSecureEnclave` on iOS, StrongBox-backed `AndroidKeyStore` on Android — matching `subcards.md §Non-Exportability` exactly, since this same provider is reused for both the device sub-card key and the requester-side sub-card key per OQ-SDK-10), `PasskeyProvider` (`react-native-passkey` default), `RealtimeTransportProvider` (native `WebSocket` + a shipped SSE implementation per OQ-SDK-3), `MultiInstanceLock` (no-op).
- Who: Claude
- Context needed: `subcards.md §Sub-Card Key Management` (attestation tiers, non-exportability requirements the `SecureKeyProvider` must satisfy)
- Done when: Each provider passes the Step 1.2 provider-contract test suite under a Jest + React Native preset environment; the `SecureKeyProvider` test confirms a generated key cannot be exported/read (only sign/verify operations succeed) on both simulated iOS and Android backends.

**Step 1.7 — CI and cross-platform test harness**
- What: GitHub Actions workflow running both test targets (web, RN) on every push: lint → typecheck → `pnpm -r test` (web packages under Playwright/jsdom, RN packages under Jest+RN preset) → build. Establish the shared integration-scenario test pattern that later phases will reuse: a scenario is written once against the core package's public API and run twice, once wired to web default providers and once to RN default providers.
- Who: Claude
- Context needed: none
- Done when: CI is green on a clean push; a placeholder shared scenario ("construct SDK instance, call one no-op method") passes identically under both provider sets, proving the harness itself works before real scenarios are written in later phases.

**⬥ Phase 1 Milestone Review**
- Context needed: Step 1.1–1.7 outputs (including Step 1.4b's `relay/` changes, Step 1.4c's `wallet-service/` changes, and Step 1.4d's `press/` changes); `plans/client-sdk/strategic-plan.md §Goal 1, Goal 6, and Goal 7`
- Done when: Every provider interface from Step 1.2 has both a web and RN default implementation passing the shared contract suite; the verifier integration smoke test passes; a full oblivious-relay round trip passes for both destinations — device via `ObliviousProtocolTransport` → real relay endpoint (Step 1.4b) → real wallet-service gateway (Step 1.4c) → back, and the same against a real press gateway (Step 1.4d) → back — not just pairwise stubs; auth-parity between the plaintext and gateway-dispatched paths is confirmed for the wallet service (Step 1.4c's refactored routes) and results-parity is confirmed for the press (Step 1.4d's unchanged handler functions, called two ways); the press's public read endpoints are confirmed to never route through the gateway; CI is green on all four workspaces (`client-sdk/`, `relay/`, `wallet-service/`, `press/`) for their respective changes; a one-paragraph phase summary is written to `plans/client-sdk/milestones/phase-1-summary.md`, noting that this phase's scope spanned four codebases.

---

### Phase 2: Wallet Setup, Keyring, and Backup/Recovery

**Goal:** A holder can create a wallet (master keypair, device sub-card, keyring, backup registration) and recover it end-to-end against a stub wallet service, with the KDF and wrapping logic covered by fixed test vectors.

---

**Step 2.1 — Master keypair and initial keyring**
- What: Implement wallet setup per `wallet_backup_and_recovery.md §Process 1` Steps 1–6: generate the master ML-DSA-44 keypair (private key held in memory only for this step, per spec), create the device-bound passkey via `PasskeyProvider`, exchange with the wallet service (`POST /accounts/challenge` → sign → `POST /accounts`, per `plans/wallet-service/implementation-plan.md` Step 2.2) to obtain `service_secret`, derive `decryption_key = KDF(device_passkey_output, service_secret)`, initialize the append-only keyring blob (master private key, AES-GCM encrypted), and store/cache it via `StorageProvider`. Clear the master private key from any in-memory variable immediately after the keyring write completes.
- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 1 Steps 1–6`, `plans/wallet-service/implementation-plan.md §Step 2.2` (the exact wallet-service request/response shapes to call against)
- Done when: A test drives full setup against a stubbed wallet service and confirms: the returned `service_secret` is never persisted in plaintext by the SDK beyond the derivation step, the KDF output matches a fixed test vector for known inputs, and the master private key is unreachable from any SDK-exposed API after setup completes (only signing operations that consume it internally are available).

**Step 2.2 — Device sub-card generation and registration**
- What: Generate the device sub-card keypair via `SecureKeyProvider` (non-exportable), sign the sub-card registration with the master key (accessed from the keyring, then cleared from memory), and post the registration on-chain per `wallet_backup_and_recovery.md §Process 1` Steps 7–9. This reuses the general sub-card request/countersign machinery built in Phase 4 (Step 4.1) — call out here that Phase 2 depends on that piece being available for the "wallet self-signing" path specifically (no consent prompt, per `subcards.md`'s wallet self-signing exception), even though full third-party sub-card handling isn't built until Phase 4. Sequence Phase 4's Step 4.1 before this step if needed, or stub the self-signing path here and wire it to the real implementation once Phase 4 lands — decide at Phase 2 kickoff based on actual dependency ordering convenience.
- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 1 Steps 7–9`, `specs/subcards.md §Sub-Card Request Flow` (self-signing exception)
- Done when: A device sub-card is generated, registered on-chain (against a test registry), and all routine signing operations in the test harness use this sub-card key rather than the master key.

**Step 2.3 — Backup registration (synced passkey + optional YubiKey)**
- What: Implement both wrapping paths per `wallet_backup_and_recovery.md §Process 1` Steps 11–15: synced passkey (automatic) and YubiKey (opt-in, PIN-derived wrap). Both produce a wrapped `decryption_key` blob sent to the backup service (`plans/wallet-service/implementation-plan.md §Step 3.1`).
- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 1 Steps 11–15`, `plans/wallet-service/implementation-plan.md §Step 3.1`
- Done when: Both wrapping paths have unit tests with fixed test vectors confirming byte-for-byte reproducible output; an integration test registers both blob types against a stub backup service and confirms neither the SDK nor the stub ever handles `decryption_key` in a form the backup service could read.

**Step 2.4 — Recovery flow (both tiers) and re-registration**
- What: Implement `wallet_backup_and_recovery.md §Process 2a` (synced passkey recovery) and `§Process 2b` (YubiKey recovery) end-to-end: initiation, notification wait (test harness simulates the 72-hour window), cancellation path, key release handling, keyring fetch by `keyring_id` from a non-primary federation member (per `wallet_backup_and_recovery.md §Keyring Storage and Replication` — even though OQ-SDK-7 resolved that the SDK targets a single configured wallet-service URL day-to-day, recovery is the one flow where the SDK must be able to fetch from a `keyring_id`-addressed endpoint that may not be the configured primary; confirm this doesn't reintroduce federation-awareness scope creep — it's a single explicit fetch-by-CID-like-identifier call, not routing logic). Then implement `§Process 3` re-registration: new passkey, new `service_secret`, keyring re-encryption under a new `keyring_id`, new device sub-cards.
- Who: Claude
- Context needed: `specs/process_specs/wallet_backup_and_recovery.md §Process 2a, §Process 2b, §Process 3`, `plans/wallet-service/implementation-plan.md §Phase 3` (the server-side counterpart)
- Done when: An end-to-end test drives: setup → simulated device loss → recovery initiation → simulated cancellation (aborts correctly) → separately, recovery initiation → simulated window expiry → key release → keyring fetch from a stub "non-primary" wallet-service instance → decrypt → re-registration — and confirms the recovered keyring matches the original bit-for-bit before re-encryption.

**Step 2.5 — Post-recovery sub-card deregistration batch**
- What: Implement the SDK-exposed operation from `subcards.md §Deregistration After Key Recovery`: after Step 2.4's re-registration completes, re-derive the list of previously-active sub-cards (from the recovered keyring / cached card list) and produce a batch of primary-key-signed deregistration requests, submitted to the press per `subcards.md §Authorization for Deregistration`. This depends on Phase 4's deregistration primitive (Step 4.4) — sequence accordingly, or build the primitive here and have Phase 4 reuse it.
- Who: Claude
- Context needed: `specs/subcards.md §Deregistration After Key Recovery`, Step 2.4 outputs
- Done when: The same recovery test harness from Step 2.4, extended: after re-registration, all sub-cards active before the simulated loss are confirmed deregistered (signed by the recovered primary key) against a stub press.

**⚑ Clarification Checkpoint CP-1 — Backup/recovery security review**

Before any implementation from this phase is used against real key material or a production wallet service: an independent security-focused review of the KDF computation, both wrapping paths, and memory-retention behavior (per strategic plan Goal 3 and Rationale). Confirm no derived key, passkey output, or master private key is logged, cached beyond the operation that needs it, or reachable from any SDK-exposed API. This mirrors `plans/wallet-service/implementation-plan.md`'s CP-2 for the same flow's server side — both should ideally be reviewed together, since the security property is joint between client and server.

**⬥ Phase 2 Milestone Review**
- Context needed: Step 2.1–2.5 outputs; `plans/client-sdk/strategic-plan.md §Goal 3 Objectives`
- Done when: Full setup → backup → recovery → re-registration → post-recovery deregistration flow passes end-to-end against stub wallet-service and press instances; CP-1 review scheduled or complete; phase summary written to `plans/client-sdk/milestones/phase-2-summary.md`.

---

### Phase 3: Card Offer Creation, Acceptance, and Press Submission

**Goal:** A holder can create a targeted offer or an open offer, and a recipient (new or existing wallet) can review, verify, countersign, and submit a claim to a press — with the "persist before sign" key-custody invariant enforced structurally, not by convention.

---

**Step 3.1 — Offer construction and signing (issuer side)**
- What: Implement targeted-offer assembly and signing per `card_offering_and_acceptance.md §Phase 3` (issuer's wallet assembles `CardDocument` offer, signs with the issuer's own card key) and open-offer assembly/signing per `open_offer_creation.md §Phase 1–2` (`OpenCardOffer` document, `issuer_pubkey` binding, offer-ID computation). Both produce a signed, ready-to-distribute offer object; open-offer additionally computes the claim link (`mcard://claim?o=...` and/or hosted-URL form) once published to a wallet service.
- Who: Claude
- Context needed: `specs/process_specs/card_offering_and_acceptance.md §Phase 3`, `specs/process_specs/open_offer_creation.md` (full)
- Done when: Both offer types serialize identically to the spec's JSON shape (tested against fixtures), sign correctly, and (for open offers) the offer ID matches `hash(canonical RFC 8785 JSON of the complete document)`.

**Step 3.2 — Offer verification before display**
- What: Implement the pre-display verification gate shared by every acceptance path (`card_offering_and_acceptance.md` step 12, `open_offer_acceptance_new_wallet.md` step 2, `open_offer_acceptance_existing_wallet.md` step 2): keccak256 binding check on `issuer_pubkey`/`issuer_card` (or the targeted-offer equivalent), decrypt and verify via the shared `CardVerifier` (Step 1.4), confirm the chain reaches a trusted root, and confirm the named press is active in on-chain `PressAuthorizations` (authoritative) with the policy's `approved_presses` as an advisory cross-check only. A hard rejection at any of these must prevent the offer from ever reaching whatever UI the host app renders — the SDK returns a rejection result, not a "display with a warning" result.
- Who: Claude
- Context needed: `specs/process_specs/open_offer_acceptance_new_wallet.md §Phase 1`, `specs/process_specs/open_offer_acceptance_existing_wallet.md §Phase 1`, `specs/object_specs/card_verifier.md §7.1–7.3`
- Done when: Test fixtures cover every hard-rejection condition in the spec (pubkey/pointer mismatch, decryption failure, chain not reaching trusted root, press not on-chain-authorized) and confirm the SDK's public "review this offer" call returns a rejection — never a displayable offer object — in each case.

**Step 3.3 — Countersigning with the "persist before sign" invariant**
- What: Implement the countersign step shared by all three acceptance paths (targeted, open-offer-new-wallet, open-offer-existing-wallet): generate the fresh per-card ML-DSA-44 keypair via the in-memory crypto core (not `SecureKeyProvider` — this key belongs in the recoverable keyring, not hardware-bound storage, per every relevant spec), write it into the keyring (and confirm the write — either a durable local write plus a queued/confirmed sync depending on Phase 2's keyring persistence model, or a synchronous federation-replicated write, matching whatever Phase 2 Step 2.1 established) **before** producing the countersignature. Structure this as a single internal function (`acceptOfferAndCountersign`) that cannot be called in a way that produces a signature without a prior confirmed keyring write — no call site outside this function should assemble a countersignature directly.
- Who: Claude
- Context needed: `specs/process_specs/card_offering_and_acceptance.md §Phase 5 Step 15`, `specs/process_specs/open_offer_acceptance_new_wallet.md §Phase 3 Step 11`, `specs/process_specs/open_offer_acceptance_existing_wallet.md §Phase 2 Step 6`, `plans/client-sdk/strategic-plan.md §Rationale: Why key generation timing is a strategic concern`
- Done when: A test that mocks the keyring-write call to fail confirms no countersignature is ever produced in that case (the function errors out before signing, not after); a happy-path test confirms write-then-sign ordering via call-order assertions, not just final-state assertions.

**Step 3.4 — New-wallet acceptance path**
- What: Implement `open_offer_acceptance_new_wallet.md` end-to-end: offer display/verification (Step 3.2) → full wallet setup (Phase 2, invoked inline as this spec requires) → Step 3.3 countersign → claim payload assembly and submission to the press's `POST /open-offer/claim` (`press.md §4`) — routed through `ObliviousProtocolTransport` targeting that offer's named press (Step 1.4a/1.4d), not a direct `fetch()` — → SCIP receipt and keyring update with the new card.
- Who: Claude
- Context needed: `specs/process_specs/open_offer_acceptance_new_wallet.md` (full), `specs/object_specs/press.md §4, §5.2`, `plans/client-sdk/strategic-plan.md §Goal 7` (why this call is oblivious-routed)
- Done when: End-to-end test: a first-time recipient with no prior wallet state completes claim → card appears in local card list → SCIP is held → keyring contains the new card's key, against stub press and wallet-service instances reached via their respective oblivious-relay gateways (Steps 1.4c/1.4d), confirming the press's access log shows only the relay's IP for this claim submission.

**Step 3.5 — Existing-wallet acceptance path**
- What: Implement `open_offer_acceptance_existing_wallet.md` end-to-end: offer display/verification (Step 3.2, wallet-already-exists) → Step 3.3 countersign (keyring update only, no new passkey/master key) → claim submission → confirmation.
- Who: Claude
- Context needed: `specs/process_specs/open_offer_acceptance_existing_wallet.md` (full)
- Done when: End-to-end test using a holder with existing wallet state (from Phase 2's setup) confirms the new card is added without re-deriving `decryption_key` or creating a second passkey.

**Step 3.6 — Targeted offer acceptance and press finalization**
- What: Implement `card_offering_and_acceptance.md §Phase 5–6`: recipient review/verification/countersign (reusing Steps 3.2–3.3), return to offerer, and — since the offerer's wallet forwards to the press, not the recipient directly — implement the offerer-side validation-and-forward step too (confirm `holder_signature` verifies before forwarding to `POST /issue/finalize`, per `press.md §4`), routed through `ObliviousProtocolTransport` the same as Step 3.4's claim submission.
- Who: Claude
- Context needed: `specs/process_specs/card_offering_and_acceptance.md §Phase 5–6`, `specs/object_specs/press.md §5.1`, `plans/client-sdk/strategic-plan.md §Goal 7`
- Done when: End-to-end test covering both sides of a targeted issuance (offerer creates + forwards, recipient reviews + countersigns) against a stub press reached via its oblivious-relay gateway, confirming the completed card carries all three signatures, the recipient holds the SCIP, and the press's access log shows only the relay's IP for the finalization call.

**⬥ Phase 3 Milestone Review**
- Context needed: Step 3.1–3.6 outputs; `plans/client-sdk/strategic-plan.md §Goals 2 (key generation) and 6 (verification) Objectives`
- Done when: All three acceptance paths (new-wallet open-offer, existing-wallet open-offer, targeted) pass end-to-end; the "persist before sign" invariant test from Step 3.3 passes; a code-search confirms no chain-walking or signature-verification logic exists outside calls into the shared `CardVerifier`; phase summary written to `plans/client-sdk/milestones/phase-3-summary.md`.

---

### Phase 4: Sub-Card Request, Consent, Countersigning, and Revocation

**Goal:** Both directions of the sub-card protocol work end-to-end: this SDK can request a sub-card from another instance of itself (or any spec-conformant wallet), and can act as the wallet granting, revoking, and deregistering sub-cards requested by other apps.

---

**Step 4.1 — Requester-side: keypair generation and SubCardDocument assembly**
- What: Per OQ-SDK-10's resolution, implement the requesting-app side: generate a fresh ML-DSA-44 keypair via `SecureKeyProvider` (non-exportable, hardware-backed on RN; software non-extractable on web per OQ-SDK-1), assemble the `SubCardDocument` (`subcards.md §Step 1`), sign with the app's own card key → `app_signature`. The SDK does not own request delivery (OQ-SDK-9) — it returns the partially-signed document for the host app to transmit via whatever channel it implements.
- Who: Claude
- Context needed: `specs/subcards.md §Sub-Card Request Flow Step 1`, `specs/protocol-objects.md §16` (`SubCardDocument` schema)
- Done when: A generated `SubCardDocument` matches the spec's JSON shape exactly (fixture test), `app_signature` verifies, and a test confirms the generated private key is not exportable via any SDK API.

**Step 4.2 — Wallet-side: inbound request validation**
- What: Implement `handleSubCardRequest(rawRequestPayload)` (the sole entry point per OQ-SDK-9): verify `app_signature`, apply both keccak256 binding checks (`holder_primary_card_pubkey`, `app_card_pubkey`), and validate the app card's chain via the shared `CardVerifier` — configured with `trustedRoots` set to the governance app-certification policy root and `fetchAnnotations: false` (annotation-board integration is deferred, OQ-SDK-11), per the strategic plan's resolution that this reuses the same verifier pattern as `press.md`'s `verifyAppCertificationChain`. Determine whether this requires a second `CardVerifier` instance (different `trustedRoots`) alongside the one from Step 1.4, or whether the primary instance's config should include both root sets — decide based on whichever the verifier package's config surface makes cleaner, and document the choice.
- Who: Claude
- Context needed: `specs/subcards.md §Sub-Card Request Flow Step 2`, `specs/object_specs/press.md §5.4 verifyAppCertificationChain` (the pattern being mirrored), `specs/object_specs/card_verifier.md §5` (`VerifierConfig.trustedRoots`, `fetchAnnotations`)
- Done when: Test fixtures cover every hard-rejection condition from `subcards.md` Step 2 that's in scope (signature invalid, either binding mismatch, chain not reaching the app-certification root, app card itself revoked); no annotation-board fixture or check is exercised in this pass (deferred, OQ-SDK-11).

**Step 4.3 — Consent data structure and countersigning**
- What: On successful validation (Step 4.2), assemble the typed consent data structure the strategic plan's Goal 5 calls for: app identity (resolved name/version/publisher from the decrypted app card), requested vs. grantable `capabilities` (the wallet may grant a subset, never more), any advisory annotation warnings, and a default/suggested `valid_until`. Expose a separate `countersignSubCardRequest(consentDecision)` call that the host app invokes after collecting user approval (or skips entirely for the wallet self-signing exception, per `subcards.md`) — this call performs the actual `holder_signature` and IPFS post. Wire this back to Phase 2 Step 2.2 for the self-signing path.
- Who: Claude
- Context needed: `specs/subcards.md §Sub-Card Request Flow Steps 3–4` (including the self-signing exception)
- Done when: A third-party-app fixture produces a consent structure with correct capability narrowing (host requests 3 capabilities, wallet config only grants 2 — output reflects 2); the self-signing path test confirms no consent structure is required/returned and countersigning proceeds directly.

**Step 4.4 — Press submission, revocation, and deregistration**
- What: Submit the completed `SubCardDocument` to the press (`press.md §5.4 processSubCardRegistration`), via `POST /sub-card/register`. Implement revocation: user-initiated (8xx, code 801, signed by the user's current active sub-card) and app-initiated (8xx, code 811, signed by the app's installation card), per `subcard_creation_policy.md §Revocation — 8xx` — both submitted via the general card-update-intent flow (`card_updates.md`, `POST /update`), not a sub-card-specific endpoint. Implement deregistration as a distinct operation (`POST /sub-card/deregister`) requiring and signed by the **primary card key only** (`subcards.md §Authorization for Deregistration`) — a test must confirm the SDK refuses to construct a deregistration request signed by anything else, including the sub-card key or the app's installation card. All three calls (`/sub-card/register`, `/update`, `/sub-card/deregister`) go through `ObliviousProtocolTransport` — these are exactly the press endpoints Goal 7 names as in-scope. This is the primitive Phase 2 Step 2.5 (post-recovery batch deregistration) depends on.
- Who: Claude
- Context needed: `specs/subcards.md §Sub-Card Revocation, §Authorization for Deregistration`, `specs/process_specs/subcard_creation_policy.md`, `specs/process_specs/card_updates.md`, `specs/object_specs/press.md §5.4`, `plans/client-sdk/strategic-plan.md §Goal 7`
- Done when: Registration succeeds against a stub press reached via its oblivious-relay gateway; both 8xx revocation paths (user-signed, app-signed) succeed and a 9xx attempt is rejected client-side before ever reaching the press (the SDK does not expose an API capable of constructing a 9xx sub-card revocation, per the strategic plan's explicit scope exclusion); deregistration signed by anything other than the primary key is refused before any network call; the press's access log for all three calls shows only the relay's IP.

**Step 4.5 — Annotation-sync scheduling — REMOVED (out of scope, OQ-SDK-11)**

This step originally implemented periodic annotation-board polling and annotation-triggered auto-revocation. Per the strategic plan's resolution of OQ-SDK-11, the EAS annotation-board layer is out of scope for now — there is no annotation check to schedule. If this is picked back up later, it slots in here as a config change (`fetchAnnotations: true` on the Step 4.2 verifier config) plus whatever scheduling hook is decided at that time; no new step number is reserved for it now.

**⬥ Phase 4 Milestone Review**
- Context needed: Step 4.1–4.4 outputs; `plans/client-sdk/strategic-plan.md §Goal 5 Objectives`
- Done when: A full loop — one SDK instance requests a sub-card, another SDK instance (acting as wallet) validates (signature, binding, certification chain, revocation log — no annotation check), produces consent data, countersigns, and registers it, then revokes it — passes end-to-end against stub press/registry; the 9xx-exclusion and primary-key-only-deregistration tests pass; phase summary written to `plans/client-sdk/milestones/phase-4-summary.md`.

---

### Phase 5: Messaging and UUID/Relay Management

**Goal:** A holder can send and receive E2E-encrypted messages across all delivery modes (SSE, WebSocket, silent push + `GET /pending`), with UUID pool lifecycle management upholding the spec's unlinkability and anti-correlation properties on both platforms.

---

**Step 5.1 — Message envelope construction and per-subcard fan-out**
- What: Implement `SignedMessageEnvelope` construction (`messaging_protocol.md`), covering the message type taxonomy needed for this SDK's in-scope flows at minimum (`text`, `reply`, `edit`, `reaction`, `read_receipt`, `card_offer`/`card_offer_accepted`/`card_offer_declined` — reusing Phase 3's offer objects, `card_update_notification` receipt, `auth_request`/`auth_response`). Implement sender-side per-subcard fan-out per `message_routing.md §Sender-Side Fan-out`: resolve the recipient's current sub-card list from the on-chain storage contract, encrypt independently to each sub-card's ML-KEM public key, and produce N independent routing envelopes.
- Who: Claude
- Context needed: `specs/messaging_protocol.md` (full), `specs/process_specs/message_routing.md §Sender-Side Fan-out, §Routing Envelope`
- Done when: A message sent to a card with 3 registered sub-cards produces exactly 3 distinct ciphertexts (not one ciphertext copied 3 times) verified by decrypting each with its respective sub-card private key in the test harness; envelope construction matches spec fixtures for each implemented message type.

**Step 5.2 — Inbound message verification and decryption**
- What: On receipt of a routing envelope payload, decrypt via ML-KEM, then verify the inner `SignedMessageEnvelope`'s signature(s) via the shared `CardVerifier`'s `verifyEnvelope()` — not a hand-rolled signature check. Apply message-type-specific handling (edit-chain linking by `edit_of`, retraction by `retracts`, reaction target linking) and persist to message history via `StorageProvider`, deduplicating by message ID (hash of canonical payload) to handle relay retransmission after restarts.
- Who: Claude
- Context needed: `specs/object_specs/card_verifier.md §6.1 verifyEnvelope`, `specs/messaging_protocol.md §Message Type Taxonomy`, `specs/process_specs/message_routing.md §UUID Re-registration and Retransmission` (dedup requirement)
- Done when: A test confirms an envelope with an invalid signature is rejected (not displayed) via the verifier's result, not a separate check; a retransmitted duplicate (same message ID, simulated relay-restart scenario) is stored once, not twice.

**Step 5.3 — UUID registration with session separation and staggering**
- What: Implement `notification_relay.md §Process 1` (relay `POST /register` bootstrap/replenishment, then per-card wallet registration via `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`), enforcing `§Registration Privacy`'s constraints structurally: each card's wallet-facing registration happens in its own session (a fresh connection/context, not a shared keep-alive pool reused across cards), with a randomized stagger delay between different cards' registrations on the same device. No SDK-exposed API allows registering multiple cards' UUIDs in one call or one session. All wallet-facing registration calls go through `ObliviousProtocolTransport` (Step 1.4a) by default — the oblivious-relay path already hides device IP from the wallet service, so this step's job is purely the content/timing-level separation (session-per-card, staggering), which is required regardless of transport.
- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Registration Privacy, §Process 1`, `plans/client-sdk/strategic-plan.md §Goal 4 and Goal 7 Objectives`
- Done when: An integration test registers UUIDs for two different cards on one device and confirms (via request-level session/connection inspection in the test harness) that the two registrations used separate sessions and were separated by at least the configured minimum stagger delay; a second test confirms registration succeeds identically via `ObliviousProtocolTransport`'s oblivious-relay path and its direct-HTTPS bypass mode, against the same stub wallet service.

**Step 5.4 — Replenishment scheduling**
- What: Implement proactive UUID pool replenishment: replenish when ≤3 UUIDs remain per subcard, on a randomized schedule, never immediately after message receipt (per the explicit anti-correlation instruction in `notification_relay.md`).
- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Replenishment`
- Done when: A test confirms replenishment does not fire in the tick immediately following a simulated message receipt, and does fire once the pool drops to the threshold on a subsequent randomized-delay tick.

**Step 5.5 — Realtime delivery: SSE, WebSocket, push catch-up**
- What: Implement device-level SSE connection management (`notification_relay.md §Process 4`) using the platform `RealtimeTransportProvider` (native `EventSource` on web, the shipped RN SSE implementation per OQ-SDK-3 resolution), per-card WebSocket sessions for active chat (`§Process 3`), silent-push-triggered `GET /pending` catch-up (`§Process 5`), and ack handling (`POST /ack`) that triggers the relay's staggered wallet-clearance. Confirm the SDK never treats a `POST /deliver` 200-equivalent as clearance — only an explicit ack, per `message_routing.md`'s "must not clear based solely on relay delivery" instruction.
- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Process 3, §Process 4, §Process 5`, `specs/object_specs/relay.md §7.3–7.6`
- Done when: End-to-end test covers all three delivery paths (SSE while foregrounded, WebSocket during active chat, silent-push-triggered pending-pickup while backgrounded) against a stub relay, on both web and RN provider sets; a message is never marked locally "delivered to relay" as equivalent to "acked."

**Step 5.6 — UUID pool deregistration**
- What: Implement `DELETE /cards/{card_hash}/subcards/{subcard_hash}` (app uninstall / device cleanup), the signed-envelope variant per `notification_relay.md`'s v0.9 authentication requirement — proving control of the subcard's private key, structurally identical to registration minus the `uuids` field.
- Who: Claude
- Context needed: `specs/process_specs/notification_relay.md §Multi-Device Support Deregistration`
- Done when: Deregistration succeeds with a valid signed envelope and is rejected without one; a re-registration immediately after deregistration resumes normal delivery (confirming this is *not* conflated with on-chain sub-card revocation, per the spec's explicit warning).

**⬥ Phase 5 Milestone Review**
- Context needed: Step 5.1–5.6 outputs; `plans/client-sdk/strategic-plan.md §Goal 4 Objectives`
- Done when: A two-device (or two-simulated-instance) test confirms independent per-subcard message delivery; session-separation and staggering tests from Step 5.3 pass; phase summary written to `plans/client-sdk/milestones/phase-5-summary.md`.

---

### Phase 6: Cross-Platform Hardening, Documentation, and Pre-Release Review

**Goal:** The SDK is validated end-to-end on both platforms against realistic (not just stub) backend instances, documented for host-app integrators, and cleared by a security review before any production use.

---

**Step 6.1 — Full cross-platform scenario suite**
- What: Run every prior phase's end-to-end scenario (wallet setup/recovery, offer acceptance x3 paths, sub-card request/grant/revoke loop, messaging) against real (not stubbed) local instances of the wallet service, press, and relay (per `plans/wallet-service/`, `press/`, `relay/`), on both the web and RN provider sets, per the Phase 1 shared-scenario harness pattern.
- Who: Claude + user validation
- Context needed: All prior phase outputs; local dev instances of wallet-service, press, relay
- Done when: Every scenario passes identically on both platform provider sets against real backend instances; any behavioral divergence between web and RN is either fixed or explicitly documented as an intended platform difference (e.g., the OQ-SDK-1 web/native key-storage gap).

**Step 6.2 — Oblivious-relay transport validation against real relay, wallet-service, and press OHTTP endpoints**
- What: Validate `ObliviousProtocolTransport` (Step 1.4a) against real (non-stub), deployed relay (Step 1.4b), wallet-service (Step 1.4c), and press (Step 1.4d) instances — the full path was already built and unit/integration-tested against each other in Phase 1, but this step exercises it against actual deployed infrastructure rather than local test harnesses: confirm end-to-end HPKE encapsulation/decapsulation against both destinations' real published key configurations, measure the added latency of the relay hop on the staggered registration flow (Step 5.3) and on press claim/update submission under realistic network conditions, and document the fallback behavior and error surface when the relay's oblivious-forwarding endpoint or either gateway is unavailable.
- Who: Claude + user validation
- Context needed: `plans/client-sdk/strategic-plan.md §OQ-SDK-4`, real (or realistic staging) relay, wallet-service, and press deployments with the corresponding endpoints implemented
- Done when: Network-level inspection confirms both the wallet service's and a press's access logs show only the relay's IP for SDK-originated sensitive requests, never a test device's IP, while the press's public read endpoints (confirmed still direct) show the test device's IP as expected; latency overhead of the oblivious path versus the direct-HTTPS bypass is measured and documented for both destinations; a clear, tested error/fallback path exists for "relay's oblivious-forwarding endpoint unavailable" and for "destination gateway unavailable."

**Step 6.3 — Integrator documentation**
- What: Write `client-sdk/README.md` and per-provider integration guides: how to supply/override each `Provider` interface, the disclosed web-vs-native security posture difference (OQ-SDK-1), how `StorageProvider` differs by platform and how to substitute a host app's own storage layer, and a worked example of the full offer-acceptance and sub-card-request/grant flows for both a web app and an RN app.
- Who: Claude
- Context needed: All prior phase outputs
- Done when: A developer unfamiliar with the SDK's internals can follow the README to wire up a minimal web app and a minimal RN app, each completing an open-offer claim against a local stub backend, using only the documented public API.

**⚑ Clarification Checkpoint CP-2: Pre-production security review**

Before any production deployment or real user data: an independent review covering (a) the "persist before sign" invariant (Step 3.3) — confirm it cannot be bypassed by any public API surface; (b) key storage — confirm `SecureKeyProvider` default implementations on both platforms match the spec's non-exportability requirements exactly, and confirm the web software-key posture (OQ-SDK-1) is clearly surfaced to end users, not just documented for integrators; (c) the sub-card 9xx-exclusion and primary-key-only-deregistration checks (Step 4.4) cannot be circumvented; (d) no derived key, passkey output, or private key material appears in any log output across the full scenario suite. **Block production launch on this review**, mirroring `plans/wallet-service/implementation-plan.md`'s CP-3 for the server side.

**⬥ Phase 6 Milestone Review (Pre-Production Gate)**
- Context needed: All phase milestone summaries; `plans/client-sdk/strategic-plan.md §All Goals and Objectives`; CP-2 review findings
- Done when: All six goals' objectives verified against the full cross-platform scenario suite; CP-2 review complete with no open Critical/High findings; integrator documentation complete; production use approved.

---

## Clarification Checkpoints Summary

| ID | Where | Trigger |
|---|---|---|
| CP-0 | Phase 1, before Steps 1.4c/1.4d | **Resolved.** Lightweight custom HPKE envelope confirmed over strict RFC 9458 Binary HTTP, applying uniformly to both the wallet-service gateway (Step 1.4c) and the press gateway (Step 1.4d) — not a blocker for either going forward. |
| CP-1 | Phase 2, after Step 2.5 | Before backup/recovery code touches real key material or a production wallet service: independent security review of KDF, wrapping, and memory-retention behavior. Pair with `plans/wallet-service/implementation-plan.md` CP-2. |
| CP-2 | Phase 6, Step 6.3 | Pre-production security review, covering key-custody invariants, storage posture disclosure, and sub-card authorization boundaries. **Blocks production launch.** Pairs with `plans/wallet-service/implementation-plan.md` CP-3. |

---

## Context Map

For a fresh agent starting any step, the minimum context to load:

| Phase | Minimum context |
|---|---|
| Phase 1 | `plans/client-sdk/strategic-plan.md` (full), `specs/object_specs/card_verifier.md`, `membership_card_verifier/packages/verifier/*` (conventions to mirror); for Step 1.4b specifically: `relay/server/utils/app-registry.ts`, `relay/server/api/deliver/[uuid].post.ts`; for Step 1.4c specifically: `wallet-service/src/secrets/*`, `wallet-service/server/routes/accounts/index.post.ts`, `wallet-service/server/utils/auth.ts`; for Step 1.4d specifically: `press/src/handlers/open-offer.ts`, `press/server/api/open-offer/claim.post.ts`, `press/src/config.ts` |
| Phase 2 | `plans/client-sdk/milestones/phase-1-summary.md`, `specs/process_specs/wallet_backup_and_recovery.md`, `plans/wallet-service/implementation-plan.md §Phase 2–3` |
| Phase 3 | `plans/client-sdk/milestones/phase-2-summary.md`, `specs/process_specs/card_offering_and_acceptance.md`, `specs/process_specs/open_offer_creation.md`, `specs/process_specs/open_offer_acceptance_new_wallet.md`, `specs/process_specs/open_offer_acceptance_existing_wallet.md`, `specs/object_specs/press.md §4, §5.1–5.2`, `plans/client-sdk/strategic-plan.md §Goal 7` (why press submission is oblivious-routed) |
| Phase 4 | `plans/client-sdk/milestones/phase-3-summary.md`, `specs/subcards.md`, `specs/process_specs/subcard_creation_policy.md`, `specs/process_specs/card_updates.md`, `specs/object_specs/press.md §5.4`, `plans/client-sdk/strategic-plan.md §Goal 7` |
| Phase 5 | `plans/client-sdk/milestones/phase-4-summary.md`, `specs/messaging_protocol.md`, `specs/process_specs/message_routing.md`, `specs/process_specs/notification_relay.md`, `specs/object_specs/relay.md` |
| Phase 6 | All previous milestone summaries, `plans/client-sdk/strategic-plan.md §All Goals` |
