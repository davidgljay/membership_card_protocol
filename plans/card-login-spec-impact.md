# Card Login — Spec Impact Scan (Phase 1)

> **Renamed 2026-11-09:** "developer card" is now **login service card**, and the app-certification root has three branches (wallet, app, login service). This document is a historical record and keeps the old terms; see `plans/card-login-spec-changes.md` §Amendment 2026-11-09.

Implementation plan: [card-login-implementation-plan.md](card-login-implementation-plan.md) · Strategic plan: [card-login-strategic-plan.md](card-login-strategic-plan.md)

Produced by Phase 1 (steps 1.1–1.6). Nothing in `specs/` or `governance/` is edited in this phase; this document lists what must change in Phase 2 and why.

## §0 Open-question resolutions assumed by this scan

The implementation plan says all strategic-plan open questions were resolved on 2026-11-08, but the strategic plan still lists them as open and the answers are only implied by the implementation plan's step text. This scan assumes the following. **David: correct any of these before Phase 2.**

| # | Question | Assumed resolution | Source |
|---|---|---|---|
| 1 | Developer policy governance | A **developer branch under the app-certification root**, governed by the AppCertificationBody (not a separate root). Wallet apps and login services are siblings under one root. | Impl plan 1.2(a), 2.5 |
| 2 | Domain binding | (a) DNS admin card **co-signs** developer card issuance; the developer card records the domain. | Impl plan 1.2(c), 4.3 |
| 3 | Server card as sub-card | A developer-branch card may be `app_card` **only for sub-cards whose master is itself**. | Impl plan 1.2(b) |
| 4 | OpenID4VP depth | Default: OpenID4VP-shaped, protocol-native (DCQL + parameter names; RFC 8785 + ML-DSA-44, no JWT). | Impl plan 1.1 |
| 5 | `required_predicate` | Default: `mcard` DCQL `meta.policies` required, optional `meta.predicate`. | Impl plan 1.3, 2.1 |
| 6 | Remove CHAPI / `callbacks.https` | Default: remove with changelog; keep `mcard://auth?r=` for native/QR. | Impl plan 2.3, 2.4 |
| 7 | Identifier the site sees | Default: master card pointer in `senders`; per-service identifiers P2. | — |
| 8 | Router hosting & registration trust | Default: new `login-router/` static package; registration token signed by a **wallet-branch** app card. | Impl plan 2.2, 4.7 |
| 9 | Where code goes / wallet UI | Default package split; **no wallet front-end in scope** — wallet UX is exercised through a test harness. | Impl plan 4.8 |

Consequence of #1 for the strategic plan's wording: G2's objective says "developer-policy root chain"; under #1 that chain is server card → developer card → developer branch → app-certification root. The strategic plan's companion line ("not yet written") and its Open Questions section should also be updated to record these answers. Both are listed in §F.

---

## §A Auth flow

Sources: `card_protocol_spec.md §8` (lines 1199–1340), `protocol-objects.md §8–9`, `messaging_protocol.md §13–14` and MSG-OQ-8/9.

### A.1 Where the existing specs already disagree with each other

These need resolving regardless of the new design. Phase 2 resolves all of them by making `protocol-objects.md §8–9` authoritative and rewriting messaging §13 to reference it.

| Topic | `card_protocol_spec §8` / `protocol-objects §8` | `messaging_protocol §13` |
|---|---|---|
| Policy requirement | `required_policy` (optional CID) + `required_predicate` | `policy_cid` (required) |
| Callback | `callbacks: { https, ohttp }` | `callback` (single HTTPS string) |
| Expiry | `expires_at` | `expires` |
| Nonce location | `payload.nonce` | `content.nonce` (top level of content, "32-byte random") |
| Statement to sign | `payload.content` | absent |
| Requester signature | `request_signature` + `requester_pubkey` on a standalone object | envelope `signatures` with requester in `senders` |
| Deep link | `mcard://auth?r=<request-url>` (§8 P1) | `mcard://auth?r=<base64(envelope)>` (whole envelope inline) |
| Context type | request `payload.context` is a **string** | response `content.context` is an **object** (both specs) |
| Numbering | — | Summary Table numbers `auth_request`/`auth_response` as 9/10; headings are §13/§14; there is no §12 heading |

Also: `protocol-objects.md §8` header says the request is "fetched by the wallet service via CHAPI"; the `CardAuth` npm package is named in `card_protocol_spec.md` Lagging Indicators but does not exist; messaging Related Specs points at `raw_notes/Card Auth.md`, which predates all of this.

### A.2 `AuthenticationRequest` fields (`protocol-objects §8`, `card_protocol_spec §8`)

