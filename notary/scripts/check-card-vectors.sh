#!/usr/bin/env bash
# Code-plan §7.5 mechanisms 1–3: keeps notary-cards (Rust) in step with the TypeScript verifier.
#  1. regenerates notary/vectors/cards/ from the TypeScript verifier and fails if the committed files differ
#     (a verifier change that alters any verdict can't merge without new vectors);
#  2. runs the Rust conformance test, which must agree with every committed case and find the coverage map complete.
set -euo pipefail
cd "$(dirname "$0")/../.."
( cd membership_card_verifier/packages/verifier && pnpm run --silent check:notary-conformance )
( cd notary && cargo test -q -p notary-cards --test conformance )
echo "card vectors: up to date, and notary-cards agrees with every case"
