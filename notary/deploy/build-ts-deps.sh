#!/bin/sh
# Builds the TypeScript packages the notary host and the e2e tooling depend on, inside an image (build context: the
# repository root, copied to /repo). The wallet SDK's two provider devDependencies (React Native / web Matrix crypto)
# are dropped: they are used only by its own tests, and nothing under its src/ imports them.
set -e
cd /repo
b() { (cd "$1" && pnpm install --frozen-lockfile=false && pnpm run build); }
b membership_card_verifier/packages/verifier
# outside its own pnpm workspace, the provider's `workspace:*` reference to the verifier is the sibling directory
sed -i 's|"@membership-card-protocol/verifier": "workspace:\*"|"@membership-card-protocol/verifier": "file:../verifier"|' membership_card_verifier/packages/verifier-ipfs-provider/package.json
b membership_card_verifier/packages/verifier-ipfs-provider
b app-sdk/packages/app-sdk
b notary/attestation-ts
(cd wallet-sdk/packages/wallet-sdk && npm pkg delete "devDependencies.@membership-card-protocol/sdk-providers-rn" "devDependencies.@membership-card-protocol/sdk-providers-web")
b wallet-sdk/packages/wallet-sdk