| Field | Verdict | Reason |
|---|---|---|
| `session_id` | **change → `state`** | OpenID4VP name for the browser-binding value. Same role: correlates the response with the browser session (cookie on `form_post`; one-time code on `mcard_message`). Keep a single field rather than both. |
| `version` | keep | Bump to `"2"`, since the object is incompatible with v1 (nothing implements v1, so this is cosmetic but signals the break). |
| `purpose` | keep | Displayed in wallet. |
| `requesting_site` | **remove** | Self-asserted display origin is a phishing surface. The wallet displays the `response_uri` origin, which it has checked against the developer card's bound domain. |
| `requester_card` | **change** | Must be a **server card** (sub-card) pointer. Becomes the OpenID4VP `client_id` in role; keep the protocol name. Wallet walks server card → developer card → developer branch → app-cert root (§B). |
| `requester_pubkey` | keep | Now the server card's key. Binding check (`keccak256(pubkey) == requester_card`) unchanged. |
| `payload.content` | keep (rename `statement`) | Text the user countersigns. Rename to match the response's `content.statement`. Default login statement defined in `card_login.md`. |
| `payload.context` | **change** | Currently a string in the request but an object in the response. Make it an optional object in both. |
| `payload.nonce` | **change → top-level `nonce`** | OpenID4VP parameter name and location. Still echoed into the signed response. |
| `required_predicate` | **change → `dcql_query`…`meta.predicate`** | Optional advanced filter, evaluated by the existing predicate engine (Q5). |
| `required_policy` | **change → `dcql_query`…`meta.policies[]`** | List of `{ id, include_children }`; required in the `mcard` format (Q5). |
| `callbacks.https` | **remove → `response_uri`** | Required back-channel replaced by `response_mode` + `response_uri` (Q6). |
| `callbacks.ohttp` | **remove** | `form_post` goes through the browser (OHTTP irrelevant); cross-device uses card messaging, which already has transport privacy options (ADR-007). Supersedes MSG-OQ-8. |
| `redirect_uri` (with `{code}`) | **remove** | `form_post`: the site's own response to the POST redirects the browser. `mcard_message`: the post-login URL travels in `auth_confirmation`. |
| `expires_at` | keep | |
| `request_signature` | keep | Signed by the server card key; serialization list updated. |
| *(new)* `response_mode` | **add** | `"form_post"` \| `"mcard_message"`. |
| *(new)* `response_uri` | **add** | Required for `form_post`. Origin must be covered by the developer card's domain binding (G2). For `mcard_message`, still required — it names the origin the user sees and the wallet checks, and the browser-redemption endpoint lives there. |
| *(new)* `dcql_query` | **add** | `{ credentials: [ { id, format: "mcard", meta: { policies: [ { id, include_children } ], predicate? } } ] }`. Single credential in v1 (multi-card is P2, MSG-OQ-9). |
| *(new)* `wallet_nonce` | **add (optional)** | OpenID4VP name. Present only on wallet-initiated logins; echoes the value the wallet put in the start URL so the wallet can match the request to its pending login (no prompt only on match). |
| *(router-only)* `wallet_hint` | **not a request field** | A router fragment parameter that picks the wallet; it must not be trusted by the wallet for anything, so it stays outside the signed object. Spec it in `login_router.md`. |
| *(new)* request hash | **add to response, not request** | `transaction_data`-style binding: the signed response carries a hash of the canonical request, so a response cannot be replayed against a different request. Hash function to be chosen in Phase 2 to match the message-ID hash (protocol-objects §5 says "the hash of the canonical payload" without naming the function — flag, see §F). |

**Single-use request URL** — keep; rename it `request_uri` (OpenID4VP) in prose. It is what the router passes to the wallet in the fragment and what `mcard://auth?r=` carries.

**`confirmation_code`** — change. Not needed for `form_post` (the browser itself carries the response and the `state` cookie). Becomes the **one-time code** in `auth_confirmation` for `mcard_message`; keep the existing single-use and expiry rules for it.

### A.3 `AuthenticationResponse` fields (`protocol-objects §9`, messaging §14)

| Field | Verdict | Reason |
|---|---|---|
| top-level `session_id` | **change → `state`** | `form_post` form field; unsigned convenience copy, as today. |
| `signed_statement` (envelope, `type: "auth_response"`) | keep | Verifiable on the standard envelope path. |
| `content.statement` | keep | |
| `content.context.session_id` | **change → `content.state`** | Signed copy of `state`. Move out of `context` to a fixed field so it can't be confused with free-form context. |
| `content.nonce` | keep | |
| *(new)* `content.request_hash` | **add** | See A.2. |
| *(new)* `content.audience` | **add** | The `response_uri` origin. The verifier checks it equals its own origin (G3 "audience origin"). |
| `senders` (holder master pointer) | keep | Q7: same identifier at every service in v1. |
| `recipients` (`requester_card`) | **change → developer card** | Messages route to master cards only; the server card is a sub-card with no routing binding. Wallet takes it from the server card's `holder_primary_card`. See D.3. |
| `timestamp` | keep | Freshness window defined in `card_login.md`. |
| signature by device sub-card | keep | Unchanged envelope rules. |
| `card_pointer` | **change (clarify)** | Spec says "the card used to sign" but the signer is a device sub-card and `senders` already holds the master. Define it as the **master card pointer of the presented card** (so it must equal `senders[0]`) or remove it as redundant. Recommend remove; flag in §F. |
| `vp_token` naming | not adopted | Q4: OpenID4VP-shaped, not conformant; keep `signed_statement`. |

### A.4 Flow steps (`card_protocol_spec §8` "Direct fetch flow", steps 1–9)

| Step | Verdict | Reason |
|---|---|---|
| CHAPI wallet discovery (whole subsection) | **remove** | Replaced by the login router (Q6). |
| 1. Handler page receives request URL | change | Router passes `request_uri` in the fragment to the chosen wallet. |
| 2. Wallet fetches request | keep | |
| 3. Expiry, required fields, pubkey binding, signature | keep | Add: `response_mode` valid; `response_uri` is HTTPS. |
| 4. Requester chain walk + revocation | **change** | Chain is now server card → developer card → developer branch → app-cert root. Add: developer card domain binding covers `response_uri` origin; developer card 8xx/9xx → block; warning codes → warn; `DOMAIN_SUSPENDED` → block (§B, §C). |
| 5. Predicate check against held cards | change | DCQL `mcard` match (policies + `include_children`, then optional predicate). Keep "explain, don't error" behavior; resolves §8 Open Question 1. |
| 6. Present request | change | Show `response_uri` origin (not `requesting_site`), developer card identity, warnings. Skipped only for a matching wallet-initiated pending login. |
| 7. Assemble `auth_response` | change | New content fields (A.3). |
| 8. Send response, receive `confirmation_code` | **change** | `form_post`: auto-submitting form in the browser to `response_uri`. `mcard_message`: card message to the server card; site replies with `auth_confirmation`. Record send time for latency (G3). |
| 9. Redirect with `{code}` | **change** | `form_post`: site redirects. `mcard_message`: browser redeems one-time code. |
| Transport options (OHTTP > HTTPS) | **remove** | Replaced by response modes. |
| Verification paragraph | change | Becomes the verifier's login-response entry point (`card_verifier.md §6`): signature, sub-card→master, chain, revocation, DCQL match, nonce, `state`, audience, request hash, freshness. |

### A.5 Acceptance criteria (`card_protocol_spec §8`)

