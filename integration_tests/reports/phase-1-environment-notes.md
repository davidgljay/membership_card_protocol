# Phase 1 Environment Notes

## Press's chain integration: real on-chain writes never worked (2026-07-20)

**Status: resolved — and this is the headline finding of Phase 2's fixtures
work.** Building `integration_tests/fixtures`' `mintCard` helper (2.1 —
"a fixture helper can produce a signed card accepted by the live press")
required exercising press's real `POST /issue` → `POST /issue/finalize` →
on-chain `RegisterCard` path for the first time against a genuinely live
stack. It had never actually worked. Six distinct, independent bugs had to
be found and fixed, in order, before a single card could be minted
end-to-end:

1. **`issuer_signature`/`holder_signature`/`press_signature` wire format
   didn't match `protocol-objects.md`'s `CardDocument` spec.** Press
   expected `{ public_key, signature }` objects; the spec (and
   `membership_card_verifier`'s own types, and `app-sdk`'s real
   `assembleAndSignTargetedOffer`) define these as bare base64url strings,
   with the issuer's public key coming from `ancestry_pubkeys[0]` instead.
   This meant **press's `/issue` endpoint could not accept an offer built
   by the actual client SDK** — the exact class of bug this whole
   environment exists to catch. Also found and fixed the same pattern in
   `OpenCardOffer`/`OpenOfferClaimSubmission` (`open-offer.ts`), which
   shares the assembly code path. Fixed in `press/src/types.ts`,
   `src/functions/issuance.ts`, `src/handlers/open-offer.ts`; press's own
   `issuance.test.ts`/`errors.test.ts` updated to match (they'd encoded
   the same wrong convention).
2. **`registry.ts`'s ABI used the wrong function-name casing everywhere.**
   Every function was declared `PascalCase` or `snake_case`
   (`RegisterCard`, `get_protocol_version`); Stylus SDK converts Rust's
   snake_case to **camelCase** for real ABI dispatch — confirmed via a raw
   `eth_call` against the live contract (the camelCase selector for
   `getCardEntry` returns valid data; every name as originally written
   reverts). This is the same class of bug as an already-documented
   logic→storage contract mismatch fixed 2026-06-22, this time in press's
   own client code rather than a cross-contract `sol_interface!`. Every
   on-chain call press made — every read and every write — was reverting.
3. **Several write functions were missing a `press_address` parameter
   entirely** (`registerCard`, `updateCardHead`, `claimOpenOffer`,
   `registerSubCard`, `deregisterSubCard`, `batchUpdateCardHeads`), and
   `Vec<u8>` fields were declared as Solidity `bytes` instead of the
   `uint8[]` Stylus actually uses (each byte padded to a 32-byte word).
   `registry_contract.md`'s own ASCII diagrams turned out to be
   simplified/inaccurate in several places (missing params, and
   `BatchUpdateCardHeads`'s `UpdateItem[]` is actually three parallel
   arrays on the wire) — not reliable as the wire-level source of truth.
   Fixed by rebuilding `REGISTRY_ABI` (split into `LOGIC_ABI`/`STORAGE_ABI`
   — see point 4) directly from `cargo stylus export-abi`'s real output
   for both contracts, the actual ground truth.
4. **Two read functions the client called (`getOpenOfferUseCount`,
   `getSubCardEntry`) don't exist on the logic contract's ABI at all** —
   only on the storage contract. Per `registry_contract.md §1`, the
   storage contract's address is "the stable protocol identifier" that
   never changes across logic upgrades, so — rather than patch just those
   two — **all reads now go through storage, not logic**, added as a new
   `STORAGE_CONTRACT_ADDRESS` config field. This is also more correct
   going forward: reads through logic would otherwise silently break on
   every future logic upgrade even for the calls logic does mirror.
5. **`press_address` is `bytes32` on-chain, but press passed a raw 20-byte
   Ethereum address.** `write_gate.rs` confirmed it's purely an opaque
   `PressAuthorizations[policy][press]` lookup key (the actual signature
   check is against a separately-stored `press_public_key`, unrelated to
   this value) — fixed by left-padding to 32 bytes, matching Solidity's
   standard `address → bytes32` conversion
   (`bytes32(uint256(uint160(address)))`).
