#!/usr/bin/env bash
# bootstrap.sh — one-shot: wait for the Nitro devnode, deploy the three
# Stylus contracts against it, and write deployments/local.json.
#
# Run inside the deploy-contracts container (see ../../docker-compose.yml).
# Idempotent-ish: deploy.sh always redeploys fresh contracts, which is
# correct here since `nitro-node --dev` resets chain state on every restart
# anyway (see contracts/scripts/deploy.sh's `local` case).

set -euo pipefail

# Inside the container (see Dockerfile), the layout is flat: /repo/contracts
# and /repo/bootstrap.sh — not the full repo tree — so this is a fixed path,
# not derived from this script's own location.
CONTRACTS_DIR="/repo/contracts"

RPC_URL="${NITRO_DEV_RPC:-http://nitro-devnode:8547}"

echo "Waiting for Nitro devnode at $RPC_URL..."
until curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' \
  "$RPC_URL" | grep -q '"result"'; do
  sleep 1
done
echo "Nitro devnode is up."

# Generate a fresh secp256r1 dev governance keypair non-interactively (the
# same generator contracts/scripts/gen_keypair.rs used by manual dev setup).
# Written to the shared volume so integration suites can sign governance
# payloads against this stack without re-deriving the key.
KEYPAIR_JSON=$(cargo run --manifest-path "$CONTRACTS_DIR/scripts/Cargo.toml" --bin gen_keypair --quiet)
export DEPLOYER_SECP256R1_PUBKEY
export SECP256R1_PRIVKEY
DEPLOYER_SECP256R1_PUBKEY=$(echo "$KEYPAIR_JSON" | jq -r .public_key)
SECP256R1_PRIVKEY=$(echo "$KEYPAIR_JSON" | jq -r .private_key)

export NITRO_DEV_RPC="$RPC_URL"

"$CONTRACTS_DIR/scripts/deploy.sh" local

# Record the governance keypair alongside the deployment record so suites/
# fixtures can pick it up without re-running gen_keypair (deploy.sh already
# wrote deployments/local.json; this augments it rather than replacing it).
DEPLOYMENT_FILE="$CONTRACTS_DIR/deployments/local.json"
jq --arg pub "$DEPLOYER_SECP256R1_PUBKEY" --arg priv "$SECP256R1_PRIVKEY" \
  '. + {dev_governance_keypair: {public_key: $pub, private_key: $priv}}' \
  "$DEPLOYMENT_FILE" > "${DEPLOYMENT_FILE}.tmp"
mv "${DEPLOYMENT_FILE}.tmp" "$DEPLOYMENT_FILE"

echo "local.json written with dev governance keypair."

# Sanity check per Phase 1 Step 1.2's done-when criterion: a cast call
# against the logic contract succeeds. Two encoding pitfalls here, both
# already documented elsewhere in this codebase for other clients hitting
# the same contracts, and both previously misread as "calling deployed
# contracts doesn't work" (reports/phase-1-environment-notes.md) when the
# actual deployment above was always fine:
# - The Stylus SDK dispatches on the camelCase-converted selector
#   (getGovernanceKeyset), not the Rust source's get_governance_keyset —
#   the wrong-cased form sends an unrecognized selector and reverts.
# - Vec<u8> is uint8[] on the wire, not bytes (confirmed via
#   `cargo stylus export-abi`), and — because it's mixed with static
#   fields in a multi-value return — cast's decoder needs the return
#   wrapped in an explicit outer tuple `((...))`, not a flat
#   comma-separated list, or it fails with "buffer overrun while
#   deserializing" despite the call itself succeeding on-chain (the same
#   PositionOutOfBoundsError-class issue already documented for viem
#   elsewhere in this codebase).
LOGIC_ADDRESS=$(jq -r .contracts.logic_contract "$DEPLOYMENT_FILE")
cast call "$LOGIC_ADDRESS" "getGovernanceKeyset(uint8)((uint8[],uint8,uint8,uint32,uint8))" 0 \
  --rpc-url "$RPC_URL"
echo "cast call against logic contract succeeded. Bootstrap complete."