| Criterion | Verdict |
|---|---|
| Site JS doesn't learn wallet identity from CHAPI | **change** → "the site never learns which wallet was used from the router handoff" (it still sees the response, which reveals nothing about the wallet service on `form_post`; on `mcard_message` the sending wallet service is visible to the server's wallet service — note in privacy section). |
| Missing `requester_card` / `requester_pubkey` / `request_signature` rejected | keep |
| Pubkey/pointer mismatch rejected | keep |
| Bad `request_signature` rejected | keep |
| Requester card undecryptable rejected | keep |
| Requester chain not to trusted root rejected | change → names the developer branch root |
| Request URL single-use | keep |
| Nonce echoed and checked | keep (new location) |
| `session_id` echoed and checked | change → `state` |
| `expires_at` enforced | keep |
| Confirmation code only after full verification | change → applies to the `mcard_message` one-time code; for `form_post`, "session only established after full verification" |
| Confirmation code single-use | keep (one-time code) |
| Decline → `redirect_uri?error=declined` | change → `form_post` posts `error=access_denied` (OpenID4VP) to `response_uri`; `mcard_message` sends an `error` message |
| Response via HTTPS / OHTTP | **remove** → replaced by per-mode criteria |
| Wallet shows requester chain summary | keep |
| *(new)* | Wrong-origin rejection; developer-card block/warn; `DOMAIN_SUSPENDED`; request hash; audience; wallet-initiated no-prompt only on match; latency recorded. These are added in `card_login.md`. |

### A.6 §8 P1/P2 items and Open Questions

| Item | Verdict |
|---|---|
| P1 Wallet chooser | keep |
| P1 CHAPI-free fallback (`mcard://auth?r=<request-url>`) | **promote**: no longer a fallback — it is the native-wallet / QR path. `r` carries the `request_uri` only (resolves the A.1 deep-link disagreement). |
| P1 OHTTP relay selection | remove |
| P2 Digital Credentials API | keep, reworded: an Android-only later enhancement alongside the router, not a CHAPI replacement. |
| P2 Requester anonymity | keep |
| P2 Multi-card statements | keep (also closes MSG-OQ-9 as P2) |
| OQ: evaluate predicate before display? | resolved — evaluate first, explain if nothing qualifies |
| OQ: confirmation code expiry/cleanup | carried into `card_login.md` for the one-time code and pending `state` |
| OQ: `/.well-known/card-wallet.json` | resolved — superseded by the router; sites never need wallet transports |
| Metric "`CardAuth` npm package" | change → app-sdk login module adoption |
| MSG-OQ-8 (OHTTP callback) | resolved — superseded by `mcard_message` |
| MSG-OQ-9 (multi-predicate auth) | resolved — P2, out of scope |

### A.7 Messaging §13 `auth_request` / §14 `auth_response`

- **§13 `auth_request`**: keep the type, but redefine its content as a **reference only**: `{ request_uri }`, sent when a site already knows a card's address and wants to push a login prompt. The signed `AuthenticationRequest` at `request_uri` remains the single source of truth. Removes every field disagreement in A.1. *(Judgment call — the alternative is to delete §13; flagged in §F.)*
- **§14 `auth_response`**: content becomes `{ statement, context?, nonce, state, request_hash, audience }`; verification-order list updated to A.4's verifier entry point.
- **New `auth_confirmation`**: site → wallet on `mcard_message` success, carrying the one-time code and post-login URL (§E).
- Summary Table: fix numbering, add `auth_confirmation`.
- Related Specs: replace `raw_notes/Card Auth.md` with `process_specs/card_login.md`.

---

## §B Trust chain

Sources: `subcards.md` (Overview, App Cards and the Trust Chain, Steps 1–5, Trust-and-Safety), `protocol-objects.md §15–16`, `object_specs/card_verifier.md §5, §7.2`, `object_specs/press.md §5.4`, `governance/AppCertificationBody/app_certification_body.md`, `dns_resolution.md §2, §4–8`.

Target chain for a login request:

```
App-certification policy root                    (VerifierConfig.appCertificationRoot)
 ├── wallet branch  → certifier → app card (wallet operator)        [existing]
 └── developer branch → developer policy → developer card (bound to example.com)   [new]
                                              └── server card  (SubCardDocument:
                                                   holder_primary_card = app_card = developer card)
```

### B.1 (a) Developer branch under the app-certification root

Today the app-cert root has one meaning — "certified wallet application" — and nothing distinguishes branches. Changes:

| Spec | Section | Change |
|---|---|---|
| `governance/AppCertificationBody/app_certification_body.md` | Role and Mandate; Trust Chain Structure; App Obligations | Second mandate: certifying **login services**. Add a developer branch node (a policy issued from the app-cert root) and a separate obligations list for developers (domain control, request honesty, no reuse of server cards across domains, revocation on domain loss). State that the developer branch can be split into its own body later without changing card chains. |
| `card_verifier.md` | §5 `VerifierConfig` | Add `developerCertificationRoot?: string` — the developer branch node's address. Its presence is what lets Stage 2 tell the branches apart. Same "missing config ⇒ loud reject" rule as `appCertificationRoot` when a developer-branch app card is encountered. |
| `card_verifier.md` | §7.2 step 16 | During the `app_card` walk, record whether the chain passes through `developerCertificationRoot` (developer branch) or not (wallet branch). Exposed on the result so callers (wallet login validation, router registration-token check) can require a specific branch. |
| `subcards.md` | App Cards and the Trust Chain | Diagram gains the developer branch; text explains wallet vs. developer app cards. |

How the branch is identified (by address of a node in `ancestry_pubkeys`) needs no new on-chain table: the developer branch node is just a card under the app-cert root, so no contract change (CP4 not triggered).

### B.2 (b) Scope rule: developer card as `app_card` only for itself

