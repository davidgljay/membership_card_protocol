# Phase 1 (Integration Testing) Milestone Summary — the docker stack

Part of `plans/integration-testing-implementation-plan.md`. Full rationale:
`plans/integration-testing-strategic-plan.md`.

## Summary

`docker compose up --wait` in `integration_tests/` brings up the full
default stack — IPFS (Kubo), press and wallet-service under real
workerd/`wrangler dev`, relay + redis, Synapse + the policy module, and each
service's own Postgres/migration containers — to a healthy state
repeatably from a clean volume in ~27s (measured twice), well under the
5-minute target. Both Workers services' `/health` endpoints were verified
directly (not just via the Docker healthcheck) under sustained polling:
press and 15/15 consecutive wallet-service requests both returned
`{"status":"ok",...}`. Two real Workers-runtime bugs (ioredis crashing
under `nodejs_compat`, and a `pg.Pool` not surviving connection reuse
across separate Workers requests) were found and fixed this phase — exactly
the class of bug this environment was built to catch, since neither would
have surfaced against a plain `node-server` preset. The chain component and
the SDK-harness half of the original Goal 1 wording were deliberately
descoped from what "done" means for this phase — see below.

## Goal 1 checklist, against the strategic plan's actual wording

- **"Nitro dev node with contracts deployed" — descoped to Sepolia, not
  done as originally scoped.** Deploying fresh Stylus contracts onto a
  local `nitro-devnode` works end-to-end (confirmed twice), but every call
  into a deployed contract on it reverts — a genuine WASM-execution bug,
  unrelated to the protocol contracts, root-caused but not fixed (see
  `reports/phase-1-environment-notes.md`'s "Local Nitro devnode" entry for
  the full investigation and where to pick it back up). Per explicit
  instruction mid-phase, the default stack now points at the existing
  Arbitrum Sepolia deployment (`contracts/deployments/sepolia.json`)
  instead; the local-devnode path is kept working and reachable via
  `docker compose --profile local-chain up`, not deleted. **Practical
  effect:** the stack is not self-contained for chain state — it depends on
  Sepolia's continued availability and the deployed contracts' continued
  correctness, and can't be run fully offline. Tracked as backlog (Task
  #17) if worth revisiting later, e.g. via `nitro-testnode` instead of
  `nitro-devnode`.
- **IPFS node — done**, Kubo, direct (no MinIO shim — see below).
- **Press (workerd) — done.** Real `NITRO_PRESET=cloudflare-module` build
  under `wrangler dev`. Two Workers-compatibility bugs found and fixed
  (`ioredis` crash, plugin global-scope I/O) plus one integration-specific
  fix (hardcoded chain ID) — see `specs/object_specs/press.md`'s
  2026-07-18 amendment.
- **Wallet-service (workerd) — done.** Same pattern; one different
  Workers-compatibility bug found and fixed (pooled `pg.Pool` connections
  not surviving across requests) — see `wallet-service/server/db/
  client.ts`'s doc comment and this file's environment-notes entry.
- **Relay + redis — done.** Adapted directly from `relay/docker-compose.yml`
  with a minimal `apps.json`.
- **Synapse + policy module — done**, healthcheck passing, a module
  loads successfully. One non-blocking application bug noted, not fixed
  (Watcher background loops throw at startup — doesn't crash Synapse or
  block module loading; see environment notes).
- **All passing healthchecks — done**, plus a `stack-ready.sh` script for
  polling an already-running stack from outside the `docker compose up`
  invocation itself (for Phase 2's suites/CI).
- **Web/RN SDK harnesses completing a scripted end-to-end call — not
  started.** This is explicitly Phase 2 scope per the implementation
  plan's own phase breakdown (`## Phase 2: Harnesses and fixtures`), not
  Phase 1's deliverable (`docker compose up brings up chain + contracts,
  IPFS, MinIO, press, wallet-service, relay+redis, Synapse — all healthy` —
  no harness clause). The strategic plan's Goal 1 bullet list predates that
  phase split and reads as if harnesses were Phase 1 scope; they aren't,
  per the implementation plan that actually governs execution order.
- **Cold start under ~5 minutes — done,** ~27s measured (two clean-state
  `docker compose up --wait` runs), far inside target.

## Deviations from the original plan, and why

- **MinIO dropped.** Superseded by press's pluggable `IpfsPinningProvider`
  abstraction (a `kubo` implementation that talks to Kubo's HTTP API
  directly), built this phase specifically so a MinIO-backed S3 shim
  faking Filebase's CID-metadata behavior wouldn't be needed. See the
  IPFS-provider-abstraction commit and `specs/object_specs/press.md`.
- **Chain: Sepolia instead of local devnode + fresh deploy.** Covered
  above.

## Service naming / env-var conventions — checked, consistent

- Every service with its own Postgres follows `<service>-postgres`; every
  one-shot init/migration container follows `<service>-init` (Synapse) or
  `<service>-migrate` (wallet-service) — same pattern, different verb
  because one renders config and the other runs schema migrations.
- `ARBITRUM_RPC_URL` and `REGISTRY_CONTRACT_ADDRESS` are named identically
  across all three consumers (press, synapse-init, wallet-service).
  `IPFS_GATEWAY_URL` is likewise identical across synapse and
  wallet-service; press uses `KUBO_API_URL`/`KUBO_GATEWAY_URL` instead —
  intentionally provider-specific (its `IpfsPinningProvider` abstraction
  supports non-Kubo providers with different config shapes), not an
  inconsistency.
- Press, wallet-service, and relay's internal container port is `3000` for
  all three (the convention their own codebases already used), exposed on
  distinct host ports (3001/3002/3000 respectively) to avoid collisions —
  consistent internal-port convention, deliberately distinct external ones.
- One real gap found and fixed during 1.8: wallet-service reads
  `IPFS_GATEWAY_URL` (like press does) but had no `depends_on: ipfs`,
  unlike press. Added for consistency.

## Workerd limitations discovered this phase

Full details in `integration_tests/reports/phase-1-environment-notes.md`;
summarized here since they're this phase's main finding:

1. `ioredis` (redis KV driver's dependency) cannot run under Workers'
   `nodejs_compat` — crashes at module load (`node:string_decoder` mock
   throws). Only surfaces under a real Workers runtime, not `node-server`.
2. A Nitro plugin's callback body runs outside any request's execution
   context under Workers — async I/O there is rejected outright, and even
   moving it into a `request` hook isn't enough unless the triggering
   request actually `await`s it; an un-awaited background promise silently
   stalls once that request's own handler returns.
3. A `pg.Pool` cached and reused across separate Workers requests
   (the standard Node pattern) intermittently hangs and gets force-killed
   by the runtime's watchdog when a connection from one request is reused
   in a later, different request (~50% failure rate, measured directly) —
   documented Cloudflare/pg behavior, not fixed by local Hyperdrive
   emulation either.

None of these three would have been caught running either service under
its `node-server` preset instead — they're specific to workerd's execution
model, which is exactly the reproduction-fidelity case
`plans/integration-testing-strategic-plan.md`'s Goal 1 rationale argues
for over the simpler alternative.

## What's next

Phase 2 (`plans/integration-testing-implementation-plan.md`'s next
section): web and RN SDK harnesses, each completing a scripted end-to-end
call against this stack, plus the shared fixtures package. `stack-ready.sh`
(added this phase) is what those harnesses/suites should poll rather than
re-invoking `docker compose up` themselves.
