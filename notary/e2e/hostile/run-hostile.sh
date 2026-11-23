#!/usr/bin/env bash
# The hostile-host harness (Phase 7.2, tranche 2). The host's own handlers and schedulers run in the test process with
# hostile services wrapped around them (dropping a stored input, feeding the enclave a forked chain, serving a tampered
# object); the enclave is the real `notary-runtime` broker behind the fake enclave service, and the chain is the simulated
# chain service. Needs `cargo build -p notary-runtime -p notary-sim`.
set -euo pipefail
cd "$(dirname "$0")/../.."
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
LOGS=$(mktemp -d); echo "logs in $LOGS"
# the test-only leaky program (never committed under templates/modules/)
templates/build.sh leaky-test >/dev/null
set -a; . e2e/sim.env; set +a
export SIM_CHAIN_URL=http://127.0.0.1:8745
export ATTESTATION_ROOT=$(target/debug/fake-enclave --print-root)
SIM_CHAIN_PORT=8745 node --experimental-strip-types e2e/src/sim-chain.ts >"$LOGS/sim-chain.log" 2>&1 & pids+=($!)
# two enclaves: A follows the honest chain; B is the one a hostile host feeds a forked chain (a broker anchors on its first header once)
start_enclave() { # name fake-port broker-port [extra fake-enclave args]
  local n=$1 fp=$2 bp=$3; shift 3
  echo 0 > "$LOGS/off-$n"   # this enclave's attested-clock offset in ms (a test moves it with the chain's `POST /warp`)
  FAKE_ENCLAVE_OFFSET_FILE="$LOGS/off-$n" target/debug/fake-enclave --listen 127.0.0.1:$fp "$@" >"$LOGS/fake-$n.log" 2>&1 & pids+=($!); echo $! > "$LOGS/pid-$n-fake"
  sleep 1
  target/debug/notary-runtime --mode broker --listen tcp:127.0.0.1:$bp --attest sim:tcp:127.0.0.1:$fp --pins e2e/fixtures/pins.json >"$LOGS/runtime-$n.log" 2>&1 & pids+=($!); echo $! > "$LOGS/pid-$n-broker"
}
start_enclave a 7310 7311
start_enclave b 7320 7321
# two rogue enclaves: a debug-mode build, and one whose PCR0 is not on the governance list
start_enclave c 7330 7331 --debug
start_enclave d 7340 7341 --pcr0-seed 77
# the leaky program asks for `dedicated` isolation, so each of its three jobs needs an enclave to itself
start_enclave l1 7350 7351
start_enclave l2 7360 7361
start_enclave l3 7370 7371
# two enclaves for one notary identity (a handoff between them), so one can be killed while the other survives
start_enclave x 7380 7381
start_enclave y 7390 7391
# and another pair for the state-blob rollback test (the kill test above leaves x dead)
start_enclave rx 7400 7401
start_enclave ry 7410 7411
sleep 2
export PIDDIR=$LOGS BROKER_X=127.0.0.1:7381 BROKER_Y=127.0.0.1:7391 BROKER_RX=127.0.0.1:7401 BROKER_RY=127.0.0.1:7411
export BROKER_LEAK_1=127.0.0.1:7351 BROKER_LEAK_2=127.0.0.1:7361 BROKER_LEAK_3=127.0.0.1:7371
export BROKER_A=127.0.0.1:7311 BROKER_B=127.0.0.1:7321 BROKER_DEBUG=127.0.0.1:7331 BROKER_ROGUE_PCR0=127.0.0.1:7341
cd e2e && pnpm exec vitest run --config hostile/vitest.config.ts "$@"
