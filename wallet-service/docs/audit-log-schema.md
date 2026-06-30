# Audit Log Schema

**Status:** Implemented (implementation-plan.md §Step 6.2)

All audit events are structured JSON, one event per line, emitted via `server/utils/audit-log.ts`'s `auditLog(level, event, fields)`. Every line has the shape:

```json
{ "event": "<event_name>", "level": "info" | "warn" | "error", ...fields, "timestamp": "<ISO 8601>" }
```

## Events

| Event | Level | Fields | Emitted by |
|---|---|---|---|
| `account_created` | info | `card_hash` | `POST /accounts` |
| `service_secret_created` | info | `card_hash` | `POST /accounts`, `PUT /accounts/{card_hash}/keyring` (rotation issues a new one) |
| `service_secret_accessed` | info | `card_hash`, `session_token_id` | `GET /accounts/{card_hash}/service-secret` |
| `keyring_rotated` | info | `card_hash` | `PUT /accounts/{card_hash}/keyring` |
| `backup_registration_created` | info | `card_hash`, `type`, `backup_id` | `POST /accounts/{card_hash}/backups` |
| `recovery_initiated` | info | `card_hash`, `recovery_id` | `POST /accounts/{card_hash}/recovery` |
| `recovery_cancelled` | info | `recovery_id` | `POST /recovery/{recovery_id}/cancel` |
| `recovery_key_released` | info | `recovery_id` | `GET /recovery/{recovery_id}/release` |
| `binding_announcement_processed` | info | `card_hash`, `peer_wallet_id`, `outcome` (`accepted` \| `rejected_conflict`) | `POST /bindings/announce` |
| `binding_announcement_rejected` | warn | `card_hash`, `peer_wallet_id`, `outcome` (verification failure reason \| `nonce_replay`) | `POST /bindings/announce` |
| `rate_limit_exceeded` | warn | `key`, `limit`, `window_seconds` | `server/utils/enforce-rate-limit.ts` (all rate-limited endpoints) |
| `secrets_backend_failure` | error | `operation` (`encryptSecret` \| `decryptSecret`), `card_hash`, `error` | Anywhere `SecretsService` is called |

`session_token_id` is `sha256(token)` (see `src/auth/session-token.ts`'s `sessionTokenId`) — never the raw token. `key` in `rate_limit_exceeded` is always either a non-reversible hash (hashed IP, via `hashIp`) or an already-opaque identifier (`card_hash`, `subcard_hash`, `session_token_id`, `wallet_service_id`) — never a raw IP or session token.

## Explicit prohibitions (enforced by `test/audit-log-schema.test.ts`)

The following **must never appear** in any log line, metric, trace, or database record:

- IP addresses or any network identifier, for any device IO endpoint (inbound messages, UUID registration, sub-card registration — `server/routes/messages/**`, `server/routes/cards/**`). `test/audit-log-schema.test.ts` asserts these route files never call `getRequestIP` or read `x-forwarded-for` at all.
- Raw session tokens (only `session_token_id`, the non-reversible hash, is permitted).
- Any data linking `subcard_hash` to a device, IP, or session. `test/audit-log-schema.test.ts` asserts no `console.*` call in a device IO route file ever interpolates the `subcardHash` variable — `subcard_hash` may appear in route-level identifiers/keys (e.g. as a rate-limit bucket key, or in a UUID-pool log's aggregate count), but never inside a logged message alongside IP/session/device data.
- Request/response bodies for device-facing endpoints. `test/audit-log-schema.test.ts` asserts no `console.*` call in a device IO route file references the request body variable wholesale.
- Fine-grained timing data that could correlate device check-in patterns to card activity.

**The wallet service must not be able to determine which cards are held on which devices.** This is a hard architectural invariant (strategic-plan.md §Goal 3), not a best-effort privacy measure — any future instrumentation, debugging tool, admin endpoint, or monitoring query must be checked against it before being added. If an operator needs to debug delivery failures, use aggregate metrics (delivery success rate per card, not per device) — never a query that joins `subcard_hash` against anything device-identifying.

## Non-audit operational logs

Several routes also emit plain, non-JSON `console.info`/`console.warn` lines for operational visibility (e.g. `[wallet-service] message received card_hash=...`, federation keyring replication, UUID pool operations, scheduled task results). These are not part of the formal audit trail above but are held to the same prohibitions — every one of them was reviewed against the explicit-prohibitions list during Phases 4-6 and contains only `card_hash`, aggregate counts, or opaque ids, never IP/session/device-correlating data.
