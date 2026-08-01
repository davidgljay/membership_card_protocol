#!/usr/bin/env bash
# Shared publish logic for the repo's publishable npm packages. Not called
# directly by operators -- each package has a thin
# <package>/scripts/publish.sh wrapper that calls this with the right paths
# (see e.g. app-sdk/scripts/publish.sh). Centralized here so dev/prod
# dist-tag handling, dev prerelease versioning, and the provenance/dry-run
# flags stay identical across all six packages instead of drifting.
#
# Usage: scripts/publish-npm-package.sh <path/to/packages/<name>> <dev|prod> [--dry-run]
set -euo pipefail

PACKAGE_DIR="${1:?Usage: $0 <package-dir> <dev|prod> [--dry-run]}"
ENVIRONMENT="${2:?Usage: $0 <package-dir> <dev|prod> [--dry-run]}"
DRY_RUN_FLAG="${3:-}"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <package-dir> <dev|prod> [--dry-run]" >&2
  exit 1
fi

if [[ -z "${NODE_AUTH_TOKEN:-}" ]]; then
  echo "::error::Missing required env var NODE_AUTH_TOKEN (npm auth token with publish rights)." >&2
  echo "See the calling package's DEPLOYMENT.md for how to obtain it." >&2
  exit 1
fi

DIST_TAG="latest"
[[ "$ENVIRONMENT" == "dev" ]] && DIST_TAG="next"

cd "$PACKAGE_DIR"
PACKAGE_NAME="$(node -p "require('./package.json').name")"

# Every package here lives at <workspace-root>/packages/<name> -- the
# pnpm-workspace.yaml convention all six packages share.
WORKSPACE_ROOT="$(cd ../.. && pwd)"

echo "[$PACKAGE_NAME] Installing workspace dependencies ($WORKSPACE_ROOT)..."
(cd "$WORKSPACE_ROOT" && pnpm install --frozen-lockfile)

# package.json gets mutated below (version bump for dev, file: dependency
# rewrite for both). Snapshot the exact bytes now and restore that exact
# snapshot on exit -- NOT `git checkout`, which would discard any other
# uncommitted edit already sitting in package.json before this script ran
# (a real bug hit during Phase 1: an unrelated uncommitted comment edit was
# silently wiped by a sibling package's publish run).
PACKAGE_JSON_SNAPSHOT="$(mktemp)"
cp package.json "$PACKAGE_JSON_SNAPSHOT"
trap 'cp "$PACKAGE_JSON_SNAPSHOT" "'"$PACKAGE_DIR"'/package.json"; rm -f "$PACKAGE_JSON_SNAPSHOT"' EXIT

ORIGINAL_VERSION="$(node -p "require('./package.json').version")"
if [[ "$ENVIRONMENT" == "dev" ]]; then
  # Dev publishes happen on every push, unlike prod's tag-triggered,
  # human-versioned flow (publish-verifier.yml's existing convention) -- a
  # fixed version would collide with a prior dev publish, so derive a unique
  # prerelease suffix from the commit.
  GIT_SHA="$(git -C "$WORKSPACE_ROOT" rev-parse --short HEAD 2>/dev/null || echo "local")"
  NEW_VERSION="${ORIGINAL_VERSION}-dev.${GIT_SHA}.$(date +%s)"
  echo "[$PACKAGE_NAME] Dev publish: bumping $ORIGINAL_VERSION -> $NEW_VERSION (reverted after publish)"
  npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null
fi

echo "[$PACKAGE_NAME] Building..."
pnpm run build

echo "[$PACKAGE_NAME] Testing..."
pnpm run test

# Build/test above ran against file: links (correct locally-resolved code,
# monorepo-only). Only now, right before packing, rewrite any in-scope
# file: dependency to a real npm-resolvable version -- see
# scripts/rewrite-file-deps.mjs for why and how dev vs. prod differ.
REPO_ROOT="$(git -C "$WORKSPACE_ROOT" rev-parse --show-toplevel)"
node "$REPO_ROOT/scripts/rewrite-file-deps.mjs" "$ENVIRONMENT"

PUBLISH_ARGS=(--tag "$DIST_TAG")
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  # --provenance requires OIDC (id-token: write), only available in CI --
  # see publish-verifier.yml's existing `permissions: id-token: write`.
  PUBLISH_ARGS+=(--provenance)
fi
if [[ "$DRY_RUN_FLAG" == "--dry-run" ]]; then
  PUBLISH_ARGS+=(--dry-run)
fi

echo "[$PACKAGE_NAME] Publishing $(node -p "require('./package.json').version") to dist-tag '$DIST_TAG'..."
npm publish "${PUBLISH_ARGS[@]}"

echo "[$PACKAGE_NAME] Published successfully to '$DIST_TAG' ($ENVIRONMENT)."
