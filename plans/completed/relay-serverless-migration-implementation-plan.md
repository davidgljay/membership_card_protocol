# Relay Serverless Migration — Implementation Plan

**Companion document:** [relay-serverless-migration-strategic-plan.md](./relay-serverless-migration-strategic-plan.md)
**Date:** 2026-07-02
**Status:** Draft

---

## Decisions carried in from the strategic plan's open questions

| # | Question | Resolution |
|---|---|---|
| 1 | SSE scope | Both `GET /sse` and `GET /ws/{uuid}` are Durable-Object-backed: one DO per `device_credential` for SSE, one per UUID for WS. |
| 2 | Device registry location | **Revised 2026-07-02, superseding the original answer below.** Cloudflare KV, accessed via Nitro's `storage()` abstraction — not a second Redis Cloud database. Reason: the free Redis Cloud tier used for test deployment disables persistence by default, which is exactly wrong for this store, and there was no technical requirement that it specifically be Redis (the original answer's rationale was "reuse the same client/Lua infrastructure," not a property only Redis has). KV's native per-key TTL also removes the need for the separate weekly pruning job. See `relay_data_model.md` v0.6 §1, §5 for the full comparison. ~~Original answer: a second Redis Cloud database, persistence ON, separate from the primary (persistence-off) UUID/message store.~~ |
| 3 | Delete queue / pruning job | Business logic stays Redis-based and portable. **Clarification:** the *trigger* that invokes this logic on a schedule is necessarily platform-native (Cloudflare Cron Trigger vs. a Node interval) — this is the smallest platform-specific surface consistent with the intent behind this answer, not a violation of it. |
| 4 | Push dispatch client | **Resolved 2026-07-02.** In-house, minimal HTTP/2 JWT-based APNs client and minimal FCM HTTP v1 client, running in the Workers runtime — no third-party push package. Consistent with the original relay plan's thin-dependency-tree rationale. |
| 5 | Cutover scope | Full cutover — Docker/Compose deployment is retired once the new architecture is validated. |
| 6 | Cutover mechanics | **Resolved — moot.** The relay has never been deployed to production, so there is no live traffic or existing deployment to cut over from. This is the relay's first production deployment, not a migration of one. No canary, blue-green, or rollback rehearsal is warranted — the ordinary staging validation already built into Phases 1 and 2 (spike validation in 1.4/1.5, full end-to-end test pass in 2.7) is sufficient before going live. |

---

## Phase 1: Foundation & Validation Spike

**Goal:** de-risk the two biggest unknowns — Nitro + Durable Object WebSocket integration, and Redis Cloud persistence-off configuration — before committing to the full build.

**1.1 — Scaffold the Nitro project with both target presets**
- **What:** Create the new Nitro-based relay codebase with `cloudflare` and `node-server` presets configured. A trivial route (e.g. `/health` stub) should build and run under both.
- **Who:** Claude / engineer
- **Context:** `relay-old/package.json` (current dependency list, for reference only — not carried over wholesale), Nitro deploy docs for the `cloudflare` and `node-server` presets, decision: Nitro chosen for portability (strategic-plan.md Goal 3)
- **Done when:** `nitro build --preset cloudflare` and `nitro build --preset node-server` both succeed in CI from a single codebase, committed as the starting point for this migration.

**1.2 — Spike: Durable Object + WebSocket Hibernation via Nitro/crossws**
- **What:** Build a minimal Durable-Object-backed WebSocket echo endpoint through Nitro's `crossws` Cloudflare adapter. Deploy to a Cloudflare preview environment. Confirm it survives hibernation and that an external HTTP call can route a message to the correct DO instance by ID.
- **Who:** Claude / engineer
- **Context:** `relay-old/src/routes/ws.ts` (current bridge logic, for later porting), Cloudflare Durable Objects WebSocket Hibernation docs, Nitro `crossws` Cloudflare adapter docs, known open issue `nitrojs/nitro#2436` (DO pub/sub + WS rough edges)
- **Done when:** the spike endpoint accepts a connection, survives a manually-triggered idle period (>10s) without disconnecting the client, and correctly receives a routed message post-hibernation. **If this spike surfaces a blocking issue, stop — see Clarification Checkpoints.**

