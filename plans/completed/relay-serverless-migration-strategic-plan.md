# Relay Serverless Migration — Strategic Plan

**Date:** 2026-07-02
**Status:** Draft — open questions pending
**Companion document:** [relay-serverless-migration-implementation-plan.md](./relay-serverless-migration-implementation-plan.md)
**Supersedes:** The "Why not serverless?" resolution in [relay-strategic-plan.md](./relay-strategic-plan.md) ("WebSocket connections require a long-running process; Lambda/Workers cannot support them"). That conclusion was correct for Workers alone but did not account for Cloudflare Durable Objects with the WebSocket Hibernation API, which is designed for exactly this connection shape.

---

## Context

The current relay (`relay-old/`) is a plain Node.js service (`node:http` + `ws`) built to deploy via Docker Compose alongside a self-hosted Redis container (persistence explicitly disabled) and a SQLite volume for the device registry — but **the relay has not yet been deployed to production**. This is a pre-launch architecture decision, not a live migration: there is no existing traffic or deployment to cut over from, which materially simplifies the implementation plan's rollout approach (see that document's decision #6). This plan replaces the Docker-based design with:

- **Durable Objects** for the live WebSocket bridging layer (`GET /ws/{uuid}`)
- **Redis Cloud** (persistence explicitly disabled) for the privacy-critical UUID-association and message-buffer state
- **Nitro** as the application framework, chosen specifically to keep the stateless HTTP-handler and storage-access code portable across compute targets rather than hard-coded to Cloudflare's APIs

This was arrived at over several rounds of prior discussion: Durable Objects fit the connection shape of this service well, but Durable Object storage (SQLite-backed, disk-resident, point-in-time recovery on by default) directly conflicts with the relay's foundational privacy invariant — UUID↔device associations must never be durably recoverable, verified today via Redis started with `--save "" --appendonly no`. Redis Cloud, with persistence explicitly disabled (unlike Upstash, which always persists regardless of configuration), preserves that invariant while removing the need to operate Redis yourselves.

---

## Goals

### 1. Remove the operational burden of self-hosting Redis and the relay container, without weakening the core privacy invariant

Running and patching two long-lived containers plus a persistent volume is ongoing work, and every self-managed piece of infrastructure is one more thing that must be kept current on security patches. But the "never durably recoverable" invariant is non-negotiable — it's the reason serverless was rejected the first time around. This migration is only worth doing if it removes operational burden *and* keeps that invariant intact.

### 2. Fit the WebSocket-bridging layer to Durable Objects' hibernation model

`GET /ws/{uuid}` is a long-lived, per-UUID, low-traffic connection — the shape Durable Objects with WebSocket Hibernation were built for. It also replaces the current Lua-script CAS hack for atomic UUID-state transitions with ordinary sequential code, since a Durable Object instance is single-threaded. As of relay spec v0.5+, the relay no longer proxies to an outbound wallet WebSocket (that was removed — see `relay.md` v0.6 §7.3), so the Durable Object's job is simpler than the current code: hold the device connection, receive delivery calls routed to it, nothing else.

### 3. Keep the stateless layer portable across compute providers via Nitro

Nitro genuinely supports deploying one codebase to Node, Cloudflare Workers, Deno, Bun, and other targets, with a storage abstraction (`unstorage`) that presents one API across Redis, Cloudflare KV, memory, and other backends. This is real portability for the HTTP-handler and storage-access code. It is **not** full portability for the WebSocket-bridging layer — Durable Objects are a Cloudflare-only primitive, and Nitro's cross-platform WebSocket support (`crossws`) doesn't make DO-specific stateful coordination available on other runtimes. This plan treats "ease of switching platforms" as applying asymmetrically: strong for the HTTP/storage layer, weak-to-absent for the DO-backed connection layer, and says so plainly rather than overselling it.

### 4. Make deployment auditable and repeatable

A protocol built around minimizing trust in any single party loses credibility if its own deployment process is undocumented or manual. A README covering both Redis Cloud and Cloudflare configuration, plus a CI/CD workflow with explicit, reviewable configuration, makes the operational security posture something a third party — or a future team member — can verify rather than take on faith.

---

## Rationale

The two prior architecture conversations that feed this plan established:

- **Why Durable Objects fit the connection layer:** WebSocket Hibernation is purpose-built for many long-lived, low-traffic, individually-addressable connections. This maps directly onto one Durable Object per UUID, replacing the in-memory `activePeers` Map in `relay-old/src/routes/ws.ts` and the `TRANSITION_SCRIPT` Lua CAS script in `relay-old/src/utils/storage/redis.ts`.
- **Why Durable Object *storage* is the wrong place for UUID associations:** SQLite-backed Durable Object storage is disk-resident with point-in-time recovery on by default (30-day window) — the opposite of the RAM-only guarantee the relay's privacy model depends on. Keeping UUID-association state purely in a Durable Object's in-memory fields avoids this, but in-memory state is discarded on hibernation/eviction, and Cloudflare evicts idle objects on a timescale of minutes — far short of the 30-day TTL an unused UUID needs to survive. This rules out using Durable Objects for the UUID *pool* itself.
- **Why Redis Cloud, specifically:** Upstash (the Redis product most associated with the Workers ecosystem) always persists to disk regardless of settings, which disqualifies it outright. Redis Cloud supports disabling both RDB snapshots and AOF for a genuine in-memory-only mode, which is the closest match to the self-hosted setup's guarantee.
- **Why Nitro:** it avoids hard-coding the relay's stateless logic to Cloudflare-specific APIs, so a future move off Cloudflare (for cost, policy, or reliability reasons) doesn't require rewriting the parts of the system that don't inherently need Cloudflare. This benefit does not extend to the Durable-Object-backed connection layer, which is Cloudflare-specific by construction — the plan should not imply the whole relay becomes platform-agnostic.

