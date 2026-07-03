# Relay Storage Provisioning Checklist

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

**Changed 2026-07-02:** the device registry moved from a second Redis Cloud
database to Cloudflare KV (`relay_data_model.md` v0.6, §1 and §5). This
document previously described provisioning two Redis Cloud databases; it now
describes provisioning one Redis Cloud database plus one Cloudflare KV
namespace. The rationale: the free Redis Cloud tier — used for the test
deployment — disables persistence by default, which is exactly wrong for a
device registry that's supposed to survive a primary-database reset, and
there was no technical requirement that this store specifically be Redis.
Cloudflare KV is free at this scale, durable by platform default, and its
native per-key TTL removes the separate weekly pruning job the old design
needed. See `relay_data_model.md` §1 for the full comparison.

---

## Why two different storage systems

Per `plans/relay-serverless-migration-strategic-plan.md` and the
implementation plan's decisions table: the relay needs two stores with
**deliberately different durability characteristics**, matching the split
described in `specs/object_specs/relay_data_model.md` §1:

| Store | Technology | Durability | Holds |
|---|---|---|---|
| **Redis Cloud (primary)** | Redis Cloud, RDB **off**, AOF **off** | RAM only | UUID records (`uuid:*`), device credentials (`cred:*`), message blobs (`messages:*`), pending delete queue (`pending_deletes`) — everything the relay's core privacy invariant says must never be durably recoverable |
| **Cloudflare KV** | Cloudflare KV, accessed via Nitro's `storage()` | Durable by platform default | Device registry only: `push_token`, `app_id`, `last_registered_at`, with a 90-day TTL — deliberately durable, needed to trigger re-registration after a primary-database reset (relay.md §9) |

**Do not put device registry data in the primary Redis Cloud database, and
do not disable KV's default durability.** The whole reason for the split is
that the device registry must survive a reset the UUID/message store must
not survive. Conveniently, this pairing also means the free tier of each
service already matches what's required: Redis Cloud's free tier defaults
to no persistence (correct for the primary), and Cloudflare KV is durable
by default with no configuration needed (correct for the registry) — unlike
the previous two-Redis-Cloud-database design, there is no tier mismatch to
work around for either store.

---

## Checklist

### 1. Redis Cloud account / subscription (primary database only)

- [ ] Confirm plan/tier with the user before creating anything (Clarification
      Checkpoint in the implementation plan). The free tier's
      persistence-off default is exactly what the primary database needs,
      so free tier is viable for both test and — pending a decision on
      throughput/support needs — potentially production too. Re-evaluate
      for production based on latency/throughput requirements, not on a
      persistence-setting mismatch (that concern no longer applies now that
      only one Redis Cloud database is needed).
- [ ] Verify the free tier's TLS support specifically (see §2's TLS
      checklist item).
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

### 3. Cloudflare KV namespace (device registry)

- [ ] Confirm you're authenticated to the intended Cloudflare account
      (`npx wrangler whoami`, or `npx wrangler login` if not — see the
      Cloudflare test-deployment instructions already shared for this
      project).
- [x] Create the KV namespace — **done 2026-07-02.** Binding name
      `mcard_relay`, namespace id `cdf75d4cac1b416d81a8ea508ce49bf5`. (The
      binding name is just what gets written into `wrangler.toml` and what
      `storage()` code refers to — it doesn't have to match the namespace's
      display name; `mcard_relay` is fine as-is, no need to recreate it to
      match this document's earlier suggested name.)
- [ ] Add the binding to `relay-next/wrangler.toml` (not yet created —
      this happens once Phase 2 scaffolds the main Worker entry, not in
      `spike-do-ws/wrangler.toml`, which doesn't touch the device registry):
      ```toml
      [[kv_namespaces]]
      binding = "mcard_relay"
      id = "cdf75d4cac1b416d81a8ea508ce49bf5"
      ```
      A `preview_id` (for `wrangler dev`/local testing against a separate
      preview namespace) can be added later by running
      `npx wrangler kv namespace create mcard_relay --preview` if wanted;
      not required to proceed.
- [ ] Configure Nitro's `storage()` to use this binding under the
      `cloudflare` preset (`nitro.config.ts` — Phase 2 implementation
      detail, `unstorage`'s `cloudflare-kv-binding` driver reads the
      binding named above automatically). No connection string or secret
      is needed for KV — it's wired as a binding, not a credential.
- [ ] For local development under the `node-server` preset, configure
      `storage()` with a different unstorage driver (filesystem or
      in-memory) instead — this store needs no Redis Cloud or Cloudflare
      credentials at all for local dev, which is a portability improvement
      over the previous second-Redis-Cloud-database design.
- [ ] Verify TTL behavior once the storage layer is implemented (Phase 2):
      write a test key with a short TTL (KV's minimum is 60 seconds),
      confirm it's readable immediately and gone after the TTL elapses.
      This is the property this store exists for — worth confirming
      directly rather than assuming the `ttl` option is wired correctly.

### 4. Secrets

- [ ] Store the primary database's connection string as a secret in
      whatever secret store the deployment pipeline uses (Phase 3 will wire
      this into GitHub Actions / `wrangler secret` — see
      `plans/relay-serverless-migration-implementation-plan.md` step 3.2).
      Suggested environment variable name (matches
      `relay_data_model.md` §9): `REDIS_PRIMARY_URL`.
- [ ] Confirm the connection string is never written to a file tracked
      by git (`.env`, `.env.local`, `.dev.vars`, `wrangler.toml` `[vars]`,
      etc. — all already covered by `.gitignore` conventions used
      elsewhere in this repo, e.g. `press/.gitignore`; `relay-next/.gitignore`
      already excludes `.env*`). The KV namespace `id`/`preview_id` in
      `wrangler.toml` under `[[kv_namespaces]]` are not secrets (they're
      resource identifiers, not credentials) and are fine to commit.

### 5. Post-provisioning verification (do once both are set up)

- [ ] Connect to the primary Redis Cloud database from a local script or
      `redis-cli` over TLS; confirm read/write works and `CONFIG GET save`
      / `CONFIG GET appendonly` show disabled.
- [ ] Confirm the KV namespace is reachable via `wrangler kv key
      put`/`get` against the created namespace.
- [ ] Record actual latency from a Cloudflare Worker (or a location close
      to one) to the Redis Cloud database — needed context for Phase 2's
      storage layer implementation and for revisiting the relay.md §8
      latency note once this architecture is live. (KV is Cloudflare-native
      and colocated with Workers, so no equivalent cross-provider latency
      concern applies to it.)
- [ ] Update this checklist (or its Phase 3 README incarnation) with the
      actual Redis Cloud region/tier chosen and any deviations from the
      above.

---

## What this document does NOT cover

- The rest of Cloudflare Workers/Durable Objects provisioning (account
  setup, custom domain, Cron Trigger configuration) — a parallel checklist,
  not yet written; Phase 1 scope per the implementation plan covers only
  the storage-provisioning side (step 1.3). The remaining Cloudflare-side
  provisioning documentation is Phase 3 (step 3.1) scope, once Phase 2's
  actual DO/Worker code exists to provision the rest of the bindings for.
- Push credential (APNs/FCM) provisioning — unchanged from the current
  relay's app registry model; not part of this migration's scope.
