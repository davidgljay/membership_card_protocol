# Press — Deployment

This document covers automated deployment to Cloudflare Workers via
`scripts/deploy.sh`. For operational concerns after deployment (key rotation,
KV backup/recovery, troubleshooting, CID reconciliation), see
[`OPERATOR.md`](./OPERATOR.md) — this file only covers what the deploy script
itself needs.

## Prerequisites

- A Cloudflare account with Workers enabled.
- A KV namespace per environment (`PRESS_KV` binding — see `wrangler.toml`).
- A Filebase account with an IPFS-enabled bucket (see `OPERATOR.md`'s
  "First-Run Checklist" for how to create one).
- The press's ML-DSA-44 and secp256r1 keypairs already generated, and the
  press already registered with the governance body (`PRESS_CARD_CID`
  issued, `AuthorizePress` called on-chain) — the deploy script does not
  perform registration, only deployment.

## Running the deploy script

```bash
cd press
./scripts/deploy.sh dev    # or: ./scripts/deploy.sh prod
```

The script:
1. Validates every required env var below is set, failing loudly with the
   full list of what's missing if not.
2. Builds with `NITRO_PRESET=cloudflare-module`.
3. Pushes each Worker secret via `wrangler secret put --env <environment>`.
4. Runs `wrangler deploy --env <environment>`, and fails the run if wrangler
   uploads the script but attaches it to no route/workers.dev target (a
   known wrangler footgun — see the relay's equivalent check in
   `relay-deploy.yml` for precedent).

Environment is always an explicit argument — the script never infers it from
branch name or hostname.

## Required environment variables

### Authenticate the `wrangler` CLI (not injected into the Worker)

| Variable | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers Scripts edit permission for the target account. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id the Worker deploys under. |

### Injected into the deployed Worker (`wrangler secret put`)

Ground truth is `src/config.ts`'s `loadConfig()` (its `requireEnv()` calls),
not `OPERATOR.md`'s "Required" table — that table turned out to be stale and
missing four vars `config.ts` requires unconditionally (press exits at
startup without them): `PRESS_GAS_WALLET_PRIVATE_KEY`,
`PRESS_OHTTP_PRIVATE_KEY`, `STORAGE_CONTRACT_ADDRESS`, and
`PRESS_ADMIN_API_KEY`. Found while porting a dev-tests suite that needs the
admin API — see `plans/deployment/phase-3-summary.md`. `EXTERNAL_KV_URL` is
excluded here on purpose — that variable only applies to the `redis` KV
driver used by the `node-server`/`aws-lambda` presets (see
`nitro.config.ts`). This script always builds the `cloudflare-module`
preset, which uses the `PRESS_KV` binding provisioned per-environment in
`wrangler.toml` instead.

| Variable | Description |
|---|---|
| `PRESS_CARD_CID` | CID of this press's `CardDocument` on IPFS. |
| `PRESS_POLICY_CIDS` | Comma-separated list of policy card CIDs this press is authorized under. |
| `PRESS_MLDSA44_PRIVATE_KEY` | Base64url-encoded ML-DSA-44 private key. **Never log or expose.** |
| `PRESS_SECP256R1_PRIVATE_KEY` | Hex-encoded secp256r1 private key, registered in `PressAuthorizations` on-chain. Used only for signing press payloads — does not pay gas. **Never log or expose.** |
| `PRESS_GAS_WALLET_PRIVATE_KEY` | Hex-encoded Ethereum wallet private key that holds ETH and pays gas for on-chain transactions — separate from the identity key above. **Never log or expose.** |
| `PRESS_OHTTP_PRIVATE_KEY` | Base64url-encoded 32-byte X25519 HPKE private key, used to decapsulate/encapsulate the oblivious-relay-routed endpoints. **Never log or expose.** |
| `ARBITRUM_RPC_URL` | Arbitrum RPC endpoint (Arbitrum One for prod; Arbitrum Sepolia for dev, per the strategic deployment plan). |
| `REGISTRY_CONTRACT_ADDRESS` | Logic contract address (upgradeable, all write operations), per environment. |
| `STORAGE_CONTRACT_ADDRESS` | Storage contract address — the stable protocol identifier that never changes across logic upgrades; all reads go here. Distinct from `REGISTRY_CONTRACT_ADDRESS` above. |
| `FILEBASE_KEY` | Filebase S3 access key. |
| `FILEBASE_SECRET` | Filebase S3 secret key. |
| `FILEBASE_BUCKET` | Filebase bucket name — use separate dev/prod buckets so dev pinning never touches prod content. |
| `PRESS_ADMIN_API_KEY` | Bearer token gating the operator-facing `/api/admin/*` endpoints (trusted-root registration, app gas crediting). Never share with end users, apps, or federation peers. |
| `EXPECTED_CHAIN_ID` | The chain ID `startup.ts` expects `ARBITRUM_RPC_URL` to resolve to — **not operator-supplied**: this script derives and pushes it automatically (`421614` for dev/Arbitrum Sepolia, `42161` for prod/Arbitrum One), listed here only so `config.ts`'s `loadConfig()` and this table stay in sync. `config.ts`'s own default (`42161`) is prod-only-safe; leaving a dev deploy on that default makes `startup.ts`'s chain-ID check fail permanently and the Worker gets stuck returning `503` forever (found live while running dev-tests against a real deploy). |

See `OPERATOR.md`'s "Optional" table (`FILEBASE_GATEWAY_URL`, `LOG_LEVEL`,
`MAX_BATCH_SIZE`, `STALENESS_WINDOW_SECONDS`), `FILEBASE_ENDPOINT`,
`FILEBASE_REGION` (all have safe defaults in `config.ts`) for variables
this script does not require setting.

## Per-environment config

`wrangler.toml` defines `[env.dev]` and `[env.prod]` blocks, each with its own
Worker name (`press-dev` / `press-prod`) and its own `PRESS_KV` namespace id
— dev and prod state never share a KV namespace. Provision each namespace
once with:

```bash
npx wrangler kv namespace create PRESS_KV --env dev
npx wrangler kv namespace create PRESS_KV --env prod
```

and replace the corresponding `REPLACE_WITH_..._KV_NAMESPACE_ID` placeholder
in `wrangler.toml` with the id each command prints.

## First-time setup

1. Complete `OPERATOR.md`'s "First-Run Checklist" (keypair generation,
   governance registration, Filebase bucket, gas funding) for the target
   environment.
2. Create the environment's KV namespace (see above) and update
   `wrangler.toml`.
3. Set the required env vars above in your shell (local dry run) or as
   GitHub Environment secrets named `dev`/`prod` (CI — see
   `plans/deployment/strategic-plan.md` Open Question 3).
4. Run `./scripts/deploy.sh dev` (or `prod`).
5. Verify with `curl https://<your-press-host>/health` — expect
   `{"status":"ok"}` (see `OPERATOR.md`'s "Health Check" section for what
   each startup check verifies and what a `503` means).

## Dry run without deploying

To validate config and bindings without actually deploying:

```bash
npx wrangler deploy --env dev --dry-run
```

This resolves `[env.dev]`'s bindings and reports the upload size without
pushing anything to Cloudflare.
