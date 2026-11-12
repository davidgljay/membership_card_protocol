# Card Login — Spec Change Summary (Phase 2, for review at CP2)

Date: 2026-11-08 · Plans: [strategic](card-login-strategic-plan.md) · [implementation](card-login-implementation-plan.md) · [Phase 1 scan](card-login-spec-impact.md)

**What to review:** the two new specs ([card_login.md](../specs/process_specs/card_login.md), [login_router.md](../specs/object_specs/login_router.md)), the rewritten objects (`protocol-objects.md §8–9, §17–19`), and the **Decisions made while drafting** list below. Approving this file approves removing CHAPI, `callbacks.https`, OHTTP callbacks, and `confirmation_code` from the specs.

---

## Overview

Card login is now fully specified:

- **Flow** (`process_specs/card_login.md`): site signs a request with a **server card** → browser goes through the static **login router** (or QR / `mcard://auth`) → wallet validates who is asking (login service branch, domain binding, status) **before display** → user approves → response by `form_post` (same device) or `mcard_message` (card message; one-time code binds the browser) → site verifies with `verifyLoginResponse`.
- **Trust chain:** server card (`S1`) → login service card (login service branch under the app-certification root, bound to a domain by the DNS admin card via code 520) → `loginServiceCertificationRoot` → `appCertificationRoot`. A login service card can authorize only its own server cards.
- **Discovery:** `preferred_services` on policies, inherited along the issuance chain with replace semantics; filtered by each service's signed `/.well-known/membership-login`.
- **No contract changes** (CP4 not triggered). No existing field on `CardDocument`, `PolicyCardDocument`, `SubCardDocument`, or `SignedMessageEnvelope` changes meaning; all object changes are additive (CP3 not triggered for shared objects — but see *Breaking for implemented code*).
- 2 new specs, 1 new governance doc, 20 specs/governance files edited (+894 / −300 lines).

---

## Decisions made while drafting

These go beyond what the strategic plan and CP1 decided. Each is a default you can overturn.

