# Card Login — Code Plan (Phase 3)

Date: 2026-11-09 · Specs approved at CP2: [card-login-spec-changes.md](card-login-spec-changes.md) · Plan: [card-login-implementation-plan.md](card-login-implementation-plan.md)

## §0 Findings from reading the code

These change what Phase 4 has to do. Items marked **David** need a decision before the affected step.

| # | Finding | Effect on login | Proposed handling |
|---|---|---|---|
| F1 | The verifier (TS `stages/stage2.ts` and Python `stages/stage2.py`) does **not** implement `card_verifier.md §7.2` steps 7 (capability), 8 (`valid_until`), or 14 (attestation level). `attestation_level` is typed `"T1" \| "T2"` only. | Login needs all three for server cards (`auth_request` capability, expiry, `S1`). | **David:** (a) *recommended* — implement steps 7, 8, 14 in Stage 2 for every sub-card, as specced, since 16f sits next to them and login can't be correct without them; or (b) implement them only inside `verifyServerCard` and log the general gap as a CP6 follow-up. (a) may reject existing sub-cards whose capabilities don't list the message type they sign — the test fixtures use `['auth_response']`, so other message types signed by device sub-cards in the suites would start failing and need fixture updates. |
| F2 | Press `handlers/sub-card.ts` step 5 accepts an app card whose chain reaches **any** trusted root (`verifyCard(...).chain_reaches_trusted_root`), not specifically the app-certification root; step 6 only logs a warning for non-T2. The press verifier (`context.ts`) has no `appCertificationRoot`. | The `P-26` scope rule needs to know the login service branch, which means the press needs app-cert and login-service-branch roots in config anyway. | **David:** *recommended* — add `PRESS_APP_CERTIFICATION_ROOT` and `PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT`, require the app card chain to pass through the former (closing the any-root gap), and enforce `S1`/`P-27`. Leave the T1-vs-policy check as-is (warning), since that's outside login. |
| F3 | `policy-match.ts` matches by `policy_id` CID. | Already handled by the spec (login matches by registry address). | New `src/login/dcql.ts`; uses `CardEntry.policy_address` (already returned by `RpcProvider.getCardEntry`), so no CID→address lookup is needed. |
| F4 | `app-sdk` `messageId()` returns keccak256 as **hex**; specs say base64url. | `auth_confirmation.in_reply_to`. | Use whatever `messageId()` returns, consistently on both sides; leave the encoding question as the CP6 item already reported. `request_hash` is computed by new code as base64url per spec. |
| F5 | `dev-tests` runs on Arbitrum Sepolia and never bootstraps governance; `integration_tests` runs on a local devnode and self-bootstraps. | Creating the login service branch node on Sepolia is a testnet governance action. | Fixtures and suites go into `integration_tests` first (no CP4). The `dev-tests` login suite is written but runs only after **David provisions the login service branch on Sepolia (CP4)**. |
| F6 | The contract already has `get_domain_registration` (`contracts/logic-contract/src/lib.rs`). | `RpcProvider.getDomainRegistration` needs only client code. | **No contract change** (CP4 not triggered by code). |
| F7 | Wallet service UUID registration (`src/auth/subcard-uuid-signature.ts`) checks only on-chain sub-card registration and the signature. | Server cards can register UUIDs and receive messages unchanged. | **No wallet-service change.** Confirmed by the integration suite (`mcard_message` scenario). |
| F8 | ~55 `CardVerifier` construction sites (most in tests) across verifier, SDKs, press, harnesses, suites, and a Matrix policy module. | The new required `loginServiceCertificationRoot` (spec decision 12) touches all that verify sub-cards. | Land the config field and all call-site updates in the same step (4.2), with a shared test-fixture constant. |
| F9 | **Found in Phase 4 (2026-11-09).** The press writes card-update log entries in a different shape from `protocol-objects.md §3`: `appendLogEntry` (`press/src/functions/log.ts`) pins them **unencrypted**, without `card_state` or `history`, and with `version` hard-coded to 1. The verifier assumed every card head is an encrypted genesis document. Together, any card that has been updated cannot be verified correctly. | Login depends on updates: every server card needs a code-510 `active_subcards` entry on the login service card, and every login service card needs a code-520 `domain_binding`. | Verifier side fixed to spec in 4.2 (`src/head.ts`: decrypt head; for a log entry, overlay `card_state` on the genesis document). **David:** fix the press side (encrypt, `card_state`, `history`, real `version`) as part of login, or treat it as a separate task (CP6)? Until fixed, login works only in unit tests and mocked integration. |
| F10 | **Found in 4.6.** Card-message fan-out needs each recipient sub-card's ML-KEM public key, and no protocol field records it yet (also noted in `press.md §5.4`'s sibling-notification text). | `mcard_message` delivery to server cards. | wallet-sdk `sendLoginMessage` takes an injected `resolveRecipients`. The key source is an existing messaging gap; integration (4.8/5.1) will show what the stack does today. |
| F11 | **Found in 4.2.** The predicate engine lives only in the press, so the verifier can't evaluate DCQL `meta.predicate`. | Requests with a predicate. | A predicate never matches (`PREDICATE_NOT_SUPPORTED`); sites should use policy lists only until the engine is shared. |
| F12 | **Found in 4.2.** `RpcProvider.getDomainRegistration` is optional on the interface so existing providers keep compiling; login entry points throw `MISSING_RPC_METHOD` without it. | Every RpcProvider used for login. | Implemented in `verifier-rpc-provider` and the press adapter; spec (`card_verifier.md §4.1`) to note it's optional. |
| F13 | **Found in 4.4.** The press records a card's `policy_address` as `keccak256(policy CID)`; the spec treats a policy as a card whose address is `keccak256(recipient_pubkey)`. The test policies have no public key at all. | DCQL policy matching and `include_children`; `preferred_services` inheritance (reads policy cards' live heads). | Login matches a card's own policy by its on-chain `policy_address` (works in both schemes). The parent walk still needs real policy cards, so today `include_children` matches only a card's own policy, and inherited services resolve only from snapshots. Reconciling policy addressing is out of login scope (CP6). |
| F14 | **Found in 4.4.** Verifier Stage 2 required a `CardEntry` for each sub-card; `RegisterSubCard` creates only a `SubCardEntry`, and the press pins the sub-card document unencrypted. No live sub-card signature had been verified before. | Every sub-card signature, including server cards and login responses. | Stage 2 now reads the document via `SubCardEntry.sub_card_doc_cid`, accepts it plain or encrypted, and checks `recipient_pubkey` is the signer (`card_verifier.md §7.2` steps 2–4 amended). |
| F15 | **Found in 4.4.** Verifier Stage 3 recognized a trusted root only when its ancestry was empty, so a root minted by an issuer never reached itself once callers pass the card's key. Press `getCardEventLog` always used the chain's public RPC (mainnet for the local devnode). wallet-sdk posted updates to `/update` instead of `/api/update`. | Press P-15 checks after F2; any press `verifyCard` with a key; every SDK-posted update. | Fixed: Stage 3 start-card check; optional `ARBITRUM_LOGS_RPC_URL`; `postCardUpdate` uses `/api/update`. |

