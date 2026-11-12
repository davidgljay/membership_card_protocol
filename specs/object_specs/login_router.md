# Login Router — Object Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-08  
**Status:** Draft — pending review at checkpoint CP2  
**Package:** `login-router/` (static site; to be built — `plans/card-login-implementation-plan.md` step 4.7)

> Process: `process_specs/card_login.md` (Phases 2 and 7, §Router Registration). Objects: `protocol-objects.md §19` (`WalletRegistrationToken`).

---

## 1. Overview

The login router is a small static website that gets a login request from a site to the user's wallet without the site knowing which wallet that is. A site sends the browser to `https://<router>/login#request_uri=…`; the router looks up the wallet the user registered earlier — stored in the router's own first-party browser storage — and forwards the browser to that wallet's handler page with the same `request_uri`.

Wallets register themselves when the user accepts their first card, by passing through `https://<router>/register#token=…&next=…` on the way to the page the user was already going to. There's no consent screen; registration can add a wallet but never replaces the user's default.

The router replaces CHAPI (removed from `card_protocol_spec.md §8`). It uses only HTTPS navigations and `localStorage`, so it works in every major browser, including all of iOS.

---

## 2. Deployment and Privacy Properties

- **Static only.** HTML, JS, and CSS served from a protocol-neutral domain (choice of domain and deployment is checkpoint CP5). No server-side code, no server-side logs beyond the host's defaults, no cookies.
- **Parameters travel in the URL fragment only** (`#…`), which browsers never send to the router host. The router reads the fragment, then removes it from history with `history.replaceState`.
- **The router never fetches `request_uri`** and never sees request or response contents.
- Headers: `Referrer-Policy: no-referrer`; a Content Security Policy that allows scripts and styles only from the router's own origin and `connect-src https:` (needed only for the address lookup in §6); `X-Frame-Options: DENY` / `frame-ancestors 'none'`.
- No analytics, no third-party scripts, no fonts or images from other origins. Wallet icons are inline data URIs (`protocol-objects.md §19`).
- The router cannot tell sites which wallet a user has. A site learns nothing from the router except that the browser came back with a response (or didn't).

---

## 3. `/login`

**Fragment parameters**

| Name | Required | Value |
|---|---|---|
| `request_uri` | Yes | Percent-encoded `https:` URL of an `AuthenticationRequest`. The router checks only that it is an `https:` URL. |
| `wallet_hint` | No | App card pointer of the wallet that should handle this request (wallet-initiated logins, `card_login.md` Phase 7). |
| `fallback_uri` | No | `https:` URL on the site that starts a cross-device (QR) login. Enables the "use my phone" recovery option (§6). |

**Behavior**

1. Parse the fragment. If `request_uri` is missing or not `https:`, show an error page ("This login link is broken — go back to the site and try again").
2. Load storage (§7). Drop any stored wallet whose `app_card` is not on the current certified wallet list (§5).
3. Choose:
   - `wallet_hint` names a stored wallet → that wallet.
   - Exactly one stored wallet → that wallet.
   - Two or more → show the **picker**: each wallet's name and icon, default first and pre-selected, plus "My wallet isn't here" (→ §6). One click continues.
   - None → the **recovery screen** (§6).
4. Forward with `location.replace(handler_url + "#request_uri=" + encodeURIComponent(request_uri))`. `handler_url` never contains a fragment (§4).

A new request that arrives while `/login` (or `/register`) is already open in the tab is a same-document `hashchange`, not a page load; the router handles it the same way. *(Added 2026-11-10 after the browser tests.)*

---

## 4. `/register` — silent wallet registration

**Fragment parameters**

| Name | Required | Value |
|---|---|---|
| `token` | Yes | base64url of the canonical JSON of a `WalletRegistrationToken` (`protocol-objects.md §19`). |
| `next` | No | `https:` URL to continue to (normally the offer's `redirect_url`). |

**Behavior**

1. Decode and validate the token (§5). On failure, do not register; if `next` is a valid `https:` URL, continue to it anyway (registration failure must never strand the user mid-onboarding); otherwise show an error.
2. **Add-only:**
   - If a wallet with the same `app_card` is stored, update its `name`, `icon`, and `handler_url` only if this token's `issued_at` is newer. Its default status is unchanged.
   - Otherwise add it.
   - If no default is set, make this wallet the default. **Never** change an existing default. (Users change the default from the router's settings page, §8, which requires a click.)
3. If `next` is an `https:` URL, `location.replace(next)`. Otherwise show the onboarding screen (§8).

Native wallets register by opening `/register` in the system browser — "silent" means no consent screen, not no browser hop.

**`next` and open redirects.** `/register` forwards to any `https:` `next`. This makes the router an open redirector for users who follow a crafted link. The impact is limited (the router shows no content of its own before redirecting and holds no session), and the alternative — signing `next` — would require a per-user token. Accepted for v1; noted in §9.

---

## 5. Certified wallet list and token validation

The router ships a **certified wallet list**, `wallets.json`, generated at build time from the **wallet cards**: every card under the wallet branch of the app-certification root (the build is configured with the wallet branch node's address), that is not revoked, and whose operator published router metadata (name, icon, `handler_url`, store links) as part of certification (`governance/AppCertificationBody/app_certification_body.md §App Obligations`). The router is rebuilt and redeployed at least daily, so revocations take effect within 24 hours.

Each entry: `{ app_card, app_card_pubkey, name, icon, handler_url, platforms: ["web" | "ios" | "android"], store_urls? }`.

**Token validation** (used by `/register` and by the address lookup in §6):

1. `token.version == "1"`; all required fields present.
2. `token.app_card` is on the certified wallet list, and `token.app_card_pubkey` equals the listed pubkey. (This also covers the `keccak256` binding check, done at build time.)
3. `signature` verifies over the canonical JSON of `token` with `app_card_pubkey` (ML-DSA-44, in the browser).
4. `token.router_origin == location.origin`.
5. `token.expires_at` is in the future and no more than 1 year after `issued_at`.
6. `token.handler_url` is an `https:` URL with no fragment.

Using a build-time list rather than walking the chain in the browser keeps the router fully static and offline-capable, and gives the recovery screen (§6) the same list for free.

---

## 6. Recovery screen

Shown by `/login` when no wallet is stored or the user picks "My wallet isn't here." It never dead-ends. Options:

1. **Pick your wallet** — the certified wallet list, filtered to the current platform. Choosing one forwards the request to that wallet's listed `handler_url`. The wallet re-registers itself afterwards by passing the user through `/register` once the login finishes (wallet-sdk does this when it sees it was reached without a router registration).
2. **Use my phone** — shown only when the site supplied `fallback_uri`. Navigates to it; the site starts a cross-device (`mcard_message`) login with a QR code.
3. **Find my wallet by address** — the user types their wallet's domain. The router fetches `https://<domain>/.well-known/membership-wallet`, which returns a `WalletRegistrationToken`; on successful validation (§5) it registers the wallet (add-only, §4) and forwards the request. This is the only network request the router ever makes, and it carries nothing about the login.
4. **Native wallets** — list entries for iOS/Android wallets use universal/app links as `handler_url`, so choosing one opens the app if it is installed and the store page (`store_urls`) if not.

---

## 7. Storage

`localStorage["mcard-router:v1"]`:

```json
{
  "version": 1,
  "default": "<app_card of the default wallet>",
  "wallets": [
    { "app_card": "<pointer>", "name": "<text>", "icon": "<data URI — optional>", "handler_url": "<https URL>", "registered_at": "<ISO 8601>", "token_issued_at": "<ISO 8601>" }
  ]
}
```

- Nothing else is stored. No request URLs, no history of logins, no identifiers of the user.
- If storage is unavailable (blocked, private mode) the router behaves as if no wallet is registered and `/register` continues to `next` without storing.
- Unparseable or unknown-version data is discarded.

---

## 8. Pages

- **Onboarding** ("Your wallet is set up for logging in") — shown by `/register` when there's no `next`. One "Done" button.
- **Settings** (`/settings`) — lists registered wallets; lets the user change the default or remove a wallet. The only way to replace a default.
- **Picker** and **recovery** — §3, §6.

All pages are plain, accessible, and readable at phone width.

---

## 9. Threat Model

| Threat | Outcome |
|---|---|
| Rogue site registers a fake wallet | Blocked: a token must be signed by a certified wallet card on the build-time list. |
| Certified wallet tries to become everyone's default | Blocked: registration never replaces a default. |
| Router host is compromised | It can misroute requests or fail to deliver them. It cannot read or forge requests (signed by server cards) or responses (verified by sites), and it never receives fragments in its logs — but a compromised router *script* could read fragments in the browser, so it could learn `request_uri` values and send users to a malicious "wallet." A malicious wallet still cannot produce a response for a card it doesn't hold. Mitigations: subresource integrity in the router build, reproducible builds, and published build hashes. |
| Site learns which wallet a user has | Not through the router. |
| Router learns who logs in where | No: fragments aren't sent to the host; nothing about requests is stored. |
| Open redirect via `/register#next=` | Accepted for v1 (§4). |
| Storage wiped (see §11) | Recovery screen; no security impact. |

---

## 10. Acceptance Criteria

Run in headless Chromium, Firefox, and WebKit.

- [ ] `/login` with one registered wallet forwards to `handler_url#request_uri=…` without any user action.
- [ ] `/login` with two registered wallets shows the picker with the default first; `wallet_hint` naming a registered wallet bypasses the picker.
- [ ] `/login` with no registered wallet shows the recovery screen, including "Use my phone" only when `fallback_uri` is present.
- [ ] `/register` with a valid token and no stored wallets stores it as default and forwards to `next` with no visible page.
- [ ] `/register` for a second wallet adds it without changing the default.
- [ ] `/register` with a token signed by a non-listed app card, a wrong `router_origin`, an expired token, or a bad signature stores nothing.
- [ ] After `/login` or `/register`, the fragment is gone from `location.href` and history.
- [ ] No network request is made by `/login` or `/register` (verified by the test harness's network log). The only request any page makes is the §6 address lookup.
- [ ] A wallet removed from the certified list is no longer offered or forwarded to.
- [ ] Choosing a wallet on the recovery screen forwards the request to that wallet.
- [ ] The address lookup registers a wallet from a valid `/.well-known/membership-wallet` and rejects an invalid one.
- [ ] Changing the default is possible only from `/settings`.

---

## 11. Open Questions

- **Safari storage expiry.** Safari's Intelligent Tracking Prevention can delete script-writable storage for a site the user hasn't interacted with (tapped or clicked) as a first party within 7 days of browser use. A silent redirect through `/register` or `/login` may not count as interaction, so Safari users may often land on the recovery screen. Mitigations to test in Phase 4 (WebKit): one-click picker and recovery pages count as interaction; the onboarding page's "Done" button; measuring how often recovery appears. If it's frequent, the recovery screen's "pick your wallet" becomes the normal Safari path, which still works.
- **Router domain and operator** — checkpoint CP5.

## 12. Related Specs

- `process_specs/card_login.md` — the end-to-end flow
- `protocol-objects.md §19` — `WalletRegistrationToken` (also served at `/.well-known/membership-wallet`)
- `object_specs/wallet_sdk.md §Login` — building tokens and registration URLs; handler page parsing
- `governance/AppCertificationBody/app_certification_body.md` — wallet operators' router metadata obligation
- `process_specs/open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`, `card_offering_and_acceptance.md` — where registration happens
