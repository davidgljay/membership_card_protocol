#!/usr/bin/env bash
# Step 5.5 end to end in docker-compose against the simulator. Restarts the host once, between genesis and the job,
# because NOTARY_CARD_ADDRESSES is static configuration (notary_host.md §4) and the card only exists after genesis.
set -euo pipefail
cd "$(dirname "$0")/../deploy"
C="docker compose -p notary-sim -f docker-compose.sim.yml"
$C build
$C down -v --remove-orphans >/dev/null 2>&1 || true
$C up -d sim-chain redis enclave-sim host
CARD=$($C run --rm driver --phase setup | tee /dev/stderr | grep '^NOTARY_CARD_ADDRESSES=' | cut -d= -f2)
NOTARY_CARD_ADDRESSES=$CARD $C up -d --force-recreate --no-deps host
$C run --rm driver --phase job
status=$?
[ "${KEEP:-0}" = 1 ] || $C down -v --remove-orphans
exit $status
