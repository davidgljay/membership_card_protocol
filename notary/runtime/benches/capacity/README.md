# notary-capacity: step 5.6 capacity benchmark

The benchmark drives the real broker under the simulator. Every input gets the real card checks, X-Wing opening and signed receipts, and every close re-checks and runs the tally program. It measures, per enclave core:
- inputs per second;
- per-job memory;
- close time.

Results and interpretation are in `plans/notary-code-plan.md` §11.

Build the worlds once:

```bash
node --experimental-strip-types e2e/src/bench-world.ts --contributors 1000 --out $W/bw1k.json
```

```bash
node --max-old-space-size=8192 --experimental-strip-types e2e/src/bench-world.ts --contributors 10000 --out $W/bw10k.json
```

The 10,000-contributor world takes about 12 minutes to build and is about 290 MB.

Run all five scenarios in Linux (memory comes from `/proc`). This takes about 25 minutes:

```bash
WORLDS=$W bash runtime/benches/capacity/run-linux.sh > results.jsonl
```

Or run one scenario on the host:

```bash
cargo run --release -p notary-capacity -- --world $W/bw1k.json --inputs 1000 --jobs 1 [--isolation dedicated]
```

On macOS, the memory figures from `ps` aren't reliable, and on Apple Silicon timings vary with performance and efficiency cores.
