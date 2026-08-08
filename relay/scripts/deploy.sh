#!/usr/bin/env bash
# Deploys relay to its current live target: the Droplet
# (docker-compose.droplet.yml), reached over SSH. See
# relay/DEPLOYMENT.md's "Current path: Droplet, not App Platform" banner
# for why -- App Platform was the original Phase 1 target and is kept
# available below (RELAY_DEPLOY_TARGET=app_platform) in case usage grows
# enough to switch back, per that same doc's tradeoff list.
#
# Usage: scripts/deploy.sh <dev|prod>
#
# The actual platform call is isolated in deploy_to_droplet() /
# deploy_to_app_platform() below -- swapping targets is a one-function
# change, not a rewrite (strategic-plan.md Open Question 2; this is the
# swap the comment in the original App-Platform-only version of this
# script anticipated).
set -euo pipefail

ENVIRONMENT="${1:-}"
if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <dev|prod>" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEPLOY_TARGET="${RELAY_DEPLOY_TARGET:-droplet}"

# --- Platform-specific section: Droplet over SSH (current live path) ------
# Pulls the latest commit on the Droplet and recreates just this
# environment's relay service (--build picks up code changes; docker
# compose only recreates services whose config/image actually changed --
# see relay/DEPLOYMENT.md's note on `restart` vs `up -d` for why recreate,
# not restart, is required for this to reliably pick up changes).
#
# Required env vars: DROPLET_SSH_HOST, DROPLET_SSH_USER,
# DROPLET_SSH_PRIVATE_KEY (the private key's contents, not a path --
# written to a temp file scoped to this function, cleaned up after,
# never logged). In CI this comes from a GitHub Environment secret; set
# it yourself, it must never pass through an agent session.
deploy_to_droplet() {
  local environment="$1"

  local required=(DROPLET_SSH_HOST DROPLET_SSH_USER DROPLET_SSH_PRIVATE_KEY)
  local missing=()
  for var in "${required[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      missing+=("$var")
    fi
  done
  if [[ ${#missing[@]} -ne 0 ]]; then
    echo "::error::Missing required env var(s) for Droplet deploy:" >&2
    for name in "${missing[@]}"; do
      echo "  - $name" >&2
    done
    exit 1
  fi

  local key_file
  key_file="$(mktemp)"
  trap 'rm -f "$key_file"' RETURN
  printf '%s\n' "$DROPLET_SSH_PRIVATE_KEY" > "$key_file"
  chmod 600 "$key_file"

  local compose_service compose_profile_arg
  if [[ "$environment" == "prod" ]]; then
    compose_service="relay-prod"
    compose_profile_arg="--profile prod"
  else
    compose_service="relay-dev"
    compose_profile_arg=""
  fi

  echo "Deploying relay-$environment to the Droplet ($DROPLET_SSH_HOST)..."
  ssh -o StrictHostKeyChecking=accept-new -i "$key_file" "$DROPLET_SSH_USER@$DROPLET_SSH_HOST" bash -s <<EOF
set -euo pipefail
cd ~/membership_card_protocol
git pull
cd relay
docker compose -f docker-compose.droplet.yml $compose_profile_arg up -d --build $compose_service
EOF
}
# ---------------------------------------------------------------------------

# --- Platform-specific section: DigitalOcean App Platform (fallback) ------
# Kept from the original Phase 1 implementation, reachable via
# RELAY_DEPLOY_TARGET=app_platform. Not the live path today -- see
# relay/DEPLOYMENT.md's "Why App Platform, not a Droplet" section.
#
# Required env vars: DIGITALOCEAN_ACCESS_TOKEN.
deploy_to_app_platform() {
  local environment="$1"

  if [[ -z "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]]; then
    echo "::error::Missing required env var DIGITALOCEAN_ACCESS_TOKEN for relay $environment App Platform deploy." >&2
    exit 1
  fi

  command -v doctl >/dev/null 2>&1 || {
    echo "::error::doctl is not installed. See https://docs.digitalocean.com/reference/doctl/how-to/install/" >&2
    exit 1
  }

  doctl auth init --access-token "$DIGITALOCEAN_ACCESS_TOKEN" >/dev/null

  local app_name="relay-$environment"
  local spec_file=".do/app.$environment.yaml"
  if [[ ! -f "$spec_file" ]]; then
    echo "::error::Spec file $spec_file not found." >&2
    exit 1
  fi

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

case "$DEPLOY_TARGET" in
  droplet)
    deploy_to_droplet "$ENVIRONMENT"
    ;;
  app_platform)
    deploy_to_app_platform "$ENVIRONMENT"
    ;;
  *)
    echo "::error::Unknown RELAY_DEPLOY_TARGET '$DEPLOY_TARGET' (expected 'droplet' or 'app_platform')." >&2
    exit 1
    ;;
esac

echo "relay deployed successfully to $ENVIRONMENT (target: $DEPLOY_TARGET)."
echo "Secret-typed config (.env.$ENVIRONMENT.droplet / REDIS_URL, APP_REGISTRY_JSON"
echo "for the app_platform path) is NOT set by this script -- confirm it's already"
echo "configured before relying on this deployment."
