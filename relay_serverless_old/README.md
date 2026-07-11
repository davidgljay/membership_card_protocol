# Relay (Serverless)

`relay/` is the serverless rebuild of the [notification relay](../relay-old/README.md):
a Nitro app that runs as Cloudflare Workers + Durable Objects in production
and as a plain Node.js server (`node-server` preset) for local development
and portability. See [`specs/process_specs/notification_relay.md`](../specs/process_specs/notification_relay.md)
for the process spec and [`specs/object_specs/relay.md`](../specs/object_specs/relay.md) /
[`specs/object_specs/relay_data_model.md`](../specs/object_specs/relay_data_model.md)
for the authoritative API and data-model specs.

This document is the operational guide: provisioning, configuration, local
dev, deployment, and troubleshooting. It does not restate architecture
already covered by the specs above or by the Phase 1/2 milestone summaries
in [`plans/milestones/`](../plans/milestones/) — where something is fully
documented elsewhere, this README links to it rather than forking a second,
driftable copy.

**Status as of this writing:** the code is built and tested locally
(`npm test`, `npm run test:do`, `npm run typecheck` all pass — see
[`plans/milestones/relay-serverless-phase-2-summary.md`](../plans/milestones/relay-serverless-phase-2-summary.md)).
It has **not** been deployed to a real Cloudflare account or run against a
real Redis Cloud database. Provisioning and deploying for the first time
will surface things this document cannot yet claim to have verified
end-to-end — see "What this document has not been validated against" at the
bottom.

---

## Architecture in one paragraph

Two storage systems, deliberately different durability: a **Redis Cloud**
database with persistence explicitly disabled (RAM only) holds UUID
records, device credentials, message blobs, and the pending-delete queue —
everything the relay's privacy invariant says must never be durably
recoverable. A **Cloudflare KV** namespace holds the device registry
(`push_token → { app_id, last_registered_at }`), which is deliberately
durable so it survives a Redis reset and can trigger re-registration.
Live WebSocket (`/ws/{uuid}`) and SSE (`/sse`) connections are held by
**Durable Objects** (one `UuidConnection` DO per UUID, one `DeviceChannel`
DO per `device_credential`) — connection state lives in DO memory /
`serializeAttachment`, never DO storage. See `relay_data_model.md` §10 for
the full authority split and how the two systems stay consistent.

---

## 1. Provisioning

### 1.1 Redis Cloud (primary database)

**Authoritative source: [`relay/PROVISIONING.md`](./PROVISIONING.md).**
That document is the exact, current, up-to-date checklist — this README
does not duplicate it, to avoid the two drifting apart. Follow it in full;
the short version is:

1. Confirm plan/tier before creating anything paid.
2. Create one Redis Cloud database with RDB snapshotting and AOF both
   explicitly disabled, TLS enabled and enforced.
3. Verify with `CONFIG GET save` (expect empty string) and
   `CONFIG GET appendonly` (expect `no`) against the live instance — not
   just the console's stated setting.
4. Store the connection string as `REDIS_PRIMARY_URL` (see §2 below) —
   never commit it.

`PROVISIONING.md`'s KV section (below) and its "Secrets" and
"Post-provisioning verification" sections apply too; read the whole file
before provisioning anything.

**As of this writing:** per the Phase 1 and Phase 2 milestone summaries,
the primary Redis Cloud database has **not** been provisioned — the
storage layer has only been exercised against a hand-rolled RESP test
server (`server/utils/redis/test-harness.ts`), not a real managed
instance. Do this before trusting the storage layer in staging.

### 1.2 Cloudflare KV (device registry)

Also covered in full in `PROVISIONING.md` §3. Status: **already
provisioned** — binding name `mcard_relay`, namespace id
`cdf75d4cac1b416d81a8ea508ce49bf5`, already wired into
[`wrangler.toml`](./wrangler.toml):

```toml
[[kv_namespaces]]
binding = "mcard_relay"
id = "cdf75d4cac1b416d81a8ea508ce49bf5"
```

No secret or connection string is needed for KV — it's a binding, not a
credential. Local development under `node-server` uses a different
`unstorage` driver (filesystem or in-memory) instead, configured in
[`nitro.config.ts`](./nitro.config.ts); no Cloudflare credentials are
needed to develop locally at all.

### 1.3 Cloudflare Workers / Durable Objects

Not previously written down in `PROVISIONING.md` (that file's own "What
this document does NOT cover" section explicitly defers this to Phase 3 —
this is that documentation):

