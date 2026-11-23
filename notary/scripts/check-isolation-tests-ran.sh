#!/usr/bin/env bash
# E27 / R5: the worker-sandbox tests are compiled only on Linux (#[cfg(target_os = "linux")]), so a green
# `cargo test` on another platform has not run them, and a skipped or filtered test is not a pass. This script runs
# them and fails unless each named test ran and passed. Run it from anywhere; it needs a Rust toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Linux ] || { echo "E27: not Linux ($(uname -s)); the isolation tests do not exist here" >&2; exit 1; }
out=$(mktemp); trap 'rm -f "$out"' EXIT
cargo test -p notary-runtime --test worker_process -- --nocapture 2>&1 | tee "$out"
for t in worker_speaks_the_section_8_protocol_over_pipes a_running_worker_is_sandboxed; do
  grep -q "^test $t \.\.\. ok$" "$out" || { echo "E27: isolation test '$t' did not run and pass" >&2; exit 1; }
done
echo "E27: isolation tests ran on $(uname -m) Linux"