---

**Decisions (David, 2026-11-09):** F1 → **login-only checks**: `verifyServerCard` checks the server card's capability, `valid_until`, and `S1` itself; Stage 2 gains only step 16f (branch + scope rule + `S1` rejection outside server cards). General enforcement of Stage 2 steps 7/8/14 stays a separate follow-up. F2 → **fix**: the press gets `PRESS_APP_CERTIFICATION_ROOT` and `PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT` and requires app card chains to pass through the app-certification root.

---

## §1 Inventory

Spec references are to the approved specs. "No change" is stated explicitly where that is the finding.

### `membership_card_verifier/packages/verifier` (TS)

| File | Change | Spec |
|---|---|---|
| `src/types.ts` | `VerifierConfig.loginServiceCertificationRoot`; `RpcProvider.getDomainRegistration`; `attestation_level` adds `"S1"`; `app_card_branch` on `SignatureVerificationResult`; login result types | `card_verifier.md §4.1, §5, §8` |
| `src/stages/stage2.ts` | Step 16f: branch detection while walking the app card chain, scope rule (`LOGIN_SERVICE_SCOPE`), `LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED`, `S1` rule. Plus steps 7/8/14 if F1(a) | `§7.2` |
| `src/login/types.ts` (new) | `AuthenticationRequest`, `AuthenticationResponse`, `DcqlMcardQuery`, `DomainBindingAttestation`, `LoginServiceMetadata`, `WalletRegistrationToken` | `protocol-objects.md §8–9, §17–19` |
| `src/login/requestHash.ts` (new) | `requestHash(request)` = base64url(keccak256(canonicalize(request))) | `protocol-objects.md §8` |
| `src/login/dcql.ts` (new) | Policy match by registry address with `include_children` (issuance-chain walk via `ancestry_pubkeys[0]` → issuer `CardEntry.policy_address`), then optional predicate | `protocol-objects.md §8.1` |
| `src/login/domainBinding.ts` (new) | Attestation binding/signature checks, currency rule (`getDomainRegistration`), coverage rule | `protocol-objects.md §17` |
| `src/login/verifyServerCard.ts`, `src/login/verifyLoginResponse.ts` (new) | The two entry points | `§6.3, §6.4` |
| `src/CardVerifier.ts` | Wire the two methods; pass `loginServiceCertificationRoot` through | `§5, §6` |
| `src/errors.ts`, `src/index.ts` | New codes; exports | `§9`, `card_login.md §Error Codes` |
| `src/policy-match.ts` | No change (F3) | — |