**A note on device registry data.** The current SQLite device registry (`push_token`, `app_id`, `last_registered_at`) is *deliberately* durable — its entire purpose is to survive a Redis reset so the relay can trigger re-registration (`relay.md` §9). It cannot move into the same RAM-only Redis Cloud database without defeating that purpose; it needs its own decision (see Open Questions).

---

## Key Objectives

**Goal 1 — Remove operational burden, preserve the invariant**
- Redis Cloud database provisioned with both RDB and AOF explicitly disabled, verified via the provider console/API and documented in the README.
- No component of the new architecture writes UUID-association records to any disk-backed store (Cloudflare KV, D1, or Durable Object storage), confirmed by architecture review before first production deploy.
- Zero self-hosted Docker containers required to run the relay in production.

**Goal 2 — Fit WebSocket bridging to Durable Objects**
- Each open `/ws/{uuid}` connection is backed by exactly one Durable Object instance addressed by UUID, using the Hibernation API so billable duration stops accruing while idle.
- UUID state transitions (`unused → active → consumed`) execute as ordinary sequential code inside the Durable Object, with no CAS or locking logic required.
- A load test confirms connection-handling behavior and cost are within an acceptable range of the current Node/`ws` baseline (target to be set in the implementation plan).

**Goal 3 — Keep the stateless layer portable via Nitro**
- The `register` / `deliver` / `pending` / `ack` / `health` handlers and the Redis Cloud data-access layer run unmodified under both the Nitro `cloudflare` preset and the Nitro `node-server` preset, verified by a Node-target smoke test in CI (not just a Cloudflare deploy).
- The connection-registry interface used by the WS layer is defined behind a single abstraction with a documented Durable-Object-backed implementation for Cloudflare, so the portability gap for this layer is explicit in code, not silently broken.
- The Nitro + `crossws` + Durable Objects integration is validated against the relay's actual `/ws/{uuid}` flow in a spike before the full migration is built, given open issues in the Nitro project around Durable Object WebSocket support as of this writing.

**Goal 4 — Auditable, repeatable deployment**
- README documents, step by step, how to provision a Redis Cloud database with persistence disabled and wire its connection string into the deployment, and how to provision the Cloudflare Workers/Durable Objects deployment (bindings, secrets, custom domain if applicable).
- A GitHub Actions workflow deploys to Cloudflare on push to the relevant branch(es), runs the test suite first, and fails the deploy rather than proceeding with missing required secrets or environment variables.
- Someone unfamiliar with the project can follow the README from a clean checkout and reach a working deployment without needing to ask questions the document doesn't already answer.

---

## Open Questions

| # | Question |
|---|---|
| 1 | **Scope of "Durable Objects for WebSocket connections."** Does this include the SSE delivery channel (`GET /sse`), which today lives in an in-memory `Map` (`sse_connections.ts`) and needs the same "which device is currently reachable" coordination that `/ws/{uuid}` needs? Recommend deciding between: (a) both WS and SSE connections are Durable-Object-backed (one per UUID for WS, one per `device_credential` for SSE), or (b) SSE is handled some other way. This is the single biggest architectural fork in the implementation plan — it should be resolved before Phase 2 (build) starts. |
| 2 | ~~**Where does the device registry live?**~~ **Resolved, then revised 2026-07-02.** Originally answered as a second Redis Cloud database with persistence enabled. Revised to **Cloudflare KV** (via Nitro's `storage()` abstraction) once the free Redis Cloud tier used for test deployment turned out to disable persistence by default — exactly wrong for this store, with no technical reason it needed to be Redis specifically. See implementation plan decision #2 (revised) and `relay_data_model.md` v0.6 §1, §5 for the full comparison, including why this doesn't weaken Goal 3's portability requirement. |
| 3 | **Delete queue and pruning job placement.** Should the staggered wallet-clearance delete queue and the weekly device-registry pruning move to Cloudflare-native primitives (Durable Object Alarms, Cron Triggers), or stay as Redis-based polling logic inside the portable Nitro app? The former is more idiomatic and cheaper on Cloudflare; the latter stays portable if the relay is ever redeployed off Cloudflare. This is a direct tradeoff between Goal 2 and Goal 3. |
| 4 | **Push dispatch compatibility.** `node-apn` does not run in the Workers runtime. Should the migration adopt a community Workers-compatible APNs client, or write a minimal in-house HTTP/2 JWT-based APNs client — consistent with the original relay plan's stated preference for a thin, auditable dependency tree? |
| 5 | **Full cutover vs. dual deployment target.** Is the Docker/Compose deployment retired entirely, or does it remain a supported fallback (local development, or a documented alternative for teams that don't want a Cloudflare dependency)? This changes how much of the implementation plan is "migrate" versus "add a second deployment target to maintain indefinitely." |
| 6 | ~~**Cutover mechanics.**~~ **Resolved — moot.** The relay has never been deployed to production; there is no live traffic and no existing deployment to migrate off of. The Nitro/Durable-Object/Redis-Cloud architecture is simply the relay's first production deployment. No canary, blue-green, or rollback rehearsal is needed — see implementation plan decision #6. |

---

**Next step:** please review the open questions above. Answers (or an explicit "proceed with assumptions") will shape the implementation plan's phasing — in particular #1 and #2 determine the shape of Phase 2's build steps.