**1.3 — Provision the primary Redis Cloud database and the Cloudflare KV device-registry namespace**
- **What:** Provision one Redis Cloud database (persistence OFF — both RDB and AOF disabled) for UUID/credential/message/delete-queue state, and one Cloudflare KV namespace for the device registry (durable by platform default — no persistence configuration needed). **Revised 2026-07-02:** originally this step provisioned two Redis Cloud databases; the device registry moved to Cloudflare KV (decision #2, revised).
- **Who:** User (account/billing action), Claude documents each step as it happens for reuse in the README (Phase 3.1)
- **Context:** `relay/PROVISIONING.md` (exact checklist, updated for the KV-based design), decision #2 (revised — Cloudflare KV device registry)
- **Done when:** the primary database is provisioned with TLS enabled/enforced and a connection string stored as a secret (never committed), a manual connection test confirms `CONFIG GET save` / `CONFIG GET appendonly` show disabled, the KV namespace is created and bound in `wrangler.toml`, and a manual `wrangler kv key put`/`get` test confirms it's reachable.

**1.4 — Update `relay.md` and `relay_data_model.md` to reflect the new architecture**
- **What:** Revise `specs/object_specs/relay.md` (version bump with changelog note, per the project's existing convention) and `specs/object_specs/relay_data_model.md` to describe the new authoritative design: the two-Redis-Cloud-database split and exactly which data lives in which one, how UUID and session state is divided between Redis-held status and Durable-Object-held live connections (and how the two stay consistent — this needs to be a specced interaction, not an implementation detail left implicit), the Durable-Object-backed connection model replacing the in-process `Map`-based description of WS/SSE handling, and a replacement for the Docker Compose topology diagram. Also mark the "Why not serverless?" row in `relay-strategic-plan.md`'s Resolved Questions table as superseded, pointing to this migration's strategic plan — consistent with how `key_rotation.md` documents amendments (`Amends: v0.1`).
- **Who:** Claude, reviewed and approved by the user — this is the authoritative spec, not an internal planning document, so it needs the same sign-off any other spec revision gets.
- **Context:** `specs/object_specs/relay.md` (current, v0.6), `specs/object_specs/relay_data_model.md` (current), the Phase 1.2 spike results (the spec should describe what was actually validated as working, not the originally-hoped-for design if the spike revealed a different shape), decisions #1–#3 from this migration's strategic plan, `plans/relay-strategic-plan.md` (row to mark superseded)
- **Done when:** both spec documents are updated and version-bumped with changelog notes, reviewed and approved by the user, and — matching this project's own bar from `relay-strategic-plan.md` Goal 3 — no engineering decision about the storage or connection model remains open or implicit in the spec text. **Phase 2 is gated on this step being complete**, since its steps build against the updated spec, not just against the old code.

**1.5 — Phase 1 Milestone Review**
- **Context needed:** build logs from 1.1, spike deployment and results from 1.2, Redis Cloud provisioning confirmation from 1.3, updated and approved specs from 1.4
- **Done when:** both presets build cleanly, the DO+WS spike is confirmed working (or a blocking issue has been escalated to the user for a go/no-go decision), persistence-disabled is verified on the primary Redis Cloud database, the spec updates from 1.4 are reviewed and approved (not just drafted), and a one-paragraph summary is written to `plans/milestones/relay-serverless-phase-1-summary.md`.

---

## Phase 2: Core Build

**Goal:** implement the relay against the spec updated in step 1.4, using the current codebase as implementation reference — not the other way around. If anything in Phase 2 requires a decision the updated spec doesn't already answer, that's a sign step 1.4 wasn't actually complete; stop and amend the spec rather than deciding it ad hoc in code.

**2.1 — Port the primary storage layer (UUID pool, credentials, messages, delete queue)**
- **What:** Reimplement `utils/storage/redis.ts`'s functionality against the primary Redis Cloud database, reachable via Workers' `connect()` TCP socket API with TLS (or Nitro's `unstorage` Redis driver, whichever proves more reliable in the Phase 1 spike). UUID CAS transition logic can simplify significantly for connection-bound states now that Durable Objects own that atomicity — retain the Lua-script approach only for the parts of the state machine that remain outside a DO's control (e.g. `unused → in_flight → consumed` during `/deliver`, which is a plain HTTP handler, not DO-backed).
- **Who:** Claude / engineer
- **Context:** `specs/object_specs/relay_data_model.md` **as updated in step 1.4** (authoritative for the key schema and state-ownership split), `relay-old/src/utils/storage/redis.ts` (current implementation, reference only), decision #2 (two databases)
- **Done when:** unit tests ported from `relay-old/tests/unit` pass against both a local dev Redis and the Redis Cloud staging database, a test confirms plaintext (non-TLS) connection attempts are rejected, and the implementation matches the updated spec's description of which system owns which state transition.

**2.2 — Port the durable device registry**
- **What:** Reimplement `utils/storage/sqlite.ts`'s schema and queries (`upsertDevice`, `getRecentDevices`, `pruneOldDevices`) against Cloudflare KV via Nitro's `storage()` abstraction. **Revised 2026-07-02:** target store changed from a second Redis Cloud database to Cloudflare KV (decision #2, revised) — `pruneOldDevices` is deleted rather than ported, since KV's native per-key TTL (`relay_data_model.md` §5.3) replaces it entirely.
- **Who:** Claude / engineer
- **Context:** `specs/object_specs/relay_data_model.md` v0.6 §5 **as updated in step 1.4**, `relay-old/src/utils/storage/sqlite.ts` (current implementation, reference only), `relay-old/src/utils/reregistration.ts` (`pruning.ts` is reference-only for the retention threshold, not for porting the scan logic itself)
- **Done when:** equivalent functions pass unit tests against Cloudflare KV (or an unstorage filesystem/in-memory driver under `node-server` for local dev), a test confirms entries expire per their TTL rather than being manually pruned, and the re-registration-on-store-reset flow (`relay.md` §9, as updated) still functions correctly using this store to find current devices via `storage.getKeys()`.

**2.3 — Port stateless HTTP handlers**
- **What:** Reimplement `register`, `deliver`, `pending`, `ack`, and `health` as Nitro route handlers with no Cloudflare-specific code paths.
- **Who:** Claude / engineer
- **Context:** `relay-old/src/routes/{register,deliver,pending,health}.ts`, `relay-old/src/utils/http.ts`, `relay-old/src/utils/apps.ts`
- **Done when:** all five handlers pass integration test equivalents of the current test suite, running under the Nitro `node-server` preset locally (proving the portability claim, not just a Cloudflare deploy).

**2.4 — Build the Durable-Object-backed connection layer**
- **What:** Implement a Durable Object class for `/ws/{uuid}` (WebSocket Hibernation) and a Durable Object class for the SSE-equivalent device-level channel, keyed by `device_credential`. Wire `/deliver/{uuid}` to check for an open connection on the relevant DO before falling back to push.
- **Who:** Claude / engineer
- **Context:** `specs/object_specs/relay.md` **as updated in step 1.4** (authoritative for connection/delivery behavior), `relay-old/src/routes/ws.ts`, `relay-old/src/routes/sse.ts`, `relay-old/src/utils/sse_connections.ts` (current implementation, reference only), Phase 1.2 spike code, decision #1 (SSE is DO-backed)
- **Done when:** both connection types are Durable-Object-backed and addressed correctly, UUID/session state transitions execute as plain sequential code inside the DO, and integration tests confirm `/deliver/{uuid}` routes correctly to an open WS or SSE connection when one exists and falls back to push when none does.

**2.5 — Port push dispatch (APNs/FCM)**
- **What:** Reimplement APNs and FCM dispatch to run in the Cloudflare Workers runtime, as an in-house HTTP/2 JWT-based APNs client and minimal FCM HTTP v1 client (decision #4, resolved).
- **Who:** Claude / engineer
- **Context:** `relay-old/src/utils/push/{apns,fcm,dispatch}.ts`, decision #4 (resolved — in-house client)
- **Done when:** APNs and FCM dispatch both work from the Workers runtime against sandbox/test credentials, and the APNs client's JWT-signing and HTTP/2 framing are unit tested independently of live network calls.

**2.6 — Port the delete queue**
- **What:** Reimplement the staggered wallet-clearance delete queue as Redis-backed logic, invoked by a platform-native scheduler (Cloudflare Cron Trigger in production; a local interval for Node-preset development). **Revised 2026-07-02:** device-registry pruning is dropped from this step's scope — it's no longer a separate job (see step 2.2); Cloudflare KV's native TTL handles it with no invoked logic to port.
- **Who:** Claude / engineer
- **Context:** `relay-old/src/utils/wallet_clearance.ts`, decision #3 (portable logic, platform-native trigger)
- **Done when:** the same Redis-backed delete-queue logic runs correctly whether invoked by a Cloudflare Cron Trigger (staging) or a local interval (Node preset dev), with identical behavior in both cases.

**2.7 — Audit `wallet-service/` against `notification_relay.md` v0.8**
- **What:** During the spec review that produced this plan's earlier revisions, `specs/process_specs/notification_relay.md` was updated to v0.8 to close a real gap: `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` (the wallet-service endpoint that registers a device's UUID pool for a subcard) previously accepted a bare `{ uuids: [...] }` body with no proof that the caller controls the subcard's private key. v0.8 requires a signed envelope (`card_hash`, `subcard_hash`, `uuids`, `timestamp`, `nonce`, ML-DSA-44 signature) verified against the subcard's on-chain public key, and restates that registrations must remain per-card, separate, staggered sessions (§Registration Privacy) rather than batched across cards. Spin up a subagent to audit the existing `wallet-service/` implementation against this spec and report — not implement fixes, unless separately instructed — whether: (a) UUID registration currently accepts unsigned requests (the pre-v0.8 gap), (b) if so, whether fixing it belongs in this plan's scope or is a separate `wallet-service` workstream, (c) anything else in `notification_relay.md` v0.8 the current implementation doesn't yet reflect.
- **Who:** Claude (subagent) — **not run now; scheduled for execution during Phase 2**, per explicit instruction.
- **Context:** `specs/process_specs/notification_relay.md` v0.8 (§Process 1 "Wallet registration," §Registration Privacy), `wallet-service/` implementation directory, `specs/process_specs/subcard_creation_policy.md` (for how the wallet should resolve/verify a subcard's on-chain public key — needed to judge whether any existing signature-verification logic checks against the right source of truth).
- **Done when:** a written report exists (chat or a short note, Claude's judgment) covering (a)–(c) above. This is an audit step — it does not block relay's own Phase 2 work, but its findings should be reflected in the Phase 2 milestone review (2.8) rather than left to surface later.

**2.8 — Phase 2 Milestone Review**
- **Context needed:** outputs of 2.1–2.6, the audit report from 2.7, strategic-plan.md Goals 1–3, decision #4 confirmation status, `specs/object_specs/relay.md` and `relay_data_model.md` as updated in 1.4
- **Done when:** all components are checked for consistency (e.g., the DO connection layer and storage layer agree on UUID lifecycle semantics), the implementation matches the updated spec rather than having quietly diverged from it during coding (if it diverged, amend the spec now and get it re-approved — don't let code and spec disagree silently), the push-dispatch client assumption from 2.5 has been explicitly confirmed with the user (not left as an assumption), the 2.7 audit report has been reviewed and any follow-up work it identifies has been triaged (fixed now, or explicitly deferred with the user's sign-off), the full test suite passes end-to-end against a staging Redis Cloud + Cloudflare preview deployment, and a summary is written to `plans/milestones/relay-serverless-phase-2-summary.md`.

---

## Phase 3: Documentation & CI/CD

**Goal:** make the new deployment auditable and repeatable, then retire the old one.

**3.1 — Write the README**
- **What:** Document Redis Cloud provisioning (the primary database, persistence settings, TLS enforcement, connection string format), Cloudflare provisioning (Workers/DO bindings, the KV namespace binding for the device registry, `wrangler` config, required secrets, custom domain steps if applicable), local development instructions (Node preset), and a troubleshooting section covering any DO+WS integration issues found in Phase 1.
- **Who:** Claude, reviewed by user
- **Context:** strategic-plan.md Goal 4, exact steps taken in 1.3 (Redis + KV provisioning), full secrets/env inventory from Phase 2
- **Done when:** the README, followed from a clean checkout, gets someone to a working deployment without needing to ask a question the document doesn't already answer.

**3.2 — Write the GitHub Actions deployment workflow**
- **What:** A workflow that triggers on push to the production branch, runs the full test suite first (blocking deploy on failure), validates that required secrets (the Redis Cloud connection string, Cloudflare API token, APNs/FCM credentials) are present and fails loudly if any are missing — the KV namespace binding is not a secret and is validated by `wrangler.toml` being present/correct, not by secret-presence checks — and deploys via `wrangler deploy` (or Nitro's Cloudflare deploy path) only after tests and secret validation pass.
- **Who:** Claude / engineer
- **Context:** README from 3.1 (secrets/env inventory must match exactly), decision #5 (full cutover — no dual deployment path to maintain in CI)
- **Done when:** a deliberate test with a missing secret causes the workflow to fail clearly and early, and a normal push with all secrets present deploys successfully.

**3.3 — Retire the Docker/Compose deployment path**
- **What:** This is not a live cutover — the Docker/Compose path was built but never deployed to production, so there's no traffic to drain or fallback to preserve. Once Phase 2's milestone review confirms the Nitro/Durable-Object/Redis-Cloud architecture is complete and tested, remove the Docker/Compose files and self-hosted Redis container from the codebase's active path.
- **Who:** Claude, with explicit user confirmation before deletion
- **Context:** `relay-old/docker-compose.yml`, `relay-old/Dockerfile`, decision #5 (full cutover), decision #6 (no live deployment — nothing to migrate)
- **Done when:** the files are removed from the active path (preserved in git history, not deleted from history), and the README no longer references Docker/Compose as a supported deployment path.

**3.4 — Phase 3 Milestone Review / Final Review**
- **Context needed:** outputs of 3.1–3.3, all prior milestone summaries
- **Done when:** the README has been followed end-to-end by someone other than its author without hitting an undocumented step, the CI workflow's missing-secret failure case has been tested, and a final summary is written to `plans/milestones/relay-serverless-phase-3-summary.md`.

---

## Clarification Checkpoints

- **Phase 1.2 spike outcome:** if the Nitro/crossws/Durable-Object integration surfaces a blocking issue, stop before Phase 2 begins. A fallback (a Workers-native implementation for the connection layer specifically, bypassing Nitro for that piece) would change the scope of strategic-plan.md Goal 3 and needs explicit user sign-off.
- **Paid resource provisioning:** before provisioning any paid Redis Cloud database or Cloudflare resource that incurs cost, confirm plan/tier with the user.
- **Before deleting the Docker/Compose files (3.3):** show the user the exact file list and get explicit confirmation before removal.
- **Time overrun:** if Phase 2 (core build) implementation exceeds roughly 3x this plan's estimated engineering time, pause and check in rather than continuing to push through.