1. **Cloudflare account and `wrangler` auth.** `npx wrangler login` (or set
   `CLOUDFLARE_API_TOKEN` — see §2 below for the token scope needed in
   CI). Confirm with `npx wrangler whoami`.
2. **`workers.dev` subdomain.** Your account needs one registered before
   `wrangler deploy` can attach a Worker to it. Visiting the Cloudflare
   dashboard once is usually enough to provision it, but see the
   troubleshooting section below (`workers.dev subdomain ... [code: 10063]`)
   — visiting the dashboard alone did **not** resolve this for us; the
   actual fix was a `wrangler.toml` setting.
3. **Durable Object bindings.** Already declared in `wrangler.toml`:
   ```toml
   [[durable_objects.bindings]]
   name = "UUID_CONNECTION"
   class_name = "UuidConnection"

   [[durable_objects.bindings]]
   name = "DEVICE_CHANNEL"
   class_name = "DeviceChannel"

   [[migrations]]
   tag = "v1"
   new_sqlite_classes = ["UuidConnection", "DeviceChannel"]
   ```
   Nothing to provision manually here beyond having `wrangler deploy` run
   once with this config present — the migration block creates both DO
   classes on first deploy.
4. **Cron Trigger** (reconciliation scan + delete queue), also already in
   `wrangler.toml`:
   ```toml
   [triggers]
   crons = ["*/5 * * * *"]
   ```
   The 5-minute interval is an explicitly-flagged **placeholder**, not an
   evidence-based value — see "What this document has not been validated
   against" below.
5. **Custom domain** (if applicable — not yet configured in this repo).
   Cloudflare's standard path: add a Custom Domain or Route under the
   Worker's settings, or add a `routes` entry to `wrangler.toml`, e.g.:
   ```toml
   routes = [
     { pattern = "relay.example.com", custom_domain = true }
   ]
   ```
   If you add `routes`, you no longer strictly need `workers_dev = true`
   for the *production* deploy target — but see the troubleshooting
   section: leaving `workers_dev` unset/`false` without a working `routes`
   entry is exactly what produces the silent "No targets deployed" outcome
   below, so don't drop one without confirming the other actually attaches
   the Worker somewhere.

### 1.4 Push credentials (APNs / FCM)

Unchanged in shape from the original relay's app registry model (see
[`relay-old/README.md`](../relay-old/README.md)'s "App registry config" section
for the JSON schema itself, which `relay` reuses). What changed is
*where* the registry and credential material live under Cloudflare — see
§2 below and the flagged provisional choice in
`server/utils/app-registry.ts`'s module doc: the app registry JSON is
expected as a build-time-bundled asset (node-server) or the
`APP_REGISTRY_JSON` env var/binding (cloudflare), and this specific
sourcing mechanism has **not** been confirmed with the user — treat it as
provisional, not final, if you're revisiting this.

---

## 2. Configuration: `wrangler` config and required secrets

### 2.1 `wrangler.toml`

[`relay/wrangler.toml`](./wrangler.toml) is the production Worker
config (`name = "mcard-relay"`, entry `server/cloudflare-entry.ts`). It is
committed and contains no secrets — only resource identifiers (KV
namespace id, DO class bindings, cron schedule), which are not sensitive.

A second config, [`relay/wrangler.do-test.toml`](./wrangler.do-test.toml),
exists only for the `npm run test:do` workerd-pool test suite — not a
deployment target, don't deploy with it.

The Phase 1 spike's own config,
[`relay/spike-do-ws/wrangler.toml`](./spike-do-ws/wrangler.toml), is
also not a deployment target for the real service — it's a standalone
throwaway Worker used only to validate the DO+WebSocket approach (see §4
below). It's mentioned here specifically because its `workers_dev = true`
setting is the thing that made the difference in the deploy gotcha
described in the troubleshooting section.

### 2.2 Required secrets

Set via `wrangler secret put <NAME>` (or the equivalent GitHub Actions
secret — see the CI workflow, [`../.github/workflows/relay-deploy.yml`](../.github/workflows/relay-deploy.yml)).
Names below are authoritative per `relay_data_model.md` §9 and the code
that reads them (`server/utils/env.ts`, `server/utils/push/dispatch.ts`,
`server/utils/reregistration.ts`):

