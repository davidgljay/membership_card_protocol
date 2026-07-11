# Notification Relay

The notification relay sits between wallet services and holder devices to deliver encrypted notifications across multiple channels (HTTP Server-Sent Events, WebSocket, or silent push). It manages device credentials, message storage, and staggered message deletion from the wallet.

This is the project's **current, supported relay implementation**. For more detail on the protocol and data model, see [`specs/process_specs/notification_relay.md`](../specs/process_specs/notification_relay.md) and [`specs/object_specs/relay.md`](../specs/object_specs/relay.md).

## Prerequisites
- Docker and Docker Compose
- Node.js 20+ (for local development without Docker)

## Quick start — local development

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The relay will start on `:3000`, Redis on `:6379`, and redis-commander (for debugging) on `:8081`.

## Production

```bash
docker compose up --build
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |
| `DB_PATH` | `/data/registry.db` | SQLite device registry database path |
| `APP_REGISTRY_PATH` | `/app/config/apps.json` | Path to app configuration file |
| `RELAY_ID` | `relay-1` | Identifier for this relay instance |
| `PORT` | `3000` | HTTP listen port |
| `UUID_TTL_SECONDS` | `2592000` (30 days) | Time-to-live for message UUIDs in Redis |
| `DEVICE_REGISTRY_RETENTION_DAYS` | `90` | Retention window for device records in SQLite |
| `NODE_ENV` | `development` | Node environment (`development` or `production`) |
| `DELETE_JOB_POLL_INTERVAL_MS` | `60000` | Interval (milliseconds) for polling pending wallet deletes |
| `MAX_DELETE_DELAY_SECONDS` | `21600` (6 hours) | Maximum random delay before deleting message from wallet |

## App registry config (config/apps.json)

The relay reads a registry of apps at startup. Each app specifies a wallet service URL and platform-specific push credentials.

Example:
```json
{
  "apps": [
    {
      "app_id": "example-wallet",
      "platform": "apns",
      "wallet_base_url": "https://wallet.example.com",
      "apns": {
        "key_file": "/app/config/secrets/apns-key.p8",
        "key_id": "ABCD123456",
        "team_id": "WXYZ789012",
        "bundle_id": "com.example.wallet",
        "sandbox": true
      }
    }
  ]
}
```

**Field reference:**
- `app_id` (required): Unique identifier for the application
- `platform` (required): Push notification platform — `"apns"` or `"fcm"`
- `wallet_base_url` (required): HTTPS URL of the wallet service (e.g., `https://wallet.example.com`). The relay sends `DELETE {wallet_base_url}/messages/{uuid}` requests to this endpoint.
- `apns` (required for APNS): Apple Push Notification Service credentials
  - `key_file`: Path to APNS private key (`.p8` file)
  - `key_id`: APNS key ID
  - `team_id`: Apple Team ID
  - `bundle_id`: App bundle identifier
  - `sandbox`: Boolean (optional; defaults to `true`)
- `fcm` (required for FCM): Firebase Cloud Messaging credentials
  - `service_account_file`: Path to FCM service account JSON file

## API Endpoints

### POST /register
Device bootstrap and credential replenishment.

**Request:**
```json
{
  "app_id": "example-wallet",
  "push_token": "device-push-token",
  "count": 10
}
```

**Response (bootstrap):**
```json
{
  "device_credential": "...",
  "uuids": ["uuid-1", "uuid-2", ...]
}
```

**Response (replenishment):**
```json
{
  "uuids": ["uuid-1", "uuid-2", ...]
}
```

For new devices (no `Authorization` header), the relay generates a `device_credential` and returns it. For returning devices (with `Authorization: Bearer {device_credential}`), the relay validates the credential and returns only the new UUIDs.

### POST /deliver/{uuid}
Primary delivery endpoint. The wallet sends encrypted message blobs to the relay.

**Request:**
```json
{
  "blob": "..."
}
```

**Response:**
```json
{}
```

The relay attempts delivery in this priority order:
1. **SSE (Server-Sent Events)**: If the device has an active SSE connection (`GET /sse`), the blob is sent immediately.
2. **WebSocket**: If no SSE connection exists but the device has an active WebSocket (`GET /ws/{uuid}`), the blob is sent immediately.
3. **Silent push**: If neither SSE nor WebSocket is active, a silent push notification is sent to the device's registered push token.
4. **Pending queue**: The device can retrieve stored blobs later via `GET /pending`.

The blob is stored in Redis until acknowledged by the device via `POST /ack`.

### GET /ws/{uuid}
Inbound-only WebSocket delivery channel. The device opens a WebSocket to receive messages.

**Upgrade:** `GET /ws/{uuid}` with `Upgrade: websocket` header

