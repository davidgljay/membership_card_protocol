# Relay — Deployment

> **Current path: Droplet, not App Platform.** David chose a single
> Droplet running both dev and prod via `docker-compose.droplet.yml` (see
> "Droplet deployment" below) over App Platform, on cost grounds while
> usage stays low — cheaper than App Platform + Managed Redis for both
> environments, at the price of self-managing the host. Easy to move back
> to App Platform later if usage grows (see "Why App Platform, not a
> Droplet" below for that path's own tradeoffs). The App Platform path
> (`scripts/deploy.sh`, `.do/app.*.yaml`) is left in place, documented
> below, and still works — just not what's actually running right now.

This document covers deployment of `relay/` to either DigitalOcean App
Platform (`scripts/deploy.sh`) or a single Droplet
(`docker-compose.droplet.yml`). For the protocol/API surface, see
[`README.md`](./README.md); for local development, see its "Quick start"
section (unchanged by this document — local dev still uses
`docker-compose.yml` + `docker-compose.dev.yml` with a self-hosted Redis
container).

## Droplet deployment (current path)

One Droplet runs both `dev` and `prod` side by side via
`docker-compose.droplet.yml`, fronted by Caddy for automatic TLS. Chosen
over App Platform + Managed Redis (~$40/mo for both environments) or
App Platform + a self-hosted Redis worker (~$20/mo) as the cheapest option
while usage stays low — see the cost comparison this decision came from
in the conversation that added this section, or re-derive it from DO's
current pricing page if it's been a while.

**Real, deliberate tradeoffs, not oversights:**
- **Host management is back.** Unlike App Platform, you're responsible for
  OS patching, Docker upgrades, and uptime on this Droplet — the exact
  thing "Why App Platform, not a Droplet" below argues against. Accepted
  for now because usage is low; revisit if that changes.
- **Redis has persistence deliberately disabled** in both environments
  (`--save "" --appendonly no`, no volume mounted) — a design requirement,
  not a gap: message UUID TTL state is expected to be lost on every
  container restart. Do not add a volume or re-enable RDB/AOF without
  updating this note.
- **Single point of failure.** One Droplet down takes out both
  environments at once (unlike separate App Platform apps, which fail
  independently).
- **The SQLite device-registry gap disappears for free**, as a side
  effect: a Droplet's local disk is real persistent storage (unlike App
  Platform, which has no persistent-volume support at all), so
  `docker-compose.droplet.yml` gives each environment's `/data` a real
  named volume instead of App Platform's ephemeral `/tmp`.

### Prerequisites

- A Droplet sized at least 2GB RAM (the 1GB/$6 tier risks OOM running two
  Node processes + two Redis instances + Caddy simultaneously) with Docker
  and the Docker Compose plugin installed (DigitalOcean's "Docker on
  Ubuntu" marketplace image has both preinstalled).
- A domain you control, with two DNS `A` records pointing at the
  Droplet's public IP: `relay.membershipcard.io` (prod) and
  `dev.relay.membershipcard.io` (dev). Both must resolve *before* first
  starting Caddy — its automatic Let's Encrypt provisioning needs to reach
  the Droplet over port 80 via each hostname to complete the HTTP-01
  challenge.
- `relay/.env.dev.droplet` and `relay/.env.prod.droplet` on the Droplet
  itself (gitignored, never committed) — see "Required environment
  variables" below for what each needs. Same secret-handling principle as
  every other package in this repo: real values never pass through an
  agent session.

### Running it

```bash
# On the Droplet, after cloning this repo:
cd relay
# Create .env.dev.droplet and .env.prod.droplet first (see below).
docker compose -f docker-compose.droplet.yml up -d --build
```

Redeploying after a code change:
```bash
git pull
docker compose -f docker-compose.droplet.yml up -d --build
```

Verify:
```bash
curl https://relay.membershipcard.io/health
curl https://dev.relay.membershipcard.io/health
# expect {"status":"ok","redis":"ok","sqlite":"ok"} from both
```

### Required environment variables (`.env.dev.droplet` / `.env.prod.droplet`)

Same variables as App Platform's secret set below (`APP_REGISTRY_JSON`,
`APNS_KEY_<APP_ID>_B64`/`FCM_SERVICE_ACCOUNT_<APP_ID>_B64`) — `REDIS_URL`,
`RELAY_ID`, and the rest of the non-secret config are already set directly
in `docker-compose.droplet.yml` per environment, not read from these
files.

## Why App Platform, not a Droplet

See `plans/deployment/strategic-plan.md` Open Question 2 for the full
rationale (cost parity with the smallest usable Droplet, zero host/OS
management). The actual platform call lives in one isolated function,
`deploy_to_app_platform()` in `scripts/deploy.sh`, so a future service that's
a worse App Platform fit can be pointed at a Droplet instead by swapping
that one function. (Superseded for now by the Droplet path above, kept
here as the rationale for switching back if usage grows.)

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
