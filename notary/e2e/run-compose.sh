#!/usr/bin/env bash
# Step 5.5 end to end in docker-compose against the simulator. The host serves the card it creates through /genesis,
# so it is not restarted (notary_host.md §4, 5.7 Q4).
set -euo pipefail
cd "$(dirname "$0")/../deploy"
C="docker compose -p notary-sim -f docker-compose.sim.yml"
$C build
$C down -v --remove-orphans >/dev/null 2>&1 || true
$C up -d sim-chain redis enclave-sim host
$C run --rm driver --phase setup
$C run --rm driver --phase job
status=$?
[ "${KEEP:-0}" = 1 ] || $C down -v --remove-orphans
exit $status
