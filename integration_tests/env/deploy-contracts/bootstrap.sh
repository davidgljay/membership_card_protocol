#!/usr/bin/env bash
# bootstrap.sh — one-shot: wait for the Nitro devnode, deploy the three
# Stylus contracts against it, and write deployments/local.json.
#
# Run inside the deploy-contracts container (see ../../docker-compose.yml).
# `docker compose up` re-runs this container's dependency graph any time a
# service that depends_on it (press, wallet-service) is recreated, even
# when nitro-devnode itself never restarted and chain state is unchanged —
# so this is NOT actually one-shot in practice. Redeploying fresh contracts
# in that situation desyncs any already-running press/wallet-service (which
# read local.json once at their own startup) from the harness (which reads
# it fresh every run), producing hard-to-diagnose "issuer_chain_not_trusted"
# failures. Guard against it: skip redeployment if local.json already
# records a logic contract with live code on the CURRENT chain — this still
# redeploys correctly on a genuine fresh chain (no code at that address)
# while skipping the redundant, desyncing redeploy otherwise.

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

DEPLOYMENT_FILE="$CONTRACTS_DIR/deployments/local.json"
if [ -f "$DEPLOYMENT_FILE" ]; then
  EXISTING_LOGIC_ADDRESS=$(jq -r '.contracts.logic_contract // empty' "$DEPLOYMENT_FILE")
  if [ -n "$EXISTING_LOGIC_ADDRESS" ]; then
    EXISTING_CODE=$(curl -s -X POST -H "Content-Type: application/json" \
      --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$EXISTING_LOGIC_ADDRESS\",\"latest\"],\"id\":1}" \
      "$RPC_URL" | jq -r '.result // "0x"')
    if [ "$EXISTING_CODE" != "0x" ] && [ -n "$EXISTING_CODE" ]; then
      echo "local.json's logic contract ($EXISTING_LOGIC_ADDRESS) already has live code on this chain — skipping redeploy."
      exit 0
    fi
  fi
fi

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