1. **Domain binding is added after issuance (code 520), not co-signed at issuance.** The strategic plan and implementation plan say the DNS admin co-signs login service card *issuance*. But a card's public key doesn't exist until the recipient accepts the offer, so the admin can't sign over it in advance. Instead the login service card is issued normally, then the site operator posts a code-520 update carrying the admin's `DomainBindingAttestation`; the press validates it (`press.md §5.3` step 4a). Same security, no change to the issuance flow. Implementation plan step 4.3 needs rewording.
2. **Request shape flattened**, `version: "2"`: `payload.{content,context,nonce}` → top-level `statement`, `context`, `nonce` (`protocol-objects.md §8`).
3. **Response addressing:** `senders` = the **presented card** (the card matching the query, not necessarily the user's "master" card); `recipients` = the **login service card** (messages route only to master cards).
4. **Response content** = `{ audience, nonce, request_hash, state, statement }`; request `context` is display-only and not echoed (it's covered by `request_hash`).
5. **`request_hash` = base64url(keccak256(canonical request including signature))**, matching the protocol's message-ID hash function.
6. **Timing limits** (`card_login.md §Timing Summary`): request ≤ 10 min; response ≤ 5 min old; one-time code 5 min / single use / 5 attempts; pending wallet-initiated login 2 min; wallet waits 60 s for confirmation; metadata cache 24 h.
7. **One-time code:** 8 Crockford base32 characters (≥ 40 bits), redeemed at `response_uri?code=…` together with the `state` cookie.
8. **Native wallets and `form_post`:** the wallet opens its own HTTPS form-relay page in the system browser, which submits the form. If that isn't the browser that started the login, it fails safely and the user retries.
9. **Router details** (`login_router.md`): fragment-only parameters; new optional `fallback_uri` so the recovery screen can offer "use my phone"; defaults change only on a `/settings` page; recovery address lookup at `/.well-known/membership-wallet`; certified-wallet list built from wallet cards at build time and rebuilt daily; `/register#next=` accepted as an open redirect for v1.
10. **Wallet registration tokens are per wallet deployment**, not per user; icons are inline data URIs so the router makes no network requests.
11. **`LoginServiceMetadata` is signed by the server card**; its `name` is informational — wallets display the policy's name for a service.
12. **`VerifierConfig.loginServiceCertificationRoot` is required whenever sub-card signatures are verified** (missing → hard reject), the same pattern as `appCertificationRoot`. Otherwise, once a login service branch exists on-chain, an unconfigured verifier would accept a login service card posing as a wallet app. Breaking for verifier configs — see below.
13. **New verifier entry points** `verifyLoginResponse` (§6.3) and `verifyServerCard` (§6.4), and `RpcProvider.getDomainRegistration` (§4.1). Login matches policies by **registry address** (not CID) and does not use `VerifierConfig.conditions`.
14. **EAS annotations on login service cards deferred to P1.** v1 warn/block rules use update codes and domain fraud status only.
15. **Error codes:** one canonical `LOGIN_*` table in `card_login.md §Error Codes`; verifier codes `LOGIN_SERVICE_SCOPE`, `LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED`; press codes `P-26`–`P-29`.
16. **`auth_request` message is reference-only** (`{ request_uri }`) for sites pushing a login to a known card. A site that rejects a response sends nothing back; the wallet learns by timeout.
17. **`preferred_services`:** standard policy field, default updater = policy holder, new code **302**; `icon` is a CID; wallets read the live policy head (explicit exception to the `policy_id` snapshot rule).
18. **Governance:** login service certification lives in a sibling doc, `login_service_certification.md`, with issuance requirements, obligations, and a revocation-code table.
19. **Wallet-initiated shortcut** skips the prompt only with no warnings and exactly one matching card (or the card the user started from).
20. **Server card capabilities** = `auth_request`, `auth_confirmation`, `error`.
21. **Domain coverage:** a binding to `example.com` covers its subdomains, `https` on port 443 only.

---

## Breaking for implemented code

Nothing in the repo implements login, but two changes affect existing code:

- **`app-sdk/src/messaging/envelope.ts`** types `AuthRequestContent` (`requester_card`, `policy_cid`, …) and `AuthResponseContent` (`context.session_id`) to the old messaging §13–14 shapes; `test/messaging/envelope.test.ts` lines 85–86 use them. They change in Phase 4.5. `auth_confirmation` is added to the type union.
- **Verifier (TS and Python) Stage 2:** the required `loginServiceCertificationRoot` and step 16f mean every existing `CardVerifier` that verifies sub-card signatures (press, wallet-sdk, app-sdk, dev-tests, integration tests) needs the new config value once the code lands. Phase 4.2 / 4.4 must update all constructors and fixtures together.

---

## Changes by file

| File | Change | Why (strategic-plan decision) | Breaking? |
|---|---|---|---|
| **New:** `specs/process_specs/card_login.md` | End-to-end flow: setup, 7 phases, service discovery, router registration, latency, timing, canonical error codes, security considerations, acceptance criteria | All goals | — |
| **New:** `specs/object_specs/login_router.md` | Static router: `/login`, `/register`, certified wallet list, recovery, storage, threat model, Safari storage-expiry open question | Transport; registration | — |
| **New:** `governance/AppCertificationBody/login_service_certification.md` | Login service branch mandate, chain, issuance requirements, obligations, revocation triggers | OQ1 | — |
| `specs/card_protocol_spec.md` | §8 rewritten (CHAPI, callbacks, `confirmation_code` removed); `preferred_services` field + `service-array` type in §1; SDK metric renamed | Transport; G4 | Spec-only removal |
| `specs/protocol-objects.md` | §8–9 v2; new §17–19; §1.1 `domain_binding`; §2 `preferred_services`; §16 `S1` + login service scope rule; relationship summary corrected; contents fixed (§16 was missing) | Requester identity; response modes; CP1-a | Additive to shared objects |
| `specs/messaging_protocol.md` | §13 reference-only; §14 new content; new §23 `auth_confirmation`; error-type login notes; Summary Table renumbered; MSG-OQ-8/9 resolved | Response modes; CP1-b | Yes for app-sdk types (above) |
| `specs/subcards.md` | Login service branch in trust chain; `S1` tier; new §Server Cards; Step 5 and an acceptance criterion corrected (runtime verifiers **do** re-walk the app card chain) | OQ1, OQ3, CP1-a | — |
| `specs/object_specs/card_verifier.md` | `loginServiceCertificationRoot`; `getDomainRegistration`; §6.3, §6.4; Stage 2 step 14 (`S1`) and 16f; `app_card_branch`; new codes | G2, G3 | Yes for verifier config (above) |
| `specs/object_specs/press.md` | Code 520 handling; `preferred_services` validation; scope rule and `S1` at sub-card registration; `verifyAppCertificationChain` returns branch; `P-26`–`P-29` | OQ2, OQ3 | — |
| `specs/dns_resolution.md` | Reserved action hosts (`auth`, `invite`) before Forms A/B; §5.3 login service domain bindings; handoff note | OQ2, OQ6 | — |
| `governance/.../app_certification_body.md` | Second mandate pointer; login service branch in chain; wallet operators publish router metadata and registration token | OQ1, OQ8 | — |
| `specs/update_codes.md` | Codes 302, 520 | G4, OQ2 | — |
| `specs/process_specs/card_updates.md` | `domain_binding` in immutable list (except code 520) | OQ2 | — |
| `specs/process_specs/policy_creation.md` | Drafters may set `preferred_services`; validation | G4 | — |
| `specs/object_specs/app_sdk.md` | New §9a Login (site-side): `LoginStore`, server card request, request creation, `form_post`/message handlers, code redemption, metadata, button | OQ9 | — |
| `specs/object_specs/wallet_sdk.md` | New §7a Login (wallet-side); §6.1 scope rule; router registration on acceptance | OQ9 | — |
| `specs/process_specs/open_offer_acceptance_new_wallet.md` | Step 22a: silent router registration on the way to `redirect_url` | Registration | — |
| `specs/process_specs/open_offer_acceptance_existing_wallet.md` | Step 17a: same, add-only | Registration | — |
| `specs/process_specs/card_offering_and_acceptance.md` | Step 15a: best-effort registration (no redirect to piggyback on) | Registration | — |
| `specs/ARCHITECTURE.md` | Core flow §4 rewritten; OQ-13 resolved | Consistency | — |
| `specs/process_specs/card_signing.md` | Step 8 and type table updated | Consistency | — |
| `specs/process_specs/card_validation.md` | Step 26 refers to the DCQL match | Consistency | — |
| `specs/process_specs/oblivious_transport.md` | Disambiguation note no longer points at the removed CHAPI/OHTTP flow | Consistency | — |
| `plans/card-login-strategic-plan.md` | Open questions marked resolved, incl. CP1-a/b | — | — |

Not changed, by finding: `object_specs/wallet.md` (wallet service — no change needed), `object_specs/registry_contract.md` (no contract change), `object_specs/client_sdk.md` (superseded).

---

## Existing inconsistencies found (CP6 — report only, not fixed)

- `card_protocol_spec.md §1` says policy cards are "issued directly by authorizers — not through a press"; `policy_creation.md` (2026-07-16) says every policy card is issued through a press.
- **Message ID encoding:** `protocol-objects.md §5` uses base64url for payload hashes (`in_reply_to`, etc.), but `app-sdk`'s `messageId()` returns keccak256 as **hex**. Login's `in_reply_to` on `auth_confirmation` inherits whichever is fixed.
- `card_verifier.md §5` `PolicyMatchConditions` matches policies by CID, so a relying-party predicate breaks when the policy is updated. Login avoids it (decision 13); other users of `conditions` are still exposed.

(The `subcards.md` contradiction about runtime app-chain walks was in a file login already edits, so it was fixed.)

---

## Consistency pass (step 2.9)

Checked: no remaining references to CHAPI, `callbacks`, `confirmation_code`, `session_id`, `requesting_site`, `required_policy`, `card-wallet.json`, or `CardAuth` in `specs/` or `governance/` outside changelog notes and the superseded `client_sdk.md`; every `LOGIN_*` code used anywhere (34) is defined once in `card_login.md §Error Codes`; `auth_response`, `auth_confirmation`, `DomainBindingAttestation`, `WalletRegistrationToken`, and `LoginServiceMetadata` field names match across objects, messaging, process, verifier, press, and SDK specs; every new cross-reference resolves to an existing section.

Fixed during the pass:
- `wallet_sdk.md §6.1` read `app_card_branch` from an app-card verification result, where that field doesn't exist (it is set only for sub-card signatures). Now uses the same `chain_card_addresses` test as the press.
- Implementation plan steps 3.1 and 4.3 reworded for decision 1 (code-520 binding instead of co-signature at issuance).

---

**Approved 2026-11-08 by David at CP2** (including the 21 drafting decisions and the removal of CHAPI, `callbacks.https`, OHTTP callbacks, and `confirmation_code`). Phase 3 started.

---

## Amendment 2026-11-09 (after CP2, approved by David): three branches and "login service card"

- **Three branches under the app-certification root** instead of "login service branch + everything else": **wallet** (wallet cards — wallet applications, the only cards the login router lists), **app** (app cards — third-party apps that act for users through delegated sub-cards), and **login service** (login service cards). The earlier draft would have let an ordinary app card pass the router's wallet check. Verifiers still need only `loginServiceCertificationRoot`; the wallet branch address is a router build setting. Existing app cards issued directly under the root need reissuing under the right branch.
- **Rename:** "developer card" → **login service card**; "developer branch" → login service branch; `developerCertificationRoot` → `loginServiceCertificationRoot`; `DomainBindingAttestation.developer_card(_pubkey)` → `login_service_card(_pubkey)`; error codes `DEVELOPER_APP_CARD_SCOPE` → `LOGIN_SERVICE_SCOPE`, `DEVELOPER_CERTIFICATION_ROOT_NOT_CONFIGURED` → `LOGIN_SERVICE_CERTIFICATION_ROOT_NOT_CONFIGURED`, `LOGIN_DEVELOPER_*` → `LOGIN_SERVICE_*`, `LOGIN_WARN_DEVELOPER_*` → `LOGIN_WARN_SERVICE_*`; `app_card_branch` values → `"login_service" | "other"`; press config `PRESS_LOGIN_SERVICE_CERTIFICATION_ROOT`; the person running a site is the **site operator**. Governance doc renamed to `login_service_certification.md`.
- The `SubCardDocument.app_card` field keeps its name and may hold any of the three card kinds (`subcards.md §App Cards and the Trust Chain`).

Files touched: `subcards.md`, `card_login.md`, `login_router.md`, `protocol-objects.md`, `card_verifier.md`, `press.md`, `dns_resolution.md`, `card_protocol_spec.md`, `messaging_protocol.md`, `ARCHITECTURE.md`, `update_codes.md`, `card_updates.md`, `app_sdk.md`, `wallet_sdk.md`, both AppCertificationBody docs, and the code and implementation plans.

---

## Amendment 2026-11-09 (Phase 4, approved by David): card update fixes found while building login

- **Press log entries now match `protocol-objects.md §3`**: encrypted under the target card's content key, with `version`, `history`, and `card_state`. Previously they were pinned unencrypted with none of those, so any updated card (including every server card's login service card after code 510) failed verification. The verifier reads log-entry heads by overlaying `card_state` on the genesis document.
- **Update request format made explicit** (`card_updates.md` step 5, `press.md §5.3`): `{ update_intent, intent_signature: { public_key, signature }, target_card_pubkey? }`. The press accepts both the spec's intent field names and its historical `*_address` names. wallet-sdk previously sent a bare signature string the press could not verify; its directory updates and sub-card revocation now go through a shared `postCardUpdate` helper.


---

## Amendment 2026-11-10 (Phase 4 milestone review): specs aligned with what the build required

- `card_verifier.md §7.2` steps 2–4: sub-card documents are found through `SubCardEntry.sub_card_doc_cid` (the contract creates no `CardEntry` for sub-cards), may be plain or encrypted, and must have the signer as `recipient_pubkey`.
- `card_verifier.md §7.3`: a card that is itself a trusted root reaches a root; `LogEntry` heads are read as genesis + `card_state`.
- `card_verifier.md §4.1`: `getDomainRegistration` is optional on `RpcProvider`; login entry points require it.
- `card_verifier.md §6.3` step 9 and `protocol-objects.md §8.1`: a card's own policy is its on-chain `policy_address`; `meta.predicate` is not supported yet. Note on today's `keccak256(policy CID)` addressing (code plan F13).
- `protocol-objects.md §9`, `messaging_protocol.md §14`, `card_login.md` step 20: `auth_response` is signed by a device sub-card only (verifiers accept sub-card signatures only).
- `login_router.md §3`: same-tab `hashchange` requests are handled.
- `press.md §5.3`: optional `ARBITRUM_LOGS_RPC_URL`.
- `wallet_sdk.md §7a`: all SDK updates go through `postCardUpdate` to `POST /api/update`.