| Spec | Section | Change |
|---|---|---|
| `protocol-objects.md §16` | `app_card` field notes; Verifier chain walk | New rule: if `app_card`'s chain is in the developer branch, `app_card` MUST equal `holder_primary_card`. |
| `card_verifier.md §7.2` | new step after 16 | Hard reject with a new code (proposed `DEVELOPER_APP_CARD_SCOPE`) and `scope_clean: false` when the rule fails. This is the **"developer card as wallet"** attack: a developer card trying to co-sign sub-cards for other people's cards. |
| `press.md §5.4` | `processSubCardRegistration` after step 5 | Same check at registration; new press error code (next free `P-` number). `verifyAppCertificationChain` returns the branch. |
| `subcards.md` | Step 2, Step 3, Step 5; Acceptance Criteria | Add a **server card flow**: developer tooling generates the server key, builds the `SubCardDocument` with `app_card = holder_primary_card = developer card`, and signs both `app_signature` and `holder_signature` with the developer card key. Consent step skipped, like the wallet self-signing exception. Step 5b (code-510 `active_subcards` entry) still applies — the developer card's policy must have an approved press. |
| `messaging_protocol.md` / `subcards.md` Capabilities | | Server card `capabilities` must include the login message types it sends (`auth_confirmation`, `error`). `auth_request` is not an envelope in the `form_post` path, so Stage 2 step 7's capability check doesn't run on it — `card_login.md` must say the wallet checks the server card's `capabilities` include `auth_request` explicitly. |

**Problem found — attestation (needs David, likely CP1).** Every sub-card carries `attestation_level` `"T2"` (App Attest / Play Integrity proof over a device key) or `"T1"` (hardware keystore). A server card runs on a server and can produce neither. Verifier Stage 2 step 14 and press §5.4 step 6 reject anything that isn't T2 unless the policy accepts T1. Options:
1. **New level `"S1"` (server key)**, accepted only when the B.2 scope rule holds (developer-branch `app_card` == master). No device proof; optional HSM attestation later. *Recommended* — keeps the T1/T2 meaning intact and makes server keys visibly different.
2. Treat server cards as `"T1"` and require `acceptedAttestationLevels` to include T1 for login. Muddies T1's meaning ("hardware-backed device keystore") and weakens every wallet-branch check on the same verifier instance.
Adding an enum value to `SubCardDocument.attestation_level` is additive (existing cards unaffected), so CP3 is likely not triggered, but it's a change to a shared object.

**Problem found — contradiction about runtime app-chain walks.** `subcards.md` Step 5 says runtime verifiers "do not independently re-walk the `app_card` certification chain". `card_verifier.md §7.2` step 16, `protocol-objects.md §16` step 12, and the AppCertificationBody doc all say they do, unconditionally. The verifier spec is the newer, more detailed one and the login design depends on the runtime walk (it is where the scope rule and branch check live). Fix `subcards.md` Step 5 in Phase 2.

**Naming note.** The implementation plan calls the app-chain walk "Stage 2d"; in `card_verifier.md` it is §7.2 **step 16** (sub-steps a–e). Phase 2–4 text should use "step 16".

### B.3 (c) Domain binding: DNS admin co-signature on developer card issuance

**Can `AdminAuthorizeSubCardPayload` be reused? No.** It encodes `sub_card_address` + `sub_card_doc_cid`, is signed with the admin's **secp256r1** key, and is verified **on-chain only inside `RegisterSubCard`** (RIP-7212). Developer card issuance is a `RegisterCard` call; reusing the secp256r1 path would mean a new `RegisterCard` parameter — a contract change (CP4).

**Proposed approach — off-chain ML-DSA-44 co-signature carried in the developer card:**

- New object `DomainBindingAttestation` (`protocol-objects.md`, new section): `{ domain, developer_card_pubkey, admin_card, admin_card_pubkey, issued_at }` plus `admin_signature` — ML-DSA-44 by the **full-domain** admin card's holder key (the same key that signs `SetPolicyAddressIntent`s today). Sub-path-scoped admin cards cannot sign it (their scope is paths, not hosts).
- Developer card carries it as a protocol-reserved field `domain_binding` (immutable after issuance — add to the immutable list, §C).
- **Press at issuance** (`press.md §5.1` `validateIssuanceRequest`, developer policy only): verify the signature; `keccak256(admin_card_pubkey) == admin_card`; `admin_card == DomainRegistrations[domain].admin_card_address`; domain not suspended; `developer_card_pubkey` equals the card being issued. Requires the developer policy to declare that issuance needs a domain binding (policy-level flag, or hard-coded for cards under `developerCertificationRoot` — recommend hard-coded, fewer moving parts).
- **Wallet at login** re-checks the binding against current chain state: admin card is still `DomainRegistrations[domain].admin_card_address` (this makes domain handoff, `dns_resolution.md §8`, automatically invalidate old developer cards); `fraud_risk == 2` with an unexpired suspension → block (`DOMAIN_SUSPENDED`); `fraud_risk == 1` → warn (proposed); `response_uri` origin is covered by `domain`.
- **Coverage rule (needs David):** does a binding to `example.com` cover `login.example.com`? Recommend **yes, the domain and its subdomains, HTTPS only, default port** — TXT control of `example.com` already implies control of its subdomains.

Spec changes: `dns_resolution.md §5` (new subsection: developer card domain bindings; who may sign; handoff effect), `press.md §5.1` (issuance check, new error codes), `protocol-objects.md` (new object + `domain_binding` field on `CardDocument` §1.1 reserved fields), `card_verifier.md` (helper or result field for login validation).

### B.4 (d) Reserved action hosts in the `mcard://` grammar

`dns_resolution.md §2` says a `mcard://` URI "takes one of two forms" (CID or domain/path). `mcard://invite` and `mcard://auth` fit neither: no dot (not Form B) and, today, a first letter that isn't a CID prefix (not Form A). They work by accident; a future action host starting with `b`, `f`, `z` or `Q` (e.g. `badge`) would parse as a CID. Change: add a **reserved action hosts** list (`auth`, `invite`) checked **before** Forms A/B, with a rule that new action hosts are added only by spec change. Add an acceptance criterion that `mcard://auth?r=…` never triggers a CID fetch or on-chain read.

---

## §C Policy and updates

Sources: `protocol-objects.md §1.1, §2`, `card_protocol_spec.md §1` (policy field table, policy creation chain walk) and §The Predicate System, `process_specs/policy_creation.md`, `process_specs/card_updates.md` (step 7), `update_codes.md`.