### `membership_card_verifier/packages/verifier-py`

Parity for every TS verifier change above (`types.py`, `stages/stage2.py`, new `login/` module, `card_verifier.py`, `errors.py`), passing the shared vectors (§2). Phase 5.3.

### `membership_card_verifier/packages/verifier-rpc-provider`

`src/index.ts`: implement `getDomainRegistration` against the logic contract's `get_domain_registration` (F6).

### `press`

| File | Change | Spec |
|---|---|---|
| `src/config.ts`, `src/context.ts` | `PRESS_APP_CERTIFICATION_ROOT`, `PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT`; pass both to the verifier; RPC adapter gains `getDomainRegistration` | F2 |
| `src/handlers/sub-card.ts` | Branch from `chain_card_addresses`; `P-26` scope rule; `S1` acceptance / `P-27` | `press.md §5.4` |
| `src/handlers/update.ts` | Code 520 path (`P-23`, `P-28`; set-once); `domain_binding` added to `IMMUTABLE_FIELDS` with 520 as its allowed code; `preferred_services` shape check (`P-29`) | `§5.3` steps 4a, 5a |
| `src/functions/issuance.ts` | `preferred_services` shape check on policy-card issuance (`P-29`) | `§5.1` step 7 |
| `src/types.ts` | Error codes `P-26`–`P-29` | `§Error codes` |
| `src/chain/registry.ts` | Read `get_domain_registration` | F6 |

### `app-sdk/packages/app-sdk`

| File | Change | Spec |
|---|---|---|
| `src/messaging/envelope.ts` | Replace `AuthRequestContent`/`AuthResponseContent` with the v2 shapes; add `auth_confirmation`; update `test/messaging/envelope.test.ts` (lines 85–86) | `messaging_protocol.md §13, §14, §23` |
| `src/login/` (new): `store.ts`, `serverCard.ts`, `request.ts`, `formPost.ts`, `message.ts`, `code.ts`, `metadata.ts`, `urls.ts`, `browser.ts`, `index.ts` | §9a functions; re-export login types from the verifier | `app_sdk.md §9a` |
| `src/testing/` | In-memory `LoginStore`; file-backed dev `SecureKeyProvider` for servers | `§9a` key custody |
| `src/subcards/types.ts` | `attestation_level` adds `"S1"` | `protocol-objects.md §16` |
| `src/index.ts` | Export `login` | — |

