# Relay-Old Restoration — Spec Gap Analysis & Closure Plan

**Date:** 2026-07-10
**Status:** Draft — not yet executed
**Companion documents:** `specs/object_specs/relay.md` (v0.8), `specs/object_specs/relay_data_model.md` (v0.8), `specs/process_specs/notification_relay.md` (v0.10), `plans/relay-serverless-migration-strategic-plan.md`, `plans/relay-serverless-migration-implementation-plan.md`, `plans/milestones/relay-serverless-docker-retirement-pending.md`

---

## Why this plan exists

The relay was migrated to a serverless architecture (Cloudflare Workers + Durable Objects + Redis Cloud + Cloudflare KV) per `plans/relay-serverless-migration-strategic-plan.md`. On reflection, the serverless design still needs a Redis instance, and running that Redis instance in Docker makes a fully-Docker topology (app + Redis together) cleaner than splitting state across a third-party Redis Cloud service and Cloudflare KV. `relay-old/` (Docker/Compose, self-hosted Redis, SQLite device registry, plain Node/Express process) is the pre-migration implementation and is the natural base to return to — it was never deployed to production, so there is no live-traffic cutover to plan for, only a code-and-spec correctness check.

**This plan does not execute the swap.** It only produces a verified, itemized list of gaps between `relay-old/`'s code and the *current* specs, excluding gaps that exist purely because the specs currently describe serverless-specific infrastructure. A second, follow-up plan (informed by this one's output) should decide which gaps are essential to close, close them, revert the specs, and only then swap `relay-old` and `relay`.

---

## Scope: what counts as a "gap" here, and what doesn't

The specs were amended several times (v0.4 → v0.8 for `relay.md`/`relay_data_model.md`) across the serverless migration. Some of those amendments are **serverless-infrastructure-specific** — they describe a Cloudflare-only mechanism and have no bearing on a Docker/self-hosted-Redis deployment. Others are **substantive corrections or behavior changes** that happened to be made *during* the migration but are not actually about serverless infrastructure — those apply regardless of deployment target, and `relay-old/` must be checked against them too.

**Explicitly OUT of scope (do not flag as gaps, do not try to "fix" relay-old to match these):**