### C.1 Where `preferred_services` lives

**A standard policy field, not a protocol-reserved field.** `card_protocol_spec.md §1` already has a table of "protocol-defined fields of a policy card" with default update policies (`approved_presses`, `auditors`, …). `preferred_services` belongs there and in `protocol-objects.md §2`. A §1.1-style reserved field (hard-coded authority, not policy-overridable) is unnecessary: there's no security reason to stop an authorizer from tightening who may edit the list.

- Type: new field type `service-array` (add to §The Field Type System) — array of service entries.
- Default update policy: `{ "is_holder": true }` — the policy administrator, same as `approved_presses` and `auditors`. Authorizer may override at issuance.
- Not immutable — do **not** add it to the `card_updates.md` step 7 immutable list.
- Set at creation in `policy_creation.md` Phase 1 step 1 (drafter checklist) and validated in step 2.

### C.2 Entry shape

```json
{ "origin": "https://example.com", "name": "Example Forum", "icon": "<cid — optional>", "description": "<text — optional>" }
```

- `origin`: HTTPS origin only (scheme + host, default port, no path). Must be unique within the list.
- `name` comes from the **policy** (trusted, signed by the community) and is what the wallet shows; the service's `.well-known` name is not used for display. Prevents a listed site from renaming itself.
- `icon` as an **IPFS CID**, not a URL — a URL would let the service see every wallet that renders the list. *(Judgment call, flagged in §F.)*
- Start URL for wallet-initiated login is **not** in the entry; it comes from the service's `/.well-known/membership-login` (§E), so services can change it without a policy update.

### C.3 Inheritance and replace semantics

- **Absent** → inherit from the parent policy. **Present, including `[]`** → replaces the inherited list entirely (`[]` means "no services"). Consistent with the protocol's existing "absent optional fields are omitted, never `null`" convention (`protocol-objects.md §1`), so absent and `[]` are distinguishable in canonical bytes.
- No merging: a chapter that wants its parent's services plus one more lists all of them.
- Effective list = the first policy, walking up from the card's own policy, that has the field present. If none, the card has no services.
- Which policy is current: the **live policy head**, not the `policy_id` snapshot. This is an intentional exception to the "compliance is anchored to `policy_id`" rule (`card_protocol_spec.md` line 75) because services are display/discovery data, not compliance. Must be stated explicitly.

**What "parent policy" means — needs David.** The specs have two different chains above a policy card:
1. **Issuance chain** (`ancestry_pubkeys`): policy card → its issuer (authorizer) card → that card's `policy_id` → … Deterministic, signed, already walked by every verifier. The implementation plan assumes this one.
2. **Holder lineage** (`card_protocol_spec.md §1`, "policy creation chain walk"; `policy_creation.md` Phase 4 step 10): holder's card → its policy → that policy's holder → "that holder's own card" → … Used for `policy_creation` constraints. Step 3 is ambiguous when an administrator holds several cards.

Recommend **(1) the issuance chain** for both `preferred_services` inheritance and DCQL `include_children` — one definition of "child policy" for login, computed from data the verifier already fetches. Note in the spec that it differs from the `policy_creation` walk and why.

### C.4 `include_children` in the DCQL `mcard` match

- `{ id: X, include_children: false }`: the presented card's `policy_id` resolves to policy X.
- `{ id: X, include_children: true }`: the card's policy is X or has X in its issuance-chain ancestry (C.3 (1)).
- Policy identity: compare by the policy card's **registry address** (stable across policy updates), not by CID (changes on every update, and `policy_id` on a card is a snapshot CID). The DCQL `id` should therefore be a card pointer, and matching resolves the card's `policy_id` snapshot to its registry address. *(Flag: the existing `issued_under_template` leaf predicate takes a CID — check in Phase 3 how `src/policy-match.ts` resolves this; if by CID, `include_children` and CID-based matching would disagree after any policy update.)*
- The optional `meta.predicate` runs after the policy match, using the existing predicate engine unchanged.

### C.5 Update codes

- New code **302 — "Preferred services update"** (3xx neutral). Using a dedicated code (rather than generic 300) lets wallets invalidate their cached services list on seeing it. Add to `update_codes.md` per its "add here first" rule.
- No new codes needed for developer cards; revocations use existing 8xx/9xx.

### C.6 Wallet behavior by code (login request validation)

Applies to the server card, developer card, and each card in the developer branch chain.

| Condition | Wallet behavior | Basis |
|---|---|---|
| Any 8xx/9xx with `effective_date` ≤ now on any card in the chain (incl. 811 on the server card) | **Block** | Strategic plan; matches `subcards.md` blocking row |
| 6xx or 7xx on the developer card | **Warn**, allow proceed | Matches `subcards.md` advisory row (6xx/7xx "equivalent") |
| EAS blocking / advisory annotation on the developer card | Block / Warn | Same table; reuses the existing annotation lookup (verifier Stage 6) |
| Domain `fraud_risk == 2`, suspension unexpired (`DOMAIN_SUSPENDED`) | **Block** | Strategic plan |
| Domain `fraud_risk == 1` (monitored) | **Warn** | Proposed — not in strategic plan |
| Bound domain's admin card ≠ current `DomainRegistrations[domain].admin_card_address` | **Block** | B.3 (domain handoff) |
| Developer card has `successor` set (code 100/101) | **Block** for 101 (key possibly compromised); **warn** for 100 | Proposed — needs David |

Proposed (needs David): treat 700/750 (honorable / procedural) the same as 760 — warn — for simplicity and consistency with `subcards.md`, with the subcode's meaning shown in the warning text.

### C.7 Other findings

- `domain_binding` (B.3) must be added to the immutable list in `card_updates.md` step 7 and to `protocol-objects.md §1.1`'s reserved-field list.
- **Existing inconsistency, not login-caused:** `card_protocol_spec.md §1` says "policy cards are issued directly by authorizers — not through a press"; `policy_creation.md` (amended 2026-07-16) says every policy card is issued through a press. Out of login scope — report only (CP6).
- `card_protocol_spec.md §1` says a policy field's update is authorized by "that field's `update_policy` (from the policy's `field_definitions`)" — for a policy card, whose `field_definitions` that means (its own, or its meta-policy's) is not stated. The default-update-policy table is the working answer; `preferred_services` follows it like `approved_presses`.

