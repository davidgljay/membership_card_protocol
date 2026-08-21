#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Card Protocol Registry — Deployment Script
#
# Deploys all three contracts in order:
#   1. verifier-module (pure computation, no state)
#   2. storage-contract (immutable-address, all state)
#   3. logic-contract (upgradeable write operations)
#
# Then wires them together via initialize() calls.
#
# Usage:
#   export ARBITRUM_SEPOLIA_RPC=https://...
#   export PRIVATE_KEY=0x...    # or export KEYSTORE_PATH=/path/to/keystore.json
#                                 (e.g. from `cast wallet new`) -- preferred for
#                                 real funds; cargo-stylus has no hardware-wallet
#                                 support, so an encrypted keystore file is the
#                                 most secure option it actually offers.
#   ./scripts/deploy.sh sepolia
#   ./scripts/deploy.sh mainnet
#
# Prerequisites:
#   cargo install cargo-stylus
#   forge installed (for cast send wiring calls)
#
# Deployment approach (resolves chicken-and-egg address dependency):
#   The storage contract needs the logic contract's address in its constructor,
#   but the logic contract needs the storage contract's address. We resolve this
#   with a two-step approach:
#   1. Deploy storage with a placeholder address (deployer EOA).
#   2. Deploy logic with the real storage address.
#   3. Call storage.initialize(logic_address, deployer_pubkey) to wire them up.
#   4. Call logic.initialize(storage_address, verifier_address) to complete wiring.
#
# All deployed addresses, tx hashes, and gas costs are saved to deployments/<network>.json.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

NETWORK=${1:-sepolia}
CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOYMENTS_DIR="$CONTRACTS_DIR/deployments"

case "$NETWORK" in
  local)
    # Arbitrum Nitro dev node (offchainlabs/nitro-node --dev), as run by the
    # integration_tests stack (see integration_tests/docker-compose.yml and
    # env/deploy-contracts/). --dev mode resets chain state on every
    # container restart, so this network case is only ever used against a
    # fresh devnode.
    RPC_URL="${NITRO_DEV_RPC:-http://nitro-devnode:8547}"
    # Well-known pre-funded devnode account from OffchainLabs/nitro-devnode's
    # run-dev-node.sh — not a secret, deliberately public/shared across every
    # nitro --dev instance.
    PRIVATE_KEY="${PRIVATE_KEY:-0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659}"
    ;;
  sepolia)
    RPC_URL="${ARBITRUM_SEPOLIA_RPC:-}"
    if [[ -z "$RPC_URL" ]]; then
      echo "ERROR: ARBITRUM_SEPOLIA_RPC not set"
      exit 1
    fi
    ;;
  mainnet)
    RPC_URL="${ARBITRUM_MAINNET_RPC:-}"
    if [[ -z "$RPC_URL" ]]; then
      echo "ERROR: ARBITRUM_MAINNET_RPC not set"
      exit 1
    fi
    echo "WARNING: Deploying to MAINNET. Are you sure? (Ctrl+C to abort, Enter to continue)"
    read -r
    ;;
  *)
    echo "ERROR: Unknown network '$NETWORK'. Use 'local', 'sepolia', or 'mainnet'."
    exit 1
    ;;
esac

# Signing: either an encrypted keystore (KEYSTORE_PATH, e.g. from
# `cast wallet new`) or a bare PRIVATE_KEY env var. Keystore is preferred
# for real funds -- cargo-stylus's own --private-key flag warns it "exposes
# your key to shell history". cargo-stylus needs a password FILE (no
# interactive prompt of its own), so the password is read once here and
# written to a chmod-600 temp file cleaned up on exit -- same pattern as
# relay/scripts/deploy.sh's SSH private key handling. Never put a keystore
# password in an env var or pass it as a literal CLI arg.
KEYSTORE_PATH="${KEYSTORE_PATH:-}"
PRIV_KEY="${PRIVATE_KEY:-}"
SIGN_ARGS_CARGO=""
SIGN_ARGS_CAST=""

