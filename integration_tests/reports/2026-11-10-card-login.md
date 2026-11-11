# Card login — integration run (implementation plan step 5.1)

Date: 2026-11-10 · Spec: [`process_specs/card_login.md`](../../specs/process_specs/card_login.md) · Plan: [`card-login-implementation-plan.md`](../../plans/card-login-implementation-plan.md) Phase 5

**Result: all green.** The full integration suite passed against the local stack (Arbitrum nitro devnode, press, IPFS, relay, wallet service), and the browser end-to-end login passed. The final run had no failures. The failures found while building the suite were fixed in login scope and are listed below. Three gaps sit outside login scope and go to David at checkpoint CP6.

## Runs

| Suite | Command | Result |
|---|---|---|
| Full integration suite (24 files) | vitest over `integration_tests/suites/` | 24 files passed; 218 tests passed, 51 `todo`; 0 failed |
| `core/card_login.spec.ts` | same run | 14 / 14 passed |
| Browser harness (`harnesses/web/test/login.spec.ts`) | Playwright, Chromium headless shell | 2 / 2 passed — router same-device login; reference site integration is 26 lines (target ~50) |
| Router browser tests (`login-router/test/e2e`) | Playwright, Chromium / Firefox / WebKit | 27 / 27 passed |
| dev-tests `core/card_login.spec.ts` (Sepolia) | `dev-tests` vitest | 2 skipped — waits on CP4 provisioning and CP5 SDK publishing (step 5.1b) |

## Coverage against step 5.1

| Required case | Where | Status |
|---|---|---|
| Same-device login (`form_post`) | `card_login.spec.ts` › same device; web harness | Covered, live |
| Cross-device (`mcard_message` + one-time code) | `card_login.spec.ts` › cross device | Covered with in-process delivery. Delivery through the relay is not covered (gap F10). |
| Wallet-initiated (`wallet_nonce`) | `card_login.spec.ts` › wallet-initiated | Covered, live |
| Recovery (no wallet registered with the router) | `login-router/test/e2e/router.spec.ts` "no wallet → recovery" | Covered in the router's browser tests |
| Revoked login service card | `card_login.spec.ts` › revocation | Covered, live (`LOGIN_SERVICE_REVOKED`) |
| Warning login service card | `card_login.spec.ts` › domain status (monitored → `LOGIN_WARN_DOMAIN_MONITORED`); 6xx/rotation warnings in verifier unit tests | Covered |
| Wrong-origin phishing | `card_login.spec.ts` › Phase 0 setup | Covered, live (`LOGIN_ORIGIN_NOT_BOUND`) |
| Wrong-session delivery | `card_login.spec.ts` › same device "without the cookie" | Covered, live (`LOGIN_SESSION_MISMATCH`) |
| Login service card used as an app | `card_login.spec.ts` › press scope | Covered, live (press P-26; verifier `LOGIN_SERVICE_SCOPE`) |

## Failures found while building the suite (all fixed in login scope)

Each was a real defect, not a test bug. The fixes are logged in `plans/card-login-code-plan.md` §0 (F9, F14, F15) and the spec amendments in `plans/card-login-spec-changes.md`.

| # | Spec reference | Components | Observed | Expected | Cause → fix |
|---|---|---|---|---|---|
| 1 | `protocol-objects.md §3`; `press.md §5.5` | press | Card-update log entries were written unencrypted, without `card_state` or `history` | Encrypted spec LogEntries | `appendLogEntry` predated the LogEntry design → rewritten (F9) |
| 2 | `card_updates.md`; `press.md §6` | wallet-sdk, press | Wallet update posts rejected / 404 | Accepted at `POST /api/update` | Wrong path and field names → path fixed; press accepts both name forms |
| 3 | `card_verifier.md §7.2` steps 2–4 | verifier (TS, Python) | Server card → `CARD_NOT_FOUND` | Sub-card document found | Contract stores sub-cards as a `SubCardEntry` with a plain-JSON document → Stage 2 reads it (F14) |
| 4 | `card_verifier.md §7.3` | verifier (TS, Python) | A root card that has its own issuer failed to reach a trusted root | Trusted | Stage 3 never checked the start card → start-card root check (F15) |
| 5 | `protocol-objects.md §1` | verifier (TS, Python) | Updated cards unreadable (fields from the genesis document only) | Current fields | Head is a LogEntry → `decryptCardHead` overlays `card_state` |
| 6 | `card_verifier.md §7.4` | verifier (TS, Python) | After fix 5, revocation LogEntries no longer reached Stage 4 | Revocation detected | Overlay dropped entry metadata → metadata kept; tests use real LogEntry heads |
| 7 | `card_verifier.md §6.2` | verifier (Python only) | `verify_card` with a pubkey reported revocation `unknown` | Real revocation status | Stage 4 ran before the card was read (already fixed in TS earlier) → order fixed |
| 8 | — (environment) | press, local stack | Press event-log reads went to the mainnet public RPC | Local devnode | Added `ARBITRUM_LOGS_RPC_URL` |
| 9 | `dns_resolution.md §4` | integration fixtures | DNS governance policy changed by another suite broke login setup | Stable | `ensureDnsGovernancePolicy` now resets the policy whenever it differs |

## Known gaps — outside login scope (checkpoint CP6, for David)

| Gap | Spec reference | Effect on login | Today's behavior |
|---|---|---|---|
| **F10** — no protocol field records a sub-card's ML-KEM public key, so card messages can't be encrypted to a server card | `messaging_protocol.md §14`; `press.md §5.4` | `mcard_message` (cross-device) can't be delivered through the relay | wallet-sdk takes an injected `resolveRecipients`; the integration test delivers in process |
| **F11** — the predicate engine lives only in the press | `protocol-objects.md §8.1` (`meta.predicate`) | Requests with a predicate never match | Verifier returns `PREDICATE_NOT_SUPPORTED`; sites use policy lists |
| **F13** — the press records `policy_address = keccak256(policy CID)`; the spec treats a policy as a card at `keccak256(recipient_pubkey)` | `protocol-objects.md §2, §8.1` | `include_children` matches only a card's own policy on the live stack; inherited `preferred_services` resolve from snapshots only | Login matches by on-chain `policy_address`; the full parent walk passes in unit tests and conformance vectors |

## Not run here

- **Sepolia (5.1b):** the dev-tests suite compiles and is skipped until David provisions the login service branch on Sepolia (CP4) and the login SDKs are published (CP5). It lists the variables it needs at the top of `dev-tests/suites/core/card_login.spec.ts`.