- Device registry backed by Cloudflare KV instead of SQLite (`relay_data_model.md` §5). `relay-old/`'s SQLite-backed registry (`relay-old/src/utils/storage/sqlite.ts`) is the correct technology for a Docker deployment and matches the pre-migration (v0.4/v0.5) spec almost exactly (same fields, same 90-day retention). No code change needed here — only the spec text needs to revert to describing SQLite (Phase B below).
- Cloudflare Cron Trigger vs. a `setInterval`/process-startup model for the reconciliation scan, delete-queue polling, and device-registry pruning (`relay_data_model.md` §2.5, §2.6, §4.4). `relay-old/`'s `startup.ts` (startup scan), `wallet_clearance.ts` (interval poll), and `pruning.ts` (weekly interval) are the correct model for a long-running Docker process. No code change needed — spec text should revert to describing this model.
- Durable Objects / Cloudflare Workers Hibernation API and the Redis-vs-DO "authority split" (`relay_data_model.md` §10). This entire section is Cloudflare-specific; a single long-running Docker process has no equivalent split to make — one process is authoritative for everything. No code change needed; the section should be dropped when specs revert (not replaced with a Docker equivalent, since the problem it solves doesn't exist outside Workers).
- Redis Cloud / Upstash TLS provisioning concerns, `REDIS_PRIMARY_URL` naming, dual Nitro presets (`cloudflare` / `node-server`), Nitro `storage()` abstraction. All Cloudflare/Nitro-specific; `relay-old/` is plain Node/Express and none of this applies.
- `specs/process_specs/notification_relay.md` v0.7–v0.10's subcard signed-envelope requirements for UUID registration and deregistration (`POST /cards/{card_hash}/subcards/{subcard_hash}/uuids`, `DELETE .../subcards/{subcard_hash}`). These are **wallet-service** endpoints, not relay endpoints — out of scope for a relay-old gap analysis regardless of architecture. Do not add wallet-side auth logic to `relay-old/`.

**IN scope (real candidate gaps — verify and assess each one):**

Anything where `relay-old/`'s code does something the current spec says is wrong, superseded, or renamed, for a reason that has nothing to do with serverless infrastructure. One major example was already found during the research for this plan (Finding 1 below) — the execution steps in Phase A start from it but must independently re-verify it (code moves) and must not assume the list below is exhaustive.

---

## Findings from initial review (verify, don't re-derive from scratch)

### Finding 1 — `GET /ws/{uuid}` implements a bidirectional bridge to the wallet service; spec requires inbound-only delivery

`relay-old/src/routes/ws.ts` opens an **outbound WebSocket from the relay to the wallet service** (`new WebSocket(record.wallet_ws_url + '/' + uuid)`) and bridges messages bidirectionally between the device and the wallet socket (`activePeers` map, `deviceSocket.on("message", ...)` forwarding to `walletSocket`, and vice versa). It also implements a `WALLET_REJECTED` (4002) close code for when the outbound wallet connection fails.

`specs/object_specs/relay.md` §7.3 (current, and per its own text, unchanged since **v0.5** — this predates the serverless migration, which started around v0.5/v0.6) states the connection is **inbound-delivery only**: the relay must never open any connection to the wallet service; outbound device→wallet messages go directly from the device to the wallet service's HTTPS endpoint. `relay_data_model.md`'s error-code table confirms: `WALLET_REJECTED` — "*(Removed in v0.5 — relay no longer opens outbound WebSocket to wallet)*".

This is corroborated by the actual wallet-service code: `wallet-service/src/relay-client.ts` only ever calls `POST /deliver/{uuid}` over HTTPS — it has no WebSocket client for talking to the relay at all. The wallet side already assumes the inbound-only model.

**This is not a serverless-specific difference.** `relay-old/` was built to an earlier spec revision (confirmed by `relay-old/plans/milestones/relay-phase-5-summary.md`'s test list, which documents `unused → active` / `active → consumed` transitions but nothing about inbound-only delivery or dropping the wallet bridge) and was simply never updated when the spec changed. This is the single largest and most consequential gap found.

**Files touched by this gap (verify each during Phase A, this list may be incomplete):**
- `relay-old/src/routes/ws.ts` — the entire bridge/`activePeers`/`WALLET_REJECTED` implementation
- `relay-old/src/utils/apps.ts` — `wallet_ws_url` field, validated as requiring a `ws://`/`wss://` scheme
- `relay-old/config/apps.json`, `relay-old/.env.example` — config using `wallet_ws_url`
- `relay-old/src/routes/register.ts`, `relay-old/src/routes/deliver.ts` — propagate `wallet_ws_url` into UUID/message records
- `relay-old/src/utils/storage/redis.ts` — `UuidRecord.wallet_ws_url`, `PendingMessage.wallet_url`, `DeleteJob.wallet_url` field naming
- Tests: `relay-old/tests/integration/websocket-bridge.test.ts`, `failure-cases.test.ts`, `push-delivery.test.ts`, `message-buffer.test.ts`, `relay-old/tests/unit/uuid-lifecycle.test.ts`

### Finding 2 — App registry field name/semantics: `wallet_ws_url` → `wallet_base_url`

Directly related to Finding 1, but worth tracking separately since it's a config-schema/documentation concern as much as a code one. `relay_data_model.md` §6.1 and `relay.md` §5 specify the app registry field as `wallet_base_url`, an `https://` base URL used **only** for staggered `DELETE {wallet_base_url}/messages/{uuid}` calls (`relay-old/src/utils/wallet_clearance.ts` already does the right thing with whatever URL it's given — `fetch(DELETE, \`${job.wallet_url}/messages/${job.uuid}\`)` — it's the *stored value* that's wrong, being a `ws://`/`wss://` URL instead of `https://`). Closing Finding 1 and Finding 2 together is likely more efficient than treating them as separate work items.

### Finding 3 — Docker/Compose deployment files were deleted

Per `plans/milestones/relay-serverless-docker-retirement-pending.md` ("Status: Executed 2026-07-03"), `relay-old/Dockerfile`, `relay-old/docker-compose.yml`, and `relay-old/docker-compose.dev.yml` were removed with the user's confirmation. Confirmed still absent as of this review. These will need to be restored (or rewritten, since requirements may have shifted — e.g. bundling Redis into the same Compose topology was always the design, so restoring from git history may just work) before `relay-old` can be a deployable default again.

### Finding 4 — `relay-old/README.md` and CI currently point away from `relay-old`

`relay-old/README.md` currently states "This codebase is superseded by `relay/`" and documents the code as reference-only. `.github/workflows/relay-deploy.yml` builds and deploys only `relay/` (Cloudflare Workers via `wrangler deploy`). Both will need to change as part of any actual cutover — tracked here so the follow-up execution plan doesn't discover them late, but the rewrite itself is a cutover step, not a spec-gap-analysis step (see Phase C).

---

## Phase A: Verify and close in-scope code gaps

Each step below is sized for independent execution (Claude, Haiku-tier agent is fine for verification/mechanical steps; steps that involve judgment calls on wire-format changes should be flagged back to the user if the "done when" can't be met cleanly).

**A.1 — Re-verify Finding 1 against current `relay-old/` code**
- **What:** Read `relay-old/src/routes/ws.ts` in full and confirm the outbound-bridge behavior described in Finding 1 still matches the current file (code may have moved since this plan was written). Grep `relay-old/` for `wallet_ws_url`, `walletSocket`, `WALLET_REJECTED`, `ws://`, `wss://` to get a complete, current file list (do not trust the list in Finding 1 as exhaustive/final).
- **Context:** `specs/object_specs/relay.md` §7.3 (inbound-only model, current text), `specs/object_specs/relay_data_model.md` error-code table (`WALLET_REJECTED` removal note).
- **Done when:** a confirmed, current file list is produced, with one line per file stating what in that file needs to change.

**A.2 — Rewrite `GET /ws/{uuid}` to the inbound-only delivery model**
- **What:** Replace `relay-old/src/routes/ws.ts`'s outbound-bridge logic with inbound-only delivery: on upgrade, validate the UUID (format → 4000, lookup → 4004, status → 4010 exactly as today), transition `unused → active`, and hold the connection open as a pure delivery channel. Remove `activePeers`, the outbound `WebSocket` client to the wallet, and the `WALLET_REJECTED`/4002 close code entirely (not in the current spec's close-code table). On `POST /deliver/{uuid}` for a UUID with an open WebSocket, the relay must forward the blob directly over that socket instead of falling through to push (mirrors the existing SSE-priority branch already present in `relay-old/src/routes/deliver.ts`, which checks `getSSEConnection` — an equivalent per-UUID WebSocket connection registry will be needed, analogous to `relay-old/src/utils/sse_connections.ts`). Frames sent by the device over this socket are ignored by the relay (delivery-only, per spec). On close/error, transition `active → consumed` (existing teardown logic in the current file already does this — keep it, strip only the wallet-bridge parts).
- **Context:** `specs/object_specs/relay.md` §7.3 (full current text — connection establishment, message flow, teardown, close codes), `relay-old/src/utils/sse_connections.ts` (existing pattern for a device-facing live-connection registry, to model the new per-UUID registry on), `relay-old/src/routes/deliver.ts` (existing SSE-priority delivery branch to extend with a WebSocket-priority branch — spec priority order is SSE, then WebSocket, then push, per relay.md §1).
- **Done when:** `relay-old/src/routes/ws.ts` contains no outbound `WebSocket` client, no `activePeers`, and no `WALLET_REJECTED`/4002 code path; `POST /deliver/{uuid}` delivers over an open per-UUID WebSocket before falling back to push; a new or updated integration test (`relay-old/tests/integration/websocket-bridge.test.ts`, likely renamed) exercises open → deliver → ack → close without ever expecting a wallet-side WebSocket server.

**A.3 — Rename and re-scope the app registry's wallet URL field**
- **What:** Rename `wallet_ws_url` → `wallet_base_url` throughout `relay-old/` (`src/utils/apps.ts`'s `AppConfig` interface and validation — must now require `https://`, not `ws://`/`wss://`; `src/routes/register.ts` and `src/routes/deliver.ts`'s propagation into `UuidRecord`; `src/utils/storage/redis.ts`'s `UuidRecord.wallet_ws_url` → `wallet_base_url` field, and reconcile with the already-correctly-named `PendingMessage.wallet_url`/`DeleteJob.wallet_url` fields — decide one consistent name and update whichever side doesn't match); `config/apps.json` and `.env.example`'s example value (`wss://wallet.example.com/ws` → an `https://` base URL, no `/ws` suffix).
- **Context:** `specs/object_specs/relay_data_model.md` §2.2, §6.1 (authoritative field name and semantics — `wallet_base_url`, `https://`, used only for staggered delete calls).
- **Done when:** no file under `relay-old/` (source, config, `.env.example`, tests) contains `wallet_ws_url` or a `ws://`/`wss://`-schemed wallet URL; `npm run typecheck` (or equivalent) and the existing test suite both pass under the new naming.

**A.4 — Update or replace the tests that assumed the wallet-bridge model**
- **What:** `relay-old/tests/integration/websocket-bridge.test.ts` currently spins up a stub *WebSocket* wallet server and asserts bridging behavior — this needs to become a test of inbound-only delivery (open WS, `POST /deliver` from a plain HTTP caller, assert the blob arrives on the open socket, assert device-sent frames are ignored, assert teardown transitions to `consumed`). `failure-cases.test.ts`, `push-delivery.test.ts`, `message-buffer.test.ts`, and `uuid-lifecycle.test.ts` should be grepped for `wallet_ws_url`/bridge assumptions and updated to the new field name/model as needed — some may need no change beyond the rename in A.3.
- **Context:** output of A.1's grep, the rewritten `relay-old/src/routes/ws.ts` from A.2.
- **Done when:** the full `relay-old` test suite passes with no references to a wallet-side WebSocket stub server remaining anywhere in the repo.

**A.5 — Sweep for any other gap not already captured above**
- **What:** With Findings 1–2 closed, do one more full read-through comparing `relay-old/src/` against the current `relay.md` (§5–§10) and `relay_data_model.md` (§2–§4, §6–§8) — specifically the sections *not* about Durable Objects, KV, or Cron (those are correctly out of scope per this plan's Scope section). Confirm: `POST /register` bootstrap/replenishment behavior (§7.1) matches; `POST /deliver/{uuid}` state machine and message-store keying (§7.2, §3) matches; `GET /sse` (§7.4) matches; `GET /pending` / `POST /ack` (§7.5–§7.6) matches; `GET /health` (§7.7) matches; `POST /notify/{uuid}` deprecation (§7.8) matches; error code table (§10 of relay.md) has no other stale/removed codes besides `WALLET_REJECTED`.
- **Context:** all of `relay.md` and `relay_data_model.md`, `relay-old/src/` in full.
- **Done when:** either no further gaps are found (state this explicitly in a short note), or any newly-found gap is written up in the same format as Findings 1–4 above and added to this plan before Phase B begins.

---

## Phase B: Revert the specs to describe the Docker architecture as authoritative

**Do this only after Phase A's findings are closed or explicitly deferred with user sign-off** — reverting the spec text first would make it describe a target `relay-old/` doesn't yet meet.

**B.1 — Revert `specs/object_specs/relay_data_model.md`**
- **What:** Version-bump and rewrite to describe: Redis (self-hosted, in Docker, persistence explicitly disabled) as the sole store for UUIDs/credentials/messages/delete-queue; SQLite (Docker volume) as the device registry; a process-startup scan (not Cron) for stuck-active reconciliation and empty-store detection; `setInterval`-based background jobs (not Cron) for delete-queue polling and device-registry pruning; drop §10 (Redis/DO authority split) entirely — there is one authoritative process again. Preserve any wording from the current v0.8 text that is a substantive correction rather than a serverless-infrastructure description (e.g. the `messages:{device_credential}` keying correction in current §3.1, which is a real bug-vs-spec correction unrelated to serverless — keep it). Restore the pre-migration environment variable table (`REDIS_URL`, `DB_PATH`, `PORT`, `DELETE_JOB_POLL_INTERVAL_MS`) in place of the Cloudflare-specific one.
- **Context:** current `relay_data_model.md` (v0.8), its own amendment history back to v0.4 (to identify which text is original vs. serverless-added), Phase A's closed findings (so the reverted spec matches what the code now actually does, including the `wallet_base_url` rename).
- **Done when:** the document describes a topology with exactly two stores (Redis, SQLite) and no Cloudflare-specific systems, reviewed and approved by the user (this is the authoritative spec, same bar as any other spec revision).

**B.2 — Revert `specs/object_specs/relay.md`**
- **What:** Version-bump and rewrite §7.3/§7.4 to drop the Durable-Object-backed connection model language (in-process `Map`-based tracking is correct again for a single Docker process) while **keeping the inbound-only delivery model itself** — that part of the v0.5+ text is a real behavior spec, not a serverless artifact (see Finding 1). Restore `wallet_base_url` as the app-registry field description if not already consistent. Update §9 (re-registration on store reset) to describe SQLite instead of KV.
- **Context:** current `relay.md` (v0.8) and its amendment history, Phase A's closed findings, `relay_data_model.md` after B.1.
- **Done when:** reviewed and approved by the user; no remaining reference to Durable Objects, Cloudflare KV, or Cloudflare Cron Triggers.

**B.3 — Update `specs/process_specs/notification_relay.md` only if needed**
- **What:** Check whether this process spec references any relay-side serverless detail (a quick grep suggests it does not — it's focused on wallet-service/device processes) — if it doesn't, no change is needed here; state that explicitly rather than editing speculatively.
- **Done when:** confirmed either "no change needed" (with the grep result noted) or a specific, justified edit is made.

---

## Phase C: Cutover (do not start without explicit user go-ahead — separate confirmation from this plan's approval)

This phase is listed for completeness so the follow-up execution plan has a map, but **each item requires its own explicit confirmation before acting**, per this project's existing Clarification Checkpoint convention (see `plans/relay-serverless-migration-implementation-plan.md`'s own Checkpoints, and `plans/milestones/relay-serverless-docker-retirement-pending.md`, which is exactly this kind of checkpoint in reverse).

- **C.1** Restore `relay-old/Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml` (from git history, then reconcile with any config changes from Phase A/B — e.g. `wallet_base_url`).
- **C.2** Rewrite `relay-old/README.md` to describe itself as the supported deployment path (inverse of what was done to `relay/README.md` during the Docker retirement).
- **C.3** Decide and execute the actual directory swap or rename (`relay` ↔ `relay-old`) — **show the exact file/directory operations planned and get explicit confirmation first**, per this session's standing instruction on destructive/hard-to-reverse actions.
- **C.4** Replace `.github/workflows/relay-deploy.yml`'s Cloudflare deploy job with a Docker build/deploy job (or retire it, if Docker deploys are handled elsewhere) — confirm target deployment infrastructure with the user before writing this, since it wasn't specified in this plan's scope.
- **C.5** Decide what happens to the `relay/` (serverless) codebase — archive, delete, or keep as a documented alternative — this is a product decision, not an engineering one, and needs explicit user input.

---

## Milestone reviews

Write a short summary to `plans/milestones/relay-old-restoration-phase-a-summary.md` (and `-phase-b-summary.md`) after each phase, matching this project's existing convention (see `plans/milestones/relay-serverless-phase-3-summary.md` for the expected format/tone).
