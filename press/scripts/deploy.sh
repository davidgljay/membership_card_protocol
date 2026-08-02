#!/usr/bin/env bash
# Deploys the press to Cloudflare Workers for a given environment.
#
# Usage: scripts/deploy.sh <dev|prod>
#
# Required env vars — see press/DEPLOYMENT.md for what each one is and how
# to obtain it. This script fails loudly and lists every missing var in one
# pass rather than stopping at the first, so a first-time setup doesn't need
# to re-run once per missing var to discover the next one.
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

# Injected into the deployed Worker via `wrangler secret put`. Ground truth
# is press/src/config.ts's loadConfig() (requireEnv calls), not
# press/OPERATOR.md's "Required" table -- that table turned out to be stale
# and missing PRESS_GAS_WALLET_PRIVATE_KEY, PRESS_OHTTP_PRIVATE_KEY,
# STORAGE_CONTRACT_ADDRESS, and PRESS_ADMIN_API_KEY, all of which config.ts
# requireEnv()s unconditionally (press exits at startup without them) --
# found live while porting dev-tests/suites/extended/subcard_creation_policy.spec.ts,
# which needs PRESS_ADMIN_API_KEY. EXTERNAL_KV_URL is excluded here on
# purpose -- that var only applies to the redis-backed KV driver used by the
# node-server/aws-lambda presets (see nitro.config.ts); the cloudflare-module
# preset this script deploys uses the PRESS_KV binding instead, provisioned
# per-environment in wrangler.toml, not passed as a secret.
WORKER_SECRETS=(
  PRESS_CARD_CID
  PRESS_POLICY_CIDS
  PRESS_MLDSA44_PRIVATE_KEY
  PRESS_SECP256R1_PRIVATE_KEY
  PRESS_GAS_WALLET_PRIVATE_KEY
  PRESS_OHTTP_PRIVATE_KEY
  ARBITRUM_RPC_URL
  REGISTRY_CONTRACT_ADDRESS
  STORAGE_CONTRACT_ADDRESS
  FILEBASE_KEY
  FILEBASE_SECRET
  FILEBASE_BUCKET
  PRESS_ADMIN_API_KEY
  EXPECTED_CHAIN_ID
)

# EXPECTED_CHAIN_ID defaults to 42161 (Arbitrum One) in config.ts -- correct
# for prod, but wrong for dev (Arbitrum Sepolia, chain 421614). Leaving this
# to operator-supplied config is a footgun: startup.ts's chain-ID check
# fails permanently against the wrong default and the Worker gets stuck
# returning 503 forever (found live -- see dev-tests suites all failing
# with "mintCard: GET /press failed: HTTP 503" until this was diagnosed).
# Derive and push it automatically instead of requiring the operator to
# know to set it.
if [[ "$ENVIRONMENT" == "dev" ]]; then
  export EXPECTED_CHAIN_ID="421614"
else
  export EXPECTED_CHAIN_ID="42161"
fi

missing=()
for var in "${WRANGLER_AUTH_VARS[@]}" "${WORKER_SECRETS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -ne 0 ]]; then
  echo "::error::Missing required env var(s) for press $ENVIRONMENT deploy:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  echo "" >&2
  echo "See press/DEPLOYMENT.md for what each one is and how to obtain it." >&2
  echo "Deploy will NOT be attempted until all required vars are present." >&2
  exit 1
fi

echo "All required vars present. Building press (cloudflare-module preset)..."
NITRO_PRESET=cloudflare-module npx nitro build

echo "Setting Worker secrets for env=$ENVIRONMENT..."
for var in "${WORKER_SECRETS[@]}"; do
  printf '%s' "${!var}" | npx wrangler secret put "$var" --env "$ENVIRONMENT"
done

echo "Deploying press ($ENVIRONMENT)..."
output=$(npx wrangler deploy --env "$ENVIRONMENT" 2>&1) || { echo "$output" >&2; exit 1; }
echo "$output"

# `wrangler deploy` exits 0 even when the script uploads but is attached to
# no route/workers.dev target -- a known wrangler gotcha (see
# relay-deploy.yml's identical check). Turn that silent no-op into a loud
# failure here too.
if echo "$output" | grep -qi "No targets deployed"; then
  echo "::error::wrangler deploy uploaded the script but attached it to no target (workers.dev or routes). Check workers_dev/routes in press/wrangler.toml." >&2
  exit 1
fi

echo "press deployed successfully to $ENVIRONMENT."
