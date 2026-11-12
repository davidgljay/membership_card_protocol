# Card Login — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-08  
**Status:** Draft — pending review at checkpoint CP2 (`plans/card-login-implementation-plan.md`)

> Feature spec: `card_protocol_spec.md §8`. Objects: `protocol-objects.md §8` (`AuthenticationRequest`), `§9` (`AuthenticationResponse`), `§17` (`DomainBindingAttestation`), `§18` (`LoginServiceMetadata`), `§19` (`WalletRegistrationToken`). Router: `object_specs/login_router.md`. Design record: `plans/card-login-strategic-plan.md`.

---

## Overview

Card login lets a person log in to a website with a membership card. The site asks for "a card issued under policy X (or one of its child policies)"; the person's wallet checks who is really asking, the person approves, and the wallet returns a signed statement the site verifies itself.

Three properties drive the design:

1. **Works in every browser.** The site never needs to know which wallet the person uses. It sends the browser to a static **login router** that remembers the person's wallet in its own first-party storage. Plain HTTPS links work everywhere, including iOS.
2. **The wallet knows who is asking.** Requests are signed by a **server card**, a sub-card of a **login service card** that is certified under the login service branch of the app-certification root and bound to a DNS domain. The wallet only shows a request if that domain covers the URL the answer will be sent to.
3. **The answer lands in the right browser.** A `state` value in a cookie on the starting browser, plus — for card-message responses — a one-time code, ensure a valid response cannot log in someone else's browser.

---

## Actors

| Actor | Role |
|---|---|
| **User** | Holds cards in a wallet; starts and approves logins. |
| **Browser** | Where the user is logging in. Holds the site's `state` cookie. |
| **Site** | The website. Its server holds a server card, creates and signs requests, verifies responses, and binds sessions. Uses the app-sdk login module (`object_specs/app_sdk.md §Login`). |
| **Login router** | Static website that forwards a login request to the user's registered wallet (`object_specs/login_router.md`). Has no server-side state and never sees request contents. |
| **Wallet** | The user's wallet app (web or native) and its wallet service. Validates requests, asks the user, signs, and delivers responses. Uses the wallet-sdk login module (`object_specs/wallet_sdk.md §Login`). |
| **Site operator** | Runs the site. Involved during setup only; holds the login service card. |
| **DNS admin** | Holder of the domain's full-domain DNS admin card (`dns_resolution.md §5.1`). Signs the domain binding during setup. |

## Terms

- **Branches** — the app-certification root has three branches, each a policy node governed by the AppCertificationBody: **wallet** (wallet cards — wallet applications), **app** (app cards — apps that act for users through delegated sub-cards), and **login service** (login service cards). The login service branch's address is `VerifierConfig.loginServiceCertificationRoot` (`governance/AppCertificationBody/login_service_certification.md`); the wallet branch's address is used by the login router's build (`login_router.md §5`). See `subcards.md §App Cards and the Trust Chain`.
- **Login service card** — a card issued under the login service branch, with a `domain_binding` (`protocol-objects.md §1.1, §17`).
- **Server card** — a sub-card whose `holder_primary_card` and `app_card` are both the login service card, with `attestation_level: "S1"` (`subcards.md §Server Cards`).
- **Presented card** — the user's card that satisfies the request's DCQL query; the identity the site sees.
- **Pending login** — the site's record of an issued request: `{ state, request, request_hash, created_at, status }`, `status` ∈ `issued | responded | complete | failed`.

---

## Preconditions

### Phase 0: Site setup (once per domain)

1. The site operator obtains a **login service card** from an AppCertificationBody login service certifier (`login_service_certification.md`). It should be a card used only for login (see Security Considerations — every response is delivered to all of its sub-cards).
2. The DNS admin signs a `DomainBindingAttestation` (`protocol-objects.md §17`) naming the login service card and the domain. The site operator submits a code-520 update intent on the login service card carrying it (`update_codes.md §5xx`, `card_updates.md`). The press validates the attestation and the currency rule before posting. A login service card without a binding cannot sign usable login requests.
3. The site's server generates a server card key through its `SecureKeyProvider` and builds an unsigned server card `SubCardDocument`. The site operator's wallet signs it as both app and holder, posts the code-510 `active_subcards` entry, and submits it to a press (`subcards.md §Server Cards`). Required `capabilities`: `auth_request`, `auth_confirmation`, `error`.
4. The login service card has an account at a wallet service (so messages to it can be routed), and each server instance registers UUIDs for its server card there and keeps a realtime connection to the relay (`object_specs/app_sdk.md §9.3–9.5`). Required only for `mcard_message`.
5. The site serves a signed `LoginServiceMetadata` document at `/.well-known/membership-login` (`protocol-objects.md §18`).

