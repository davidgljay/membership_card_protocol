# Relay — Deployment

This document covers automated deployment of `relay/` to DigitalOcean App
Platform via `scripts/deploy.sh`. For the protocol/API surface, see
[`README.md`](./README.md); for local development, see its "Quick start"
section (unchanged by this document — local dev still uses
`docker-compose.yml` + `docker-compose.dev.yml` with a self-hosted Redis
container).

## Why App Platform, not a Droplet

See `plans/deployment/strategic-plan.md` Open Question 2 for the full
rationale (cost parity with the smallest usable Droplet, zero host/OS
management). The actual platform call lives in one isolated function,
`deploy_to_app_platform()` in `scripts/deploy.sh`, so a future service that's
a worse App Platform fit can be pointed at a Droplet instead by swapping
that one function.

## Known limitations — read before relying on this for real traffic

**SQLite device registry does not persist across redeploys.** App Platform
does not support mounting a persistent volume into an app component (unlike
`docker-compose.yml`'s `db_data` volume). `.do/app.*.yaml` sets `DB_PATH` to
local ephemeral disk (`/tmp/registry.db`); every redeploy or platform-managed
restart starts from an empty device registry. Per `README.md`'s "Device
registry" section, this table only supports analytics/diagnostics (active
device counts, retention cleanup) — no message delivery or device state
depends on it — so this is a real but bounded gap. **This must be resolved
before a production cutover** (options: move the device registry to the
already-provisioned Managed Redis instead of SQLite, or fall back to the
Droplet + persistent-volume path this deploy script's isolated function was
designed to allow). Flagged for correction in `strategic-plan.md` before
Phase 2 begins, per the Phase 1 Milestone Review criteria.

**Config files and push credentials are materialized from env vars, not
mounted.** `docker-compose.yml` bind-mounts `./config` (containing
`apps.json` and per-app APNS/FCM key files) directly into the container. App
Platform has no equivalent bind-mount mechanism, so `Dockerfile`'s
`ENTRYPOINT` now runs `scripts/materialize-secrets.mjs` before starting the
server: if `APP_REGISTRY_JSON` is set, it writes that JSON to
`APP_REGISTRY_PATH` and decodes one `<PLATFORM>_<APP_ID>_B64` env var per app
into the `key_file`/`service_account_file` path that app's registry entry
declares. This is a no-op under docker-compose (`APP_REGISTRY_JSON` is unset
there), so local dev is unaffected.

## Prerequisites

- A DigitalOcean account with billing configured (Claude cannot provision
  billed infrastructure — see the Phase 1 clarification checkpoint in
  `plans/deployment/implementation-plan.md`: confirm with David before the
  first real `doctl apps create` runs).
- `doctl` installed and authenticated (`doctl auth init`), or a
  `DIGITALOCEAN_ACCESS_TOKEN` for non-interactive use (what
  `scripts/deploy.sh` uses).
- **Prod**: a DigitalOcean Managed Redis database provisioned per
  environment (replaces the self-hosted `redis` container from
  `docker-compose.yml` — see Open Question 2's note on avoiding host
  management through the back door). Note its connection string for
  `REDIS_URL`.
- **Dev**: `app.dev.yaml` instead runs Redis as a self-hosted worker
  component in the same app (cheaper for a throwaway deployment) — see
  the file's own doc comment for the tradeoff (no persistent volume, data
  wiped on every redeploy/restart, same class of gap as the SQLite device
  registry below). Set `REDIS_URL=redis://redis:6379` (the worker
  component's name as hostname, via App Platform's internal
  component-to-component networking) rather than a Managed Redis
  connection string. If that hostname doesn't resolve on first deploy,
  fall back to provisioning Managed Redis the same way prod does.
- `.do/app.dev.yaml` / `.do/app.prod.yaml` updated with your real GitHub
  `repo`/`branch` (App Platform builds from a GitHub source, not a local
  Dockerfile push — replace the `<your-github-org>/<your-repo>` placeholder
  first).