| Secret | Required | Description |
|---|---|---|
| `REDIS_PRIMARY_URL` | Yes | TLS (`rediss://`) connection string for the persistence-off Redis Cloud database |
| `RELAY_ID` | Yes | Unique identifier for this relay deployment, included in re-registration push payloads |
| `INTERNAL_API_SECRET` | Yes | Shared secret the `UuidConnection` DO presents (`x-internal-secret` header) when calling back into the Worker's own `/api/internal/ws-closed/{uuid}` route — see `server/do/uuid-connection.ts` and `server/api/internal/ws-closed/[uuid].post.ts` |
| `APNS_KEY_<APP_ID>` | Conditionally | Raw `.p8` APNs auth key PEM content, one per `apns`-platform app in the app registry (`<APP_ID>` substituted with the app's `app_id`) — required only for apps registered as `platform: "apns"` |
| `FCM_SERVICE_ACCOUNT_<APP_ID>` | Conditionally | Raw Firebase service account JSON content, one per `fcm`-platform app — required only for apps registered as `platform: "fcm"` |
| `APP_REGISTRY_JSON` | Yes (cloudflare preset) | Full app registry JSON as a string — see the provisional-sourcing note in §1.4 |

Non-secret config (`UUID_TTL_SECONDS`, `DEVICE_REGISTRY_RETENTION_DAYS`,
`MAX_DELETE_DELAY_SECONDS`, `RECONCILIATION_CRON_SCHEDULE`, `NODE_ENV`) is
documented in full in `relay_data_model.md` §9 — all have working
defaults and don't need to be set to get a working deployment.

`RECONCILIATION_CRON_SCHEDULE` as an env var and the `[triggers]` cron
schedule in `wrangler.toml` are two different mechanisms for the same
concept (env var is read by code that also needs to know its own
schedule for internal timing math; the `[triggers]` block is what
actually invokes the Worker on that schedule) — keep them in sync if you
change one.

**Cloudflare API token (for `wrangler deploy` / CI):** a token with
`Workers Scripts:Edit`, `Workers KV Storage:Edit` (already-provisioned
namespace, so `Edit` not `Admin`), and `Account Settings:Read` scopes for
the target account, stored as `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_ACCOUNT_ID`
is also required by `wrangler` in non-interactive (CI) contexts.

---

## 3. Local development (`node-server` preset)

No Cloudflare account, Redis Cloud instance, or any credentials are
required to develop locally — this portability is one of the reasons this
migration chose Nitro (see the strategic plan's Goal 3).

```sh
cd relay
npm install

# Run the test suite (plain-Node, no real Redis/Cloudflare needed —
# storage.ts uses ioredis-mock and an in-memory/filesystem unstorage driver)
npm test

# Type-check
npm run typecheck

# Build under the node-server preset
npm run build:node

# Run the built server
node .output/server/index.mjs
# or, for hot-reload dev:
npm run dev
```

Health check:

```sh
curl http://localhost:3000/api/health
```

### Running the Durable Object test suite locally

`npm run test:do` runs against real Durable Object stubs via
`@cloudflare/vitest-pool-workers` (real `workerd`, not a mock) — this
needs no live Cloudflare account, it runs entirely locally, but it is a
separate test run from `npm test` because it needs the `workerd` runtime
rather than plain Node:

```sh
npm run test:do
```

### Building for Cloudflare locally (without deploying)

```sh
npm run build:cloudflare
```

This is a build-only sanity check — it does not deploy anything. It
proves the Cloudflare-targeted build compiles, independent of whether you
have Cloudflare credentials configured. See the troubleshooting section
for a sandbox-specific `EPERM` quirk observed (and not reproduced) during
Phase 2.

### Local dev against Cloudflare's runtime (`wrangler dev`)

To exercise the real DO/WebSocket connection layer locally (closer to
production than `node-server`, still no live account needed thanks to
Miniflare):

```sh
npm run build:cloudflare
npx wrangler dev --local
```

If you hit `SQLITE_IOERR` from Miniflare's local DO storage simulation
(seen in a sandboxed environment during Phase 1, not expected on a normal
dev machine — see the Phase 1 milestone summary), work around it with:

```sh
npx wrangler dev --local --persist-to /tmp
```

---

## 4. Deploying to Cloudflare

```sh
npm run build:cloudflare
npx wrangler deploy
```

(or via CI — see [`.github/workflows/relay-deploy.yml`](../.github/workflows/relay-deploy.yml),
which runs this after tests and secret validation pass, on push to `main`.)

**Read the troubleshooting section below before your first deploy** — two
non-obvious failure modes were hit getting the Phase 1 spike deployed and
are not documented anywhere else.

---

## 5. Troubleshooting

### DO + WebSocket integration issues (Phase 1 findings)

Full detail in [`relay/spike-do-ws/README.md`](./spike-do-ws/README.md);
summarized here:

1. **Nitro's built-in `cloudflare-durable` preset only supports one
   fixed Durable Object instance for the entire Worker** (hardcoded
   `idFromName("server")`, no config surface to resolve a different
   instance per request, in the `nitropack@2.11+` version pinned here).
   It's explicitly labeled experimental upstream and isn't in Nitro's
   published docs. **Consequence:** this codebase does not use that
   preset. `server/cloudflare-entry.ts` and the DO classes under
   `server/do/` talk to the Cloudflare Workers Hibernation API directly
   (`ctx.acceptWebSocket`, `ctx.getWebSockets`, `serializeAttachment` /
   `deserializeAttachment`), addressing DOs by `idFromName(uuid)` /
   `idFromName(device_credential)` per request — proven first in the
   Phase 1 spike, then built out for real in Phase 2.
2. **The published `crossws@0.4.8` has dropped
   `"./adapters/cloudflare-durable"` from its package `exports` map**
   (files are still in the tarball, just not importable through the
   public export surface), while Nitro's own nested, pinned
   `crossws@^0.3.5` still exports it. If you're tempted to import that
   adapter directly instead of going through Nitro's preset: don't —
   it'll resolve inconsistently depending on which `crossws` copy
   resolves first. This codebase avoids the adapter entirely, for the
   same reason as point 1.

### `wrangler deploy` fails with "You need a workers.dev subdomain in order to proceed [code: 10063]"

This can happen even after visiting the Cloudflare dashboard to register
a `workers.dev` subdomain for the account — visiting the dashboard alone
did not resolve it in this project's experience. **The actual fix:**
check `workers_dev` in the `wrangler.toml` you're deploying with. If it's
explicitly set to `false` (or a stale/spike config with `workers_dev =
false` gets used by mistake — this happened here because
`spike-do-ws/wrangler.toml` had it hardcoded `false` for local-only
`wrangler dev` use, and is easy to confuse with the real deploy config),
set it to `true`:

```toml
workers_dev = true
```

then retry `wrangler deploy`. If you're deploying to a custom domain
instead of `*.workers.dev`, a correctly-configured `routes` entry can
substitute for `workers_dev = true` — but confirm the route actually
attaches (see the next entry) rather than assuming it does.

### `wrangler deploy` succeeds but says "Uploaded ... / No targets deployed for ..."

This is **not an error** — it's easy to miss in the output, but it means
the Worker script uploaded successfully and is not attached to any route
or `workers_dev` target, i.e., it is not reachable by anything. Check:

- `workers_dev = true` is set in `wrangler.toml` (see above), **or**
- a `routes` entry is present and correctly configured (custom domain
  case).

Either alone is sufficient; having neither is exactly what produces this
message. Re-run `wrangler deploy` after fixing the config — the previous
"successful" deploy doesn't need to be rolled back, it just needs a
target attached.

### Sandbox-specific: `EPERM` on `build:cloudflare` / `SQLITE_IOERR` on `wrangler dev --local`

Both observed in this project's development sandbox, not expected on a
normal developer machine or in CI (re-run in Phase 2 without the EPERM
recurring — see the Phase 2 milestone summary). If `wrangler dev --local`'s
Miniflare DO-storage simulation fails with `SQLITE_IOERR`, it's very
likely a filesystem-mount quirk of a sandboxed environment (SQLite doesn't
like the mounted filesystem's locking semantics) — work around with
`--persist-to /tmp` as shown in §3 above.

---

## What this document has not been validated against

Stated plainly, matching the honesty bar of the Phase 1/2/3 milestone
summaries — this README describes the intended, documented path, not a
confirmed end-to-end run:

- **No real Redis Cloud database has been provisioned or connected to.**
  The storage layer has only been tested against a hand-rolled RESP test
  server and `ioredis-mock`.
- **No real `wrangler deploy` to a live Cloudflare account has been
  performed from this codebase.** The two deploy gotchas above are real,
  hard-won findings from getting the Phase 1 *spike* deployed — the main
  `relay` Worker itself has not yet gone through a first real
  deploy, so there may be more to find.
- **Real Cloudflare Durable Object hibernation-eviction timing is
  unmeasured.** `relay/spike-do-ws/test-hibernation.mjs` exists and
  is designed for this, but no run's output has been found committed
  anywhere in the repository — the 5-minute `RECONCILIATION_CRON_SCHEDULE`
  default remains a placeholder, not an evidence-based value.
- **This README itself has not yet been followed end-to-end, from a
  clean checkout, by anyone other than its author.** Per the
  implementation plan's own "done when" bar for this step, that's the
  real test — do that before trusting it fully.
