#!/usr/bin/env bash
# Publishes one of this workspace's three publishable npm packages.
#
# Usage: scripts/publish.sh <verifier|verifier-ipfs-provider|verifier-rpc-provider> <dev|prod> [--dry-run]
#
# Unlike the other five packages in scope (one publishable package per
# workspace), membership_card_verifier/packages/ holds three JS packages
# (plus verifier-py, a Python package published to PyPI, out of scope here).
# verifier has no in-repo dependents needed at publish time; verifier and
# verifier-ipfs-provider must both publish before app-sdk (which depends on
# both) -- see app-sdk/DEPLOYMENT.md for the full cross-package order.
set -euo pipefail

PACKAGE="${1:?Usage: $0 <verifier|verifier-ipfs-provider|verifier-rpc-provider> <dev|prod> [--dry-run]}"
shift || true

case "$PACKAGE" in
  verifier|verifier-ipfs-provider|verifier-rpc-provider) ;;
  *)
    echo "Usage: $0 <verifier|verifier-ipfs-provider|verifier-rpc-provider> <dev|prod> [--dry-run]" >&2
    exit 1
    ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(git rev-parse --show-toplevel)"
exec "$REPO_ROOT/scripts/publish-npm-package.sh" "$(pwd)/packages/$PACKAGE" "$@"