**Protocol:**
- Opening this connection consumes the path UUID (`unused → active`) — that UUID is now the connection's identifier, not a future delivery target.
- The relay delivers blobs over this connection for `POST /deliver/{uuid}` calls against a *different*, still-unused UUID that shares the same `device_credential` — the same device-level channel model `GET /sse` uses, not an address keyed by this connection's own UUID.
- Any frames sent by the device are ignored.
- The connection is delivery-only — no wallet communication happens over WebSocket.
- On close (device disconnect or error), the UUID transitions `active → consumed` and the channel is removed.

**Close codes:**
- `4000`: Invalid UUID format
- `4004`: UUID not found
- `4010`: UUID already consumed or active (a connection is already open for this UUID)
- `1001`: Device disconnected (`GOING_AWAY`)
- `1011`: Internal error (e.g. Redis failure during state transition)

### GET /sse
Server-Sent Events delivery channel. The device subscribes to receive messages.

**Request:**
```
GET /sse
Authorization: Bearer {device_credential}
```

**Response:** `text/event-stream` with messages in the format:
```
data: {"uuid": "...", "blob": "..."}

```

The connection is kept alive with periodic heartbeats. Messages are sent as soon as they arrive via `POST /deliver/{uuid}`.

### GET /pending
Retrieve all unacknowledged messages stored for the device.

**Request:**
```
GET /pending
Authorization: Bearer {device_credential}
```

**Response:**
```json
{
  "messages": [
    {"uuid": "...", "blob": "..."},
    {"uuid": "...", "blob": "..."}
  ]
}
```

This endpoint is typically used when the device wakes up after being offline and wants to retrieve any missed messages.

### POST /ack
Acknowledge received messages and schedule deletion from the wallet.

**Request:**
```json
{
  "uuids": ["uuid-1", "uuid-2", ...]
}
```

**Response:**
```json
{}
```

The relay schedules staggered, random-delayed `DELETE {wallet_base_url}/messages/{uuid}` requests to the wallet for each acknowledged UUID. This prevents the wallet from observing a burst of deletions and inferring delivery timing.

### GET /health
Health check endpoint. Checks Redis (`PING`) and the SQLite device registry (`SELECT 1`) independently.

**Response — healthy:**
```json
{ "status": "ok", "redis": "ok", "sqlite": "ok" }
```
`200 OK`.

**Response — degraded:**
```json
{ "status": "degraded", "redis": "ok" | "error", "sqlite": "ok" | "error" }
```
`503 Service Unavailable` if either dependency is unreachable.

### POST /notify/{uuid} (deprecated)
This endpoint is deprecated and returns a `410 Gone` response. Use `POST /deliver/{uuid}` instead.

## Device credential model

Devices authenticate all requests (except `/register` bootstrap) with a bearer token in the `Authorization` header:
```
Authorization: Bearer {device_credential}
```

Credentials are 64-character hex strings generated by the relay during device bootstrap. They are stored in Redis with a TTL matching `UUID_TTL_SECONDS` and tracked in SQLite's device registry for administrative queries (e.g., active device counts, retention cleanup).

## Message storage

Blobs delivered via `POST /deliver/{uuid}` are stored in Redis, keyed by `device_credential`, until the device acknowledges them via `POST /ack`. This allows:
- **Silent push fallback**: If the device is offline during delivery, it can pull messages via `GET /pending`.
- **Multiple delivery channels**: The same device can maintain SSE and WebSocket connections simultaneously.
- **No loss**: A blob sent to the wrong device or missed due to network failure can be retrieved on wake.

## Device registry

The SQLite device registry (`DB_PATH`) tracks `push_token → app_id, last_registered_at`. Entries are retained for `DEVICE_REGISTRY_RETENTION_DAYS` (default 90 days) after the last registration, then pruned. This supports analytics and diagnostics without tracking individual message delivery or device state.

## Wallet integration

The relay communicates with the wallet service (configured in `config/apps.json` via `wallet_base_url`) in two ways:

1. **Inbound (primary)**: The wallet sends encrypted message blobs to `POST /deliver/{uuid}`.
2. **Outbound (staggered cleanup)**: The relay sends randomized `DELETE {wallet_base_url}/messages/{uuid}` requests to clear messages after the device acknowledges them.

The relay does not open any persistent connection to the wallet and does not support WebSocket communication with the wallet. All wallet integration happens via HTTPS.

## Running tests

Tests require a local Redis instance reachable at the URL specified by `REDIS_URL` (default `redis://localhost:6379`):

```bash
npm test
```

To run tests with a Redis instance in Docker:
```bash
docker run -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379
npm test
```