Server key provider package: **not created now.** `testing/` gets a dev file-backed provider; a production Node/KMS provider is a follow-up once a real site needs one.

### `wallet-sdk/packages/wallet-sdk`

| File | Change | Spec |
|---|---|---|
| `src/subcards/handleSubCardRequest.ts` | Login service scope rule (`LOGIN_SERVICE_SCOPE`) and reject `S1` on the third-party path | `wallet_sdk.md §6.1` |
| `src/login/` (new): `handoff.ts`, `validate.ts`, `match.ts`, `pending.ts`, `response.ts`, `confirmation.ts`, `serverCard.ts`, `router.ts`, `services.ts`, `index.ts` | §7a functions | `§7a` |
| `src/offers/newWalletOpenOfferAcceptance.ts`, `existingWalletOpenOfferAcceptance.ts`, `targetedOfferAcceptance.ts` | Optional `routerRegistrationUrl` on results when a router config + token are supplied | `§7.5` note |
| `src/index.ts` | Export `login` | — |

### `login-router/` (new package)

Static site: `src/login.ts`, `src/register.ts`, `src/settings.ts`, `src/recovery.ts`, `src/storage.ts`, `src/token.ts` (validation with `@noble/post-quantum` + a canonicalizer — no network), `scripts/build-wallet-list.ts` (generates `wallets.json` from wallet cards via the verifier), HTML pages, Vite build, Playwright config for Chromium/Firefox/WebKit. Tooling modeled on `sdk-providers-web` (pnpm, ESLint, Vitest). Deployment and domain: CP5, not in this phase.

### `wallet-service`, `relay`, `contracts`

- `wallet-service`: **no change** (F7).
- `relay`: **no change** — `mcard_message` uses ordinary delivery.
- `contracts`: **no change** (F6). CP4 is not triggered by code.

### Test fixtures and harnesses

| Location | Change |
|---|---|
| `integration_tests/fixtures/src/` | Create all three branch nodes (wallet, app, login service) under the app-cert root; move the harness's wallet card under the wallet branch (today it uses the root directly). New `loginServiceBranch.ts`: create the login service branch node under the app-cert root, login service policy, mint a login service card, register a domain (local devnode), sign + post a code-520 binding, create and register a server card (`S1`); `policy.ts`: policies with/without `preferred_services`, plus an inheriting child |
| `integration_tests/harnesses/web/` | Reference site (Node server using app-sdk login, also the "< 50 lines" measurement) and a wallet harness page using wallet-sdk login; router served from `login-router` build |
| `dev-tests/support/` | Mirror helpers that assume a pre-provisioned login service branch (F5) |
| Every `CardVerifier` construction (F8) | Pass `loginServiceCertificationRoot` (shared fixture constant) |

---

## §2 Types and tests

### 2.1 Where shared types and canonicalization live

Today each package declares its own `CardDocument`/`SubCardDocument` interfaces, and both SDKs depend on the verifier. Login follows the dependency direction rather than duplicating again:

- **Object types and `requestHash`** live in the verifier (`src/login/types.ts`, `requestHash.ts`) and are re-exported by app-sdk and wallet-sdk. The verifier already owns RFC 8785 canonicalization (`src/canonicalize.ts`), so request hashes and signatures use one canonicalizer.
- **The router** imports only the type definitions and `canonicalize` from the verifier at build time (bundled), plus `@noble/post-quantum` for ML-DSA-44. No runtime dependency on RPC or IPFS.
- **Python** mirrors the types in `verifier-py/.../login/`, kept honest by the shared vectors.

### 2.2 Test layers

