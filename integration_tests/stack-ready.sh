#!/usr/bin/env bash
# Polls `docker compose ps` until every service in the default stack (i.e.
# not behind the `local-chain` profile, which isn't part of the default
# `docker compose up`) reports healthy, or exits non-zero after a timeout.
#
# Compose's own `up --wait` already does this for a fresh `up` invocation.
# This script exists for the case that's *not* covered by that: confirming
# an already-running stack (started by someone/something else, e.g. a CI
# job that brought it up in a separate step) is ready before a suite runs
# against it — see Phase 2's harnesses/suites, which will call this rather
# than re-invoking `docker compose up`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TIMEOUT_SECONDS="${STACK_READY_TIMEOUT_SECONDS:-300}"
POLL_INTERVAL_SECONDS=2
SERVICES=(ipfs redis relay synapse-postgres synapse press wallet-service-postgres wallet-service)

elapsed=0
while true; do
  not_ready=()
  for service in "${SERVICES[@]}"; do
    status=$(docker compose ps --format '{{.Health}}' "$service" 2>/dev/null || true)
    if [[ "$status" != "healthy" ]]; then
      not_ready+=("$service:${status:-missing}")
    fi
  done

  if [[ ${#not_ready[@]} -eq 0 ]]; then
    echo "stack-ready: all ${#SERVICES[@]} services healthy after ${elapsed}s"
    exit 0
  fi

  if [[ "$elapsed" -ge "$TIMEOUT_SECONDS" ]]; then
    echo "stack-ready: timed out after ${TIMEOUT_SECONDS}s, still not healthy: ${not_ready[*]}" >&2
    exit 1
  fi

  sleep "$POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + POLL_INTERVAL_SECONDS))
done
