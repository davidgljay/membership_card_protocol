#!/usr/bin/env bash
# Publishes @membership-card-protocol/sdk-providers-rn.
#
# Usage: scripts/publish.sh <dev|prod> [--dry-run]
#
# Depends on @membership-card-protocol/app-sdk being published to the target
# dist-tag first -- see sdk-providers-rn/DEPLOYMENT.md for the full publish
# order across all six packages.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(git rev-parse --show-toplevel)"
exec "$REPO_ROOT/scripts/publish-npm-package.sh" "$(pwd)/packages/sdk-providers-rn" "$@"
