#!/usr/bin/env bash
# Fetches EAS 1.9.0's compiled contracts (MIT, npm: @ethereum-attestation-service/eas-contracts) for the notary suites'
# devnode deployment (governance/scripts/notary-eas.ts). The tarball's SHA-512 is pinned below: a different file is refused.
# Usage: fetch-eas-contracts.sh <dir>   (prints the directory to use as EAS_CONTRACTS_DIR; reuses a verified earlier fetch)
set -euo pipefail
dir=${1:?usage: fetch-eas-contracts.sh <dir>}
version=1.9.0
integrity='sha512-L60y1fgKlY3a45xxnPlgRbiGQY8RF/lF+AzF1iVoR7/aEzitS0Nuyyjq8+IXs1sSSU0dl2+yGSmELxVeB6FelA=='
target="$dir/node_modules/@ethereum-attestation-service/eas-contracts"
if [ -f "$target/artifacts/contracts/EAS.sol/EAS.json" ] && [ -f "$dir/.verified-$version" ]; then echo "$dir/node_modules"; exit 0; fi
mkdir -p "$dir" && cd "$dir"
npm pack "@ethereum-attestation-service/eas-contracts@$version" --silent >/dev/null
tgz="ethereum-attestation-service-eas-contracts-$version.tgz"
got="sha512-$(openssl dgst -sha512 -binary "$tgz" | openssl base64 -A)"
if [ "$got" != "$integrity" ]; then echo "fetch-eas-contracts: $tgz has integrity $got, expected $integrity" >&2; rm -f "$tgz"; exit 1; fi
rm -rf node_modules/@ethereum-attestation-service && mkdir -p node_modules/@ethereum-attestation-service/eas-contracts
tar -xzf "$tgz" -C node_modules/@ethereum-attestation-service/eas-contracts --strip-components=1
touch ".verified-$version"
echo "$dir/node_modules"
