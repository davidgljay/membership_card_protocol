#!/bin/sh
# Materializes config/secrets from env vars (no-op on docker-compose, where
# ./config is bind-mounted already) before starting the real command.
set -e

node scripts/materialize-secrets.mjs

exec "$@"
