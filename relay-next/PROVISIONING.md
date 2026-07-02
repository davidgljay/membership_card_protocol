# Redis Cloud Provisioning Checklist

**Status:** Not yet provisioned. This is a checklist for the user (account/billing
owner) to execute, per
`plans/relay-serverless-migration-implementation-plan.md` step 1.3 and the
plan's Clarification Checkpoint: *"before provisioning any paid Redis Cloud
database or Cloudflare resource that incurs cost, confirm plan/tier with the
user."* No paid resources have been created as part of this work — this
document only describes what needs to be created and how to verify it once
it is.

This will be folded into the main README in Phase 3 (`plans/relay-serverless-migration-implementation-plan.md`
step 3.1); it is written here first so the exact steps are captured while
fresh, per that step's stated context dependency on "exact steps taken in 1.3."

---

## Why two databases

Per `plans/relay-serverless-migration-strategic-plan.md` (resolved question
#2) and the implementation plan's decisions table: the relay needs two
Redis Cloud databases with **deliberately different persistence settings**,
matching the split already described in `specs/object_specs/relay_data_model.md`
today (the current architecture uses one no-persistence Redis + a separate
durable SQLite file; this migration replaces the SQLite half with a second,
persistence-on Redis Cloud database rather than moving it to Cloudflare D1
or KV — see the amended `relay_data_model.md` §1, §9 for the finalized
per-store rationale).

| Database | Persistence | Holds |
|---|---|---|
| **Primary** | RDB **off**, AOF **off** | UUID records (`uuid:*`), device credentials (`cred:*`), message blobs (`messages:*`), pending delete queue (`pending_deletes`) — everything the relay's core privacy invariant says must never be durably recoverable |
| **Secondary** | Persistence **on** (RDB and/or AOF enabled per Redis Cloud's standard durable configuration) | Device registry only: `push_token`, `app_id`, `last_registered_at` — deliberately durable, needed to trigger re-registration after a primary-database reset (relay.md §9) |

**Do not consolidate these into one database.** The whole reason for the
split is that the device registry must survive a reset the UUID/message
store must not survive. A single database cannot have both properties at
once.

---

## Checklist

### 1. Redis Cloud account / subscription

- [ ] Confirm plan/tier with the user before creating anything (Clarification
      Checkpoint in the implementation plan). Redis Cloud's free/trial tier
      may not support disabling both RDB and AOF, or may not support TLS
      enforcement — verify the chosen tier supports all the requirements
      below before provisioning.
- [ ] Decide region/placement to minimize latency to the Cloudflare Workers
      edge locations this relay will run in (relay.md §8's latency note
      assumes "same cloud provider or data center" — Redis Cloud is not
      Cloudflare-hosted, so some added latency versus that assumption should
      be expected and is worth measuring once both are live).

### 2. Primary database (persistence OFF)

- [ ] Create a new Redis Cloud database.
- [ ] Explicitly disable **RDB snapshotting** (no snapshot schedule
      configured).
- [ ] Explicitly disable **AOF (Append-Only File)** persistence.
- [ ] Enable **TLS** and set it to **enforced** (reject plaintext
      connections) — Redis Cloud requires this to be turned on explicitly
      and it is mandatory once enabled (per the strategic plan's summary of
      Redis Cloud's TLS model).
- [ ] After creation, connect and run:
      ```
      CONFIG GET save
      CONFIG GET appendonly
      ```
      Confirm `save` returns an empty string and `appendonly` returns `no`.
      This is the same verification the original relay's self-hosted Redis
      used (`--save "" --appendonly no`) — Redis Cloud's managed console
      may present these as toggles rather than raw config flags; use
      whatever the console/API exposes, but verify via `CONFIG GET`
      directly against the running instance, not just the console's stated
      setting, before trusting it.
- [ ] Confirm a plaintext (non-TLS) connection attempt is rejected (this is
      also asserted by an automated test in Phase 2 step 2.1 — the manual
      check here is to catch a misconfiguration before that test exists).
- [ ] Generate the connection string / credentials. Store as a secret (see
      "Secrets" below) — **never commit this to the repository.**

### 3. Secondary database (persistence ON, device registry)

- [ ] Create a second, separate Redis Cloud database.
- [ ] Leave persistence **enabled** (Redis Cloud's standard durable
      configuration — RDB and/or AOF per whatever the plan/tier defaults
      to; the requirement here is "durable," not a specific persistence
      mechanism).
- [ ] Enable **TLS**, enforced, same as the primary.
- [ ] Generate the connection string / credentials. Store as a secret,
      separate from the primary's.
- [ ] No `CONFIG GET save`/`appendonly` verification needed here — this
      database is *supposed* to persist.

### 4. Secrets

- [ ] Store both connection strings as secrets in whatever secret store
      the deployment pipeline uses (Phase 3 will wire this into GitHub
      Actions / `wrangler secret` — see `plans/relay-serverless-migration-implementation-plan.md`
      step 3.2). Suggested environment variable names, to be finalized
      against the updated `relay_data_model.md` §environment-variables
      section:
      - `REDIS_PRIMARY_URL` (no-persistence database)
      - `REDIS_REGISTRY_URL` (persistence-on database, device registry)
- [ ] Confirm neither connection string is ever written to a file tracked
      by git (`.env`, `.env.local`, `.dev.vars`, `wrangler.toml` `[vars]`,
      etc. — all already covered by `.gitignore` conventions used
      elsewhere in this repo, e.g. `press/.gitignore`; `relay-next/.gitignore`
      already excludes `.env*`).

### 5. Post-provisioning verification (do once both databases exist)

- [ ] Connect to the primary from a local script or `redis-cli` over TLS;
      confirm read/write works and `CONFIG GET save` / `CONFIG GET
      appendonly` show disabled.
- [ ] Connect to the secondary; confirm read/write works.
- [ ] Record actual latency from a Cloudflare Worker (or a location close
      to one) to both databases — needed context for Phase 2's storage
      layer implementation and for revisiting the relay.md §8 latency
      note once this architecture is live.
- [ ] Update this checklist (or its Phase 3 README incarnation) with the
      actual region/tier chosen and any deviations from the above.

---

## What this document does NOT cover

- Cloudflare Workers/Durable Objects provisioning (wrangler bindings,
  account setup, custom domain) — a parallel checklist, not yet written;
  Phase 1 scope per the implementation plan covers only the Redis Cloud
  side of provisioning documentation (step 1.3). Cloudflare-side
  provisioning documentation is Phase 3 (step 3.1) scope, once Phase 2's
  actual DO/Worker code exists to provision bindings for.
- Push credential (APNs/FCM) provisioning — unchanged from the current
  relay's app registry model; not part of this migration's scope.
