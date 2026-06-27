# Press Operator Guide

**Version:** 0.1 — matches press spec v0.3 (Nitro serverless, Filebase IPFS, external KV store)

---

## Overview

A **press** is the service that validates, co-signs, publishes, and registers cards on behalf of a policy. It runs as a stateless Nitro serverless application. All durable state (rate limits, offer records, log heads, app gas balances) is stored in an external key-value store. IPFS pinning is provided by Filebase.

---

## Deployment

The press is a standard Nitro application. Build for your target platform, then deploy with the environment variables listed below.

**Self-hosted Node.js:**
```bash
NITRO_PRESET=node-server pnpm build
node .output/server/index.mjs
```

**AWS Lambda:**
```bash
NITRO_PRESET=aws-lambda pnpm build
# Deploy .output/ to Lambda with your preferred tooling (SST, Serverless Framework, CDK, etc.)
```

**Cloudflare Workers:**
```bash
NITRO_PRESET=cloudflare-pages pnpm build
```

All secrets are injected as environment variables. Key material is never written to disk or logged.

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `PRESS_CARD_CID` | CID of this press's `CardDocument` on IPFS. Issued by the governance body that authorized this press. |
| `PRESS_POLICY_CIDS` | Comma-separated list of policy card CIDs this press is authorized under. |
| `PRESS_MLDSA44_PRIVATE_KEY` | Base64url-encoded ML-DSA-44 private key (2560 bytes). This is the press's IPFS content-signing identity. **Never log or expose this value.** |
| `PRESS_SECP256R1_PRIVATE_KEY` | Hex-encoded secp256r1 private key (64 hex chars, `0x` prefix optional). Used for on-chain write authorization. **Never log or expose this value.** |
| `ARBITRUM_RPC_URL` | Arbitrum One RPC endpoint. Example: `https://arb1.arbitrum.io/rpc` |
| `REGISTRY_CONTRACT_ADDRESS` | Address of the registry storage contract on Arbitrum One. |
| `FILEBASE_KEY` | Filebase S3 access key. |
| `FILEBASE_SECRET` | Filebase S3 secret key. |
| `FILEBASE_BUCKET` | Filebase bucket name for IPFS content pinning. |
| `EXTERNAL_KV_URL` | Connection URL for the external KV store (Redis, Upstash, etc.). Example: `redis://localhost:6379` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `FILEBASE_GATEWAY_URL` | `https://ipfs.filebase.io` | Filebase IPFS gateway for content fetches. |
| `PORT` | `3000` | HTTP port (self-hosted Node.js only). |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |
| `MAX_BATCH_SIZE` | `100` | Maximum cards per `BatchUpdateCardHeads` call. |
| `STALENESS_WINDOW_SECONDS` | `300` | Maximum age of revocation data before press rejects issuance. |

---

## First-Run Checklist

1. **Generate press keypairs** (if not already done):

   ```bash
   # ML-DSA-44 private key (run this in a secure environment):
   node -e "
     const { ml_dsa44 } = require('@noble/post-quantum/ml-dsa.js');
     const kp = ml_dsa44.keygen();
     console.log('PRIVATE (base64url):', Buffer.from(kp.secretKey).toString('base64url'));
     console.log('PUBLIC (base64url):', Buffer.from(kp.publicKey).toString('base64url'));
   "
   
   # secp256r1 private key:
   node -e "
     const { generatePrivateKey } = require('viem/accounts');
     console.log('SECP256R1_PRIVATE_KEY:', generatePrivateKey());
   "
   ```

2. **Issue the press card** — send the ML-DSA-44 public key to the governance body. They will issue a `CardDocument` for the press and give you its CID (`PRESS_CARD_CID`).

3. **Register on-chain** — the governance body calls `AuthorizePress` on the registry contract, registering your secp256r1 public key under each policy you will serve. You must be registered before the press can submit writes.

4. **Create a Filebase bucket** — log in to Filebase, create a bucket with IPFS enabled, and note the bucket name.

5. **Set up the KV store** — provision a Redis-compatible store (Upstash, Redis Cloud, AWS ElastiCache, etc.) and note the connection URL.

6. **Fund the press Arbitrum wallet** — the press's on-chain address is `keccak256(secp256r1_pubkey)`. It must hold enough ETH to cover gas for card registrations and updates. Keep at least 0.01 ETH as a buffer.

7. **Deploy and verify** — after deploying, call `GET /health`:
   ```bash
   curl https://your-press.example.com/health
   # Expected: {"status":"ok"}
   ```
   If `status` is `"starting"`, the `error` field explains which check failed.

---

## Health Check

`GET /health` returns:

- `200 {"status":"ok"}` — all startup checks passed; press is operational.
- `503 {"status":"starting","error":"..."}` — startup in progress or a check failed.

The startup sequence checks in order:
1. All required environment variables are present and well-formed.
2. ML-DSA-44 private key decodes to 2560 bytes.
3. Filebase bucket is reachable (authenticated `HeadObject` call).
4. Arbitrum One RPC is responsive (checks chain ID matches Arbitrum One = 42161).

If any check fails, the press does not open its HTTP listener and `GET /health` returns 503 with the failing check in the `error` field.

---

## Key Rotation

### secp256r1 (on-chain authorization key)

Rotate when: key is compromised or during routine rotation.