if [[ -n "$KEYSTORE_PATH" ]]; then
  if [[ ! -f "$KEYSTORE_PATH" ]]; then
    echo "ERROR: KEYSTORE_PATH '$KEYSTORE_PATH' not found." >&2
    exit 1
  fi
  echo "Using encrypted keystore: $KEYSTORE_PATH"
  read -r -s -p "Keystore password: " KEYSTORE_PW
  echo ""
  KEYSTORE_PW_FILE="$(mktemp)"
  chmod 600 "$KEYSTORE_PW_FILE"
  trap 'rm -f "$KEYSTORE_PW_FILE"' EXIT
  printf '%s' "$KEYSTORE_PW" > "$KEYSTORE_PW_FILE"
  unset KEYSTORE_PW
  SIGN_ARGS_CARGO="--keystore-path $KEYSTORE_PATH --keystore-password-path $KEYSTORE_PW_FILE"
  SIGN_ARGS_CAST="--keystore $KEYSTORE_PATH --password-file $KEYSTORE_PW_FILE"
elif [[ -n "$PRIV_KEY" ]]; then
  SIGN_ARGS_CARGO="--private-key $PRIV_KEY"
  SIGN_ARGS_CAST="--private-key $PRIV_KEY"
else
  echo "ERROR: Neither KEYSTORE_PATH nor PRIVATE_KEY is set. Export one before running this script." >&2
  exit 1
fi

echo "=== Card Protocol Registry Deployment ==="
echo "Network: $NETWORK"
echo "RPC:     $RPC_URL"
echo ""

# ─── Local devnode bootstrap ───────────────────────────────────────────────────
# A fresh `nitro-node --dev` container starts with no chain owner, a nonzero
# L1 data fee component in its gas estimates (throws off cargo-stylus's gas
# estimation), no registered WASM cache manager, an ArbOS version too old to
# support multi-fragment Stylus contracts at all, and (separately) a max
# decompressed-WASM size too small for logic-contract's ~210KB uncompressed
# WASM. All five must be fixed before any of the three contracts can be
# checked/deployed; safe to rerun (each step is idempotent or resets to the
# same value).
#
# The ArbOS version gate was the hard one to find: logic-contract (56KB
# compressed, split into 3 calldata fragments — the other two contracts are
# single-fragment) reverted at activation with a bare
# "execution reverted, data: 0x" no matter what ArbOwner size/cache-manager
# params were tuned. Root cause, found by reading cargo-stylus's actual
# source (stylus-tools' core/deployment/mod.rs): multi-fragment deployment
# calls `ArbOwnerPublic.getMaxStylusContractFragments()` first, and "failing
# this call likely means the chain does not support fragments (old ArbOS)"
# per that code's own comment — confirmed by calling it directly here and
# getting the same bare revert. It only starts working once the chain is
# running ArbOS 61+ (nitro-node v3.7.1's default ArbOS 40 caps out at
# ArbOS 41 and can't even be upgraded that far; v3.11.2's default ArbOS 59
# can be upgraded to 61 cleanly). Real Arbitrum Sepolia is far newer than
# either, which is why logic-contract deployed there fine (deployments/
# sepolia.json) while every local devnode attempt failed until this fix.
if [[ "$NETWORK" == "local" ]]; then
  echo "[0/7] Bootstrapping local devnode (chain ownership, L1 price, ArbOS version, WASM cache manager, WASM max size)..."
  cast send 0x00000000000000000000000000000000000000FF "becomeChainOwner()" \
    --private-key "$PRIV_KEY" --rpc-url "$RPC_URL" >/dev/null
  cast send 0x0000000000000000000000000000000000000070 "setL1PricePerUnit(uint256)" 0x0 \
    --private-key "$PRIV_KEY" --rpc-url "$RPC_URL" >/dev/null

  # Upgrade ArbOS to 61 (the highest version this nitro-node build, v3.11.2,
  # supports; anything from 61 up to that ceiling works — see comment
  # above). timestamp=0 means
  # "apply at the next block"; the follow-up becomeChainOwner-address no-op
  # send is what actually advances a block so the upgrade takes effect.
  cast send 0x0000000000000000000000000000000000000070 "scheduleArbOSUpgrade(uint64,uint64)" 61 0 \
    --private-key "$PRIV_KEY" --rpc-url "$RPC_URL" >/dev/null
  cast send "$(cast wallet address --private-key "$PRIV_KEY")" --value 0 \
    --private-key "$PRIV_KEY" --rpc-url "$RPC_URL" >/dev/null

  # Cache Manager bytecode + registration, copied verbatim from
  # OffchainLabs/nitro-devnode's run-dev-node.sh (a fixed init-code blob
  # deploying the CacheManager contract used across all nitro-devnode
  # instances, not project-specific).
  CACHE_MANAGER_DEPLOY_OUTPUT=$(cast send --private-key "$PRIV_KEY" \
    --rpc-url "$RPC_URL" --json \
    --create 0x60a06040523060805234801561001457600080fd5b50608051611d1c61003060003960006105260152611d1c6000f3fe)
  CACHE_MANAGER_ADDRESS=$(echo "$CACHE_MANAGER_DEPLOY_OUTPUT" | grep -o '"contractAddress":"[^"]*"' | cut -d'"' -f4)
  if [[ -z "$CACHE_MANAGER_ADDRESS" ]]; then
    echo "ERROR: failed to deploy WASM cache manager. Output:" >&2
    echo "$CACHE_MANAGER_DEPLOY_OUTPUT" >&2
    exit 1
  fi
  cast send --private-key "$PRIV_KEY" --rpc-url "$RPC_URL" \
    0x0000000000000000000000000000000000000070 \
    "addWasmCacheManager(address)" "$CACHE_MANAGER_ADDRESS" >/dev/null

  # Default max decompressed-WASM size is 128KB; logic-contract's WASM is
  # ~210KB uncompressed.
  cast send --private-key "$PRIV_KEY" --rpc-url "$RPC_URL" \
    0x0000000000000000000000000000000000000070 \
    "setWasmMaxSize(uint32)" 500000 >/dev/null

  echo "  Devnode bootstrapped (cache manager at $CACHE_MANAGER_ADDRESS)."
