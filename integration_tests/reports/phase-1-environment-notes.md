# Phase 1 Environment Notes

## Wallet-service under workerd: pooled pg connections don't survive across requests (2026-07-19)

**Status: resolved.** Full details in `plans/integration-testing-implementation-plan.md`'s
Step 1.7 amendment and `wallet-service/server/db/client.ts`'s doc comment —
not duplicated here. Summary: a module-scope `pg.Pool` reused across
requests (standard Node pattern, used by all ~37 `getPool()` call sites)
intermittently hung and got force-killed by the Workers runtime's watchdog
when a connection from one request got reused in a later, different
request (~50% failure rate on a plain health check, measured directly).
Confirmed local Hyperdrive emulation does not fix this — `wrangler dev`'s
`localConnectionString` is a passthrough with no pooling. Fixed by
returning a fresh, small (`max: 1`) `Pool` per call on the Workers runtime
instead of a cached singleton; `node-server`/`aws-lambda` keep the real
persistent pool. Confirmed 15/15 consecutive `/health` requests passing
after the fix (previously ~50% failure). `wallet-service/docs/
operations.md` had a stale claim that raw TCP sockets don't work under
Workers without Hyperdrive at all — corrected; the real constraint is
connection lifetime, not socket capability.

## Press under workerd: three real Workers-compatibility bugs, all fixed (2026-07-18)

**Status: resolved.** Full details and the fix for each are in
`specs/object_specs/press.md`'s 2026-07-18 amendment (§3.1–§3.3, config
table) and `plans/integration-testing-implementation-plan.md`'s Step 1.6
amendment — not duplicated here. Summary for anyone scanning this file:

1. `ioredis` (behind the KV `redis` driver) can't run under Workers'
   `nodejs_compat` — crashes on boot (`node:string_decoder` mock throws).
   Fixed: native `cloudflare-kv-binding` on the default preset.
2. `defineNitroPlugin`'s callback runs outside any request's execution
   context under Workers; workerd rejects async I/O there. A background
   promise not `await`ed from inside a request handler also silently stalls
   once that request ends (confirmed empirically, not just from docs).
   Fixed: startup checks deferred to an `await`ed `request` hook.
3. Startup RPC check hardcoded Arbitrum One (42161), so it always failed
   against the stack's Sepolia chain component. Fixed: new
   `EXPECTED_CHAIN_ID` config (readiness check only — `src/chain/
   {registry,gas}.ts`/`reconcile-cids.ts` still hardcode mainnet for
   transaction construction).

## Synapse policy module: watcher background loops throw at startup (2026-07-18)

**Status: noted, not fixed — not on the critical path.** Bringing up Synapse
+ the policy module in `integration_tests` (Phase 1 Step 1.5) surfaced a
real application-level bug, unrelated to the integration environment itself:
`PolicyModule.__init__` does start the Watcher's subscription/backstop
background loops (`matrix_policy_module/watcher.py`), and both immediately
throw `RuntimeError: no running event loop` (from `rpc_provider.py`'s
`connect()`), logged by Synapse's background-process wrapper. This doesn't
crash Synapse or block module loading — `Loaded module <PolicyModule ...>`
still logs successfully — so it didn't block Step 1.5's own acceptance
criteria (healthcheck passes, a test user can register and create a room,
policy module logs show it loaded). Likely a module-scheduling-before-the-
event-loop-starts ordering bug in how the watcher's loops get scheduled
relative to Twisted/asyncio setup. Left for whoever next touches
`matrix_policy_module`'s watcher wiring — reproducible by just bringing up
`synapse` in this stack and grepping its logs for `card-protocol-watcher`.

## Local Nitro devnode: deployment works, contract calls don't (2026-07-18)

**Status: deferred.** The integration stack's chain component now points at the
existing Arbitrum Sepolia deployment (`contracts/deployments/sepolia.json`)
instead of a local `nitro-devnode` container — see `docker-compose.yml`'s
`nitro-devnode`/`deploy-contracts` services, kept behind the `local-chain`
Compose profile rather than deleted, and `plans/integration-testing-strategic-plan.md`'s
Open Questions amendment. This note exists so the local-devnode path can be
picked back up later without re-deriving everything below.