## Running the deploy script

```bash
cd relay
./scripts/deploy.sh dev    # or: ./scripts/deploy.sh prod
```

The script:
1. Validates `DIGITALOCEAN_ACCESS_TOKEN` is set.
2. Looks up whether an App Platform app named `relay-<environment>` already
   exists (`doctl apps list`). If not, creates it from
   `.do/app.<environment>.yaml`; if it does, updates it with the current
   spec.
3. Triggers a deployment and waits for it to finish (`doctl apps
   create-deployment --wait`).

Environment is always an explicit argument — the script never infers it from
branch name or hostname.

**This script does not set secret values.** Per
`strategic-plan.md` Open Question 5, secrets (`REDIS_URL`,
`APP_REGISTRY_JSON`, per-app push credential vars) are configured once,
out-of-band, directly on the DO app (dashboard, or a manual
`doctl apps update` you run yourself) — never pushed through CI or this
script, so they never transit a spec file or CI logs. The checked-in
`.do/app.*.yaml` declares these as `type: SECRET` with no value; `doctl apps
update` leaves an existing secret's value untouched when the spec omits it.

## Required environment variables

### For `scripts/deploy.sh` itself

| Variable | Description |
|---|---|
| `DIGITALOCEAN_ACCESS_TOKEN` | DO API token with App Platform write access. |

### Set once, out-of-band, directly on the DO app (never via this script)

| Variable | Description |
|---|---|
| `REDIS_URL` | Connection string for the environment's Managed Redis instance. |
| `APP_REGISTRY_JSON` | Full contents of `config/apps.json` — see `README.md`'s "App registry config" section for the schema. |
| `APNS_KEY_<APP_ID>_B64` | Base64-encoded `.p8` file content, one per app with `platform: "apns"` in the registry. `<APP_ID>` is that app's `app_id`, uppercased with non-alphanumerics replaced by `_` (e.g. `example-wallet` → `EXAMPLE_WALLET`). |
| `FCM_SERVICE_ACCOUNT_<APP_ID>_B64` | Base64-encoded service account JSON, one per app with `platform: "fcm"`. Same `<APP_ID>` naming rule. |

Non-secret config (`RELAY_ID`, `PORT`, `UUID_TTL_SECONDS`,
`DEVICE_REGISTRY_RETENTION_DAYS`, `DELETE_JOB_POLL_INTERVAL_MS`,
`MAX_DELETE_DELAY_SECONDS`, `NODE_ENV`, `DB_PATH`, `APP_REGISTRY_PATH`) is
already set in `.do/app.dev.yaml` / `.do/app.prod.yaml` and pushed by
`scripts/deploy.sh` on every run — no manual step needed for these.

## First-time setup

1. Confirm DO account/billing with David (Claude cannot provision billed
   infrastructure).
2. **Prod only**: provision a Managed Redis database for the environment;
   note its connection string. **Dev**: no provisioning needed —
   `app.dev.yaml` already declares a self-hosted `redis` worker component.
3. Replace the GitHub `repo`/`branch` placeholder in
   `.do/app.<environment>.yaml`.
4. Run `./scripts/deploy.sh <environment>` once to create the app.
5. In the DO dashboard, set `REDIS_URL` (dev: `redis://redis:6379`; prod:
   the Managed Redis connection string from step 2), `APP_REGISTRY_JSON`,
   and each app's
   `APNS_KEY_*_B64`/`FCM_SERVICE_ACCOUNT_*_B64` secret, then trigger a
   redeploy from the dashboard (or re-run `scripts/deploy.sh` — it will
   update the app and trigger a new deployment; secret values you already
   set are preserved since the spec doesn't include them).
6. Verify: `curl https://<your-app>.ondigitalocean.app/health` — expect
   `{"status":"ok","redis":"ok","sqlite":"ok"}`.
