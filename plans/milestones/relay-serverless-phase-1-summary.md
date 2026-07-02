# Relay Serverless Migration — Phase 1 Milestone Summary

**Date:** 2026-07-02
**Status:** Complete, with one item explicitly deferred to the user (Redis Cloud provisioning) and several items honestly flagged as locally-validated-only pending a real Cloudflare account

---

## Summary

Phase 1 (Foundation & Validation Spike) is complete. A new `relay-next/` Nitro project builds cleanly under both the `cloudflare-module` and `node-server` presets from one codebase (1.1); a standalone Durable Object spike proves the one-DO-per-UUID connection shape works with the real Workers Hibernation API, surviving a 15-second idle period and correctly routing delivery calls to the right instance with strict per-UUID isolation, all validated locally via `wrangler dev`/Miniflare (1.2); a Redis Cloud provisioning checklist is written but no paid resources were created, per the plan's explicit checkpoint (1.3); and `specs/object_specs/relay.md` (v0.7) and `specs/object_specs/relay_data_model.md` (v0.5) are drafted to describe the target architecture in full, including a new data-model §10 that is the single authoritative statement of which system — Redis Cloud or Durable Objects — owns which piece of state (1.4). Two real ecosystem rough edges were found and documented rather than worked around: Nitro's built-in `cloudflare-durable` preset only supports one fixed Durable Object instance for the entire Worker, and the currently-published `crossws` package has dropped its Durable Object adapter's export path, so the spike talks to the Cloudflare Workers Hibernation API directly instead of through either of those layers. Nothing here has been deployed to a real Cloudflare account or a real Redis Cloud database — both remain to be confirmed before Phase 2 begins, and the spec drafts are pending the user's explicit review and approval, not yet final.

---

## Step-by-step results

### 1.1 — Scaffold Nitro project: Complete

