# Docker/Compose Retirement — Pending File List (Phase 3.3)

**Status:** Proposed, NOT executed. No files listed below have been deleted
or modified as part of this document being written.

Per the implementation plan's explicit Clarification Checkpoint
(`plans/relay-serverless-migration-implementation-plan.md`, "Before
deleting the Docker/Compose files (3.3): show the user the exact file list
and get explicit confirmation before removal"), this document is that file
list, produced for the user's review. It is a report, not an action.

## Context

Per implementation plan step 3.3: "This is not a live cutover — the
Docker/Compose path was built but never deployed to production, so there's
no traffic to drain or fallback to preserve." That's confirmed still true
as of this writing — nothing in `relay/` has ever been deployed to
production. Decision #5 in the implementation plan's decisions table
("Cutover scope") calls for full cutover once the new architecture
(`relay-next/`) is validated; decision #6 notes there is no live traffic to
migrate, so no canary/blue-green/rollback rehearsal is needed for the
retirement itself.

**However**, per the Phase 3 milestone review (see
`plans/milestones/relay-serverless-phase-3-summary.md`), the new
architecture is not yet fully validated — no real Redis Cloud database has
been provisioned, and `relay-next/` has not yet been deployed to a real
Cloudflare account. Retiring `relay/`'s Docker/Compose path before that
validation is complete would leave no working deployment path at all if an
unexpected blocker surfaces in `relay-next/`'s first real deploy. This file
list is therefore being recorded now (per the plan's Phase 3.3 step) but
its execution should wait for the user's explicit go-ahead, informed by
that validation status.

## Exact file list proposed for removal

```
relay/Dockerfile
relay/docker-compose.yml
relay/docker-compose.dev.yml
```

One path per line, with rationale:

- `relay/Dockerfile` — builds the Docker image for the old Node/Express
  (non-serverless) relay service (`node:20-alpine` multi-stage build →
  `node dist/server.js`). Docker-deployment-specific; nothing outside the
  Docker/Compose path references this file.
- `relay/docker-compose.yml` — the production Compose topology: the `relay`
  service (built from the Dockerfile above) plus a self-hosted `redis:7-alpine`
  container (`--save "" --appendonly no`) and a `db_data` volume for the
  SQLite device registry. This is the file the migration's whole premise
  (Redis Cloud + Cloudflare KV replacing a self-hosted Redis container and a
  volume-backed SQLite file) makes obsolete.
- `relay/docker-compose.dev.yml` — the local-dev Compose overlay (hot-reload
  via `tsx watch`, plus a `redis-commander` inspection UI container).
  Docker-deployment-specific; `relay-next/`'s local dev path (`node-server`
  preset, `npm run dev`) replaces this and needs no Docker at all.

## What is explicitly NOT on this list, and why

These files live in the same `relay/` directory and are Docker-*adjacent*
but are not Docker/Compose-*deployment*-specific — they're also read
directly by the plain Node process (`node dist/server.js` / `tsx watch`),
so removing the Docker path does not make them obsolete on their own:

- `relay/.env`, `relay/.env.example` — environment variables consumed
  directly by the Node process (`REDIS_URL`, `APP_REGISTRY_PATH`, `RELAY_ID`,
  etc., per `relay/README.md`'s "Environment variables" table), not
  Docker-specific.
- `relay/config/apps.json`, `relay/config/secrets/` — the app registry and
  push credential files, bind-mounted into the container in the Docker path
  but read from the same relative location by a non-Docker `node` process
  too.
- `relay/.gitignore` — generic ignore rules (`node_modules/`, `dist/`,
  `.env`, `*.db`, `config/secrets/`), not Docker-specific.
- No `.dockerignore` file exists anywhere under `relay/` — checked, none
  found, so there is nothing of that kind to add to this list.
- No separate self-hosted-Redis container config file exists — the
  `redis:7-alpine` image and its startup flags (`--save "" --appendonly
  no --maxmemory-policy noeviction`) are inlined directly in
  `docker-compose.yml`'s `redis:` service block above, not a separate file.

## What retiring these three files would also require (not part of this list, flagged for completeness)

Per the implementation plan's "done when" for step 3.3 ("the README no
longer references Docker/Compose as a supported deployment path"):
`relay/README.md` itself documents the Docker/Compose flow in detail
("Prerequisites," "Quick start," "Production," "Running tests" all assume
Docker) and would need to be rewritten or removed alongside these three
files, not left dangling and referencing files that no longer exist. That
rewrite is not attempted here — it's a consequence of executing this list,
not a file to delete outright, and is called out so it isn't missed if/when
the user confirms removal.

## Explicitly out of scope for this document

Per the task's constraints, nothing under `relay/` beyond identifying this
list was touched. `relay/src/`, `relay/tests/`, `relay/package.json`, and
the rest of the old Node/Express implementation are not addressed here —
whether/when to retire the application code itself (as opposed to its
Docker/Compose deployment wrapper) is a separate decision not covered by
implementation plan step 3.3, which is scoped specifically to "the
Docker/Compose files and self-hosted Redis container."

## Next step

Awaiting the user's explicit confirmation to delete the three files listed
above (and, at that point, decide how to handle `relay/README.md`'s
Docker-flow documentation). No deletion should happen without that
confirmation, per the plan's Clarification Checkpoint.
