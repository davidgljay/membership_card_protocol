# Spike: Durable Object + WebSocket Hibernation (Phase 1.2)

This is a minimal, standalone spike for
`plans/relay-serverless-migration-implementation-plan.md` step 1.2. It is
**not** wired into the main `relay-next` Nitro app's route tree — see
"Why this is a separate worker" below for the reason.

## What this proves

- A Durable Object addressed by an arbitrary per-connection key (here, a
  `uuid` path segment) — not a single fixed instance name — can accept a
  WebSocket using the Hibernation API (`this.ctx.acceptWebSocket`, not
  `server.accept()`), survive an idle period, and be found again by a
  second, independent HTTP request that looks up the *same* DO by the same
  key and delivers a message into it.
- This is the actual connection shape the relay spec needs: one DO per
  UUID (`GET /ws/{uuid}`), not one shared DO for the whole service.
- It talks to the Cloudflare Workers Hibernation API directly
  (`acceptWebSocket`, `getWebSockets`, `serializeAttachment` /
  `deserializeAttachment`) rather than through a framework adapter, so
  there is no ambiguity about what is actually being exercised.

## Two ecosystem rough edges found while building this, both worth escalating

**1. Nitro's built-in `cloudflare-durable` preset only supports a single,
fixed Durable Object instance.** (`nitropack@2.11+`, matching what
`press/package.json` already pins elsewhere in this repo.) Its shipped
`$DurableObject` hardcodes:

```js
const DURABLE_BINDING = "$DurableObject";
const DURABLE_INSTANCE = "server";
const id = binding.idFromName(DURABLE_INSTANCE);
```

Every WebSocket upgrade — regardless of route or path — resolves to
`idFromName("server")`, i.e. **one single Durable Object instance for the
entire Worker**, with no config surface in this preset version to override
the instance name per-request. This preset is explicitly labeled
experimental upstream ("Not documenting yet to experiment" —
nitrojs/nitro#2801, the PR that introduced it) and isn't listed on the
current published Nitro docs' Cloudflare provider page at all. It's also
plausibly the kind of thing nitrojs/nitro#2436 (Cloudflare Pub/Sub &
Durable Object support) is tracking — that issue's linked PR is #2801,
the same PR that shipped this single-instance preset.

**2. `crossws`'s own `cloudflare-durable` adapter — which the Nitro preset
above uses internally, and which would otherwise have been the natural
building block for this spike — is not consistently available depending
on which version resolves.** The currently-published `crossws@0.4.8`
(what a fresh `npm install crossws` gives you today) has dropped
`"./adapters/cloudflare-durable"` from its `package.json` `exports` map
entirely; the compiled files are still physically present in the npm
tarball but are no longer importable through the package's public export
surface. Nitro's own pinned `crossws@^0.3.5` (a transitive, nested
dependency) still exports it. Concretely: `npm install crossws` at the top
level of this project, then `import ... from "crossws/adapters/cloudflare-durable"`,
fails to resolve — while the exact same import works from *inside*
`nitropack`'s own nested copy. This is a real version-skew trap for
anyone trying to use the adapter directly instead of through Nitro's
preset.

Given both of these, this spike bypasses both the Nitro preset and the
`crossws` adapter and talks to the raw Cloudflare Workers Hibernation API
(`this.ctx.acceptWebSocket`, `this.ctx.getWebSockets`,
`serializeAttachment`/`deserializeAttachment`) directly in
`durable-object.ts`, with a hand-written Worker entry (`worker.ts`) doing
`idFromName(uuid)` per request. **This is the kind of blocking rough edge
the implementation plan told us to escalate rather than silently work
around** — so both findings are documented here and in the Phase 1
milestone summary rather than patched over.

Wiring per-key DO resolution into the `relay-next` Nitro app's own
route/build pipeline (so `GET /ws/{uuid}` works as an ordinary Nitro
route, indistinguishable from the other HTTP handlers) is Phase 2 scope,
not Phase 1. It will require either Nitro adding a config hook for custom
per-request DO instance resolution, or `relay-next`'s Cloudflare deploy
carrying a small amount of hand-rolled Worker-entry code (like this
spike's `worker.ts`) alongside Nitro's generated output. Both are viable;
deciding between them belongs to Phase 2 planning, not this spike.

## Files

- `worker.ts` — Worker entry point. Routes `GET /ws/:uuid` to a per-UUID
  Durable Object; also exposes `POST /deliver/:uuid`, which looks up the
  *same* DO instance and, if it holds an open WebSocket, sends a message
  into it (simulating a delivery call arriving after the WS connection is
  already open/hibernating — the relay's actual `/deliver/{uuid}` →
  `GET /ws/{uuid}` interaction, minus real Redis-backed state).
- `durable-object.ts` — The `UuidConnection` Durable Object class. Holds
  the device WebSocket **in memory / socket-attachment only** — see
  "Privacy invariant" below.
- `wrangler.toml` — Local Miniflare config for `wrangler dev`.

## Privacy invariant maintained even in spike code

Per the task's constraints: this DO's code never calls
`this.ctx.storage.put(...)` (Durable Object *storage*, which is
disk-resident and has 30-day point-in-time recovery on by default —
exactly the disk-recoverability the relay's core privacy invariant
forbids). All state referenced by the DO (the uuid, the open WebSocket, an
in-memory delivery counter) lives only in the DO's in-memory instance
fields and in `serializeAttachment`/`deserializeAttachment` on the
WebSocket itself (the runtime's own hibernation-survival mechanism) —
both are RAM-only and are the Workers-runtime equivalent of the "RAM
only, gone on restart" guarantee Redis provides today. No UUID or
connection-linked data is written to KV, D1, or DO storage anywhere in
this spike.

## What was validated locally vs. what still needs a real account

See the Phase 1 milestone summary
(`plans/milestones/relay-serverless-phase-1-summary.md`) for the full
honest accounting. Short version: connection accept, message echo, and
DO-instance persistence *across separate `wrangler dev` HTTP requests*
were confirmed locally via Miniflare (see the manual test transcript in
that summary). Multi-colo behavior and cost/billing behavior remain
unverified — Miniflare/local testing can't speak to either.

**Update 2026-07-03 — real hibernation-eviction test run.** This spike
was deployed to a real Cloudflare account and probed with
`test-hibernation.mjs` (a single WebSocket left idle, checked at
increasing intervals). Result: the connection survived cleanly through
30 minutes of genuine idle time (each checkpoint confirmed a message
actually arrived on the still-open socket). The run's later checkpoints
are confounded by an apparent client-side interruption (the test
machine's own process showed a ~6-minute scheduling gap right before the
connection eventually closed at ~52 minutes with an abnormal-closure
code), so this run cannot cleanly attribute that specific close to
Cloudflare's eviction policy versus the test client itself dropping the
connection. See `specs/object_specs/relay_data_model.md` §2.5 for the
full writeup. Net effect: "at least 30 minutes, confirmed" is solid;
pinning down an exact eviction boundary would need a longer, repeated
test from infrastructure that can't itself sleep mid-test — not
currently needed, since nothing in the design depends on that exact
number, only on the reconciliation scan interval being comfortably
shorter than it (5 minutes vs. 30+ confirmed minutes).
