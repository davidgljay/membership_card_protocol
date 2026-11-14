#!/usr/bin/env bash
# Step 5.5 end to end as local processes (the same services docker-compose.sim.yml runs):
# sim-chain, the fake enclave service, notary-runtime (broker), the host, then the driver's two phases.
# Needs: node >= 22, a built host (`pnpm -C host build`), and `cargo build -p notary-runtime -p notary-sim`.
set -euo pipefail
cd "$(dirname "$0")/.."
LOGS=${LOGS:-$(mktemp -d)}
echo "logs in $LOGS"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
set -a; . e2e/sim.env; set +a
export SIM_CHAIN_URL=http://127.0.0.1:8545 HOST_URL=http://127.0.0.1:3000 STATE_FILE="$LOGS/state.json"
export ATTESTATION_ROOT=$(target/debug/fake-enclave --print-root)
export EXTERNAL_KV_URL=memory:// ENCLAVE_CIDS=sim-1 ENCLAVE_ENDPOINTS=sim-1=127.0.0.1:7001 NOTARY_PUBLIC_BASE_URL=$HOST_URL

node --experimental-strip-types e2e/src/sim-chain.ts >"$LOGS/sim-chain.log" 2>&1 & pids+=($!)
target/debug/fake-enclave --listen 127.0.0.1:7100 >"$LOGS/fake-enclave.log" 2>&1 & pids+=($!)
sleep 1
target/debug/notary-runtime --mode broker --listen tcp:127.0.0.1:7001 --attest sim:tcp:127.0.0.1:7100 --pins e2e/fixtures/pins.json >"$LOGS/runtime.log" 2>&1 & pids+=($!)
sleep 1

# no NOTARY_CARD_ADDRESSES: the host serves the card it creates through /genesis
PORT=3000 node host/.output/server/index.mjs >>"$LOGS/host.log" 2>&1 & pids+=($!)
node --experimental-strip-types e2e/src/driver.ts --phase setup | tee "$LOGS/setup.log"
node --experimental-strip-types e2e/src/driver.ts --phase job | tee "$LOGS/job.log"
