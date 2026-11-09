# Card Login — Strategic Plan

Companion: [card-login-implementation-plan.md](card-login-implementation-plan.md) (not yet written — follows answers to the open questions below)

Source: design discussion with David, 2026-11-07 → 2026-11-08 (decisions recorded in §Design Decisions below).

## Starting point

`card_protocol_spec.md §8` ("Authenticating with a Card") already specifies a login-shaped flow: a signed `AuthenticationRequest` (`protocol-objects.md §8`) hosted at a single-use URL, wallet discovery via CHAPI, a back-channel HTTPS POST to `callbacks.https`, and a `confirmation_code` redirect that binds the browser session. `messaging_protocol.md §13–14` defines matching `auth_request` / `auth_response` message types. **None of it is implemented** — no code in `app-sdk`, `wallet-sdk`, `membership_card_verifier`, or `wallet-service` handles auth requests, and the `CardAuth` package named in the spec's metrics does not exist.

The existing protocol also already provides most of the building blocks this design needs:

| Design concept | Existing protocol mechanism |
|---|---|
| Developer card | Close analogue: **app cards** (`subcards.md`, `governance/AppCertificationBody/`) — but those certify *wallet* applications, under the app-certification root |
| Domain-bound card | **DNS admin cards** and `PolicyAddresses` (`dns_resolution.md §4–5`) |
| Server card / subcard | **Sub-cards** (`subcards.md`, `protocol-objects.md §15–16`), with `capabilities` and `limitations` |
| Warning vs block | **Update codes** (`update_codes.md`): 6xx/7xx negative → warn; 8xx/9xx revocation → block; matches the sub-card annotation outcome table |
| Card messaging response | Card-to-card messaging (`messaging_protocol.md`), routed via wallet service + relay |
| Custom URI scheme | `mcard://` (already used for `mcard://invite`, `mcard://auth` P1 deep link) |

So this initiative is mostly **revising §8 and wiring existing primitives together**, plus three genuinely new pieces: the static login router, a developer-policy trust root, and a `preferred_services` field on policy cards.

## Design Decisions (carried in from discussion)

- **Transport:** a static HTTPS **login router** is the primary path (works in all browsers incl. iOS). It stores registered wallets in its own first-party storage; the request travels in the URL fragment. `web+` handlers are not a primary path (Safari won't support `registerProtocolHandler`; handlers aren't detectable). Digital Credentials API is a later Android-only enhancement.
- **Wallet registration:** silent on a user's first card acceptance; **may add, never replace** an existing wallet or default. Recovery when storage is lost = pick from known-wallet list (picking re-registers), QR to another device, `.well-known` address lookup, universal links for native wallets.
- **Query format:** OpenID4VP 1.0 **DCQL**, with a new credential format **`mcard`**; `meta` carries a list of policy IDs, each with an `include_children` boolean. URL-bound policy patterns (`nytimes.com/staff/*`) are a 2.0 feature.
- **Requester identity:** requests are signed by a **server card** (sub-card) derived from a **developer card**, which is **minted from a developer policy** (governed separately) and **bound to the domain** of the site. The developer card's domain binding must cover the `response_uri` origin. Other trust sources (endorsements, registries) come later.
- **Developer card status:** revoked (8xx/9xx) → **block**; warning codes → **warn**.
- **Response modes:** `form_post` (same-device default) and **`mcard_message`** — the wallet sends the signed response as a card message to the server card (cross-device; replaces `direct_post`). One-time-code handoff binds the browser. Measure message delivery latency from day one; may consolidate to messaging-only later.
- **Static sites:** out of scope. Every login site has a server holding a server card.
- **Wallet-initiated login:** the wallet opens the site's start URL; the site creates the request and routes via the router with `wallet_hint`; the wallet signs without a prompt only if the request matches a short-lived, single-use pending login it started.
- **Service discovery:** `preferred_services` is a field on the **card policy**, updated through normal policy updates. Inherited from ancestor policies; **a policy that sets its own list replaces** the inherited one. The wallet shows a service only if the service's `/.well-known/membership-login` confirms it accepts the card.

## Goals

