# Matrix Phase 6 Milestone Review — End-to-End Testing and Documentation

**Date:** 2026-07-16
**Status:** Complete, with one honest scope gap: Step 22's on-chain-dependent smoke-test items (5, 7, 8, 10, 11, 12 — satisfying-card join, encrypted post/read, and revocation force-part) require a deployed registry contract and a funded test wallet, neither of which exists in this sandbox. Everything reachable without those was run against a real, live `docker compose up` stack — not mocked — and several real bugs were found and fixed only because of that.

## What was built and verified

| Step | What | Verification |
|---|---|---|
| 20 | Integration test — room lifecycle | `wallet-service/test/integration/matrix-room-lifecycle.test.ts`. 9/9 passing against a live stack (`describe.runIf(hasLiveStack)`, so it skips honestly rather than silently passing when Docker isn't up). Covers: real room creation via `POST /matrix/rooms`, the room appearing in `GET /matrix/room-index`, live Synapse state (`m.card.policy`, `m.room.encryption` = Megolm, enforcement-account power level), and — closing the exact gap Phase 5's own review flagged ("confirmed against a mock server, not a live Synapse + matrix-policy-module instance") — real join denials from the live module: no attestation, and a malformed attestation (empty signatures), both returning `403 M_FORBIDDEN` from `matrix_policy_module` itself, plus confirming the denied joiner is genuinely absent from the room's member list. |
| 21 | Operator runbook | `wallet-service/docs/matrix-operations.md` — startup sequence, env var table, room creation, log interpretation for denied joins/posts (including `attestation_invalid` and `membership_not_registered`), force-part log interpretation, credential inventory (correctly reflecting that no watcher admin token exists), backup/restore for both `synapse_pg_data` and the membership registry volume, and an explicit operator-visibility statement. |
| 22 | Final docker-compose verification | Full live stack booted (wallet-service, its Postgres, relay, synapse, synapse-postgres, the watcher). Confirmed no startup errors after fixing the bugs below. `POST /matrix/token`, `POST /matrix/rooms`, `GET /matrix/room-index`, and direct Synapse Client-Server API calls all exercised for real, over real HTTP, against a real running instance. |

## Bugs found only by booting the real stack (not catchable by unit tests alone)

This phase's methodology — actually running the stack instead of stopping at green unit tests — surfaced nine real defects, none visible from source review or mocked tests:

1. **`ModuleNotFoundError: No module named 'matrix_policy_module'`** — Dockerfile copied source but never installed it as a package.
2. **`pip install`'s relative `file:` dependency path resolving against the wrong CWD** — fixed via explicit `WORKDIR` matching the dependency's relative path.
3. **`ImportError: cannot import name 'mldsa'`** — base image's `cryptography` predates ML-DSA support; pinned `cryptography>=47.0.0`.
4. **`AttributeError: module 'lib' has no attribute 'GEN_EMAIL'`** — upgrading `cryptography` alone broke `pyOpenSSL`'s cffi bindings; fixed by upgrading both in the same install step.
5. **Cold-start `import web3` cost (100s+)** threatening the healthcheck's `start_period` — mitigated with `python -m compileall` baked into the image layer.
6. **Membership registry key read as raw bytes instead of base64url-decoded text**, producing a 44-byte value where `AESGCM` requires exactly 32 — fixed `from_key_path`, added a regression test.
7. **`MATRIX_MEMBERSHIP_REGISTRY_PATH` pointing at the volume mount directory itself**, not a file inside it — `IsADirectoryError` at first write.
8. **The policy module's core join-authorization callback was dead code in production.** `module.py` was registered against `check_event_for_spam`, which — in the installed Synapse version — is never invoked for room joins at all. Combined with `self.api.NOT_SPAM`/`self.api.errors.Codes` not existing on the real `ModuleApi` (both would have raised `AttributeError` on first real join even if the callback had fired) and no default `RoomPolicyResolver` being wired (every room would have been treated as ungated), the entire join-attestation enforcement mechanism would have silently done nothing in a real deployment. Fixed by registering `check_event_allowed` (the `ThirdPartyEventRules` category, which *is* invoked for joins) as the actual gate, adding `ModuleApiRoomPolicyResolver`, and importing `Codes`/`NOT_SPAM` directly from `synapse.api.errors`/`synapse.module_api`.
9. **`private_chat`'s preset default (`m.room.join_rules: invite`) rejected every non-invited join before the policy module ever ran.** Synapse's core event-authorization enforces invite-only join rules ahead of and independently from any spam-checker/third-party-rules callback — under the original config, card-gating was entirely unreachable; every join attempt failed with a generic "not invited" error regardless of attestation validity. Fixed in `wallet-service/src/matrix/room-creation.ts` by adding an explicit `m.room.join_rules: "public"` initial-state entry (Synapse only applies a preset's default when `initial_state` doesn't already specify one), making the policy module the actual join gate while leaving the room out of Matrix's public directory (a separate `visibility` parameter, untouched) and every other `private_chat` default intact.

Bugs 1–7 were found and fixed earlier in this phase (2026-07-14, per their own code comments); bug 8 was found by a dedicated review agent reading `module.py` against the real `ModuleApi` surface rather than trusting the original implementation; bug 9 was found today (2026-07-16) by the live join-denial tests in Step 20 — the first time an actual `/join` request was sent to a real Synapse instance in this whole implementation effort.

## Also folded into this phase

- **Dead code removed:** `wallet-service/scripts/generate-matrix-secrets.ts` still generated a `watcher-credential.json` login password for a design (a dedicated watcher bot account authenticating via Matrix login) that was superseded on 2026-07-12 by the in-process `ModuleApi.update_room_membership` force-part mechanism, which needs no login credential at all. Found independently by both the Step 21 runbook-writing agent and me; removed the generation code, the credential-record call, and the stale documentation, replacing it with a note pointing at the real mechanism. Re-typechecked clean (`tsc --noEmit`) after the edit.
- **`docker-compose.override.yml`** (gitignored, local-dev-only): exposes Synapse's port 8008 as host port 18008, since the host already had something on 8008.

## Checklist (per implementation plan's Step 22)

Of the twelve smoke-test items specified:

- **Done, against the real stack:** 1 (stack boots clean), 2 (`POST /matrix/token` issues a valid token), 3 (`POST /matrix/rooms` creates a room, appears in `GET /matrix/room-index`), 6 (tampered/missing attestation denied, distinctly from a policy-based denial — confirmed by two separate real-403 tests for the missing vs. malformed cases).
- **Not done — genuinely blocked, not skipped for convenience:** 4, 5, 7, 8, 9, 10, 11, 12 all require a card whose on-chain chain walk actually satisfies a room's policy, which requires a deployed registry contract with real on-chain state and a funded signer — no contract is deployed in this sandbox. This is the same category of gap Phase 4 and Phase 5's reviews already flagged for on-chain-dependent paths; Phase 6 closes every gap that doesn't require chain state, and no further gap of that kind was found.

## Test coverage

- `matrix-policy-module` (Python): 86/86 passing, including the new `test_module_policy_resolver.py` (4 tests) and the updated `test_module.py`/`test_membership_registry.py` regression coverage for bugs 6 and 8 above.
- `wallet-service` (TypeScript): `matrix-room-creation.test.ts` (8/8, including the new join-rules regression test), `matrix-discover-rooms.test.ts` (16/16), `matrix-room-lifecycle.test.ts` (9/9, live stack) — all passing. The four other failing test files in the full `wallet-service` suite (`ohttp-*`, `message-delivery`, `bundled-server-smoke`) are pre-existing, unrelated failures caused by missing local environment variables (`process.exit` in `requireEnv`), not regressions from this phase's changes — confirmed by inspecting their failure output directly rather than assuming.
- `npx tsc --noEmit` clean across `wallet-service` after the `generate-matrix-secrets.ts` cleanup.

## What's left for a future pass

1. **Everything in Step 22's checklist gated on a deployed registry contract** — the actual join-with-satisfying-card, encrypted post/read, and revocation/force-part smoke tests. These need a real contract deployment and funded test cards, not more sandbox work.
2. **The RN native crypto module**, unchanged from Phase 5's own review — still a real, scoped-but-undone piece of work.
3. **Cross-server federation**, explicitly out of scope for this pass per the plan's locked-in decisions.
