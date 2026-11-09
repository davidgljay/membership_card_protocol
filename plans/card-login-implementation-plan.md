# Card Login — Implementation Plan

Strategic plan: [card-login-strategic-plan.md](card-login-strategic-plan.md) — read §Design Decisions and §Open Questions (all resolved 2026-11-08) before starting any step.

**Working files this plan produces** (all in `plans/`, flat, matching recent plans):
- `card-login-spec-impact.md` — Phase 1 scan results
- `card-login-spec-changes.md` — Phase 2 change summary for review
- `card-login-code-plan.md` — Phase 3 code inventory and build order
- `milestones/card-login-phase-N-summary.md` — one per milestone review

**Resuming:** find the first unchecked `- [ ]` step. Checked steps are done; don't redo them.

---

## Phase 1: Scan existing specs

Goal: a complete list of every spec that must change or be created, with the specific sections and the reason, before anything is edited.

- [ ] **1.1 Scan the existing auth flow**
  - **What**: Read `card_protocol_spec.md §8`, `protocol-objects.md §8–9`, `messaging_protocol.md §13–14` and §Open Questions (MSG-OQ-8, MSG-OQ-9). For every field, step, and acceptance criterion, mark it **keep / change / remove** against the design decisions, with one line of reason. Include: CHAPI removal, `callbacks.https` removal, `required_predicate` → `mcard` DCQL `meta`, `response_mode` (`form_post`, `mcard_message`), `response_uri` origin rule, `wallet_hint`, `state` vs. `session_id`, request hash (`transaction_data` semantics), single-use request URL, `confirmation_code`. Note where `auth_request` (messaging) and `AuthenticationRequest` (objects) already disagree (e.g. `policy_cid` vs. `required_policy`, `callback` vs. `callbacks`).
  - **Who**: Claude
  - **Context needed**: the three spec sections above; strategic plan §Design Decisions, §Open Questions 4–7
  - **Done when**: a "§A Auth flow" section exists in `plans/card-login-spec-impact.md` covering every field and acceptance criterion in those sections.

- [ ] **1.2 Scan the trust chain specs**
  - **What**: Read `subcards.md` (App Cards and the Trust Chain; Steps 2 and 5; Trust-and-Safety Integration), `protocol-objects.md §15–16`, `card_verifier.md §5` (config) and `§7.2` (Stage 2), `press.md §5.4` (`processSubCardRegistration`), `governance/AppCertificationBody/app_certification_body.md`, and `dns_resolution.md §2, §5, §6`. List the changes needed for: (a) a developer certification root under the app-certification root; (b) the scope rule "a developer-branch card may be `app_card` only for sub-cards whose master is itself"; (c) DNS admin card co-signature on developer card issuance, and how the bound domain is recorded on the developer card; (d) reserved action hosts (`auth`, `invite`) in the `mcard://` grammar. For (c), check whether the existing `AdminAuthorizeSubCardPayload` secp256r1 mechanism can be reused or a new co-signature is needed.
  - **Who**: Claude
  - **Context needed**: the specs above; strategic plan §Open Questions 1–3, 6
  - **Done when**: "§B Trust chain" in `card-login-spec-impact.md` lists each change with spec, section, and a proposed approach for (c).