| Layer | Where | Runs |
|---|---|---|
| Unit | Each package's Vitest (pytest for verifier-py), next to the module | Every step in Phase 4 |
| Conformance vectors | `specs/login-conformance.json`: canonical bytes + `request_hash` for sample requests; a signed response; a `DomainBindingAttestation`, `LoginServiceMetadata`, and `WalletRegistrationToken` with fixed keys; DCQL match cases (policy tree with `include_children` true/false); domain coverage cases. Format follows `specs/serialization-conformance.json` (`version`, `cases[]` with `id`, `description`, `input`, `expected_*`) | TS verifier (4.1), verifier-py (5.3), router token tests |
| Browser matrix | `login-router/` Playwright, Chromium + Firefox + WebKit, against the static build and a stub wallet/site | 4.7 |
| Integration | `integration_tests/suites/core/card_login.spec.ts` (local devnode stack) | 5.1 |
| Dev | `dev-tests/suites/core/card_login.spec.ts` (Sepolia) | After CP4 provisioning |

Every test name starts with the spec section it verifies, e.g. `card_login §AC-G2 wrong-origin phishing`.

### 2.3 Acceptance criteria → tests

`V` = verifier unit, `P` = press unit, `A` = app-sdk unit, `W` = wallet-sdk unit, `R` = router Playwright, `I` = integration suite.

**`card_login.md` — wallet validation (G2)**

| Criterion | Test |
|---|---|
| Malformed request rejected | W `validate.test.ts › malformed: missing field / bad version / two credentials` |
| Pubkey/pointer binding mismatch | W `validate.test.ts › LOGIN_REQUESTER_BINDING_MISMATCH` |
| Bad `request_signature` | W `validate.test.ts › LOGIN_REQUEST_SIGNATURE_INVALID` |
| Non-server sub-card / `app_card ≠ holder` | V `verifyServerCard.test.ts › not a server card (T2 device sub-card; app_card ≠ holder)`; I `› ordinary sub-card cannot sign a login request` |
| Login service card under the wallet or app branch | V `verifyServerCard.test.ts › LOGIN_SERVICE_NOT_CERTIFIED` |
| 8xx/9xx on server card, login service card, or ancestor blocks | V `verifyServerCard.test.ts › revoked server / login service card / ancestor`; I `› revoked login service card blocks` |
| 6xx/7xx warns, user can proceed | V `verifyServerCard.test.ts › LOGIN_WARN_SERVICE_NEGATIVE`; I `› warning login service card logs in after proceed` |
| Wrong-origin phishing | V `domainBinding.test.ts › example.net not covered`; I `› valid login service card, wrong origin` |
| Coverage: subdomain yes; `http` and :8443 no | V `domainBinding.test.ts › coverage vectors` (from conformance file) |
| `DOMAIN_SUSPENDED`; stale after admin change | V `domainBinding.test.ts › suspended / admin changed`; I `› domain handoff retires binding` |
| Expired request | W `validate.test.ts › LOGIN_REQUEST_EXPIRED` |

**`card_login.md` — verification and session binding (G3)**

| Criterion | Test |
|---|---|
| Valid `form_post` + cookie → session bound to `senders[0]` | A `formPost.test.ts › success`; I `› same-device form_post` |
| Same response without cookie rejected | A `formPost.test.ts › LOGIN_SESSION_MISMATCH`; I `› response posted from another browser` |
| Tampered `state`/`nonce`/`statement`/`request_hash`/`audience`/`recipients` | V `verifyLoginResponse.test.ts › one test per field and code` |
| Response > 5 min old | V `verifyLoginResponse.test.ts › LOGIN_RESPONSE_STALE` |
| DCQL: child policy rejected when `include_children: false`, accepted when `true` | V `dcql.test.ts › include_children vectors`; I `› child-policy card` |
| `mcard_message` needs cookie **and** code | A `code.test.ts › cookie only / code only / both`; I `› cross-device QR login` |
| Code single-use; 6th wrong attempt fails | A `code.test.ts › reuse / attempt limit` |
| `request_uri` returns 410 after completion | A `request.test.ts › serveLoginRequest 410` |
| Latency recorded | A `message.test.ts › onLatency sample`; I `› cross-device latency recorded` |
| Polling never completes a login | A `code.test.ts › no completion without code` (store has no completion path except `redeemLoginCode`) |

**`card_login.md` — discovery and wallet-initiated (G4)**