- [ ] **G1. Any site with a server can offer "Log in with a membership card," and it works in every major browser.**
- [ ] **G2. Users can see — and the wallet enforces — who is asking before a card signs anything.**
- [ ] **G3. A completed login is cryptographically verifiable by the site and bound to the right browser session, on the same device or across devices.**
- [ ] **G4. Cards lead people to the services that accept them, and logging in from the wallet takes one tap.**
- [ ] **G5. The specs remain the source of truth: login is fully specified before it is built, and tested against the specs once it is.**

## Rationale

**G1.** The existing §8 depends on CHAPI, a polyfill with a small ecosystem and a central mediator. The router design gets the same "site doesn't need to know the user's wallet" property using only plain HTTPS links, which is the one thing every browser — including all of iOS — reliably supports. If login doesn't work on iPhones, it isn't a login system.

**G2.** A login prompt is the most phishable surface a wallet has. The existing §8 already requires a signed request and a chain walk, but any valid card can sign — nothing ties the signer to the site the response will be sent to. Binding a developer card to the domain, and requiring the `response_uri` origin to match, closes the gap where a legitimate cardholder signs a request pointing at their own phishing page. A separate developer policy lets the protocol govern who may stand up login-enabled services independently of who may issue community cards.

**G3.** The value of card login to a site is a signed statement it can verify itself, without trusting the wallet or the router. Session binding (`state` cookie / one-time code) is what stops a valid statement from logging in the wrong browser. `form_post` is the simplest correct same-device path; card messaging reuses infrastructure the protocol already has for the cross-device case, and its latency is the deciding unknown for whether it can become the only path.

**G4.** Communities already decide what their cards are for. Putting the list of services on the policy — with inheritance so a parent organization's list flows down until a chapter overrides it — makes cards useful from the moment they're issued, and makes the wallet a launcher rather than only a key store. The two-sided check (policy lists service, service confirms it accepts the card) keeps a stale or careless list from becoming a phishing vector.

**G5.** This repo's working method is spec-first with consistency reviews (`plans/spec-consistency/`) and spec-derived integration tests (`integration-testing-strategic-plan.md`). §8 is currently an aspirational spec with no code; revising it against today's decisions before writing code avoids building to a spec that is already out of date. Several decisions touch shared objects (`PolicyCardDocument`, `SubCardDocument`, verifier Stage 2), so ripple effects need to be found deliberately.

## Key Objectives

- [ ] **G1 (any site, any browser)**
  - [ ] A static login router exists in this repo, serves `/login` and `/register`, and stores wallets only in its own first-party storage; it has no server-side state.
  - [ ] A test site completes a full same-device login through the router in headless Chromium, Firefox, and WebKit.
  - [ ] A site-side SDK lets a developer add the button, issue a signed request, and verify the response in under ~50 lines of integration code (measured in the reference example).
  - [ ] With no registered wallet, the router shows the recovery UI (known-wallet list, QR, address lookup) — never a dead end.
- [ ] **G2 (who is asking)**
  - [ ] The wallet rejects, before display, any request not signed by a server card → developer card → developer-policy root chain, and any request whose developer card's domain binding does not cover the `response_uri` origin.
  - [ ] A developer card with an 8xx/9xx code blocks the login; one with a warning code produces a visible warning; a suspended domain (`DOMAIN_SUSPENDED`) blocks.
  - [ ] Each of the above has a dedicated test, including a "valid card, wrong origin" phishing test.
- [ ] **G3 (verifiable, session-bound)**
  - [ ] The verifier (TS) verifies a login response end-to-end: signature, sub-card → master link, chain walk, revocation, DCQL `mcard` policy match including `include_children`, nonce, `state`/`session_id`, audience origin, and request hash.
  - [ ] `form_post` and `mcard_message` both complete in the integration stack; a response delivered to the wrong browser session is rejected.
  - [ ] Every `mcard_message` login records wallet-send → server-receive latency.
- [ ] **G4 (services and one-tap login)**
  - [ ] `preferred_services` is defined on `PolicyCardDocument`, with inheritance-with-replace semantics specified and press-validated.
  - [ ] The wallet SDK resolves a card's effective services list from its policy chain and filters it by each service's `/.well-known/membership-login`.
  - [ ] Wallet-initiated login completes with no prompt when it matches a pending login, and falls back to the normal prompt when it doesn't (both tested).
  - [ ] First-card acceptance registers the wallet with the router with no consent screen, and never replaces an existing default (tested).