6. **A `PositionOutOfBoundsError` decoding `getCardEntry`/
   `getPressAuthorization`/`getSubCardEntry`.** Any multi-value return that
   includes a `uint8[]` gets ABI-encoded with an extra 32-byte outer tuple
   offset that a plain comma-separated `returns (...)` declaration doesn't
   account for — the exact issue already documented in project memory for
   a contracts-side Foundry test, now hit again in press's own ABI. Fixed
   by declaring the return as a single named tuple
   (`returns ((uint8[] x, ...) r)`) — note viem's human-readable-ABI
   parser rejects the `tuple(...)` keyword `cast` accepts; plain
   parentheses are required.

None of this was reachable by press's own unit test suite (all mocked)
or by anything in Phase 1, which never drove a real on-chain write. Every
one of these was found only by actually running `POST /issue/finalize`
against the live Sepolia deployment and reading real revert data/RPC
errors — this is precisely Goal 3's "the first run against real
components mostly finds pre-existing issues, not test bugs" playing out.

**Separately, also found and fixed while getting this far:**

- **`crypto.createCipheriv` is not implemented under Workers'
  `nodejs_compat`** (`aes256gcmEncrypt`/`aes256gcmDecrypt` in
  `press/src/functions/crypto.ts`) — the same class of gap as Phase 1's
  `ioredis` finding, just a different Node API `unenv` doesn't polyfill.
  Fixed by switching to `crypto.subtle` (WebCrypto, native to Workers and
  available in Node 22+), mirroring the pattern `wallet-service`'s
  `WebCryptoBackend` already uses. WebCrypto's AES-GCM `encrypt` already
  returns ciphertext with the tag appended, so the on-disk/IPFS wire
  format (`nonce(12) || ciphertext || tag(16)`) is unchanged — no other
  component needs to change to keep decrypting these.
- **`registry.ts`/`gas.ts` hardcoded viem's `arbitrum` (mainnet, chain ID
  42161) chain object for transaction construction even when
  `ARBITRUM_RPC_URL` points at Sepolia** — a gap already flagged (not
  fixed) during Step 1.6's press work. It turned out to matter for real:
  `eth_sendRawTransaction` rejects a transaction whose signed chain ID
  doesn't match the RPC endpoint's ("Missing or invalid parameters"),
  which only surfaces once a real write is attempted — reads (`eth_call`)
  carry no chain ID and were unaffected, which is why nothing caught this
  until now. Fixed by deriving the `chain` object from `EXPECTED_CHAIN_ID`
  in both files. `server/tasks/reconcile-cids.ts` still hardcodes
  `arbitrum` — not fixed, out of scope for the write path this covers.

**The Sepolia deployment itself was also stale and had to be redeployed.**
`getProtocolVersion()` reverted even after the ABI-casing fix — confirmed
independently via a raw `eth_call` bypassing press entirely. Root cause:
the function's own doc comment says "contracts deployed before §4.17 was
added are treated as v0.1," implying it was added to source *after* the
2026-06-28 deployment; if the deployed WASM simply doesn't contain that
function's dispatch entry, any call to it hits Stylus's unrecognized-
selector fallback and reverts regardless of the defensive Rust-level
logic, since that logic never executes. The correct fix — a logic-only
upgrade via `proposeLogicUpgrade`/`confirmLogicUpgrade`, which preserves
`storage_contract`'s state — has a mandatory **7-day timelock**, too slow
to unblock testing. Did a full fresh three-contract deployment instead
(explicit tradeoff, authorized: the 2026-06-28 deployment had no real
users/value, so abandoning its state was acceptable). New addresses in
`contracts/deployments/sepolia.json`; the superseded record (including its
DNS bootstrap) is preserved at `sepolia-2026-06-28-superseded.json`. The
fresh deployment has **not** re-run DNS bootstrap — only a minimal
`registerPolicy`/`authorizePress` for the fixtures' own test policy and
press's on-chain identity. Every service's `REGISTRY_CONTRACT_ADDRESS`
(and press's new `STORAGE_CONTRACT_ADDRESS`) updated to match.

**Confirmed working end-to-end**, twice consecutively: `integration_tests/
fixtures`' `mintCard` helper signs a real offer with `app-sdk`, POSTs
through `/issue` and `/issue/finalize`, and press successfully registers
the new card on real Sepolia — full spec-conformant signing, ABI encoding,
and chain submission all correct.

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