fi

# ─── Helper: extract gas cost from a transaction receipt ─────────────────────
# Prints "gas_used:gas_price_wei:cost_eth" for a given tx hash.
tx_cost() {
  local tx="$1"
  local receipt
  receipt=$(cast receipt "$tx" --rpc-url "$RPC_URL" --json 2>/dev/null)
  local gas_hex price_hex gas price cost_wei cost_eth
  gas_hex=$(echo "$receipt" | grep -o '"gasUsed":"[^"]*"' | cut -d'"' -f4)
  price_hex=$(echo "$receipt" | grep -o '"effectiveGasPrice":"[^"]*"' | cut -d'"' -f4)
  gas=$(printf '%d' "$gas_hex")
  price=$(printf '%d' "$price_hex")
  cost_wei=$(echo "$gas * $price" | bc)
  cost_eth=$(echo "scale=7; $cost_wei / 1000000000000000000" | bc)
  echo "${gas}:${price}:${cost_eth}"
}

# ─── Helper: extract deploy/activate tx hashes from cargo-stylus output ──────
# cargo-stylus's output format has changed across versions. Older versions
# (what deploy.sh originally targeted) print exactly two bare "0x<64hex>"
# strings with nothing else distinguishing them, so the original extraction
# just took the first/second such match anywhere in the output. Newer
# versions (0.10.7, confirmed live on this repo's first real mainnet
# deployment) print explicit labeled lines instead -- "deployment tx hash:
# 0x<64hex>" and "...with tx \"<64hex>\"" -- and critically, the activation
# hash in that second line has NO 0x prefix. The old positional regex
# (0x[hex]{64}) never matches an unprefixed hash, so activation_txs came
# back empty for all three contracts on that run, and (compounding with the
# subshell bug below) the whole deployment silently reported "Total gas
# cost: 0 ETH" despite real gas being spent. These helpers try the labeled
# format first (unambiguous) and fall back to the old positional heuristic
# for older cargo-stylus versions.
extract_deploy_tx() {
  local output="$1"
  local labeled
  labeled=$(echo "$output" | grep -oE 'deployment tx hash: 0x[0-9a-fA-F]{64}' | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
  if [[ -n "$labeled" ]]; then
    echo "$labeled"
  else
    echo "$output" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '1p'
  fi
}

extract_activate_tx() {
  local output="$1"
  local labeled
  labeled=$(echo "$output" | grep -oE 'with tx "[0-9a-fA-F]{64}"' | grep -oE '[0-9a-fA-F]{64}' | head -1)
  if [[ -n "$labeled" ]]; then
    echo "0x$labeled"
  else
    echo "$output" | grep -oE '0x[0-9a-fA-F]{64}' | sed -n '2p'
  fi
}

# ─── Helper: accumulate a tx's cost into the running total ───────────────────
# Deliberately called as a plain statement, NEVER via $(...) command
# substitution -- command substitution forks a subshell, and a mutation to
# total_cost_wei (a variable that already exists in the parent shell) made
# inside that subshell is discarded the moment the subshell exits. This
# exact bug previously lived inside cost_json_for()/wire_cost_json_for()
# themselves (both called via X=$(fn ...) for their JSON return string),
# silently zeroing total_cost_wei for the entire script regardless of how
# much gas each individual step actually used -- found live on this repo's
# first real mainnet deployment (reported "Total gas cost: 0 ETH" despite a
# real ~0.0012 ETH having been spent, confirmed by checking the deployer
# wallet's balance directly). Costs a few extra `cast receipt` RPC calls
# (tx_cost() also runs once per hash inside cost_json_for/wire_cost_json_for
# for display purposes) in exchange for the total actually being correct.
accumulate_tx_cost() {
  local tx="$1"
  [[ -z "$tx" ]] && return
  local gas price eth
  IFS=':' read -r gas price eth <<< "$(tx_cost "$tx")"
  [[ -z "$gas" || -z "$price" ]] && return
  total_cost_wei=$(echo "$total_cost_wei + ($gas * $price)" | bc)
}

# ─── Build all WASM contracts (release profile) ───────────────────────────────
echo "[1/7] Building contracts..."
cd "$CONTRACTS_DIR"
cargo build --release --target wasm32-unknown-unknown
echo "  Build complete."

# ─── Check contracts with cargo stylus ────────────────────────────────────────
echo "[2/7] Checking contracts with cargo-stylus..."

(cd "$CONTRACTS_DIR/verifier-module" && cargo stylus check --endpoint "$RPC_URL")
echo "  verifier-module: OK"

(cd "$CONTRACTS_DIR/storage-contract" && cargo stylus check --endpoint "$RPC_URL")
echo "  storage-contract: OK"

(cd "$CONTRACTS_DIR/logic-contract" && cargo stylus check --endpoint "$RPC_URL")
echo "  logic-contract: OK"

# ─── Deploy verifier module ───────────────────────────────────────────────────
echo "[3/7] Deploying verifier-module..."

VERIFIER_DEPLOY_OUTPUT=$(
  cd "$CONTRACTS_DIR/verifier-module" && cargo stylus deploy \
    --endpoint "$RPC_URL" \
    $SIGN_ARGS_CARGO \
    --no-verify \
    --max-fee-per-gas-gwei 0.1 \
    2>&1
)
echo "$VERIFIER_DEPLOY_OUTPUT"
VERIFIER_ADDRESS=$(echo "$VERIFIER_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
VERIFIER_DEPLOY_TX=$(extract_deploy_tx "$VERIFIER_DEPLOY_OUTPUT")
VERIFIER_ACTIVATE_TX=$(extract_activate_tx "$VERIFIER_DEPLOY_OUTPUT")
echo "  verifier-module deployed at: $VERIFIER_ADDRESS"

# ─── Deploy storage contract ──────────────────────────────────────────────────
echo "[4/7] Deploying storage-contract..."

STORAGE_DEPLOY_OUTPUT=$(
  cd "$CONTRACTS_DIR/storage-contract" && cargo stylus deploy \
    --endpoint "$RPC_URL" \
    $SIGN_ARGS_CARGO \
    --no-verify \
    --max-fee-per-gas-gwei 0.1 \
    2>&1
)
echo "$STORAGE_DEPLOY_OUTPUT"
STORAGE_ADDRESS=$(echo "$STORAGE_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
STORAGE_DEPLOY_TX=$(extract_deploy_tx "$STORAGE_DEPLOY_OUTPUT")
STORAGE_ACTIVATE_TX=$(extract_activate_tx "$STORAGE_DEPLOY_OUTPUT")
echo "  storage-contract deployed at: $STORAGE_ADDRESS"

# ─── Deploy logic contract ────────────────────────────────────────────────────
echo "[5/7] Deploying logic-contract..."

LOGIC_DEPLOY_OUTPUT=$(
  cd "$CONTRACTS_DIR/logic-contract" && cargo stylus deploy \
    --endpoint "$RPC_URL" \
    $SIGN_ARGS_CARGO \
    --no-verify \
    --max-fee-per-gas-gwei 0.1 \
    2>&1
)
echo "$LOGIC_DEPLOY_OUTPUT"
LOGIC_ADDRESS=$(echo "$LOGIC_DEPLOY_OUTPUT" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
LOGIC_DEPLOY_TX=$(extract_deploy_tx "$LOGIC_DEPLOY_OUTPUT")
LOGIC_ACTIVATE_TX=$(extract_activate_tx "$LOGIC_DEPLOY_OUTPUT")
echo "  logic-contract deployed at: $LOGIC_ADDRESS"

# ─── Wire contracts together ──────────────────────────────────────────────────
echo "[6/7] Wiring contracts..."

INIT_STORAGE_TX=""
INIT_LOGIC_TX=""

DEPLOYER_PUBKEY="${DEPLOYER_SECP256R1_PUBKEY:-}"
if [[ -z "$DEPLOYER_PUBKEY" ]]; then
  echo "  WARNING: DEPLOYER_SECP256R1_PUBKEY not set."
  echo "  You must call storage.initialize(logic_address, deployer_pubkey) manually."
  echo "  See deployments/README.md for the initialization procedure."
else
  # Stylus SDK 0.8 maps Vec<u8> to uint8[] (not bytes) in the ABI.
  # Convert the hex pubkey to a uint8[] literal that cast can encode.
  PUBKEY_HEX="${DEPLOYER_PUBKEY#0x}"
  PUBKEY_ARRAY="["
  for ((i=0; i<${#PUBKEY_HEX}; i+=2)); do
    byte=$((16#${PUBKEY_HEX:$i:2}))
    [[ $i -eq 0 ]] && PUBKEY_ARRAY+="$byte" || PUBKEY_ARRAY+=",$byte"
  done
  PUBKEY_ARRAY+="]"

  echo "  Calling storage.initialize($LOGIC_ADDRESS, <pubkey as uint8[]>)..."
  INIT_STORAGE_OUTPUT=$(cast send "$STORAGE_ADDRESS" \
    "initialize(address,uint8[])" \
    "$LOGIC_ADDRESS" \
    "$PUBKEY_ARRAY" \
    --rpc-url "$RPC_URL" \
    $SIGN_ARGS_CAST \
    --json \
    2>&1)
  echo "$INIT_STORAGE_OUTPUT"
  INIT_STORAGE_TX=$(echo "$INIT_STORAGE_OUTPUT" | grep -o '"transactionHash":"[^"]*"' | cut -d'"' -f4)

  echo "  Calling logic.initialize($STORAGE_ADDRESS, $VERIFIER_ADDRESS)..."
  INIT_LOGIC_OUTPUT=$(cast send "$LOGIC_ADDRESS" \
    "initialize(address,address)" \
    "$STORAGE_ADDRESS" \
    "$VERIFIER_ADDRESS" \
    --rpc-url "$RPC_URL" \
    $SIGN_ARGS_CAST \
    --json \
    2>&1)
  echo "$INIT_LOGIC_OUTPUT"
  INIT_LOGIC_TX=$(echo "$INIT_LOGIC_OUTPUT" | grep -o '"transactionHash":"[^"]*"' | cut -d'"' -f4)
fi

# ─── Collect gas costs ────────────────────────────────────────────────────────
echo "[7/7] Collecting gas costs and saving deployment record..."

total_cost_wei=0

# Build the display/JSON fragment only -- these are called via X=$(fn ...)
# for their echoed string, which forks a subshell, so they must NOT try to
# mutate total_cost_wei themselves (see accumulate_tx_cost's comment above
# for why that silently broke the grand total on the first real mainnet
# deployment). Callers separately call accumulate_tx_cost() as a plain
# statement for the actual running total.
cost_json_for() {
  local deploy_tx="$1" activate_tx="$2"
  local d_gas d_price d_eth a_gas a_price a_eth total_eth

  IFS=':' read -r d_gas d_price d_eth <<< "$(tx_cost "$deploy_tx")"
  IFS=':' read -r a_gas a_price a_eth <<< "$(tx_cost "$activate_tx")"
  total_eth=$(echo "scale=7; $d_eth + $a_eth" | bc)

  echo "\"deploy_gas\": $d_gas, \"deploy_cost_eth\": \"$d_eth\", \"activate_gas\": $a_gas, \"activate_cost_eth\": \"$a_eth\", \"total_cost_eth\": \"$total_eth\""
}

wire_cost_json_for() {
  local tx="$1" label="$2"
  local gas price eth
  IFS=':' read -r gas price eth <<< "$(tx_cost "$tx")"
  echo "\"${label}_gas\": $gas, \"${label}_cost_eth\": \"$eth\""
}

VERIFIER_COSTS=$(cost_json_for "$VERIFIER_DEPLOY_TX" "$VERIFIER_ACTIVATE_TX")
STORAGE_COSTS=$(cost_json_for "$STORAGE_DEPLOY_TX" "$STORAGE_ACTIVATE_TX")
LOGIC_COSTS=$(cost_json_for "$LOGIC_DEPLOY_TX" "$LOGIC_ACTIVATE_TX")

accumulate_tx_cost "$VERIFIER_DEPLOY_TX"
accumulate_tx_cost "$VERIFIER_ACTIVATE_TX"
accumulate_tx_cost "$STORAGE_DEPLOY_TX"
accumulate_tx_cost "$STORAGE_ACTIVATE_TX"
accumulate_tx_cost "$LOGIC_DEPLOY_TX"
accumulate_tx_cost "$LOGIC_ACTIVATE_TX"

WIRE_COSTS='"note": "wiring skipped (DEPLOYER_SECP256R1_PUBKEY not set)"'
if [[ -n "$INIT_STORAGE_TX" && -n "$INIT_LOGIC_TX" ]]; then
  STORAGE_WIRE=$(wire_cost_json_for "$INIT_STORAGE_TX" "init_storage")
  LOGIC_WIRE=$(wire_cost_json_for "$INIT_LOGIC_TX" "init_logic")
  WIRE_COSTS="$STORAGE_WIRE, $LOGIC_WIRE"
  accumulate_tx_cost "$INIT_STORAGE_TX"
  accumulate_tx_cost "$INIT_LOGIC_TX"
fi

GRAND_TOTAL_ETH=$(echo "scale=7; $total_cost_wei / 1000000000000000000" | bc)

# ─── Save deployment record ───────────────────────────────────────────────────
mkdir -p "$DEPLOYMENTS_DIR"
DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/${NETWORK}.json"

cat > "$DEPLOYMENT_FILE" <<EOF
{
  "network": "$NETWORK",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "rpc_url": "$RPC_URL",
  "contracts": {
    "verifier_module": "$VERIFIER_ADDRESS",
    "storage_contract": "$STORAGE_ADDRESS",
    "logic_contract": "$LOGIC_ADDRESS"
  },
  "deployment_txs": {
    "verifier_module": "$VERIFIER_DEPLOY_TX",
    "storage_contract": "$STORAGE_DEPLOY_TX",
    "logic_contract": "$LOGIC_DEPLOY_TX"
  },
  "activation_txs": {
    "verifier_module": "$VERIFIER_ACTIVATE_TX",
    "storage_contract": "$STORAGE_ACTIVATE_TX",
    "logic_contract": "$LOGIC_ACTIVATE_TX"
  },
  "wiring_txs": {
    "init_storage": "$INIT_STORAGE_TX",
    "init_logic": "$INIT_LOGIC_TX"
  },
  "gas_costs": {
    "note": "gasUsed x effectiveGasPrice for each tx. 1 ETH = 1e18 wei.",
    "verifier_module": { $VERIFIER_COSTS },
    "storage_contract": { $STORAGE_COSTS },
    "logic_contract": { $LOGIC_COSTS },
    "wiring": { $WIRE_COSTS },
    "grand_total_eth": "$GRAND_TOTAL_ETH"
  },
  "notes": "storage_contract is the stable protocol identifier — never redeployed."
}
EOF

echo "  Saved to $DEPLOYMENT_FILE"

echo ""
echo "=== Deployment Complete ==="
echo "verifier-module:  $VERIFIER_ADDRESS"
echo "storage-contract: $STORAGE_ADDRESS  ← stable protocol identifier"
echo "logic-contract:   $LOGIC_ADDRESS"
echo "Total gas cost:   $GRAND_TOTAL_ETH ETH"
echo ""
echo "NEXT STEPS:"
if [[ -z "${DEPLOYER_SECP256R1_PUBKEY:-}" ]]; then
  echo "1. Call storage.initialize($LOGIC_ADDRESS, <deployer_pubkey_as_uint8[]>) if not done."
  echo "   Note: Stylus SDK 0.8 maps Vec<u8> to uint8[], not bytes. Use the hex→array"
  echo "   conversion in this script, or see deployments/README.md."
  echo "2. Call logic.initialize($STORAGE_ADDRESS, $VERIFIER_ADDRESS) if not done."
  echo "3. Run main bootstrap: RegisterPolicy (RootPolicyBody) → AuthorizePress (PressRegistryBody)."
  echo "4. Run DNS bootstrap:"
  echo "   export LOGIC_ADDRESS=$LOGIC_ADDRESS"
  echo "   ./contracts/scripts/setup_dns.sh"
  echo "5. Run DNS end-to-end test:"
  echo "   ./contracts/scripts/test_dns.sh"
else
  echo "1. Run main bootstrap: RegisterPolicy (RootPolicyBody) → AuthorizePress (PressRegistryBody)."
  echo "2. Run DNS bootstrap:"
  echo "   export LOGIC_ADDRESS=$LOGIC_ADDRESS"
  echo "   ./contracts/scripts/setup_dns.sh"
  echo "3. Run DNS end-to-end test:"
  echo "   ./contracts/scripts/test_dns.sh"
fi
echo ""
echo "After bootstrap:"
echo "  • Run RotateGovernanceKeys for ALL THREE bodies (Root, Press, DNS) to expand from"
echo "    1-of-1 to multi-sig. The 1-of-1 bootstrap is a single point of failure."
echo "  • Update contracts/tests/src/SepoliaIntegration.t.sol with the new addresses."
echo "  • Update governance/scripts/.env with LOGIC_CONTRACT_ADDRESS=$LOGIC_ADDRESS"
echo "  • Transaction hashes saved to $DEPLOYMENT_FILE"
