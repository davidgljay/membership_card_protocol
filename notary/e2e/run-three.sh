#!/usr/bin/env bash
# Step 6.3: the three-host scenario in docker-compose (deploy/docker-compose.three.yml). Takes about seven minutes:
# the replica stopped mid-job is counted lost only after the 120 s liveness window.
set -euo pipefail
cd "$(dirname "$0")/../deploy"
C="docker compose -p notary-three -f docker-compose.three.yml"
$C build
$C down -v --remove-orphans >/dev/null 2>&1 || true
$C up -d
status=0
$C run --rm driver --phase setup || status=$?
if [ $status = 0 ]; then
  out=$($C run --rm driver --phase start) || status=$?
  echo "$out"
fi
if [ $status = 0 ]; then
  kill=$(echo "$out" | sed -n 's/^KILL=//p' | tail -1)
  echo "[e2e-3] stopping $kill"
  $C stop "$kill"
  $C run --rm driver --phase finish || status=$?
fi
[ $status = 0 ] || $C logs --tail 60 host-a host-b host-c > /tmp/notary-three-logs.txt 2>&1 || true
[ "${KEEP:-0}" = 1 ] || $C down -v --remove-orphans
exit $status