---

## §D Wallet, SDK, messaging

Sources: `object_specs/app_sdk.md`, `object_specs/wallet_sdk.md`, `object_specs/wallet.md`, `process_specs/open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`, `card_offering_and_acceptance.md`, `process_specs/message_routing.md`.

### D.1 `app_sdk.md` (site side)

| Change | Section | Notes |
|---|---|---|
| New §"Login (Site-Side)" and `login/` in §3 module list | new section after §9 | Functions: create and sign `AuthenticationRequest` with the server card; host it single-use; issue `state`/`nonce` and set the `state` cookie; `form_post` handler; `mcard_message` receiver; `auth_confirmation` + one-time code issue/redeem; wallet-initiated start URL; `/.well-known/membership-login` generator; latency recording; browser button helper (builds the router link). Same discriminated-union result convention as §12. |
| **Server key custody** | §1 "does NOT do", §2, §4.2 | §1 says no function touches a private key except via hardware-backed `SecureKeyProvider`. Server cards fit that if the server supplies a `SecureKeyProvider` (KMS, HSM, or file-backed for dev). Only web and React Native provider packages exist. Phase 3 must decide: a Node provider package, or "integrator supplies one" plus a dev-only file provider in `testing/`. |
| **Server card creation** | §7 | `requestSubCard` (§7.1) signs `app_signature` with "the app's own card key", but for a server card that key is the **developer card's master key**, which lives in the developer's wallet, not on the server. Flow must be: server generates the key → sends an unsigned `SubCardDocument` to the developer's wallet → wallet signs both `app_signature` and `holder_signature` → registers. Needs a new app-sdk "server card request" helper (unsigned doc) and a wallet-sdk counterpart (D.2). |
| Messaging type union | §9.1 | Add `auth_confirmation` to `MessageType`; `auth_request`/`auth_response` already listed. |
| Server card receiving messages | §9.2–9.5 | The server must run the inbound pipeline (UUID registration with a wallet service, realtime delivery, `handleInboundRoutingEnvelope`) as a long-lived process. Already in scope for "server-side integrators" per §1, but nothing documents it for a web server; the login section should say so. |

### D.2 `wallet_sdk.md` (wallet side)

| Change | Section | Notes |
|---|---|---|
| New §"Login (Wallet-Side)" and `login/` module | new section | Parse router handoff / `mcard://auth?r=`; fetch and validate request (all A.4 step 3–4 checks, §B chain + domain binding, §C.6 warn/block); DCQL `mcard` match over held cards; build `auth_response`; deliver by `form_post` (return form data for the host to auto-submit) or `mcard_message` (send via §9.1 fan-out); pending wallet-initiated logins (create, match by `wallet_nonce`, single-use, short TTL); router registration (build registration token, produce `/register` URL); effective `preferred_services` resolution + `.well-known` filter. |
| **Authorize a server card** | §6 | New function to sign a server card `SubCardDocument` with the developer card key in both roles, skipping consent (wallet self-signing analogue) and enforcing the B.2 scope rule on the wallet side too. `handleSubCardRequest` (§6.1) today checks the app card reaches the app-cert root — must not accept a developer-branch app card for any master other than itself. |
| Attestation reality | §5.4 | Device sub-cards are hard-coded to `attestation_level: 'T1'` today (no App Attest provider), and §6.1 does no attestation-proof check. So in practice every deployed verifier already accepts T1. Doesn't change the B.2 recommendation (a distinct server level), but lowers the urgency. |
| Offer acceptance hook | §7.3, §7.4, §7.5 | After a successful acceptance, call router registration (D.4). |
| Annotation check | §6.1 | "No annotation-board check … in scope". Login's warn/block table (§C.6) uses EAS annotations on the developer card; either bring the annotation check into scope for login, or drop annotations from C.6 for v1. *(Flag in §F.)* |

### D.3 Messaging and routing (`message_routing.md`, `messaging_protocol.md`)