| Criterion | Test |
|---|---|
| Inherit / `[]` / own list | W `services.test.ts › inheritance vectors`; P `update.test.ts › preferred_services shape (P-29)` |
| Service whose metadata doesn't accept the card hidden | W `services.test.ts › filtered by accepts` |
| Wallet-initiated, matching `wallet_nonce` → no prompt | W `pending.test.ts › skip on match`; I `› wallet-initiated one-tap` |
| Prompt shown on mismatch / expired / used / warning | W `pending.test.ts › four negative cases` |

**`card_login.md` — router registration**

| Criterion | Test |
|---|---|
| First card registers silently; second wallet doesn't replace default | R `register.spec.ts › first / second`; W `offers › routerRegistrationUrl present on first acceptance`; I `› new-wallet open offer registers with router` |

**`login_router.md §10`** — one Playwright test each, in `login-router/test/`: `login.spec.ts` (one wallet forwards; two wallets → picker; `wallet_hint`; no wallet → recovery with/without `fallback_uri`), `register.spec.ts` (first default; add without replacing; four invalid-token cases store nothing), `privacy.spec.ts` (fragment removed; no network requests on `/login`/`/register`), `list.spec.ts` (delisted wallet not offered), `recovery.spec.ts` (pick wallet forwards; address lookup valid/invalid), `settings.spec.ts` (default changes only there). Each runs in all three browsers.

**`subcards.md` (new criteria)**

| Criterion | Test |
|---|---|
| `S1` accepted only on server cards | V `stage2.test.ts › S1 on server card / S1 on device sub-card`; P `sub-card.test.ts › P-27` |
| Login service `app_card` for another master rejected by wallet, press, verifier | W `handleSubCardRequest.test.ts › LOGIN_SERVICE_SCOPE`; P `sub-card.test.ts › P-26`; V `stage2.test.ts › LOGIN_SERVICE_SCOPE`; I `› login service card as wallet rejected` |

**`dns_resolution.md` (new criterion)** — `mcard://auth` triggers no CID fetch or chain read: W `handoff.test.ts › mcard://auth parsed as action link` (the wallet SDK is the only `mcard://` parser in the repo that handles `auth`).

**`press.md` code 520** — P `update.test.ts › 520 accepted; not login service branch / already set / bad signature / admin not current / suspended → P-28; not self-update → P-23`.

**`card_protocol_spec.md §8`** acceptance criteria are covered by the rows above (browser matrix → R; wrong origin, wrong browser, both modes, wallet-initiated, services → I and the unit rows).

---

## §3 Build order

Each step is testable when it lands and only depends on earlier steps. Step numbers match the implementation plan's Phase 4–5.

| # | Step | Depends on | Done when |
|---|---|---|---|
| 4.1 | **Conformance vectors + shared types**: `specs/login-conformance.json`; verifier `src/login/types.ts`, `requestHash.ts` | — | Vectors validate against the verifier canonicalizer |
| 4.2a | **Verifier config + Stage 2**: `loginServiceCertificationRoot`, `S1`, step 16f, `app_card_branch`, new codes; F1 steps 7/8/14 if (a); update **all** `CardVerifier` construction sites (F8) | 4.1; **F1 decision** | Existing verifier, SDK, and press suites pass with the new config; new Stage 2 tests pass |
| 4.2b | **Verifier login**: `getDomainRegistration` (+ `verifier-rpc-provider`), `dcql.ts`, `domainBinding.ts`, `verifyServerCard`, `verifyLoginResponse` | 4.2a | §2.3 `V` rows pass; vectors pass |
| 4.3 | **Press**: roots config, `P-26`/`P-27`, code 520 (`P-28`), `preferred_services` (`P-29`), `domain_binding` immutable | 4.2a, 4.2b (binding checks reuse `domainBinding.ts`); **F2 decision** | §2.3 `P` rows and existing press suite pass |
| 4.4 | **Fixtures** (`integration_tests/fixtures`): login service branch, login service policy, login service card, local domain registration, code 520, server card; `preferred_services` policies | 4.3 | Smoke test creates each object on the local devnode stack |
| 4.5 | **app-sdk login** + envelope type change | 4.2b | §2.3 `A` rows and existing app-sdk suite pass |
| 4.6 | **wallet-sdk login** + scope rule in `handleSubCardRequest` + acceptance hook | 4.2b, 4.5 (fan-out, types) | §2.3 `W` rows and existing wallet-sdk suite pass |
| 4.7 | **Login router** | 4.1 (types, canonicalizer), 4.6 (token signing for test tokens) | §2.3 `R` rows pass in Chromium, Firefox, WebKit |
| 4.8 | **Reference site + wallet harness** in `integration_tests/harnesses/web` | 4.4–4.7 | Same-device login completes end-to-end locally; reference site's login integration is counted (target < 50 lines) |
| 4.9 | Phase 4 milestone review | 4.1–4.8 | `milestones/card-login-phase-4-summary.md` |
| 5.1 | **Integration suite** `integration_tests/suites/core/card_login.spec.ts` (all `I` rows) | 4.8 | Suite runs; dated report in `integration_tests/reports/` |
| 5.1b | **dev-tests suite** (Sepolia) | 5.1; **CP4: David provisions the login service branch on Sepolia** | Suite runs against dev stack |
| 5.2 | Triage and fix | 5.1 | In-scope failures fixed (CP6 for the rest) |
| 5.3 | **Python parity** (verifier-py) | 4.2a, 4.2b | pytest + shared vectors pass |
| 5.4–5.5 | Docs, status, final review | all | Per implementation plan |