### Per login

- The user's wallet is registered with the login router (normally done when the user accepted their first card — `login_router.md §4`), or the user has the wallet app on a phone for QR.
- The user holds at least one card that matches the site's query (otherwise the wallet explains why it can't log in).

---

## Steps

### Phase 1: Start (site)

1. The user clicks "Log in with a membership card."
2. The site creates an `AuthenticationRequest` (`protocol-objects.md §8`):
   - fresh `state` (≥ 16 random bytes) and `nonce` (32 random bytes);
   - `dcql_query` naming the accepted policies;
   - `statement` — the site's text, or the default login statement `"Log in to <origin of response_uri>"`;
   - `response_mode`: `form_post` when the login continues on this device through the router; `mcard_message` when the site will show a QR code;
   - `response_uri` on the site's own origin; `expires_at` ≤ 10 minutes from now;
   - `wallet_nonce` only on a wallet-initiated login (Phase 7);
   - signs it with the server card → `request_signature`.
3. The site stores a pending login with `status: issued` and `request_hash` (`protocol-objects.md §8`).
4. The site sets a cookie on the browser holding `state`: `Secure; HttpOnly; SameSite=None; Path=<path of response_uri>`, expiring at `expires_at`. `SameSite=None` is required because the `form_post` POST arrives as a cross-site top-level navigation.
5. The site hosts the request at an unguessable `request_uri` (≥ 128 bits of randomness in the path). It serves the request with `Cache-Control: no-store` until the pending login leaves `issued`, or `expires_at` passes; after that it returns `410 Gone`.
6. The site sends the user onward:
   - **Same device:** navigate the browser to `https://<router>/login#request_uri=<percent-encoded request_uri>` (plus `&wallet_hint=<app card>` on a wallet-initiated login, and optionally `&fallback_uri=<site URL that starts a QR login>` so the router can offer "use my phone" — `login_router.md §3`).
   - **Cross-device:** show a QR code encoding `mcard://auth?r=<percent-encoded request_uri>`, and a waiting page with a one-time code entry box (Phase 6).

### Phase 2: Reaching the wallet

7. **Router.** The router reads the fragment and opens the registered wallet's `handler_url#request_uri=…` — the default wallet, the one named by `wallet_hint` if registered, or a picker if the user has several. With none registered, it shows the recovery screen. See `login_router.md §3`.
8. **QR / deep link.** The wallet app scans or opens `mcard://auth?r=…` (`dns_resolution.md §2`, reserved action host `auth`) and reads `request_uri`.
9. The wallet remembers **how it was reached** — router handoff on this device, deep link from this device, or QR scan — for use in step 25.

### Phase 3: Request validation (wallet)

Every check here happens before anything is shown to the user. A failure is a **rejection**: the wallet shows only "This login request isn't valid" with the error code, and sends nothing to the site. Error codes: §Error Codes.

