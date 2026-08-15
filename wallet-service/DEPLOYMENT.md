# Wallet Service — Deployment

This document covers automated deployment to Cloudflare Workers via
`scripts/deploy.sh`. For operational concerns after deployment (audit log
signals, federation peer management, admin endpoints, scheduled tasks), see
[`docs/operations.md`](./docs/operations.md) — this file only covers what
the deploy script itself needs.

> **Production status:** per `docs/operations.md`, production deployment
> approval is pending CP-3's independent security review
> (`docs/security-review-cp3.md`). `scripts/deploy.sh prod` is functional but
> should not be run against real production infrastructure until that review
> clears — see the Phase 1 clarification checkpoint in
> `plans/deployment/implementation-plan.md`.

## Prerequisites

- A Cloudflare account with Workers enabled.
- A Postgres instance per environment (schema managed by `node-pg-migrate`).
  The deployed Worker connects to it directly over `nodejs_compat` TCP — see
  `docs/operations.md`'s "Deployment" section for why this works without
  Hyperdrive, and its per-request-connection caveat.
- A KV namespace per environment (`WALLET_KV` binding) if you intend to run
  `KV_BACKEND=cloudflare-kv`; not required if using `KV_BACKEND=postgres`.
- This instance's federation identity already generated (`WALLET_SERVICE_ID`,
  `WALLET_SERVICE_PRIVATE_KEY`) — see `.env.example`'s Federation section for
  how to generate an ML-DSA-44 keypair.

## Fixed: stale `main` path in `wrangler.toml`

`wrangler.toml`'s `main` used to point at `.output/server/index.mjs`, but
`nitro.config.ts` keys the build output directory off `NITRO_PRESET`
(`.output-${NITRO_PRESET}`) to prevent the `cloudflare-module`/`node-server`/
`aws-lambda` presets from silently overwriting each other's build artifact.
Since the default preset is `cloudflare-module`, the real build output lands
at `.output-cloudflare-module/server/index.mjs` — `wrangler deploy` would
have failed with a missing-file error against the old path. Fixed as part of
this deploy script's introduction; `main` now points at
`.output-cloudflare-module/server/index.mjs`, and `scripts/deploy.sh` always
builds with `NITRO_PRESET=cloudflare-module` before deploying so that path
exists. `.gitignore` was also missing a pattern for `.output-*/` (only
`.output/` was listed) — fixed alongside.

## Running the deploy script

```bash
cd wallet-service
./scripts/deploy.sh dev    # or: ./scripts/deploy.sh prod
```

The script:
1. Validates every required env var below is set, failing loudly with the
   full list of what's missing if not.
2. Runs `node-pg-migrate up` against `DATABASE_URL` — migrations always run
   before the new code deploys.
3. Builds with `NITRO_PRESET=cloudflare-module`.
4. Pushes each env var as a Worker secret via `wrangler secret put --env
   <environment>`.
5. Runs `wrangler deploy --env <environment>`, and fails the run if wrangler
   uploads the script but attaches it to no route/workers.dev target (same
   check as `press/scripts/deploy.sh` and `relay-deploy.yml`).

Environment is always an explicit argument — the script never infers it from
branch name or hostname.

## Required environment variables

### Authenticate the `wrangler` CLI (not injected into the Worker)

| Variable | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers Scripts edit permission for the target account. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id the Worker deploys under. |

### Injected into the deployed Worker (`wrangler secret put`)

These are exactly the names tested in
`.github/workflows/wallet-service-ci.yml`'s `env:` block — a value proven to
work in CI works here unchanged. Full descriptions are in `.env.example`;
summarized here:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string, per environment. Also used locally by this script to run migrations. |
| `SECRETS_BACKEND` | `webcrypto` or `kms` — see `.env.example`'s Secrets backend section. |
| `WEBCRYPTO_MASTER_KEY` | Required when `SECRETS_BACKEND=webcrypto`: base64url 32-byte AES key. Never commit; store as a platform secret only. |
| `SESSION_TOKEN_SECRET` | HMAC secret signing/verifying session tokens. |
| `KV_BACKEND` | `postgres` (works everywhere) or `cloudflare-kv` (requires the `WALLET_KV` binding to exist in the target account). |
| `WEBAUTHN_RP_ID` | WebAuthn relying party id — must match the real public hostname. |
| `WEBAUTHN_ORIGIN` | WebAuthn expected origin — must match the real public hostname. |
| `WALLET_SERVICE_ID` | This instance's federation identity: `0x` + keccak256 of its ML-DSA-44 public key. |
| `WALLET_SERVICE_ENDPOINT` | This instance's own public endpoint, announced to federation peers. |
| `WALLET_SERVICE_PRIVATE_KEY` | ML-DSA-44 secret key signing federation messages. Never commit; store as a platform secret only. |
| `PEER_LIST` | JSON array of federation peers. `[]` for a single-instance deployment. |
| `RELAY_BASE_URL` | Base URL of the relay this instance delivers `POST /deliver/{uuid}` calls to. |
| `ADMIN_API_KEY` | Bearer token gating `/admin/*`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `ARBITRUM_RPC_URL` | Read-only Arbitrum RPC endpoint for subcard resolution. |
| `REGISTRY_CONTRACT_ADDRESS` | Same registry contract press/ writes to, per environment. |

### Out of scope for this script

The Matrix/Synapse subsystem (`MATRIX_SERVER_NAME`,
`MATRIX_MEMBERSHIP_REGISTRY_PATH`, `ARBITRUM_RPC_WS_URL`, etc.) deploys as a
separate Docker service via `wallet-service/docker-compose.yml`, not via
`wrangler deploy` — it is not covered by this script or by
`scripts/deploy-all.sh` (Phase 2). See `matrix-implementation-plan.md` and
`docker-compose.yml`'s `synapse` service for its own deployment path.
`IPFS_GATEWAY_URL`, `JOIN_ATTESTATION_FRESHNESS_SECONDS`, and
`WATCHER_BACKSTOP_INTERVAL_SECONDS` have safe defaults per `.env.example` and
are not required here.

## Per-environment config

`wrangler.toml` defines `[env.dev]` and `[env.prod]` blocks, each with its
own Worker name (`wallet-service-dev` / `wallet-service`) and its own
`WALLET_KV` namespace id. Provision each namespace (only needed if using
`KV_BACKEND=cloudflare-kv`) with:

```bash
npx wrangler kv namespace create WALLET_KV --env dev
npx wrangler kv namespace create WALLET_KV --env prod
```

and replace the corresponding `REPLACE_WITH_..._KV_NAMESPACE_ID` placeholder
in `wrangler.toml`.

## First-time setup

1. Provision Postgres for the target environment; set `DATABASE_URL`.
2. Generate this instance's federation keypair (see `.env.example`'s
   Federation section) and set `WALLET_SERVICE_ID` /
   `WALLET_SERVICE_PRIVATE_KEY`.
3. Set the remaining required env vars above in your shell (local dry run)
   or as GitHub Environment secrets named `dev`/`prod`.
4. Run `./scripts/deploy.sh dev` (or `prod`, once the CP-3 security review
   has cleared).
5. Verify with `curl https://<your-wallet-service-host>/bindings` (returns
   the routing table; unauthenticated by design) or check the deployed
   Worker's logs for successful startup.

## Dry run without deploying

```bash
npx wrangler deploy --env dev --dry-run
```
