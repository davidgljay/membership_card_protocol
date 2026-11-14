#!/usr/bin/env bash
# Builds a template to a notary_v1 module (code-plan §7.4: reproducible, checked by CI).
#   templates/build.sh aggregate            -> templates/modules/aggregate.wasm and its CID in templates/modules/aggregate.cid
#   templates/build.sh aggregate --check    -> fails if the committed module differs from a fresh build
# Linker flags give admission what it needs (runtime §6): one memory exported as "memory" with a declared maximum, no
# start function, and exactly two exports (`memory`, `run`).
set -euo pipefail
cd "$(dirname "$0")/.."
name=$1; mode=${2:-}
crate=notary-template-$name
RUSTFLAGS="--remap-path-prefix=$PWD=/notary --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$(rustc --print sysroot)=/rustc -C debuginfo=0 -C opt-level=s -C panic=abort -C codegen-units=1 -C target-cpu=mvp -C target-feature=+mutable-globals,+sign-ext,+multivalue,+bulk-memory,-reference-types,-nontrapping-fptoint -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=4194304 -C link-arg=-zstack-size=262144 -C link-arg=--no-entry -C link-arg=--export=run -C link-arg=--gc-sections -C link-arg=--strip-all" \
  cargo build -q -p "$crate" --release --target wasm32-unknown-unknown 2>&1
linked=target/wasm32-unknown-unknown/release/notary_template_${name}.wasm
built=target/wasm32-unknown-unknown/release/notary_template_${name}.normalized.wasm
cargo run -q -p notary-template-normalize --release -- "$linked" "$built"
mkdir -p templates/modules
if [ "$mode" = "--check" ]; then
  cmp -s "$built" "templates/modules/$name.wasm" || { echo "stale: templates/modules/$name.wasm" >&2; exit 1; }
  echo "$name: the committed module is what the source builds"
else
  cp "$built" "templates/modules/$name.wasm"
  echo "$(sha256sum "templates/modules/$name.wasm" 2>/dev/null || shasum -a 256 "templates/modules/$name.wasm")" > "templates/modules/$name.sha256"
  echo "wrote templates/modules/$name.wasm"
fi