10. **Fetch.** `GET request_uri` over HTTPS with no cookies or credentials. Non-`https` URL, non-200 response, or non-JSON body → `LOGIN_REQUEST_UNAVAILABLE`.
11. **Shape.** `version` is `"2"`; every required field is present and well-formed; `response_mode` is a known value; `response_uri` is an absolute `https:` URL with default port, no fragment, no userinfo; `dcql_query.credentials` has exactly one entry with `format: "mcard"` and at least one policy → else `LOGIN_REQUEST_MALFORMED`. `expires_at` has passed, or is more than 10 minutes (+ 60 s clock skew) in the future → `LOGIN_REQUEST_EXPIRED`.
12. **Signature.** `keccak256(requester_pubkey) == requester_card` → else `LOGIN_REQUESTER_BINDING_MISMATCH`. `request_signature` verifies → else `LOGIN_REQUEST_SIGNATURE_INVALID`.
13. **Server card.** Run `verifyServerCard(requester_pubkey)` (`card_verifier.md §6.4`). It confirms: the server card is a registered, active, unexpired sub-card listed in the login service card's `active_subcards`; `app_card == holder_primary_card`; `attestation_level == "S1"`; `capabilities` includes `auth_request`; the login service card chains to `loginServiceCertificationRoot`. Not a server card → `LOGIN_REQUESTER_NOT_SERVER_CARD`. Login service card not under the login service branch → `LOGIN_SERVICE_NOT_CERTIFIED`.
14. **Status (block).** Any 8xx/9xx with `effective_date` ≤ now on the server card, the login service card, or any card on the login service card's chain → `LOGIN_SERVICE_REVOKED`. Login service card has `successor` set by code 101 (possible key compromise) → `LOGIN_SERVICE_KEY_COMPROMISED`.
15. **Domain binding.** The login service card has a `domain_binding` → else `LOGIN_DOMAIN_BINDING_MISSING`. Its signature and binding checks pass → else `LOGIN_DOMAIN_BINDING_INVALID`. Currency rule (`protocol-objects.md §17`): admin card is no longer the domain's admin, or is revoked → `LOGIN_DOMAIN_BINDING_STALE`; domain suspended → `DOMAIN_SUSPENDED`. Coverage rule: the binding covers the origin of `response_uri` → else `LOGIN_ORIGIN_NOT_BOUND`.
16. **Warnings (do not block).** Collect:
    - `LOGIN_WARN_SERVICE_NEGATIVE` — the login service card has a current 6xx or 7xx entry (show the code's meaning from `update_codes.md`);
    - `LOGIN_WARN_DOMAIN_MONITORED` — the bound domain has `fraud_risk == 1`;
    - `LOGIN_WARN_SERVICE_ROTATED` — the login service card has `successor` set by code 100.

### Phase 4: Card selection and approval (wallet)

17. **Match.** Evaluate `dcql_query` against every card the wallet holds (`protocol-objects.md §8.1`). If none match, show which policies the site accepts and that the user holds none of them; the user can only close (treated as a decline, step 22).
18. **Wallet-initiated shortcut.** If the request has `wallet_nonce` and the wallet holds a pending wallet-initiated login (Phase 7) with the same `wallet_nonce`, the same origin as `response_uri`, unexpired and unused, **and** step 16 collected no warnings, **and** exactly one held card matches (or the user started from a specific card that matches): mark the pending login used and go to step 20 with that card, without a prompt. Otherwise continue to step 19. A `wallet_nonce` that matches nothing is not an error.
19. **Prompt.** The wallet shows:
    - the **origin of `response_uri`** as the primary identity ("example.com wants you to log in"), with the login service card's name and a chain summary;
    - any warnings from step 16, styled as warnings;
    - `purpose`, `statement`, and `context`;
    - the matching card(s), with a chooser if more than one.
    The user approves with a chosen card, or declines.

### Phase 5: Response (wallet)

20. **Build.** The wallet builds the `auth_response` envelope (`protocol-objects.md §9`): `content` = `{ audience, nonce, request_hash, state, statement }`, `senders = [presented card]`, `recipients = [login service card]`, `timestamp = now`. It signs with one of the presented card's device sub-cards (`capabilities` must include `auth_response`). The card's own key is not used: verifiers accept sub-card signatures only (`card_verifier.md §7.2`).
21. **Deliver.**
    - **`form_post`:** a web wallet submits a form in the browser (top-level navigation, `POST`, `application/x-www-form-urlencoded`) to `response_uri` with fields `state` and `auth_response` (`protocol-objects.md §9`). A native wallet on the same device opens its own HTTPS form-relay page in the system browser with the two fields in the URL fragment; that page submits the same form. (If the system browser is not the one that started the login, the cookie is missing and the site rejects at step 24 — the user retries from the browser they're using.)
    - **`mcard_message`:** the wallet sends the envelope as a routed card message to the login service card (`messaging_protocol.md §14`, `message_routing.md`), which delivers a copy to each of its active sub-cards — the site's server cards. The wallet then waits up to 60 seconds for an `auth_confirmation` (step 25); on timeout it tells the user the site didn't respond.
22. **Decline.** `form_post`: post `state` and `error=access_denied` to `response_uri`. `mcard_message`: send an `error` message (`messaging_protocol.md §22`) to the login service card with `code: "access_denied"` and `state`. The site marks the pending login `failed`.

### Phase 6: Verification and session binding (site)

23. **Look up.** Find the pending login by `state` (form field, or `content.state` for messages). Unknown, not `issued`, or past `expires_at` → reject with `LOGIN_STATE_UNKNOWN`.
24. **Verify.** Call `verifyLoginResponse` (`card_verifier.md §6.3`) with the stored request and the site's own origin. Any failure → reject with the returned code; the pending login stays `issued` until it expires (a bad response does not burn a good login).
    - **`form_post`:** additionally require the browser's `state` cookie to equal the posted `state` → else `LOGIN_SESSION_MISMATCH`. On success: set `status: complete`, establish the site session bound to the presented card's pointer (`senders[0]`), clear the `state` cookie, and redirect (`303`) to the post-login page. Done.
    - **`mcard_message`:** on success: set `status: responded`; record the delivery latency (§Latency); create a **one-time code** (8 characters from the Crockford base32 alphabet, ≥ 40 bits, single-use, bound to this `state`, expiring 5 minutes after issue); send `auth_confirmation` (`messaging_protocol.md §23`) to the presented card, signed by the server card, `in_reply_to` the `auth_response` message ID.
25. **Wallet hands over the code.** The wallet verifies the `auth_confirmation` (signed by the request's server card; `in_reply_to` matches its response; `request_hash` matches). Then, by how it was reached (step 9):
    - **Router handoff or deep link on this device:** open `response_uri?code=<code>` in the browser. No typing.
    - **QR scan:** show the code with the text "Enter this code at **<origin>** — only in a browser you are using yourself." The user types it into the waiting page.
26. **Redeem.** The browser sends the code to `response_uri` (`GET ?code=` from step 25, or `POST` from the waiting page's form). The site requires: a `state` cookie whose pending login is `responded`; the code matches that pending login, is unused, and unexpired → set `status: complete`, establish the session, clear the cookie, redirect. Otherwise → `LOGIN_CODE_INVALID`. After 5 failed attempts for one `state`, the pending login becomes `failed`.
27. The waiting page may poll the site (by its `state` cookie) to show "Approved in your wallet — enter the code." Polling MUST NOT complete a login on its own.

### Phase 7: Wallet-initiated login

28. The user taps a service in the wallet. The list is the card's effective `preferred_services`, filtered by each service's metadata (§Service Discovery).
29. The wallet creates a pending wallet-initiated login: `{ origin, wallet_nonce (16 random bytes), created_at, expires_at: +2 minutes, used: false }`.
30. The wallet opens `start_url?wallet_nonce=<…>&wallet_hint=<wallet's app card>` (from the service's metadata) in the browser on the same device.
31. The site runs Phase 1 with `wallet_nonce` copied into the request and `wallet_hint` passed to the router. From there the flow is the normal one; step 18 skips the prompt only if everything matches.

---

## Service Discovery

A card's **effective services list**:

1. Start at the card's policy (the live head of the policy card, not the `policy_id` snapshot — services are discovery data, not compliance data).
2. If that policy has `preferred_services` (even `[]`), that is the list. Stop.
3. Otherwise move to the parent policy along the issuance chain (`protocol-objects.md §2, §8.1`) and repeat. If no policy on the chain has the field, the list is empty.

For each entry, the wallet fetches `https://<origin>/.well-known/membership-login` (`protocol-objects.md §18`), validates it, and shows the service only if `metadata.accepts` matches the card (`§8.1` step 1). The wallet displays the policy entry's `name` and `icon`, not the site's own.

## Router Registration

When the user accepts their first card, the wallet registers itself with the login router as part of the redirect that already ends offer acceptance (`open_offer_acceptance_new_wallet.md` step 22a, `open_offer_acceptance_existing_wallet.md` step 17a, `card_offering_and_acceptance.md` step 15a, best effort). Registration needs no consent screen and never replaces an existing default wallet. See `login_router.md §4`.

## Latency

For every `mcard_message` login that passes step 24, the site records `{ sent_at: payload.timestamp, received_at: server receive time, latency_ms }`. `sent_at` is wallet-clock time, so the metric includes clock skew; sites report it as-is and the protocol treats it as an operational signal, not a check. The app-sdk exposes it through a callback (`app_sdk.md §Login`).

## Timing Summary

| Item | Limit |
|---|---|
| Request lifetime (`expires_at`) | ≤ 10 minutes |
| Clock skew allowance | 60 seconds |
| Response freshness (`payload.timestamp`) | within the request's lifetime and ≤ 5 minutes old at receipt |
| Wallet wait for `auth_confirmation` | 60 seconds |
| One-time code | 5 minutes, single use, 5 attempts per `state` |
| Pending wallet-initiated login | 2 minutes, single use |
| `LoginServiceMetadata` cache | ≤ 24 hours |

---

## Postconditions

- The site holds a verified `auth_response` for the presented card and a session bound to it in the browser that started the login.
- The pending login is `complete`; its `request_uri` returns `410`; its one-time code (if any) is spent.
- No party other than the site and the wallet saw the request or response contents. The router saw neither.

---

## Error Codes

Canonical list for card login. Other specs reference these names; they are not redefined elsewhere.

| Code | Raised by | Step | Outcome |
|---|---|---|---|
| `LOGIN_REQUEST_UNAVAILABLE` | Wallet | 10 | Reject |
| `LOGIN_REQUEST_MALFORMED` | Wallet | 11 | Reject |
| `LOGIN_REQUEST_EXPIRED` | Wallet | 11 | Reject |
| `LOGIN_REQUESTER_BINDING_MISMATCH` | Wallet | 12 | Reject |
| `LOGIN_REQUEST_SIGNATURE_INVALID` | Wallet | 12 | Reject |
| `LOGIN_REQUESTER_NOT_SERVER_CARD` | Wallet | 13 | Reject |
| `LOGIN_SERVICE_NOT_CERTIFIED` | Wallet | 13 | Reject |
| `LOGIN_SERVICE_REVOKED` | Wallet | 14 | Block |
| `LOGIN_SERVICE_KEY_COMPROMISED` | Wallet | 14 | Block |
| `LOGIN_DOMAIN_BINDING_MISSING` | Wallet | 15 | Reject |
| `LOGIN_DOMAIN_BINDING_INVALID` | Wallet | 15 | Reject |
| `LOGIN_DOMAIN_BINDING_STALE` | Wallet | 15 | Block |
| `DOMAIN_SUSPENDED` | Wallet | 15 | Block (same name as the `dns_resolution.md §3` result) |
| `LOGIN_ORIGIN_NOT_BOUND` | Wallet | 15 | Reject |
| `LOGIN_WARN_SERVICE_NEGATIVE` | Wallet | 16 | Warn |
| `LOGIN_WARN_DOMAIN_MONITORED` | Wallet | 16 | Warn |
| `LOGIN_WARN_SERVICE_ROTATED` | Wallet | 16 | Warn |
| `LOGIN_NO_MATCHING_CARD` | Wallet | 17 | Explain; user may only decline |
| `LOGIN_CONFIRMATION_INVALID` | Wallet | 25 | Show error; do not hand over the code |
| `LOGIN_STATE_UNKNOWN` | Site | 23 | Reject |
| `LOGIN_WRONG_TYPE` | Site (verifier) | 24 | Reject |
| `LOGIN_STATE_MISMATCH` | Site (verifier) | 24 | Reject |
| `LOGIN_NONCE_MISMATCH` | Site (verifier) | 24 | Reject |
| `LOGIN_STATEMENT_MISMATCH` | Site (verifier) | 24 | Reject |
| `LOGIN_REQUEST_HASH_MISMATCH` | Site (verifier) | 24 | Reject |
| `LOGIN_AUDIENCE_MISMATCH` | Site (verifier) | 24 | Reject |
| `LOGIN_RECIPIENT_MISMATCH` | Site (verifier) | 24 | Reject |
| `LOGIN_SENDER_MISMATCH` | Site (verifier) | 24 | Reject (`senders` not exactly the signing card) |
| `LOGIN_PRESENTED_CARD_INVALID` | Site (verifier) | 24 | Reject (signature, sub-card link, chain, or revocation failed; underlying verifier code in `reason`) |
| `LOGIN_RESPONSE_STALE` | Site (verifier) | 24 | Reject |
| `LOGIN_CARD_NOT_ACCEPTED` | Site (verifier) | 24 | Reject (DCQL match failed) |
| `LOGIN_SESSION_MISMATCH` | Site | 24 | Reject (`form_post` cookie ≠ `state`) |
| `LOGIN_CODE_INVALID` | Site | 26 | Reject; 5 failures fail the login |
| `access_denied` | Wallet → site | 22 | User declined (OpenID4VP name) |

Signature, chain, and revocation failures on the presented card are reported as `LOGIN_PRESENTED_CARD_INVALID`, with the verifier's own code (`card_verifier.md §9`) in `reason`.

## Error Paths

| Condition | Resolution |
|---|---|
| Wallet rejects or blocks the request | Nothing is sent. The site's pending login expires. The user sees the code; the site's page offers "try again." |
| No matching card | Wallet explains which policies the site accepts; user declines. |
| User declines | Site marks the login `failed` and shows its own message. |
| No wallet registered with the router | Router recovery screen (`login_router.md §6`). |
| `form_post` lands in a different browser | `LOGIN_SESSION_MISMATCH`; user retries in the original browser. |
| `mcard_message` not delivered in 60 s | Wallet reports the site didn't respond; the site's pending login expires. |
| Wrong one-time code | `LOGIN_CODE_INVALID`; after 5 attempts the user starts over. |
| Request expired before the user approved | `LOGIN_REQUEST_EXPIRED` (wallet) or `LOGIN_STATE_UNKNOWN` (site); user starts over. |

---

## Security Considerations

- **Phishing with a valid card ("right card, wrong site").** A legitimate login service card cannot be used to send responses to a domain it isn't bound to: the wallet checks `domain_binding` coverage of the `response_uri` origin (step 15), and the site checks `audience` (step 24).
- **Login service card used as a wallet.** A login-service-branch card can be `app_card` only for its own sub-cards (`subcards.md §Server Cards`). It cannot co-sign sub-cards for other people's cards; presses and verifiers reject it (`LOGIN_SERVICE_SCOPE`).
- **QR relay phishing.** An attacker can start a real login and get a victim to scan the QR code; the wallet correctly shows the real site. The one-time code (steps 24–26) defeats this: the attacker's browser has the `state` cookie but never the code. The wallet's wording discourages relaying the code. Proximity-based binding is a P2 item (`card_protocol_spec.md §8`).
- **Response delivered to the wrong browser.** `form_post` requires the `state` cookie; `mcard_message` requires the cookie and the code.
- **Replay.** `state` and the one-time code are single-use; `request_hash`, `nonce`, and freshness limits bind a response to one request.
- **Login CSRF.** Logging a victim in as the attacker requires the victim's `state` cookie value, which appears only in the victim's browser and the `request_uri` document; `request_uri` is unguessable and is not sent to the router host (fragment only).
- **Router compromise.** A compromised router can misroute or drop requests; it cannot read, forge, or alter a request (signed by the server card) or a response (verified by the site).
- **Fan-out to login service card sub-cards.** `mcard_message` responses are encrypted to every active sub-card of the login service card. A site operator who also uses that card on a personal device receives copies of users' login responses. Site operators should use a card dedicated to login.
- **Identifier correlation.** The site learns the presented card's pointer, which is the same at every site. Per-service identifiers are a P2 item.

---

## Acceptance Criteria

**Wallet validation (G2)**
- [ ] A request with a missing required field, unknown `version`, or more than one DCQL credential is rejected with `LOGIN_REQUEST_MALFORMED` before display.
- [ ] A request whose `keccak256(requester_pubkey)` ≠ `requester_card` is rejected with `LOGIN_REQUESTER_BINDING_MISMATCH`.
- [ ] A request with an invalid `request_signature` is rejected with `LOGIN_REQUEST_SIGNATURE_INVALID`.
- [ ] A request signed by an ordinary (non-server) sub-card, or by a sub-card whose `app_card` ≠ `holder_primary_card`, is rejected with `LOGIN_REQUESTER_NOT_SERVER_CARD`.
- [ ] A request whose login service card chains to the wallet or app branch instead of the login service branch is rejected with `LOGIN_SERVICE_NOT_CERTIFIED`.
- [ ] A login service card (or its server card or any chain ancestor) with an effective 8xx/9xx blocks the login (`LOGIN_SERVICE_REVOKED`).
- [ ] A login service card with a current 6xx or 7xx entry produces a visible warning and the user can still proceed.
- [ ] **Wrong-origin phishing:** a correctly signed request from a valid login service card bound to `example.com` with `response_uri` on `example.net` is rejected with `LOGIN_ORIGIN_NOT_BOUND`.
- [ ] A binding to `example.com` accepts `https://login.example.com/cb` and rejects `http://example.com/cb` and `https://example.com:8443/cb`.
- [ ] A domain with an unexpired suspension blocks with `DOMAIN_SUSPENDED`; after the domain's admin card changes, the old binding blocks with `LOGIN_DOMAIN_BINDING_STALE`.
- [ ] An expired request is rejected with `LOGIN_REQUEST_EXPIRED`.

**Verification and session binding (G3)**
- [ ] A valid `form_post` response with a matching `state` cookie establishes a session bound to `senders[0]`.
- [ ] The same response posted from a browser without the cookie is rejected with `LOGIN_SESSION_MISMATCH`.
- [ ] Each of `state`, `nonce`, `statement`, `request_hash`, `audience`, and `recipients` tampered in turn is rejected with its specific code.
- [ ] A response older than 5 minutes is rejected with `LOGIN_RESPONSE_STALE`.
- [ ] A response from a card that doesn't match the DCQL query — including a child-policy card when `include_children` is `false` — is rejected with `LOGIN_CARD_NOT_ACCEPTED`; the same child-policy card is accepted when `include_children` is `true`.
- [ ] A `mcard_message` login completes only when the browser presents both the cookie and the correct code; the code alone in another browser, or the cookie alone, does not log in.
- [ ] A one-time code works once; a second use and a sixth wrong attempt are rejected.
- [ ] The `request_uri` returns `410` after the login completes.
- [ ] Every completed `mcard_message` login records `sent_at`, `received_at`, and `latency_ms`.
- [ ] Polling the waiting page never completes a login without the code.

**Discovery and wallet-initiated login (G4)**
- [ ] A child policy with no `preferred_services` shows its parent's list; a child with `[]` shows none; a child with its own list shows only its own.
- [ ] A listed service whose metadata does not accept the card is not shown.
- [ ] A wallet-initiated login whose request echoes the pending `wallet_nonce` completes with no prompt.
- [ ] The same flow shows the prompt when the `wallet_nonce` doesn't match, has expired, was already used, or a warning was collected.

**Router registration**
- [ ] Accepting a first card registers the wallet with the router with no consent screen, and accepting a card in a second wallet does not replace the first as default. (Detailed criteria: `login_router.md`.)

---

## Related Specs

- `card_protocol_spec.md §8` — feature spec
- `protocol-objects.md §8, §9, §17, §18, §19` — objects; `§1.1` `domain_binding`; `§2` `preferred_services`; `§16` server cards
- `object_specs/login_router.md` — the login router
- `object_specs/card_verifier.md §6.3, §6.4` — `verifyLoginResponse`, `verifyServerCard`
- `object_specs/app_sdk.md §Login`, `object_specs/wallet_sdk.md §Login` — SDK functions
- `messaging_protocol.md §13, §14, §22, §23` — `auth_request`, `auth_response`, `error`, `auth_confirmation`
- `subcards.md §Server Cards` — server card creation and scope rule
- `dns_resolution.md §2, §5.3` — `mcard://auth`; login service domain bindings
- `governance/AppCertificationBody/login_service_certification.md` — login service branch
- `process_specs/message_routing.md` — `mcard_message` delivery
