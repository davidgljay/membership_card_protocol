#!/usr/bin/env bash
# One-shot init: generates Synapse's signing key + registration shared
# secret + the policy module's membership-registry key (none of these exist
# yet in a fresh volume), then renders homeserver.yaml from the template.
# Idempotent — skips anything that already exists, so it's safe to rerun
# against a volume from a previous run.
set -euo pipefail

SECRETS_DIR=/data/secrets
mkdir -p "$SECRETS_DIR"

# 1. Signing key (ed25519 <key_id> <base64_seed>). Generated via Synapse's
# own `generate` mode into a scratch dir rather than hand-rolled — that
# mode's own key generation is what Synapse itself considers correct, and
# hand-rolling the DER-to-raw-seed extraction is easy to get subtly wrong
# (see wallet-service/scripts/generate-matrix-secrets.ts's own comment on
# this exact risk, which this sidesteps by not doing it at all).
if [[ ! -f "$SECRETS_DIR/homeserver.signing.key" ]]; then
  SCRATCH=$(mktemp -d)
  SYNAPSE_SERVER_NAME="${MATRIX_SERVER_NAME}" SYNAPSE_REPORT_STATS=no \
    SYNAPSE_CONFIG_DIR="$SCRATCH" SYNAPSE_DATA_DIR="$SCRATCH" \
    python3 /start.py generate
  cp "$SCRATCH"/*.signing.key "$SECRETS_DIR/homeserver.signing.key"
  rm -rf "$SCRATCH"
  echo "Generated $SECRETS_DIR/homeserver.signing.key"
fi

# 2. registration_shared_secret — no `_path` config variant exists for this
# key (confirmed against Synapse's sample config; same finding recorded in
# wallet-service/scripts/generate-matrix-secrets.ts's header comment), so
# it's supplied as a literal value in its own config file, passed as a
# second --config-path alongside homeserver.yaml.
if [[ ! -f "$SECRETS_DIR/registration-shared-secret.yaml" ]]; then
  SECRET=$(openssl rand -hex 32)
  echo "registration_shared_secret: \"$SECRET\"" > "$SECRETS_DIR/registration-shared-secret.yaml"
  echo "Generated $SECRETS_DIR/registration-shared-secret.yaml"
fi

# 3. Membership registry encryption key (raw 32 bytes, base64url, one line
# — matches wallet-service's WEBCRYPTO_MASTER_KEY encoding convention).
if [[ ! -f "$SECRETS_DIR/membership-registry.key" ]]; then
  openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n' > "$SECRETS_DIR/membership-registry.key"
  echo >> "$SECRETS_DIR/membership-registry.key"
  echo "Generated $SECRETS_DIR/membership-registry.key"
fi

# 4. Render homeserver.yaml.template -> homeserver.yaml. sed, not envsubst
# (not present in this image) — `|` delimiter since the substituted values
# (URLs) contain `/`.
sed \
  -e "s|\${MATRIX_SERVER_NAME}|${MATRIX_SERVER_NAME}|g" \
  -e "s|\${ARBITRUM_RPC_URL}|${ARBITRUM_RPC_URL}|g" \
  -e "s|\${ARBITRUM_RPC_WS_URL}|${ARBITRUM_RPC_WS_URL:-}|g" \
  -e "s|\${REGISTRY_CONTRACT_ADDRESS}|${REGISTRY_CONTRACT_ADDRESS}|g" \
  -e "s|\${IPFS_GATEWAY_URL}|${IPFS_GATEWAY_URL}|g" \
  -e "s|\${JOIN_ATTESTATION_FRESHNESS_SECONDS}|${JOIN_ATTESTATION_FRESHNESS_SECONDS}|g" \
  -e "s|\${WATCHER_BACKSTOP_INTERVAL_SECONDS}|${WATCHER_BACKSTOP_INTERVAL_SECONDS}|g" \
  -e "s|\${MATRIX_MEMBERSHIP_REGISTRY_PATH}|${MATRIX_MEMBERSHIP_REGISTRY_PATH}|g" \
  -e "s|\${MATRIX_MEMBERSHIP_REGISTRY_KEY_PATH}|${MATRIX_MEMBERSHIP_REGISTRY_KEY_PATH}|g" \
  -e "s|\${MATRIX_ENFORCEMENT_USER_ID}|${MATRIX_ENFORCEMENT_USER_ID}|g" \
  /template/homeserver.yaml.template > /data/homeserver.yaml

echo "Rendered /data/homeserver.yaml"

# The `run`-mode synapse process may run as a non-root user (gosu) while
# this init script runs as root — dev/test-only stack, so broad
# permissions are simplest and not a real security concern here.
chmod -R a+rwX /data
