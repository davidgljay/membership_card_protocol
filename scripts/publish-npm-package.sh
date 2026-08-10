#!/usr/bin/env bash
# Shared publish logic for the repo's publishable npm packages. Not called
# directly by operators -- each package has a thin
# <package>/scripts/publish.sh wrapper that calls this with the right paths
# (see e.g. app-sdk/scripts/publish.sh). Centralized here so dev/prod
# dist-tag handling, dev prerelease versioning, and the provenance/dry-run
# flags stay identical across all six packages instead of drifting.
#
# Usage: scripts/publish-npm-package.sh <path/to/packages/<name>> <dev|prod> [--dry-run]
# Dev publishes are skipped automatically when nothing changed since the
# last one -- see the skip-if-unchanged block below. Set FORCE_PUBLISH=1 to
# always publish regardless.
set -euo pipefail

PACKAGE_DIR="${1:?Usage: $0 <package-dir> <dev|prod> [--dry-run]}"
ENVIRONMENT="${2:?Usage: $0 <package-dir> <dev|prod> [--dry-run]}"
DRY_RUN_FLAG="${3:-}"

if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "Usage: $0 <package-dir> <dev|prod> [--dry-run]" >&2
  exit 1
fi

# In CI, these packages publish via npm's Trusted Publishing (OIDC,
# id-token: write -- see deploy-pipeline.yml's `permissions` block and
# publish-verifier.yml's). Trusted Publishing requires NODE_AUTH_TOKEN to
# be ABSENT, not just present-and-unused: npm treats a token alongside a
# Trusted Publisher identity as a token-based publish attempt and rejects
# it with a 404 (not a clearer 403) if the package's npmjs.com settings
# only allow the trusted publisher -- confirmed live. So NODE_AUTH_TOKEN
# is only required outside CI (a human publishing from their own machine,
# where no OIDC token exists).
if [[ -z "${GITHUB_ACTIONS:-}" && -z "${NODE_AUTH_TOKEN:-}" ]]; then
  echo "::error::Missing required env var NODE_AUTH_TOKEN (npm auth token with publish rights)." >&2
  echo "See the calling package's DEPLOYMENT.md for how to obtain it." >&2
  echo "(Not needed in CI -- these packages publish via Trusted Publishing there.)" >&2
  exit 1
fi

DIST_TAG="latest"
[[ "$ENVIRONMENT" == "dev" ]] && DIST_TAG="next"

cd "$PACKAGE_DIR"
PACKAGE_NAME="$(node -p "require('./package.json').name")"

# Every package here lives at <workspace-root>/packages/<name> -- the
# pnpm-workspace.yaml convention all six packages share.
WORKSPACE_ROOT="$(cd ../.. && pwd)"

# Skip-if-unchanged (dev only): every dev publish embeds the git SHA it was
# built from in the version string (see NEW_VERSION below,
# "-dev.<sha>.<timestamp>"). Pull the last-published dev version back off
# npm, recover that SHA, and diff this package's directory (plus any local
# file: dependency it embeds -- see FILE_DEP_DIRS below) against HEAD. A
# clean diff means the tarball we'd produce is byte-identical in substance
# to what's already published under the 'next' tag, so skip the
# install/build/test/publish cycle entirely.
#
# Deliberately scoped to dev only. Prod versions are human-bumped, not
# derived from a commit SHA (publish-verifier.yml's existing tag-triggered
# convention), so there's no SHA to recover from a prod version string --
# and prod's `npm publish` already refuses to overwrite an unchanged
# version on its own (E403), which is the correct behavior there (forces a
# human to bump the version), not something to route around.
#
# Any failure to determine the last-published SHA (never published before,
# ambiguous/unresolvable SHA, shallow clone that doesn't reach it) falls
# through to a normal publish -- this only ever skips work, never silently
# skips a real change. Set FORCE_PUBLISH=1 to bypass entirely (e.g.
# re-publishing after a registry-side mishap with no corresponding commit).
if [[ "$ENVIRONMENT" == "dev" && "${FORCE_PUBLISH:-}" != "1" ]]; then
  LAST_DEV_VERSION="$(npm view "$PACKAGE_NAME" dist-tags.next 2>/dev/null || true)"
  LAST_SHA="$(node -e '
    const m = (process.argv[1] || "").match(/-dev\.([0-9a-f]+)\./);
    if (m) process.stdout.write(m[1]);
  ' "$LAST_DEV_VERSION")"

  if [[ -n "$LAST_SHA" ]] && git -C "$WORKSPACE_ROOT" cat-file -e "${LAST_SHA}^{commit}" 2>/dev/null; then
    # file: deps count toward the diff too -- a change in an upstream
    # in-repo package (e.g. verifier) must still trigger app-sdk to
    # republish, since app-sdk's own tarball embeds verifier's resolved
    # code at publish time (see rewrite-file-deps.mjs below). Unquoted on
    # purpose when used below: these are always plain repo-relative paths
    # with no spaces/globs, and deploy-all.sh already avoids bash arrays
    # here for the same "empty array + set -u" portability reason (see its
    # own publish_step comment).
    FILE_DEP_DIRS="$(node -e '
      const path = require("path");
      const pkg = require("./package.json");
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const v of Object.values(deps)) {
        if (typeof v === "string" && v.startsWith("file:")) {
          console.log(path.resolve(process.cwd(), v.slice("file:".length)));
        }
      }
    ')"

    if git -C "$WORKSPACE_ROOT" diff --quiet "$LAST_SHA" HEAD -- "$PWD" $FILE_DEP_DIRS; then
      echo "[$PACKAGE_NAME] No changes since $LAST_SHA (published as $LAST_DEV_VERSION) -- skipping publish."
      exit 0
    fi
  fi
fi

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
# No --provenance flag: under Trusted Publishing (npm docs, confirmed live)
# npm generates and publishes the provenance attestation automatically from
# the OIDC identity -- passing --provenance explicitly is for the older
# token+OIDC-signing hybrid flow, not needed (and not used) here.
if [[ "$DRY_RUN_FLAG" == "--dry-run" ]]; then
  PUBLISH_ARGS+=(--dry-run)
fi

echo "[$PACKAGE_NAME] Publishing $(node -p "require('./package.json').version") to dist-tag '$DIST_TAG'..."
npm publish "${PUBLISH_ARGS[@]}"

echo "[$PACKAGE_NAME] Published successfully to '$DIST_TAG' ($ENVIRONMENT)."