- [ ] **G5 (spec-first)**
  - [ ] `card_protocol_spec.md §8`, `protocol-objects.md §8–9`, and `messaging_protocol.md §13–14` are revised to the decisions above, and every other spec they touch is updated in the same pass.
  - [ ] A change summary is reviewed and approved by David before any code is written.
  - [ ] A `card_login` spec suite exists in `dev-tests/` and `integration_tests/`, with every test naming the spec section it verifies.

## Open Questions

These came out of reading the existing specs and code, and each changes what gets written. Recommended defaults are marked; "go with defaults" resolves all of them.

1. **Developer policy vs. app certification.** App cards today certify *wallet* applications (`AppCertificationBody`). The developer policy should be a **new, separate policy root** (per "governed separately"). Who governs it — a new body (e.g. a Service Certification Body) or the AppCertificationBody under a second mandate? *Recommended: a new policy root, governed by the AppCertificationBody initially, with its own governance doc so it can be split off later.*

2. **How a developer card is bound to a domain.** You noted cards can already be tied to domain ownership; in the specs that happens through DNS admin cards and `PolicyAddresses` (`dns_resolution.md`). A developer card can't be both "minted from the developer policy" and "issued under the domain's policy" — a card has one policy. Which mechanism is intended?
   - (a) The developer policy requires a co-signature from the domain's DNS admin card at issuance, and the developer card records the domain. *(Recommended — keeps the developer policy as the governance root and reuses existing domain proof.)*
   - (b) The developer card is a sub-card of the domain's DNS admin card.
   - (c) Something else you had in mind.

3. **Server card as a sub-card.** `SubCardDocument` requires an `app_card` whose chain reaches the app-certification root, and the verifier's Stage 2d hard-rejects otherwise. A server card derived from a developer card won't pass that today. *Recommended: allow a developer card to act as its own `app_card` for its server sub-cards (like the wallet self-signing exception), with Stage 2d accepting the developer-policy root for that case.*

4. **How deeply to adopt OpenID4VP.** The protocol signs RFC 8785 JSON with ML-DSA-44; OpenID4VP request objects are JWTs. *Recommended: OpenID4VP-shaped, protocol-native — use DCQL (`mcard` format), OpenID4VP parameter names (`response_mode`, `response_uri`, `nonce`, `state`, `transaction_data` semantics), but keep RFC 8785 + ML-DSA-44 encoding. Full JWT conformance is deferred until the Digital Credentials API path is pursued.* This is a narrower reading of my earlier "use OpenID4VP" recommendation, because full conformance would mean a second signature format.

5. **What happens to `required_predicate`.** The existing request carries a full predicate expression; the decision was a list of policy IDs with `include_children`. *Recommended: the `mcard` DCQL `meta` carries `policies` (required) and an optional `predicate` for advanced cases, evaluated by the existing predicate engine.*

6. **Replacing parts of §8 rather than adding alternatives.** The plan removes CHAPI and the required `callbacks.https` back-channel, replacing them with the router, `form_post`, and `mcard_message`. Nothing implements them, so the cost is spec-only. *Recommended: remove, with a changelog entry; keep `mcard://auth?r=` as the native-wallet / QR deep link.*

7. **Identifier the site sees.** The existing `auth_response` puts the holder's master card pointer in `senders` as the account identifier, so the same card is the same identifier at every service. That's consistent with "cards are unlinkable to each other," but services can correlate a given card across sites. *Recommended: accept for v1 and record per-service identifiers as a P2 item.*

8. **Router hosting and silent-registration trust.** The router is new. *Recommended: a new `login-router/` package in this repo, deployed as a static site (alongside the existing Cloudflare deploys) on a protocol-neutral domain; silent registration allowed only for wallets presenting a registration token signed by a certified app card — which reuses AppCertificationBody as the "vetted wallets" list.*

9. **Where the code goes.** *Recommended: site-side login in `app-sdk` (new `login/` module, server + a tiny browser button helper); wallet-side login in `wallet-sdk` (new `login/` module); verification in `membership_card_verifier` (TS first; Python parity as the last phase).* There is no wallet front-end in this repo, so wallet UX is exercised through a test harness rather than shipped UI — is that right, or is there a wallet app elsewhere that should be in scope?