- New sibling directory `relay-next/` (not `relay-serverless` or similar — checked the monorepo for an existing parallel-service naming convention first; found none, so used the plan's suggested default).
- `nitro.config.ts` configured with `preset: 'cloudflare-module'` — deliberately not the legacy `cloudflare`/`cloudflare-worker` alias, since Durable Objects extend the module-worker preset, not the legacy one. This distinction matters and is documented in the config file's own comments.
- `package.json` scripts follow the same `NITRO_PRESET` override convention already used by this repo's other Nitro app (`press/package.json`): `build:cloudflare` and `build:node`.
- **Verified:** `npm run build:cloudflare` (`NITRO_PRESET=cloudflare-module nitro build`) and `npm run build:node` (`NITRO_PRESET=node-server nitro build`) both succeed against a trivial `/api/health` stub route, from the same codebase, no per-preset code changes. The `node-server` build was additionally run (`node .output/server/index.mjs`) and its `/api/health` route was confirmed live via `curl`.
- Not yet verified: an actual `wrangler deploy` to a real Cloudflare account (no credentials in this sandbox — see "What still needs a real account" below).

### 1.2 — Spike: Durable Object + WebSocket Hibernation: Complete, with two documented ecosystem findings

Built in `relay-next/spike-do-ws/` as a standalone worker (see that directory's `README.md` for the full reasoning) rather than wired into the main Nitro route tree, because of two rough edges found while building it:

1. **Nitro's built-in `cloudflare-durable` preset (`nitropack@2.11+`, matching this repo's existing pin in `press/package.json`) hardcodes a single, fixed Durable Object instance name (`"server"`)**, with no config surface in this version to resolve a different instance per request. Every WebSocket upgrade routes to the same one DO for the whole Worker — it cannot address one DO per UUID out of the box. This preset is explicitly labeled experimental upstream (the PR that introduced it, nitrojs/nitro#2801, says "Not documenting yet to experiment") and does not appear at all in the current published Nitro docs' Cloudflare provider page.
2. **The currently-published `crossws@0.4.8` has dropped `"./adapters/cloudflare-durable"` from its package.json `exports` map** (the compiled files are still physically present in the npm tarball but are no longer importable through the public export surface), while `nitropack`'s own pinned `crossws@^0.3.5` (a nested, transitive copy) still exports it. A fresh `npm install crossws` at the project's top level and then importing `crossws/adapters/cloudflare-durable` fails to resolve — a genuine version-skew trap for anyone reaching for that adapter directly instead of through Nitro's preset.

Given both, the spike bypasses both layers and talks to the raw Cloudflare Workers Hibernation API directly (`this.ctx.acceptWebSocket`, `this.ctx.getWebSockets`, `WebSocket.serializeAttachment`/`deserializeAttachment`) in a hand-written Durable Object class, with a hand-written Worker entry point doing `idFromName(uuid)` per request. This is exactly the kind of Nitro/DO/WebSocket rough edge the plan asked to be escalated rather than silently hacked past — both findings are written up in `relay-next/spike-do-ws/README.md` and are being surfaced here for a go/no-go read before Phase 2 starts building the real connection layer against this pattern.

**What was validated locally (via `wrangler dev --local`, Miniflare's real `workerd` runtime, not a mock):**
- A Durable Object instance addressed by an arbitrary key (`idFromName(uuid)`), not a single shared instance, accepts a WebSocket via the Hibernation API.
- The connection survives a **15-second** idle period with zero client-side keepalive traffic (plan required >10s) — confirmed via `GET /status/{uuid}` reporting the socket still open before and after the idle window.
- A separate HTTP request (`POST /deliver/{uuid}`), issued after the idle window, correctly resolves to the **same** Durable Object instance and delivers a message into the still-open socket — the device client received it.
- Strict per-UUID isolation: two concurrent connections on different UUIDs never cross-deliver, and a delivery call for a UUID with no open connection correctly returns 404 rather than silently succeeding or hitting the wrong instance.
- No Durable Object storage writes anywhere in the spike code — all state is in-memory instance fields or `serializeAttachment`, both RAM-only, consistent with the relay's non-negotiable privacy invariant even at spike-code quality.
- One sandbox-specific (not Cloudflare-specific) issue was hit and resolved: Miniflare's local DO simulation backs SQLite-based DO storage with real files under `.wrangler/state` by default, which failed with a `SQLITE_IOERR` on this sandbox's mounted filesystem. Worked around with `--persist-to /tmp`. This is an artifact of the sandbox environment this work was done in, not a Cloudflare or Nitro issue, and would not be expected to recur on a normal developer machine or in CI.

**What still needs a real Cloudflare account to confirm (explicitly not claimed as validated here):**
- True hibernation-eviction timing under Cloudflare's actual production infrastructure. Miniflare simulates the Hibernation API's contract (accept, survive idle, wake on message) but does not — and cannot — reproduce Cloudflare's real eviction scheduler, which is what actually determines when a DO's JS context is torn down and billing stops accruing. The 15-second local test proves the API behaves correctly across an idle window; it does not prove anything about real eviction timing or cost.
- Multi-colo / cross-region behavior (a single `wrangler dev` process is one simulated location).
- Actual cost/billing behavior under hibernation versus the current Node/`ws` baseline (strategic-plan.md Goal 2's load-test target is unaddressed by this spike; that's explicitly a later-phase item, not claimed here).
- Whether the single-instance limitation in Nitro's built-in preset has been addressed in a version newer than what's pinned here, or whether the maintainers' stated intent to "reiterate with another method of enabling durable for workers" (per pi0's comment on PR #2801) has shipped — worth re-checking immediately before Phase 2 begins, since it could change whether Phase 2 needs the hand-rolled-worker-entry approach this spike used or can use an upstream-native alternative instead.

### 1.3 — Redis Cloud provisioning: Checklist written, nothing provisioned

Per the plan's explicit clarification checkpoint ("before provisioning any paid Redis Cloud database or Cloudflare resource that incurs cost, confirm plan/tier with the user"), **no paid resources were created.** `relay-next/PROVISIONING.md` documents exactly what needs to be provisioned: two Redis Cloud databases (primary with RDB and AOF both explicitly disabled, secondary with persistence enabled for the device registry), TLS enabled and enforced on both, connection strings stored as secrets and never committed, plus the specific `CONFIG GET save`/`CONFIG GET appendonly` verification steps to run once the primary database exists. This is written to be accurate and complete enough to fold directly into the Phase 3 README without rework, but it is a checklist for the user's account/billing action, not a completed step.

### 1.4 — Spec updates: Drafted, not yet reviewed or approved

`specs/object_specs/relay.md` (v0.6 → v0.7) and `specs/object_specs/relay_data_model.md` (v0.4 → v0.5) are updated to describe the target serverless architecture, following this repo's `Amends: v0.X` convention (per `specs/key_rotation.md`). Key additions:

- A new `relay_data_model.md` §10, "Authority Split: Redis Cloud vs. Durable Objects" — the single authoritative statement of which system owns which piece of state, and exactly how a UUID's `active` status in Redis and a Durable Object's live-connection knowledge stay consistent (including the bounded-staleness case where a DO is evicted before its close handler runs, and why the reconciliation scan is the correctness backstop for that case, not a "this should never happen" assumption).
- A new topology diagram in `relay_data_model.md` §1.1 replacing the Docker Compose diagram that lived in `plans/relay-strategic-plan.md`.
- An explicit false-positive guard added to the empty-primary-database detection logic (`relay_data_model.md` §2.6): under the old single-process-startup model this check only ever ran once, but under a periodic Cron Trigger it will otherwise fire spuriously every time the primary database happens to be momentarily empty during a quiet period, which is a real bug this review caught rather than left implicit.
- `plans/relay-strategic-plan.md`'s "Why not serverless?" row in its Resolved Questions table is marked superseded, pointing to `plans/relay-serverless-migration-strategic-plan.md`.

**These are drafts.** Per the implementation plan's own "done when" criterion for step 1.4, this step is not actually complete until the specs are "reviewed and approved by the user," not merely drafted — that review has not yet happened. Phase 2 should not begin against these documents until that review occurs; treating them as final before then would violate the same plan's Phase 2 gating requirement.

---

## Overall Phase 1 status against the plan's "done when" criteria

| Criterion (from the implementation plan's Phase 1 milestone review) | Status |
|---|---|
| Both presets build cleanly | Done, verified locally |
| DO+WS spike confirmed working, or blocking issue escalated | Confirmed working locally; two non-blocking-but-worth-reviewing ecosystem findings escalated above and in `spike-do-ws/README.md` |
| Persistence-disabled verified on the primary Redis Cloud database | **Not done** — no Redis Cloud database exists yet; this requires the user's provisioning action first (see 1.3) |
| Spec updates from 1.4 reviewed and approved | **Not done** — drafted only; awaiting user review |
| One-paragraph summary written | This document |

---

## Recommended next steps before Phase 2

1. User reviews and either approves or requests changes to the `relay.md` v0.7 and `relay_data_model.md` v0.5 drafts.
2. User decides on Redis Cloud plan/tier and provisions both databases per `relay-next/PROVISIONING.md`; the `CONFIG GET save`/`appendonly` verification in that checklist should be run before Phase 2 code is written against it.
3. Before Phase 2 builds the real connection layer: re-check whether Nitro's `cloudflare-durable` preset has gained per-instance DO addressing support, or whether the plan should proceed with the hand-rolled-worker-entry pattern this spike used as the permanent approach. This is a real fork in how much of Phase 2's connection-layer code ends up looking like idiomatic Nitro versus custom Worker code, and is worth a deliberate decision rather than defaulting into it.
4. If a real Cloudflare account becomes available before Phase 2 starts, re-run this spike's test sequence against an actual deployed Worker (not just `wrangler dev`) to get a real signal on eviction timing, at minimum as a sanity check before committing to the connection-layer design in Phase 2.
