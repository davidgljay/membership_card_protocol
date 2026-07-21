#!/bin/sh
# Reads the local nitro-devnode deployment's fresh contract addresses
# (written by deploy-contracts to the bind-mounted contracts/deployments/
# local.json, shared with the host so the web harness can read the same
# file directly) and injects them as wrangler vars, overriding whatever
# static placeholder is in .dev.vars. Addresses aren't stable across
# deploy-contracts runs (nitro-devnode resets all chain state on every
# restart, and the deployer's tx sequence includes a freshly generated
# governance keypair each time), so this can't be a static .dev.vars entry.
set -eu

DEPLOYMENT_FILE=/repo/contracts/deployments/local.json

echo "Waiting for $DEPLOYMENT_FILE..."
until [ -f "$DEPLOYMENT_FILE" ]; do
  sleep 1
done

LOGIC_ADDRESS=$(node -e "console.log(require('$DEPLOYMENT_FILE').contracts.logic_contract)")
STORAGE_ADDRESS=$(node -e "console.log(require('$DEPLOYMENT_FILE').contracts.storage_contract)")

echo "Using local devnode contracts: logic=$LOGIC_ADDRESS storage=$STORAGE_ADDRESS"

exec npx wrangler dev .output/server/index.mjs --site .output/public --ip 0.0.0.0 --port 3000 \
  --var ARBITRUM_RPC_URL:http://nitro-devnode:8547 \
  --var REGISTRY_CONTRACT_ADDRESS:"$LOGIC_ADDRESS" \
  --var STORAGE_CONTRACT_ADDRESS:"$STORAGE_ADDRESS"