**Parallelism.** After 4.2b, three tracks can run side by side without touching the same files: press (4.3 → 4.4), app-sdk (4.5), and Python parity (5.3, moved earlier if wanted). wallet-sdk (4.6) needs 4.5's types; the router (4.7) needs only 4.1 plus test tokens.

**Gates.** F1 and F2 decisions before 4.2a / 4.3. CP4 before 5.1b. CP5 (router domain/deploy, npm publish) is not needed for any step here — the router is served locally in tests.

---

## §4 Coverage check (step 3.4)

**Every spec change has a code location or is spec-only:**

| Spec file (from the change summary) | Code location |
|---|---|
| `card_login.md` | verifier, press, app-sdk, wallet-sdk, router, fixtures (§1) |
| `login_router.md` | `login-router/` |
| `protocol-objects.md` | verifier `src/login/types.ts`; `S1` in verifier/app-sdk types |
| `messaging_protocol.md` | app-sdk `messaging/envelope.ts`, `login/message.ts`; wallet-sdk `login/confirmation.ts` |
| `subcards.md`, `card_verifier.md` | verifier Stage 2 + login; press `sub-card.ts`; wallet-sdk `handleSubCardRequest.ts`, `login/serverCard.ts` |
| `press.md`, `card_updates.md` | press `sub-card.ts`, `update.ts`, `issuance.ts`, `types.ts` |
| `dns_resolution.md` | wallet-sdk `login/handoff.ts` (action host); verifier `domainBinding.ts` (§5.3) |
| `update_codes.md` | 520 → press `update.ts`. 302 → no special press handling (ordinary 3xx field update; `P-29` shape check applies). Wallet-side cache invalidation on 302 is left to the wallet host: `resolveEffectiveServices` reads live and caches only metadata (24 h) |
| `policy_creation.md` | press `P-29`; drafter guidance is spec-only |
| `app_sdk.md`, `wallet_sdk.md` | the `login/` modules |
| Offer acceptance specs (3) | wallet-sdk offer acceptance hooks |
| `login_service_certification.md`, `app_certification_body.md` | Spec-only, except the router's `build-wallet-list.ts` and the fixtures' login service branch |
| `card_protocol_spec.md §1, §8`, `ARCHITECTURE.md`, `card_signing.md`, `card_validation.md`, `oblivious_transport.md` | Spec-only |

**Every acceptance criterion has a test:** all criteria in `card_login.md`, `login_router.md §10`, and the new ones in `subcards.md` and `dns_resolution.md` are mapped in §2.3; `card_protocol_spec.md §8`'s criteria are covered through those rows.
