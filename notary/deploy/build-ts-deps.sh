#!/bin/sh
# Builds the TypeScript packages the notary host and the e2e tooling depend on, inside an image (build context: the
# repository root, copied to /repo, or any checkout with REPO_ROOT set). Every install is `--frozen-lockfile`: the workspace's own lockfile decides what is
# installed, and a lockfile that does not match its manifests fails the build instead of being re-resolved.
#
# Each workspace's root files (package.json, pnpm-lock.yaml, pnpm-workspace.yaml) are copied by the Dockerfile with the
# packages named here. `--filter "./<pkg>..."` installs that package and what it depends on, so a lockfile entry for a
# package that is not in the image (another workspace member) is ignored.
set -e
cd "${REPO_ROOT:-/repo}"
# b <workspace root> <package dir>...: a locked install of those packages, then their builds, in the order given
b() {
  root=$1; shift
  filters=""
  for p in "$@"; do filters="$filters --filter ./$p..."; done
  (cd "$root" && pnpm install --frozen-lockfile $filters)
  for p in "$@"; do (cd "$root" && pnpm --filter "./$p" run build); done
}
b membership_card_verifier packages/verifier packages/verifier-ipfs-provider
b app-sdk packages/app-sdk
b notary attestation-ts
b wallet-sdk packages/wallet-sdk