### What was chased down and fixed

`logic-contract` (the largest of the three protocol contracts, ~56KB
compressed / ~210KB uncompressed WASM, split into 3 calldata fragments —
`verifier-module` and `storage-contract` are single-fragment) failed
`cargo stylus check`/`deploy` against a local `nitro-devnode --dev` container
with a bare `execution reverted, data: "0x"`, no matter what `ArbOwner`
size/cache-manager parameters were tuned.

Root cause, found by reading cargo-stylus's actual source
(`stylus-tools`' `core/deployment/mod.rs`): deploying a multi-fragment
contract calls `ArbOwnerPublic.getMaxStylusContractFragments()` first — and
per that code's own comment, "failing this call likely means the chain does
not support fragments (old ArbOS)". Confirmed directly: calling that
precompile method by hand reverted the same way. It only starts working once
the chain runs ArbOS 61+ — `nitro-node:v3.7.1` (the devnode tooling's own
pinned default) boots at ArbOS 40 and can't even be upgraded past ArbOS 41;
`nitro-node:v3.11.2` boots at ArbOS 59 and can be upgraded to 61 cleanly
(`ArbOwner.scheduleArbOSUpgrade(61, 0)`). Real Arbitrum Sepolia runs a far
newer ArbOS than either, which is why `logic-contract` deployed there fine
originally while every local-devnode attempt failed.

With `nitro-node:v3.11.2` + the ArbOS-61 upgrade + a registered WASM cache
manager + a raised `ArbOwner.setWasmMaxSize`, all three contracts deploy,
activate, and wire together successfully via real transactions — confirmed
twice end-to-end through `docker compose up deploy-contracts`.

### What's still broken: calling deployed contracts

Phase 1 Step 1.2's own "done when" criterion (a `cast call` against the
deployed logic contract succeeds) does not pass. Every read call into every
deployed Stylus contract on this devnode reverts — not just `logic-contract`,
not just multi-fragment contracts. Reproduced on `verifier-module`, the
smallest and simplest of the three, with zero cross-contract calls and a
function (`verify_secp256r1`) explicitly documented to never revert (invalid
input returns `false`).

Ruled out during investigation:

- **Not an activation problem.** `ArbWasm.programVersion(address)` and
  `programTimeLeft(address)` (precompile calls, which work fine) confirm the
  contract is genuinely activated — `programVersion` matches the chain's
  current `stylusVersion`, with ~1 year left before expiry.
- **Not read-vs-write or eth_call-vs-real-tx.** A real mined `cast send` to a
  pure getter fails identically to `cast call`/`eth_call`.
- **Not fragmentation-specific.** Reproduces on single-fragment
  `verifier-module` just as much as multi-fragment `logic-contract`.
- **Not application logic.** `verify_secp256r1` with all-zero dummy args
  still reverts despite its own doc guarantee against reverting.
- **Not an instant/dispatch-level rejection.** `debug_traceCall` shows real,
  contract-size-proportional gas consumption before the revert (52,790 gas
  for `verifier-module` vs. 68,106 for `storage-contract`) — consistent with
  a WASM trap partway through genuine execution, not an immediate rejection.
- **Not specific to how ArbOS 61 was reached.** Reproduces identically
  whether ArbOS 61 was reached via a live `scheduleArbOSUpgrade` or set
  natively at genesis via `--chain.info-json`.

### Where to pick this back up

Next diagnostic step, not yet tried: swap `nitro-devnode` (the lightweight
single-container tool) for `OffchainLabs/nitro-testnode` (the fuller
reference environment — sequencer + validator + L1) to see if this is
specific to the stripped-down devnode setup. That's a meaningfully heavier
environment to stand up than anything tried so far, which is why this was
deferred rather than pursued immediately.