- [ ] **1.3 Scan policy and update specs**
  - **What**: Read `protocol-objects.md §2` (PolicyCardDocument), `process_specs/policy_creation.md`, `process_specs/card_updates.md` (immutable-field list, P-25), `update_codes.md`, and `card_protocol_spec.md` §The Predicate System. Determine: where `preferred_services` lives (policy field vs. protocol-reserved field), its entry shape (`origin`, `name`, `icon`, optional `description`), who may update it and with which code, what "inherited from ancestor policies" walks (the policy card's `ancestry_pubkeys` chain), and the exact replace semantics (including an explicit empty list meaning "no services" vs. absent meaning "inherit"). Map update codes to wallet behavior: which 6xx/7xx codes warn, 8xx/9xx block.
  - **Who**: Claude
  - **Context needed**: the specs above; strategic plan §Design Decisions (service discovery, developer card status)
  - **Done when**: "§C Policy and updates" in `card-login-spec-impact.md` answers each question above, flagging any that need David.

- [ ] **1.4 Scan wallet, SDK, and messaging specs**
  - **What**: Read `object_specs/app_sdk.md`, `object_specs/wallet_sdk.md`, `object_specs/wallet.md`, `process_specs/open_offer_acceptance_new_wallet.md`, `open_offer_acceptance_existing_wallet.md`, `card_offering_and_acceptance.md` (where "first card accepted" happens → silent router registration), and `process_specs/message_routing.md` (how a server card receives an `auth_response` message and replies). List required additions and any conflicts.
  - **Who**: Claude
  - **Context needed**: the specs above; strategic plan §Design Decisions (registration, response modes, wallet-initiated login)
  - **Done when**: "§D Wallet, SDK, messaging" in `card-login-spec-impact.md` lists each change.

- [ ] **1.5 Identify new specs and external facts**
  - **What**: Propose the new documents: `specs/process_specs/card_login.md` (end-to-end process: same-device, cross-device, wallet-initiated, recovery, registration), `specs/object_specs/login_router.md`, and new governance text for the developer certification root. Propose new protocol objects and where each is defined: `mcard` DCQL query, login service metadata (`/.well-known/membership-login`), wallet registration token, `auth_confirmation` message. Check whether `mcard` is already registered in the IANA URI scheme registry (search; if unreachable, ask David to check).
  - **Who**: Claude (IANA check may need David)
  - **Context needed**: `card-login-spec-impact.md` §A–D; strategic plan §Open Questions 6, 8
  - **Done when**: "§E New documents" in `card-login-spec-impact.md` lists each new spec/object with an outline, and the IANA status is recorded.

- [ ] **1.6 Phase 1 Milestone Review**
  - **What**: Check §A–E for contradictions (e.g. the same field changed two ways), for decisions the scan shows won't work as stated, and for specs touched by one section but missed by another. Grep `specs/` for every object and field name being changed to catch references outside the scanned files.
  - **Who**: Claude
  - **Context needed**: `plans/card-login-spec-impact.md`; strategic plan
  - **Done when**: contradictions resolved in place; `plans/milestones/card-login-phase-1-summary.md` written (one paragraph plus any items for David). **→ Checkpoint CP1** if any strategic decision needs to change.

---

## Phase 2: Draft and update specs

Goal: the specs fully describe card login, consistently, before any code. Edit specs in place; record every edit in the change summary as you go.

- [ ] **2.1 Write `specs/process_specs/card_login.md`**
  - **What**: Process spec in the repo's process-spec format (Overview, Actors, Preconditions, Steps by phase, Postconditions, Error Paths, Related Specs, acceptance criteria). Cover: button → router → wallet; request fetch and validation; card selection by DCQL `mcard` (policies + `include_children`, optional predicate); `form_post` with `state` cookie (`SameSite=None; Secure`); `mcard_message` with `auth_confirmation` one-time code and browser redemption; wallet-initiated login (start URL, `wallet_hint`, pending login single-use and short-lived, prompt skipped only on match); warn/block rules; latency recording for `mcard_message`.
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §A, §D, §E; an existing process spec as a format model (e.g. `process_specs/card_offering_and_acceptance.md`)
  - **Done when**: file exists, every flow has numbered steps and error paths, and acceptance criteria cover every G2/G3/G4 objective in the strategic plan.

- [ ] **2.2 Write `specs/object_specs/login_router.md`**
  - **What**: Object spec for the static router: `/login` and `/register` contracts (fragment parameters), storage schema, silent registration (registration token signed by a wallet-branch app card; add-only, never replace default), picker behavior, recovery UI (known-wallet list and who maintains it, QR to another device, `.well-known` address lookup, universal links), onboarding "card saved" screen, privacy properties (no server state; request never sent to router host), and threat model (rogue registration, router compromise can only fail to deliver).
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §D–E; strategic plan §Design Decisions (transport, registration)
  - **Done when**: file exists with acceptance criteria for each behavior above.

- [ ] **2.3 Revise the authentication request/response specs**
  - **What**: Rewrite `card_protocol_spec.md §8` to the new flow (pointing to `card_login.md` for steps); update `protocol-objects.md §8–9` field tables and JSON templates (signer = server card; `response_mode`, `response_uri`, `state`, `dcql_query` with `mcard`, request hash binding; remove `callbacks.https` and CHAPI text); add the new objects from §E (DCQL `mcard` query, login service metadata, wallet registration token). Add changelog entries noting the removals.
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §A, §E; the sections being edited
  - **Done when**: no remaining reference to CHAPI or `callbacks.https` in `specs/` (grep), and every new object has a template, field table, and "Serialized for signing" line.

- [ ] **2.4 Revise `messaging_protocol.md`**
  - **What**: Update `auth_request` (§13) and `auth_response` (§14) to match `protocol-objects.md §8–9`; add `auth_confirmation`; resolve MSG-OQ-8 (superseded by `mcard_message`) and MSG-OQ-9 (multi-card: P2, out of scope); keep `mcard://auth?r=` and state that it carries only a request reference.
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §A, §D; revised `protocol-objects.md §8–9`
  - **Done when**: the message types and object specs use identical field names, and the Summary Table is updated.

- [ ] **2.5 Revise trust chain specs**
  - **What**: Apply §B: `subcards.md` and `protocol-objects.md §16` (developer branch, `app_card` scope rule); `card_verifier.md` §7.2 (Stage 2d scope check and its error code) plus a new login-response verification entry point in §6; `press.md §5.4` (scope rule at registration; developer card issuance requires DNS admin co-signature); `dns_resolution.md` §2 (reserved action hosts checked before Forms A/B) and §5 (reference to developer cards); `governance/AppCertificationBody/app_certification_body.md` (developer certification root mandate and obligations for login services).
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §B; the specs listed
  - **Done when**: each change in §B is applied, and the developer-card-as-wallet attack is named with its rejection in both press and verifier specs.

- [ ] **2.6 Revise policy and update specs**
  - **What**: Apply §C: `preferred_services` in `protocol-objects.md §2` (template, field table, inheritance-with-replace rule), `policy_creation.md` (setting it at creation), `card_updates.md` (how it's updated, by whom), `update_codes.md` (cross-reference for which codes wallets treat as warnings in login).
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §C
  - **Done when**: a reader can compute a card's effective services list from the specs alone, including the absent-vs-empty distinction.

- [ ] **2.7 Revise SDK and wallet specs**
  - **What**: Add a login section to `object_specs/app_sdk.md` (site side: create/sign/host request, `form_post` and `mcard_message` handlers, one-time code, start URL, `.well-known` generation, button helper) and `object_specs/wallet_sdk.md` (wallet side: handoff parsing, validation, DCQL matching, response delivery, pending login, router registration, effective services resolution). Update the open-offer acceptance process spec(s) with the silent-registration step on first card. Update `object_specs/wallet.md` only if §D found a service-side change.
  - **Who**: Claude
  - **Context needed**: `card-login-spec-impact.md` §D; revised `card_login.md`, `login_router.md`
  - **Done when**: each SDK spec lists its new public functions with signatures and result/error conventions matching the spec's existing style.

- [ ] **2.8 Write the change summary for review**
  - **What**: Write `plans/card-login-spec-changes.md`: for each spec file, what changed, why (link to the strategic-plan decision), whether it's a breaking change to anything implemented, and any judgment calls made while drafting that David hasn't explicitly decided. Lead with a one-screen overview and a list of "decisions made while drafting."
  - **Who**: Claude
  - **Context needed**: all Phase 2 edits (`git diff specs/ governance/`)
  - **Done when**: every edited or new file appears in the summary, and every judgment call is listed.

- [ ] **2.9 Phase 2 Milestone Review (consistency pass)**
  - **What**: Using the approach in `plans/spec-consistency/`, cross-check all touched specs for: identical field names and types across objects, process, messaging, and SDK specs; error codes defined once and referenced consistently; acceptance criteria that each map to a spec section; and no leftover references to removed mechanisms. Fix in place and note fixes in the change summary.
  - **Who**: Claude
  - **Context needed**: `plans/card-login-spec-changes.md`; all touched specs; `plans/spec-consistency/strategic-plan.md` (method)
  - **Done when**: `plans/milestones/card-login-phase-2-summary.md` written. **→ Checkpoint CP2 (required): David reviews and approves `card-login-spec-changes.md` before Phase 3.**

---

## Phase 3: Plan the code changes

Goal: know exactly which modules change, in what order, and how each is tested, before building.

- [ ] **3.1 Inventory code impacts per package**
  - **What**: For each package, list files to add or change and the spec section driving each:
    - `membership_card_verifier/packages/verifier` — `src/stages/stage2.ts` (developer `app_card` scope rule), `src/policy-match.ts` (DCQL `mcard` policy match with `include_children`), new login-response verification entry point in `src/CardVerifier.ts`, `src/types.ts`, `src/errors.ts`
    - `membership_card_verifier/packages/verifier-py` — parity for the same
    - `press` — `src/handlers/sub-card.ts` (scope rule), `src/functions/issuance.ts` (developer card DNS co-signature; `preferred_services` validation), `src/handlers/update.ts` (`preferred_services` updates)
    - `app-sdk/packages/app-sdk` — new `src/login/` (server-side request, handlers, one-time code, start URL, `.well-known`, latency metric, button helper), reusing `src/subcards/signWithSubCard.ts` and `src/messaging/`
    - `wallet-sdk/packages/wallet-sdk` — new `src/login/` (handoff, validation, DCQL matching, response delivery, pending login, router registration, services resolution); hook into `src/offers/*Acceptance.ts` for first-card registration
    - `login-router/` — new package (static site)
    - `wallet-service` — confirm no change needed for server cards receiving messages; list any if found
    - `contracts` — confirm no change needed; **any contract change triggers CP4**
    - `dev-tests/support` — helpers to create the developer certification root, mint a domain-bound developer card, and register a server sub-card
  - **Who**: Claude
  - **Context needed**: approved specs; `plans/card-login-spec-changes.md`; the package source trees listed
  - **Done when**: "§1 Inventory" in `plans/card-login-code-plan.md` covers every package, with "no change" stated explicitly where that's the finding.

- [ ] **3.2 Define shared types and the test plan**
  - **What**: Decide where shared login types and canonicalization live (follow how `CardDocument`/`SubCardDocument` types are shared today). Define the test layers: unit tests per package (vitest), conformance vectors `specs/login-conformance.json` (canonical request, response, registration token, metadata; shared by TS and Python), a `card_login` suite in `dev-tests/suites/` and `integration_tests/suites/`, and a browser matrix for the router (Playwright: Chromium, Firefox, WebKit). Map each acceptance criterion in `card_login.md` and `login_router.md` to a test.
  - **Who**: Claude
  - **Context needed**: §1 of `card-login-code-plan.md`; `specs/serialization-conformance.json` (vector format model); `plans/integration-testing-strategic-plan.md`
  - **Done when**: "§2 Types and tests" in `card-login-code-plan.md` maps every acceptance criterion to a named test.

- [ ] **3.3 Set build order**
  - **What**: Order the work so each step is testable on completion: conformance vectors and types → verifier → press → test fixtures → app-sdk login → wallet-sdk login → router → reference site and wallet harness → integration suites → Python parity.
  - **Who**: Claude
  - **Context needed**: `card-login-code-plan.md` §1–2
  - **Done when**: "§3 Build order" written, with dependencies stated per step.

- [ ] **3.4 Phase 3 Milestone Review**
  - **What**: Check that every spec change in `card-login-spec-changes.md` has a code location or an explicit "spec-only" note, and every acceptance criterion has a test.
  - **Who**: Claude
  - **Context needed**: `card-login-code-plan.md`; `card-login-spec-changes.md`
  - **Done when**: `plans/milestones/card-login-phase-3-summary.md` written; David told the build is starting (no approval needed unless CP4 applies).

---

## Phase 4: Build with tests

Each step: implement per the spec, write tests from the spec's acceptance criteria (not from the implementation), and run the package's existing suite to confirm no regressions. Name the spec section in each test.

- [ ] **4.1 Conformance vectors and shared types**
  - **What**: Write `specs/login-conformance.json` and the shared types per `card-login-code-plan.md §2`.
  - **Who**: Claude
  - **Context needed**: `protocol-objects.md` (new objects); `card-login-code-plan.md §2`
  - **Done when**: vectors validate against the canonicalizer in `membership_card_verifier/packages/verifier/src/canonicalize.ts`.

- [ ] **4.2 Verifier (TypeScript)**
  - **What**: Stage 2d developer `app_card` scope rule; DCQL `mcard` policy match with `include_children` (walks the card's policy ancestry); login-response verification (signature, sub-card link, chain, revocation, policy match, nonce, `state`/session, audience origin, request hash).
  - **Who**: Claude
  - **Context needed**: `card_verifier.md` (revised §6, §7.2); `card_login.md`; verifier `src/`
  - **Done when**: new tests pass (including "developer card as wallet app card" rejection and "valid card, wrong origin"), all existing verifier tests pass, and vectors pass.

- [ ] **4.3 Press**
  - **What**: Reject sub-card registrations that violate the developer scope rule; require and validate the DNS admin co-signature on developer card issuance; validate `preferred_services` shape on policy issuance and updates.
  - **Who**: Claude
  - **Context needed**: `press.md` (revised §5.4); `dns_resolution.md §5`; `protocol-objects.md §2`; press `src/`
  - **Done when**: new press tests pass and the existing press suite passes.

- [ ] **4.4 Test fixtures**
  - **What**: Add `dev-tests/support` helpers: create the developer certification root under the app-certification root, mint a domain-bound developer card, register a server sub-card, and create policies with and without `preferred_services` (including an inheriting child).
  - **Who**: Claude
  - **Context needed**: `dev-tests/support/governance.ts`, `devPolicy.ts`, `mintCard.ts`
  - **Done when**: a smoke test using each helper passes against the dev stack.

- [ ] **4.5 Site side (`app-sdk` login module)**
  - **What**: Create and sign requests with the server card; single-use request hosting; `state`/nonce; `form_post` handler; `mcard_message` receiver, `auth_confirmation`, and one-time code redemption; wallet-initiated start URL; `.well-known/membership-login` generation; latency recording; browser button helper (links to router).
  - **Who**: Claude
  - **Context needed**: `app_sdk.md` (revised login section); `card_login.md`; app-sdk `src/subcards/`, `src/messaging/`
  - **Done when**: unit tests cover each acceptance criterion assigned to app-sdk in `card-login-code-plan.md §2`, and the existing app-sdk suite passes.

- [ ] **4.6 Wallet side (`wallet-sdk` login module)**
  - **What**: Parse router handoff; fetch and validate requests (all G2 checks, warn/block rules, `DOMAIN_SUSPENDED`); match held cards by DCQL; build and deliver `auth_response` by `form_post` or `mcard_message`; pending wallet-initiated login; router registration on first card acceptance (add-only); effective `preferred_services` resolution filtered by each service's `.well-known`.
  - **Who**: Claude
  - **Context needed**: `wallet_sdk.md` (revised login section); `card_login.md`; `login_router.md` (registration contract); wallet-sdk `src/`
  - **Done when**: unit tests cover each acceptance criterion assigned to wallet-sdk, including no-prompt only on a matching pending login, and the existing wallet-sdk suite passes.

- [ ] **4.7 Login router**
  - **What**: Build `login-router/` as a static site: `/login`, `/register`, picker, recovery UI, onboarding screen, add-only registration, token check. No server code.
  - **Who**: Claude
  - **Context needed**: `login_router.md`; an existing package's tooling as a model (e.g. `sdk-providers-web`)
  - **Done when**: Playwright tests pass in Chromium, Firefox, and WebKit for login with one wallet, several wallets, no wallet (recovery), silent registration, and a rejected attempt to replace the default.

- [ ] **4.8 Reference site and wallet harness**
  - **What**: A minimal reference site using `app-sdk` login (also serves as the "under ~50 lines" measurement) and a wallet test harness using `wallet-sdk`, wired to the router, for integration tests.
  - **Who**: Claude
  - **Context needed**: 4.5–4.7 outputs; `integration_tests/harnesses/`
  - **Done when**: same-device login completes end-to-end locally.

- [ ] **4.9 Phase 4 Milestone Review**
  - **What**: Check implementations against the specs (not just tests): field names, error codes, and behavior match; any place the code needed something the spec doesn't say is fixed in the spec and logged in `card-login-spec-changes.md`.
  - **Who**: Claude
  - **Context needed**: Phase 4 diffs; revised specs; `card-login-code-plan.md`
  - **Done when**: `plans/milestones/card-login-phase-4-summary.md` written.

---

## Phase 5: Integration, parity, and wrap-up

- [ ] **5.1 Integration suites**
  - **What**: Add `card_login.spec.ts` to `dev-tests/suites/` and `integration_tests/suites/` covering same-device, cross-device (`mcard_message`), wallet-initiated, recovery, revoked and warning developer cards, wrong-origin phishing, wrong-session delivery, and the developer-card-as-wallet rejection. Run against the full stack.
  - **Who**: Claude
  - **Context needed**: `card_login.md`; `card-login-code-plan.md §2`; `integration_tests/README.md`
  - **Done when**: suites run, and a dated report is in `integration_tests/reports/` listing each failure with spec reference, components, observed vs. expected, and suspected cause.

- [ ] **5.2 Triage and fix**
  - **What**: Fix failures within login scope. **→ Checkpoint CP6** for anything outside it.
  - **Who**: Claude (David for out-of-scope items)
  - **Context needed**: 5.1 report
  - **Done when**: all in-scope failures fixed and suites green.

- [ ] **5.3 Python verifier parity**
  - **What**: Implement the 4.2 verifier changes in `verifier-py`, passing `specs/login-conformance.json` and cross-language vectors.
  - **Who**: Claude
  - **Context needed**: 4.2 diff; `verifier-py/src`, `verifier-py/vectors`
  - **Done when**: Python tests and shared vectors pass.

- [ ] **5.4 Docs and status**
  - **What**: Update the README's Core Flows with login, `branding/capability-status.md`, and each package README for its new module.
  - **Who**: Claude
  - **Context needed**: final specs; `branding/capability-status.md`
  - **Done when**: docs describe login as it was built.

- [ ] **5.5 Final Milestone Review**
  - **What**: Check every strategic-plan objective; check off those met with evidence (test name or file); list anything unmet with a reason.
  - **Who**: Claude, then David
  - **Context needed**: strategic plan; all milestone summaries; 5.1 report
  - **Done when**: `plans/milestones/card-login-final-summary.md` written and the strategic plan's checkboxes updated.

---

## Clarification Checkpoints

Stop and check with David when:

- **CP1 — Decision doesn't survive contact with the specs.** If Phase 1 finds that a strategic-plan decision conflicts with existing spec behavior in a way that can't be resolved by editing the new text alone.
- **CP2 — Spec approval (required).** After Phase 2, before any code: David reviews `plans/card-login-spec-changes.md`. Removals of existing spec text (CHAPI, `callbacks.https`) are approved here.
- **CP3 — Breaking shared objects.** Before changing a field on `CardDocument`, `PolicyCardDocument`, `SubCardDocument`, or `SignedMessageEnvelope` in a way that breaks existing tests or already-registered cards.
- **CP4 — Contracts and on-chain actions.** Before any change under `contracts/`, and before registering the developer certification root (or anything else) on a testnet or mainnet.
- **CP5 — External actions.** Before IANA scheme registration, npm publishing, deploying the router, choosing or buying its domain, or publishing governance text.
- **CP6 — Out-of-scope fixes.** If integration testing exposes a bug outside login (e.g. in existing verifier stages or messaging), report it rather than fix it.
- **CP7 — Git.** Commit or push only when David asks.
