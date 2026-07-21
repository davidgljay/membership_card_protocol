#!/bin/sh
# See env/press/entrypoint.sh's doc comment — same rationale, wallet-service
# just needs the logic contract address (REGISTRY_CONTRACT_ADDRESS), not
# storage.
set -eu

DEPLOYMENT_FILE=/repo/contracts/deployments/local.json

echo "Waiting for $DEPLOYMENT_FILE..."
until [ -f "$DEPLOYMENT_FILE" ]; do
  sleep 1
done

LOGIC_ADDRESS=$(node -e "console.log(require('$DEPLOYMENT_FILE').contracts.logic_contract)")

echo "Using local devnode contract: logic=$LOGIC_ADDRESS"

exec npx wrangler dev .output/server/index.mjs --assets .output/public --ip 0.0.0.0 --port 3000 \
  --var ARBITRUM_RPC_URL:http://nitro-devnode:8547 \
  --var REGISTRY_CONTRACT_ADDRESS:"$LOGIC_ADDRESS"
