# Notification Relay (superseded)

**This codebase is superseded by [`relay/`](../relay/README.md).**
The relay described here — Docker/Compose deployment, self-hosted Redis,
SQLite device registry, `POST /notify` — was never deployed to production.
It has been fully replaced by `relay/`'s serverless architecture
(Cloudflare Durable Objects + Redis Cloud + Cloudflare KV), per
[`plans/relay-serverless-migration-strategic-plan.md`](../plans/relay-serverless-migration-strategic-plan.md)
and its companion implementation plan.

The Docker/Compose deployment files (`Dockerfile`, `docker-compose.yml`,
`docker-compose.dev.yml`) have been removed
(`plans/milestones/relay-serverless-docker-retirement-pending.md`, confirmed
by the user 2026-07-03). The application source (`src/`, `tests/`) is
retained for reference only — it is not the supported deployment path and
should not be run in production. See
[`specs/process_specs/notification_relay.md`](../specs/process_specs/notification_relay.md)
and [`specs/object_specs/relay.md`](../specs/object_specs/relay.md) for the
current, authoritative spec, and [`relay/README.md`](../relay/README.md)
for how to actually deploy the relay today.
