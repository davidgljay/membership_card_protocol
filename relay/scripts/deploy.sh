#!/usr/bin/env bash
# Deploys relay/Dockerfile to a DigitalOcean App Platform app for a given
# environment.
#
# Usage: scripts/deploy.sh <dev|prod>
#
# Required env vars -- see relay/DEPLOYMENT.md for what each one is and how
# to obtain it. This script fails loudly and lists every missing var in one
# pass rather than stopping at the first.
#
# The actual platform call is isolated in deploy_to_app_platform() below so
# a future service that's a worse App Platform fit (stateful volume,
# multiple bound ports, non-HTTP protocol) can be pointed at a Droplet
# instead by swapping that one function, without touching the rest of this
# script or the Dockerfile (strategic-plan.md Open Question 2).
set -euo pipefail

ENVIRONMENT="${1:-}"
if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <dev|prod>" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Authenticates doctl and identifies the DO app to deploy.
REQUIRED_VARS=(
  DIGITALOCEAN_ACCESS_TOKEN
)

missing=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -ne 0 ]]; then
  echo "::error::Missing required env var(s) for relay $ENVIRONMENT deploy:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  echo "" >&2
  echo "See relay/DEPLOYMENT.md for what each one is and how to obtain it." >&2
  echo "Note: REDIS_URL, APP_REGISTRY_JSON, and per-app push credential" >&2
  echo "secrets are NOT checked here -- they are configured once, out of" >&2
  echo "band, directly on the DO app (see relay/DEPLOYMENT.md and" >&2
  echo ".do/app.$ENVIRONMENT.yaml), never pushed through this script." >&2
  exit 1
fi

command -v doctl >/dev/null 2>&1 || {
  echo "::error::doctl is not installed. See https://docs.digitalocean.com/reference/doctl/how-to/install/" >&2
  exit 1
}

doctl auth init --access-token "$DIGITALOCEAN_ACCESS_TOKEN" >/dev/null

# --- Platform-specific section: DigitalOcean App Platform -----------------
# Swap this function's body (and the spec file it points at) to target a
# different platform (e.g. a Droplet + docker-compose) without touching
# anything above or below it.
deploy_to_app_platform() {
  local app_name="$1"
  local spec_file="$2"

  local app_id
  app_id="$(doctl apps list --format ID,Spec.Name --no-header 2>/dev/null \
    | awk -v name="$app_name" '$2 == name {print $1}')"

  if [[ -z "$app_id" ]]; then
    echo "No existing DigitalOcean App Platform app named '$app_name' -- creating it..."
    app_id="$(doctl apps create --spec "$spec_file" --format ID --no-header)"
    echo "Created app '$app_name' (id: $app_id)."
  else
    echo "Updating existing app '$app_name' (id: $app_id) with current spec..."
    doctl apps update "$app_id" --spec "$spec_file"
  fi

  echo "Triggering deployment for app '$app_name' (id: $app_id)..."
  doctl apps create-deployment "$app_id" --wait
}
# ---------------------------------------------------------------------------

APP_NAME="relay-$ENVIRONMENT"
SPEC_FILE=".do/app.$ENVIRONMENT.yaml"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "::error::Spec file $SPEC_FILE not found." >&2
  exit 1
fi

deploy_to_app_platform "$APP_NAME" "$SPEC_FILE"

echo "relay deployed successfully to $ENVIRONMENT (app: $APP_NAME)."
echo "Secret-typed env vars (REDIS_URL, APP_REGISTRY_JSON, per-app credential"
echo "vars) are NOT set by this script -- confirm they're already configured"
echo "on the app in the DO dashboard before relying on this deployment."
