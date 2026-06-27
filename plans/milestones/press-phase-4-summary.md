# Press Phase 4 Milestone Summary

**Date:** 2026-06-26
**Status:** Complete

## Deliverables

### Step 4.1 — Startup validation hardening

`server/plugins/startup.ts` now runs a 4-step startup sequence before marking the press ready:
1. `loadConfig()` — all required env vars + ML-DSA-44 key byte length
2. `checkFilebaseHealth()` — HeadObject probe against configured bucket
3. Arbitrum One RPC — `getChainId()` verifies the endpoint returns chain ID 42161
4. Press authorization advisory check — warns (non-fatal) if press is not yet authorized under any policy

`GET /health` returns `503` until all checks pass, with the failing check description in the `error` field.

### Step 4.2 — KV backend: Nitro useStorage adapter

`server/utils/kv.ts` — `createNitroKvStore()` wraps Nitro's `useStorage('press')` with the `KvStore` interface. The driver (configured in `nitro.config.ts` as `redis`) provides persistence across cold starts. `increment()` is implemented as getItem+setItem (non-atomic; acceptable for rate-limit counters).

`server/plugins/startup.ts` now uses `createNitroKvStore()` instead of the Phase 3 in-memory store.

### Step 4.3 — CID reconciliation task

`server/tasks/reconcile-cids.ts` (fully implemented):
- Reads `press:reconcile:last_block` checkpoint from KV (defaults to current block on first run)
- Fetches `CardRegistered` and `CardHeadUpdated` events from Arbitrum One in 2000-block batches using viem `getLogs`
- Extracts `initial_log_cid` / `new_log_cid` from each event
- Pins each CID via Filebase Pinning API (`POST https://api.filebase.io/v1/ipfs/pins`), idempotent (HTTP 409 = already pinned, treated as success)
- Advances checkpoint only on full success (no partial checkpointing that would skip blocks)
- Scheduled every 6 hours via `nitro.config.ts`

### Step 4.4 — Remaining API endpoints

- **`GET /press`** — returns `press_card_cid`, `policy_cids`, `address` (on-chain hex), and `log_heads` (KV-backed per-policy log head CIDs, null if not yet cached)
- **`GET /app-gas/:address`** — returns `balance_wei`, `last_funded_at`, `last_debited_at` from KV

### Step 4.5 — P-11 implementation

`handleUpdate` now calls `verifier.verifyCard(updater_card_address)` for field update codes (1xx–7xx) and throws `P-11` if the updater's chain does not reach a trusted root.

### Step 4.6 — Operator documentation

`press/OPERATOR.md` covers:
- Deployment commands (Node.js, Lambda, Cloudflare Workers)
- Full env var reference (required + optional)
- First-run checklist (keypair generation, press card issuance, governance registration, Filebase setup, wallet funding)
- Key rotation for both key types (secp256r1 and ML-DSA-44), including zero-downtime approach
- KV store backup and recovery table (per-key-prefix recoverability)
- CID reconciliation bootstrap instructions
- App gas account management
- Troubleshooting guide for common operator errors

---

## Error Code Coverage (all P-xx codes)

```
P-01 ✓  P-02 ✓  P-03 ✓  P-04 ✓  P-05 ✓  P-06 ✓
P-07 ✓  P-08 ✓  P-09 ✓  P-10 ✓  P-11 ✓  P-12 ✓
P-13 ✓  P-14 ✓  P-15 ✓  P-16 ✓  P-17 ✓  P-18 ✓
P-19 ✓  P-20 ✓  P-21 ✓  P-22 ✓  P-24 ✓
```

All 23 press error codes (P-01 through P-24, excluding P-23 which is not defined in the spec) appear in at least one test's expected output.

## Test summary

107 tests pass across 8 test files. Phase 4 added 17 new tests (16 in `errors.test.ts` + 1 P-11 test via `update` handler).

## Items not implemented (out of scope for this phase)

- **CP-5 (integration tests against anvil)**: requires a deployed registry contract on a local chain; deferred until the Stylus contract build is stable.
- **Full `ancestry_pubkeys` chain walk**: populating this field correctly requires the press to hold the entire ancestry chain in IPFS, which requires decrypted card documents — not accessible to the press. Phase 4+ defines this as a holder-supplied field.
- **E2E-encrypted auditor notifications**: auditors receive plaintext JSON in Phase 4; encryption requires per-auditor ML-DSA-44 pubkey resolution from their CardDocument on IPFS (correct path exists but adds latency).