**Problem found — the response can't be addressed to the server card.** Routing is by **master card**: the routing header `to` is a card hash whose wallet service holds the card, and the sender fans out to that card's `active_subcards`. A sub-card (the server card) has no `active_subcards` and no routing-table binding. So for `mcard_message`:
- `auth_response.recipients` must be the **developer card** (the server card's master), not `requester_card` as `protocol-objects §9` says today. The wallet derives it from the server card's `holder_primary_card`.
- Fan-out delivers a copy to **every** active sub-card of the developer card — all server instances' cards, and any personal device sub-cards the developer holds on the same card. Recommend `card_login.md` tell developers to keep a dedicated developer card for login (no personal devices on it); any server card that receives the response may process it, and single-use `state` makes duplicates harmless.
- This also fixes the `senders`/`recipients` convention: both are master pointers everywhere else.

Other routing facts that shape the design:
- The cross-device latency path is wallet → wallet service A → wallet service B → relay → server (realtime transport). The G3 latency metric should record wallet-send time in the signed `timestamp` and server-receive time locally; no protocol change needed beyond `card_login.md` saying where each timestamp comes from.
- The developer card needs a holder account at a wallet service (routing binding) and each server card needs a UUID pool there (`wallet.md §7.7`). Nothing new in the wallet service, as far as the spec shows. Confirm in Phase 3.1.

### D.4 First-card router registration (`open_offer_acceptance_*.md`, `card_offering_and_acceptance.md`)

- **New-wallet open offer**, Phase 5 steps 21–23, and **existing-wallet open offer**, Phase 5 steps 17–18: the wallet already redirects the browser to `redirect_url`. Insert registration there: redirect to the router's `/register` with the registration token and `next=<redirect_url>`; the router stores the wallet (add-only) and forwards to `next`. That is the "silent" registration — no extra screen.
- **Targeted offers** (`card_offering_and_acceptance.md` Phase 5) have no browser redirect. Registration happens the next time the wallet opens a browser context, or from a "Set up login" action. Spec it as best-effort for this path.
- **Native wallets**: router storage is browser storage, so a native wallet must open the router in the system browser to register. "Silent" means no consent screen, not no browser hop. State this in `login_router.md`.
- Each spec gets a postcondition: "the wallet is registered with the login router, unless a wallet is already registered as default there (add-only)."

### D.5 `wallet.md` (wallet service)

No change found. The wallet service never sees login content (it is ordinary routed messages), and registration with the router happens in the browser, not the service. Phase 3.1 confirms against code.

---

## §E New documents

### E.1 New specs

**`specs/process_specs/card_login.md`** — format of `card_offering_and_acceptance.md` (Overview, Actors, Preconditions, Steps by phase, Postconditions, Error Paths, Related Specs, acceptance criteria).
- Actors: user, browser, site (server + server card), login router, wallet (+ wallet service), developer (setup only).
- Preconditions / setup phase: developer card issued with a domain binding (B.3); server card created and registered (B.2, D.2); `.well-known/membership-login` published; developer card has a wallet-service account and server cards have UUID pools (D.3).
- Phase 1 — Start: button → site creates and signs request, stores `state`/`nonce`, sets `state` cookie (`SameSite=None; Secure`), redirects to router `/login#request_uri=…` (or shows QR / `mcard://auth?r=` for cross-device).
- Phase 2 — Wallet selection: router picks the registered wallet (or `wallet_hint`), recovery UI if none (`login_router.md`).
- Phase 3 — Validation (wallet): A.4 steps 3–4, §B chain + domain binding, §C.6 warn/block table. Every rejection before display.
- Phase 4 — Card selection: DCQL `mcard` match (C.4), chooser if several, explanation if none.
- Phase 5a — `form_post`: wallet produces an auto-submitting form to `response_uri` in the browser; site verifies (verifier entry point) and sets the session.
- Phase 5b — `mcard_message`: wallet sends `auth_response` to the developer card (D.3); site verifies, replies `auth_confirmation`; browser binding (see E.4 question); latency recorded.
- Phase 6 — Wallet-initiated: wallet creates a pending login (`wallet_nonce`, single-use, short TTL), opens the service's start URL from `.well-known`; site builds a request echoing `wallet_nonce` and routes with `wallet_hint`; wallet skips the prompt only on an exact match.
- Error paths: expired, bad signature, chain/scope failure, wrong origin, revoked/suspended (block), warning (proceed/cancel), no qualifying card, user decline (`error=access_denied`), replayed `state`, wrong browser session, delivery timeout on `mcard_message`.
- Acceptance criteria: the A.5 list as revised, plus every G2/G3/G4 objective.

**`specs/object_specs/login_router.md`**
- Routes: `/login` (fragment params: `request_uri`, optional `wallet_hint`), `/register` (fragment: `token`, `next`). Fragment-only so the router host never receives them.
- Storage schema (origin-scoped `localStorage`/IndexedDB): list of wallets `{ handler_url, name, icon, app_card, registered_at }` + `default`.
- Registration rules: verify the wallet registration token (E.2), add-only, never replace `default`; first registration becomes default.
- Picker (several wallets), recovery UI (no wallet): known-wallet list, QR to another device, `.well-known` address lookup, universal links for native wallets.
- Onboarding "card saved" screen (shown on `/register` when `next` is absent).
- Privacy: no server state, no analytics, request never sent to router host. Threat model: rogue registration (token check), router compromise (can misroute or fail to deliver; cannot forge or read a response, because the request is signed by the server card and the response is verified by the site).
- Open item: **token verification cost in a static page** — checking the token's app card chain to the wallet branch means an ML-DSA-44 verify plus RPC + IPFS reads from the browser. Options: run the verifier in-browser (heavier router), or the router ships a pinned list of wallet-branch app card addresses refreshed at build time. *(Flag in §F.)*
- Open item: **who maintains the known-wallet list** — recommend: generated from wallet-branch app cards at router build time, so it is the AppCertificationBody's list, not the router operator's.

**Governance text for the developer branch** — either a new section in `governance/AppCertificationBody/app_certification_body.md` or a sibling file `governance/AppCertificationBody/developer_certification.md`. Recommend the sibling file (keeps the split-off path clean): mandate, branch structure (B.1), issuance requirements (domain binding, B.3), developer obligations, revocation triggers (domain loss, phishing, abuse).

### E.2 New protocol objects (all in `protocol-objects.md`, new sections after §9)

| Object | Defined in | Outline |
|---|---|---|
| `AuthenticationRequest` v2 | revised §8 | A.2 field list. Signed by server card. |
| `mcard` DCQL credential query | new subsection of §8 | `{ id, format: "mcard", meta: { policies: [ { id: <policy card pointer>, include_children: bool } ], predicate? } }` inside `dcql_query.credentials` (exactly one entry in v1). |
| `AuthenticationResponse` v2 | revised §9 | A.3 field list; `recipients` = developer card (D.3). |
| `DomainBindingAttestation` | new | B.3: `{ domain, developer_card_pubkey, admin_card, admin_card_pubkey, issued_at }` + `admin_signature` (ML-DSA-44, full-domain admin card). Carried in the developer card's `domain_binding` reserved field. |
| `LoginServiceMetadata` (`/.well-known/membership-login`) | new | `{ version, name, start_url, server_card, accepts: [ { policy, include_children } ], response_modes }`, signed by the server card so a wallet can tie it to the developer card's domain. Wallet shows a policy-listed service only if `accepts` matches the card (strategic plan: "two-sided check"). |
| `WalletRegistrationToken` | new | `{ handler_url, name, icon, app_card, app_card_pubkey, router_origin, issued_at, expires_at }` signed by a **wallet-branch** app card key. Per wallet deployment, not per user — carries nothing about the user, so registering reveals nothing to the router. |
| `auth_confirmation` message | `messaging_protocol.md` new §, plus `protocol-objects` if it needs a field table | `{ state, code, redirect_uri, expires_at }`, site → wallet, `in_reply_to` the `auth_response`. |
| `preferred_services` entry | `protocol-objects.md §2` | C.2. |

### E.3 External facts

- **IANA URI scheme registry: `mcard` is not registered** (checked 2026-11-08 against the live registry, `uri-schemes-1.csv`, 456 entries; no `mcard`, `web+mcard`, or similar). Registering it (provisional, RFC 7595) is an external action → **CP5**; not needed for Phase 2.
- The DCQL format identifier `mcard` is a protocol-local string, not an IANA registration.

### E.4 Design point surfaced by drafting the outline (for David)

**Cross-device session binding and QR relay phishing.** On `mcard_message`, whoever started the login in their browser gets the session. An attacker can start a real login on their own machine, show the QR to a victim, and the victim's wallet will (correctly) display the real site's verified origin. Shown origin checks do not stop this. The strategic plan's "one-time-code handoff binds the browser" is the mitigation, but direction matters:
- **Recommended:** the code is delivered to the wallet in `auth_confirmation` and the user types it into the browser they're using. The wallet says "only enter this in a browser you are using yourself." Attacker now needs the victim to relay a second secret.
- Alternative: the browser polls by `state` cookie with no code. Simpler, but fully exposed to relay phishing.
- Long-term fix is proximity (Digital Credentials API / CTAP hybrid), already a P2 item.

---

## §F Milestone review (step 1.6)

### F.1 Contradictions found and resolved in place

- §A A.3 originally kept `recipients = requester_card`; §D.3 shows responses must be addressed to the developer card. A.3 corrected.
- §C.6 uses EAS annotations on the developer card, but `wallet_sdk.md §6.1` puts annotation checks out of scope. Not resolved — listed in F.3.

### F.2 Specs that reference changed names but were outside steps 1.1–1.5

Found by grepping `specs/` and `governance/` for `CHAPI`, `callbacks`, `confirmation_code`, `required_predicate`, `required_policy`, `requesting_site`, `AuthenticationRequest`/`Response`, `auth_request`/`auth_response`, `mcard://auth`, `CardAuth`, `card-wallet.json`, `redirect_uri`. Add to Phase 2:

| File | Where | Change |
|---|---|---|
| `specs/ARCHITECTURE.md` | Core flow §4 "Card Authentication" (lines ~639–690); OQ-13 | Rewrite flow (router, response modes); close OQ-13 as superseded. |
| `specs/process_specs/card_validation.md` | step 26; Related Specs | `required_predicate`/`required_policy` → DCQL `mcard` match; point to the verifier login entry point. |
| `specs/process_specs/card_signing.md` | step 8 (line ~107); type table | Remove the OHTTP / `AuthenticationResponse`-wrapping text; add `auth_confirmation` to the type table. |
| `specs/process_specs/oblivious_transport.md` | Disambiguation note (line ~179) | Its pointer to "the CHAPI authentication flow's OHTTP" becomes stale; delete the clause. |
| `specs/object_specs/client_sdk.md` | — | Marked SUPERSEDED; leave untouched. |
| `README.md`, `branding/capability-status.md` | — | Already in Phase 5.4. |

Also: `dns_resolution.md` and `wallet.md` match `callbacks` only in unrelated senses — no change from that term.

### F.3 Items for David (before or during Phase 2)

Grouped by whether they block Phase 2. Recommended answers are in the referenced section.

**Strategic (CP1 — decision needs adjusting):**
1. **Server card attestation** (§B.2): server cards can't produce T1/T2 device attestation. Recommend new `attestation_level: "S1"` allowed only for developer-scoped sub-cards.
2. **Cross-device binding direction** (§E.4): QR relay phishing defeats origin display. Recommend the one-time code goes to the wallet and is typed into the browser.

**Confirm assumptions:**
3. Open-question resolutions in §0 — especially #1 (developer branch *under* the app-cert root) and #9 (no wallet UI in scope).
4. Domain coverage (§B.3): binding to `example.com` covers its subdomains, HTTPS only.
5. "Parent policy" for `preferred_services` inheritance and `include_children` = issuance chain, not holder lineage (§C.3).

**Smaller judgment calls (default will be used unless you object):**
6. `session_id` → `state`; remove `requesting_site`, `redirect_uri`, `callbacks`; `AuthenticationResponse.card_pointer` removed as redundant (§A).
7. Messaging §13 `auth_request` kept as a reference-only push (`{ request_uri }`) rather than deleted (§A.7).
8. `preferred_services` as a standard policy field, holder-updatable by default, new code 302; `icon` as CID; name taken from the policy, not the site (§C.1–C.2, C.5).
9. Warn/block extras (§C.6): `fraud_risk == 1` warns; developer card `successor` via 101 blocks, via 100 warns; all 7xx warn.
10. EAS annotations on developer cards (§D.2): include in v1 (requires bringing annotation checks into wallet-sdk scope) or defer.
11. Router token verification (§E.1): pinned build-time list of wallet-branch app cards vs. in-browser chain walk. Recommend pinned list (same list feeds recovery UI).
12. Dedicated developer card for login (no personal devices on it), because responses fan out to all its sub-cards (§D.3).

**Existing inconsistencies found in passing (CP6 — report only, outside login):**
- `subcards.md` Step 5 says runtime verifiers don't re-walk the app-card chain; `card_verifier.md §7.2` step 16, `protocol-objects.md §16`, and the AppCertificationBody doc say they do. (Login depends on the runtime walk; Phase 2.5 fixes `subcards.md` since it's in a file login already edits.)
- `card_protocol_spec.md §1`: "policy cards are issued directly by authorizers — not through a press" vs. `policy_creation.md` (2026-07-16): every policy card goes through a press.
- `messaging_protocol.md` Summary Table numbering doesn't match section numbers (no §12).
- `protocol-objects.md §5` defines the message ID as "the hash" of the canonical payload without naming the function; `app_sdk.md §9.1` implements keccak256. The login request hash should use the same function and the spec should name it.

### F.4 Resolutions (2026-11-08, CP1)

David approved Phase 2 with: item 1 → `"S1"` attestation level; item 2 → one-time code delivered to the wallet, typed only for QR-started cross-device logins (auto-redeemed otherwise; site requires `state` cookie + code); items 3–12 → the defaults above. Recorded in the strategic plan's Open Questions.