1. Generate a new secp256r1 private key.
2. Compute the corresponding public key (64-byte uncompressed x||y).
3. Ask the Press Registry Governance Body to call `AuthorizePress` with your press address and the new public key.
4. Wait for the transaction to confirm.
5. Redeploy the press with the new `PRESS_SECP256R1_PRIVATE_KEY`. `next_sequence` resets to 0 on-chain automatically.
6. Verify the new key is active: `GET /press` should show the press address unchanged; on-chain writes should succeed.

### ML-DSA-44 (IPFS identity key)

Rotate when: key is compromised or during planned rotation.

> **Important:** Cards previously issued under the old press card remain valid. Only new issuances use the new press card.

1. Generate a new ML-DSA-44 keypair.
2. Ask the governance body to issue a new press `CardDocument` using the new public key. They will give you a new `PRESS_CARD_CID`.
3. Ask the governance body to update each policy's `approved_presses` list to include the new press card CID and call `AuthorizePress` to register the new ML-DSA-44 key hash.
4. Redeploy with `PRESS_MLDSA44_PRIVATE_KEY` and `PRESS_CARD_CID` set to the new values.
5. The old press card CID can remain in `approved_presses` during the transition if you need zero downtime.

---

## KV Store Backup and Recovery

The press stores durable state in the external KV store. Data classes by recoverability:

| Key prefix | Data | Recoverable? |
|---|---|---|
| `press:log_head:*` | Current IPFS log head per policy | Yes — re-read from on-chain `CardEntry` |
| `press:offer:*` | In-flight issuance offers | No — lost offers require requester to resubmit |
| `press:rate:*` | Rate-limit counters | No — counters reset; operators may see temporary over-limit bypass |
| `press:policy_writes:*` | Per-policy write counters | No — same as above |
| `press:app_gas:*` | App gas account balances | No — use on-chain ETH transfer events to reconstruct |
| `press:reconcile:last_block` | CID reconciliation checkpoint | Yes — set to contract deploy block to re-run full reconciliation |

**Recommended:** Use a durable, replicated KV backend (Upstash with global replication, Redis Cluster, etc.). For production, enable persistence (RDB/AOF on Redis or Upstash Durable Storage).

**To restore after full KV loss:**
1. Redeploy the press. `press:log_head:*` will be reconstructed on first read from on-chain.
2. Set `press:reconcile:last_block` to the registry contract deploy block number to trigger a full CID reconciliation on the next scheduled run.
3. Rate limit counters are lost; monitor for unusual activity in the first 7-day window after restore.

---

## CID Reconciliation

The press runs a scheduled task every 6 hours that reads all `CardRegistered` and `CardHeadUpdated` events from the registry contract and ensures every CID is pinned in Filebase. This ensures the press holds pins for cards it did not originally publish (e.g., cards from another press under the same policy).

**On first deployment:** The reconciliation task bootstraps from the current block, so it will not catch up on historical cards. To backfill:

1. Find the block number at which the registry contract was deployed.
2. Set `press:reconcile:last_block` in your KV store to that block minus 1:
   ```bash
   redis-cli SET press:reconcile:last_block <deploy_block_minus_1>
   ```
3. The next reconciliation run will process the full event history.

**To trigger a manual run** (self-hosted Node.js only):
```bash
curl -X POST https://your-press.example.com/_nitro/tasks/reconcile-cids
```

---

## App Gas Accounts

Apps pre-fund sub-card operations (RegisterSubCard) by sending ETH to the press's Arbitrum One address with their `app_card_address` (keccak256 of their ML-DSA-44 public key, hex-encoded) in the transaction calldata.

Check an app's current balance:
```bash
curl https://your-press.example.com/app-gas/0x<app_card_address>
# Returns: {"app_card_address":"0x...","balance_wei":"...","last_funded_at":...}
```

The press's Arbitrum One address is returned by `GET /press` in the `address` field. Apps should send ETH to this address.

**ETH transfer monitoring** runs as part of the scheduled block polling (see `src/chain/gas.ts`). If an app's balance is not updated after funding, check that the transaction calldata contains exactly 32 bytes (64 hex chars) encoding their app card address.

---

## Troubleshooting

**`GET /health` returns `{"status":"starting","error":"Filebase: ...bucket..."}` **

The press cannot reach Filebase. Check:
- `FILEBASE_KEY`, `FILEBASE_SECRET`, and `FILEBASE_BUCKET` are correct.
- The bucket exists and has IPFS enabled.
- Network connectivity to `s3.filebase.com`.

**`GET /health` returns `{"error":"ARBITRUM_RPC_URL: RPC not responding"}`**

The Arbitrum One RPC is unreachable. Check:
- `ARBITRUM_RPC_URL` is correct.
- Your RPC provider is operational (check provider status page).
- If using a rate-limited endpoint, check your quota.

**`GET /health` returns 503 but shows `{"status":"starting"}` indefinitely**

The startup plugin crashed before setting `pressReady = true`. Check process logs for the error.

**Press logs `Warning: press is not currently authorized under any configured policy`**

The press's secp256r1 public key has not been registered via `AuthorizePress` on-chain. Card writes will fail with contract revert until the governance body registers the press. This is a warning, not a startup failure — the press is functional for read operations.

**On-chain writes fail with `SEQUENCE_MISMATCH`**

The press's `next_sequence` value is out of sync. The press automatically retries once with a fresh sequence fetch. If retries continue to fail, another process may be sharing the same secp256r1 key — do not run two press deployments with the same key.

**Card issuance fails with `P-10`**

The CID returned by Filebase did not match the content that was uploaded. This may indicate a transient Filebase issue. Retrying the issuance request is safe.
