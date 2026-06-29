# Notification Relay

The notification relay sits between wallet services and holder devices, enabling privacy-preserving message delivery without either party knowing the other's identity. It supports two delivery modes:

- **Push** — silent APNs or FCM wake-up when the device app is backgrounded
- **WebSocket** — low-latency bidirectional bridge when the app is in the foreground

See [`specs/process_specs/notification_relay.md`](../specs/process_specs/notification_relay.md) for the full process spec and [`specs/object_specs/relay.md`](../specs/object_specs/relay.md) for the API spec.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Node.js 20+ (for local development without Docker)

---

## Quick start — local development

```sh
cp .env.example .env
# Edit .env if needed (defaults work for local dev)

docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This starts:
- **relay** on `http://localhost:3000` with hot-reload via `tsx watch`
- **redis** on `localhost:6379`
- **redis-commander** on `http://localhost:8081` for Redis inspection

Test the server is running:

```sh
curl http://localhost:3000/health
# {"status":"ok","redis":"ok","sqlite":"ok"}
```

---

## Production

```sh
docker compose up --build
```

The Dockerfile uses a multi-stage build: `node:20-alpine` compiles TypeScript to `dist/`, then a minimal runtime image runs `node dist/server.js`.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | — | Redis connection URL, e.g. `redis://redis:6379` |
| `APP_REGISTRY_PATH` | Yes | — | Path to `apps.json` config file |
| `RELAY_ID` | Yes | — | Unique identifier for this relay instance, included in re-registration push payloads |
| `DB_PATH` | No | `/data/registry.db` | Path to SQLite device registry file |
| `PORT` | No | `3000` | HTTP listen port |
| `UUID_TTL_SECONDS` | No | `2592000` | Redis TTL for UUID records (default: 30 days) |
| `DEVICE_REGISTRY_RETENTION_DAYS` | No | `90` | Age threshold for SQLite device registry pruning |
| `NODE_ENV` | No | `production` | Set to `development` to enable stub push mode (no real pushes sent) |

---

## App registry config (`config/apps.json`)

The relay serves multiple wallet service deployments. Each is an "app" identified by an `app_id` string. Add an entry to `apps.json` for each app:

```json
{
  "apps": [
    {
      "app_id": "my-wallet-ios",
      "platform": "apns",
      "wallet_ws_url": "wss://wallet.example.com/ws",
      "apns": {
        "key_file": "/app/config/secrets/apns-key.p8",
        "key_id": "ABCD123456",
        "team_id": "WXYZ789012",
        "bundle_id": "com.example.wallet",
        "sandbox": false
      }
    },
    {
      "app_id": "my-wallet-android",
      "platform": "fcm",
      "wallet_ws_url": "wss://wallet.example.com/ws",
      "fcm": {
        "service_account_file": "/app/config/secrets/fcm-service-account.json"
      }
    }
  ]
}
```

**Fields:**

| Field | Description |
|---|---|
| `app_id` | Unique string. Supplied by the device in `POST /register`. |
| `platform` | `"apns"` (iOS) or `"fcm"` (Android). |
| `wallet_ws_url` | Base `wss://` URL of the wallet service. The relay appends `/{uuid}` when bridging a WebSocket session. |
| `apns.key_file` | Path to your `.p8` APNs auth key file. |
| `apns.key_id` | 10-character APNs key ID. |
| `apns.team_id` | 10-character Apple Team ID. |
| `apns.bundle_id` | App bundle ID (e.g. `com.example.wallet`). |
| `apns.sandbox` | `true` for APNs sandbox (default), `false` for production. |
| `fcm.service_account_file` | Path to your Firebase service account JSON. |

Place credential files in `config/secrets/` (excluded from git via `.gitignore`). The `./config` directory is bind-mounted into the container at `/app/config`.

---

## Adding a new app

1. Add an entry to `config/apps.json`
2. Place credential files in `config/secrets/`
3. Restart the relay: `docker compose restart relay`

No code changes required.

---

## How to connect a wallet service

The relay exposes three endpoints:

| Endpoint | Caller | Purpose |
|---|---|---|
| `POST /register` | Device | Obtain a pool of single-use UUIDs |
| `POST /notify/{uuid}` | Wallet service | Trigger a silent push to the device |
| `GET /ws/{uuid}` | Device | Open a bridged WebSocket session to the wallet |

**Wallet service integration:**

1. Receive a UUID from the device (via your own registration endpoint)
2. When a message arrives for a card, call `POST /notify/{uuid}` — no body required
3. The relay delivers a silent push: `{ "uuid": "<the uuid>" }` via APNs or FCM
4. The device wakes, identifies the card from the UUID, and fetches messages directly from your service

For WebSocket sessions, the device opens `wss://relay.example/ws/{uuid}`. The relay opens an outbound connection to `{wallet_ws_url}/{uuid}` and bridges the two. Your wallet service validates the UUID against its pool and accepts the connection. Message content flows through the relay as opaque bytes and is never logged.

---

## Privacy properties

| Party | Knows | Does not know |
|---|---|---|
| Wallet service | Card → UUID(s) | Device identity, push token, which UUIDs belong to the same person |
| Relay service | UUID → push token or WebSocket connection | Card identity, message content |

**What is stored:**

- **Redis** (no persistence): UUID → `{ push_token, wallet_ws_url, status, app_id }`. Cleared on Redis restart, which triggers automatic device re-registration.
- **SQLite** (durable volume): `push_token → { app_id, last_registered_at }`. No UUID associations. Pruned weekly; records older than 90 days are deleted.
- **Logs**: UUID values, timing, delivery success/failure. No card identities or message content.

**What is never stored:** card identities, message content, which UUIDs belong to the same card.

---

## Running tests

Tests require a local Redis instance:

```sh
docker run -d --name relay-redis -p 6379:6379 redis:7-alpine redis-server --save "" --appendonly no
REDIS_URL=redis://localhost:6379 npm test
docker stop relay-redis && docker rm relay-redis
```

The test suite covers:
- UUID state machine: all valid transitions, all invalid transitions, atomicity under concurrent requests
- `POST /register`, `POST /notify/{uuid}`: all success and error paths
- WebSocket bridge: bidirectional message flow, teardown on either-side disconnect, all rejection close codes
- Failure cases: TTL expiry, push rollback, startup stuck-UUID scan, re-registration notifier, pruning job
