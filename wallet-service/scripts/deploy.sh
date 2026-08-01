#!/usr/bin/env bash
# Runs migrations, builds, and deploys wallet-service to Cloudflare Workers
# for a given environment.
#
# Usage: scripts/deploy.sh <dev|prod>
#
# Required env vars — see wallet-service/DEPLOYMENT.md for what each one is.
# Names match .github/workflows/wallet-service-ci.yml's tested env block
# exactly, so a value that works in CI works here. This script fails loudly
# and lists every missing var in one pass rather than stopping at the first.
set -euo pipefail

ENVIRONMENT="${1:-}"
if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <dev|prod>" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Authenticates the wrangler CLI itself (not injected into the Worker).
WRANGLER_AUTH_VARS=(
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
)

# Same names as wallet-service-ci.yml's tested `env:` block. Matrix/Synapse
# federation vars (MATRIX_SERVER_NAME, MATRIX_MEMBERSHIP_REGISTRY_*, etc.)
# are deliberately excluded here -- Synapse is a separate docker-compose
# service (wallet-service/docker-compose.yml), not part of this Worker
# deploy; see DEPLOYMENT.md's "Out of scope" section.
WORKER_ENV_VARS=(
  DATABASE_URL
  SECRETS_BACKEND
  WEBCRYPTO_MASTER_KEY
  SESSION_TOKEN_SECRET
  KV_BACKEND
  WEBAUTHN_RP_ID
  WEBAUTHN_ORIGIN
  WALLET_SERVICE_ID
  WALLET_SERVICE_ENDPOINT
  WALLET_SERVICE_PRIVATE_KEY
  PEER_LIST
  RELAY_BASE_URL
  ADMIN_API_KEY
  ARBITRUM_RPC_URL
  REGISTRY_CONTRACT_ADDRESS
)

missing=()
for var in "${WRANGLER_AUTH_VARS[@]}" "${WORKER_ENV_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -ne 0 ]]; then
  echo "::error::Missing required env var(s) for wallet-service $ENVIRONMENT deploy:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  echo "" >&2
  echo "See wallet-service/DEPLOYMENT.md for what each one is and how to obtain it." >&2
  echo "Deploy will NOT be attempted until all required vars are present." >&2
  exit 1
fi

echo "All required vars present. Running migrations against DATABASE_URL..."
npx node-pg-migrate up --migrations-dir server/db/migrations --database-url-var DATABASE_URL

echo "Building wallet-service (cloudflare-module preset)..."
NITRO_PRESET=cloudflare-module npx nitro build

echo "Setting Worker secrets for env=$ENVIRONMENT..."
for var in "${WORKER_ENV_VARS[@]}"; do
  printf '%s' "${!var}" | npx wrangler secret put "$var" --env "$ENVIRONMENT"
done

echo "Deploying wallet-service ($ENVIRONMENT)..."
output=$(npx wrangler deploy --env "$ENVIRONMENT" 2>&1) || { echo "$output" >&2; exit 1; }
echo "$output"

# `wrangler deploy` exits 0 even when the script uploads but is attached to
# no route/workers.dev target -- see relay-deploy.yml's identical check.
if echo "$output" | grep -qi "No targets deployed"; then
  echo "::error::wrangler deploy uploaded the script but attached it to no target (workers.dev or routes). Check workers_dev/routes in wallet-service/wrangler.toml." >&2
  exit 1
fi

echo "wallet-service deployed successfully to $ENVIRONMENT."
