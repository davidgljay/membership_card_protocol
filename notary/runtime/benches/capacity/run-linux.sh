#!/usr/bin/env bash
# Step 5.6: runs the capacity scenarios in a Linux container (arm64 on Apple Silicon or Graviton), where resident
# memory and its peak come from /proc. Worlds come from notary/e2e/src/bench-world.ts:
#   WORLDS=/path/with/bw1k.json+bw10k.json bash runtime/benches/capacity/run-linux.sh > results.jsonl
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${WORLDS:?set WORLDS to the directory holding bw1k.json and bw10k.json}"
docker run --rm -v "$PWD":/notary -v "$WORLDS":/worlds -v notary-bench-target:/target -v notary-bench-cargo:/usr/local/cargo/registry \
  -w /notary rust:1.96 sh -c '
  cargo build --release -p notary-capacity --target-dir /target >&2
  B=/target/release/notary-capacity
  echo "# $(uname -m), $(nproc) cpus, $(grep -m1 "model name\|CPU part" /proc/cpuinfo | cut -d: -f2)" >&2
  $B --world /worlds/bw1k.json  --inputs 1000  --jobs 1
  $B --world /worlds/bw1k.json  --inputs 1000  --jobs 1 --isolation dedicated
  $B --world /worlds/bw10k.json --inputs 10000 --jobs 1
  $B --world /worlds/bw1k.json  --inputs 1000  --jobs 20
  $B --world /worlds/bw10k.json --inputs 10000 --jobs 5
'
