# Card Login — Final Summary (Phase 5)

Date: 2026-11-10 · Strategic plan: [card-login-strategic-plan.md](../card-login-strategic-plan.md) · Implementation plan: [card-login-implementation-plan.md](../card-login-implementation-plan.md) · Integration report: [2026-11-10-card-login.md](../../integration_tests/reports/2026-11-10-card-login.md)

Card login is specified, built, and tested on the local stack. A website can issue a signed request from its server card, send it through the static login router to the user's wallet, and log the user in as the card they pick. The wallet first checks who is asking: the server card, the login service card that certifies it, and that card's DNS-admin-signed domain binding. The site checks the signed answer with the verifier. Three of the five goals (G2, G4, G5) are met. G1 and G3 each have one item left, both noted below. Nothing is deployed, published, or provisioned on a public chain; those steps wait on David (CP4, CP5).

## Goals

| Goal | Status | Evidence / what's left |
|---|---|---|
| G1 — any site, any browser | Partly met | Router built and tested in Chromium, Firefox, and WebKit (27 browser tests); reference site integration is 26 lines; recovery screen tested. **Left:** the full site → router → wallet → site login runs in Chromium only. The harness pins Playwright 1.61, whose Firefox and WebKit builds aren't installed here. |
| G2 — who is asking | Met | `verifyServerCard` in TS and Python; 16 unit cases plus live tests for wrong-origin phishing, revocation, warnings, and suspended domains. |
| G3 — verifiable, session-bound | Partly met | `verifyLoginResponse` in TS and Python; `form_post` and wrong-session rejection run live; latency is recorded. **Left:** `mcard_message` completes with in-process delivery but not through the relay, because no protocol field records a server card's ML-KEM key (F10). |
| G4 — services and one-tap login | Met | `preferred_services` specified and press-validated (P-29); wallet resolves and filters services; wallet-initiated login and router registration tested. |
| G5 — spec-first | Met | All specs revised and approved at CP2 before code; `card_login` suites in `integration_tests/` (14 live tests) and `dev-tests/` (waiting on Sepolia). |

## Phase 5 work

- **5.1 Integration:** full suite green (24 files, 218 passed); browser harness and router tests green. Report: `integration_tests/reports/2026-11-10-card-login.md`.
- **5.1b Sepolia:** `dev-tests/suites/core/card_login.spec.ts` compiles against the published SDKs and stays skipped until the login fixtures are provisioned (CP4) and the login SDKs are published (CP5). The variables it needs are listed in the file.
- **5.2 Triage:** nothing failed in the final run. Two defects found in this phase were fixed. The TS verifier's `decryptCardHead` dropped LogEntry metadata, hiding revocations from Stage 4. The Python `verify_card` checked revocation before reading the card, an older TS fix never ported.
- **5.3 Python parity:** `verifier-py` now has the login module (`verify_server_card`, `verify_login_response`, domain binding, DCQL match, preferred services). It also has the Stage 2 login-branch rule, sub-card documents read from `SubCardEntry`, the Stage 3 start-root check, and `decrypt_card_head`. 211 tests pass, including every `specs/login-conformance.json` vector; ruff and mypy are clean on `src/`.
- **5.4 Docs:** root README (Logging In), verifier READMEs (TS and Python), app-sdk and wallet-sdk READMEs, press `OPERATOR.md` (three new variables), login-router README, and `branding/capability-status.md` (new row 6; corrected the stale press log-entry note).

## Test totals

verifier (TS) 206 · verifier (Python) 211 · press 203 · app-sdk 192 · wallet-sdk 161 · RPC provider 11 · login-router 23 unit + 27 browser · integration 218 (24 files) · browser harness 2.

## Open items for David

| Item | Checkpoint | Notes |
|---|---|---|
| Provision the login service branch and test fixtures on Sepolia, then run the dev-tests suite | CP4 | Variables listed in `dev-tests/suites/core/card_login.spec.ts` |
| Publish SDKs with login; choose the router domain and deploy it; generate `wallets.json` from the chain | CP5 | |
| F10 — a field for sub-card ML-KEM public keys | CP6 | Needed for cross-device delivery through the relay |
| F11 — share the predicate engine with the verifier | CP6 | Until then, DCQL predicates never match |
| F13 — reconcile policy addressing (`keccak(CID)` vs. policy card address) | CP6 | Limits `include_children` on the live stack |
| Firefox/WebKit for the full-login harness | — | Install Playwright 1.61's Firefox and WebKit, or upgrade the harness's Playwright, and add browser projects |
| Publish governance text (`login_service_certification.md`) | CP5 | Written, not published |
