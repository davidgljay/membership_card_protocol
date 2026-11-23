# suites/notary/: Digital Notaries

Tests derived from the acceptance criteria in `specs/card_protocol_spec.md` §9 (Notaries). Run with
`./run.sh --integration-only --with-notary` (see the header of `run.sh`) or one file at a time:
`./run.sh --suite notary/rpc_chain`.

This directory holds the tests that need the integration stack's devnode. The processes-end-to-end scenarios (the host,
the enclave broker, a simulated chain, three hosts in Docker) live in `notary/e2e/` and run as steps of `--with-notary`.

| File | What it checks | Needs |
|---|---|---|
| `rpc_chain.spec.ts` | The host's production chain clients against the registry on the devnode: register and batch writes through the real write gate, reads, the registry feed, header RLP | devnode with contracts deployed |
| `eas_anchor.spec.ts` | The host's EAS anchorer writes; the production reader (`EthersEasReader`) reads; schema, ABI encoding and scope agree | devnode; `EAS_CONTRACTS_DIR` (`--with-notary` sets it; the suite skips without it) |

## Where each acceptance criterion is tested

| Criterion (§9) | Test |
|---|---|
| G1: aggregation at `k_min`; fewer gives `insufficient_participation` | `notary/e2e` `job` phase (at `k_min`); the below-`k_min` case on the aggregate template through real processes (`e2e/hostile`, "fewer contributors than k_min") and on the vote template (`vote` phase, second vote) |
| G1: vote tally, closing on chain and enclave time | `notary/e2e` `vote` phase |
| G1: derived card, projected fields only, unlinkable | `notary/e2e` `derive` phase (a scan of the chain transactions); the scan of everything the host holds is the Rust test `derive.rs::the_hosts_records_never_name_a_source_card` |
| G1: `sealed_link` revocation; `expiry_only` lapse | `notary/e2e` `derive` (nothing is released one minute before `min_delay`; released by `min_delay + batch_window`) and `expiry` phases |
| G1: all four on real AWS Nitro (deferred) | `aws_nitro.spec.ts`: five tests, skipped on purpose, so the deferral shows in every run |
| G2: the wallet's rejections | `notary/e2e` `vote` phase (five of six against a real announcement); `wallet-sdk` `verifyJob.test.ts` (all six, with forged attestations) |
| G2: inclusion in `input_commitment` | `notary/e2e` `vote` phase |
| G2: the consent screen comes from policy and job | `wallet-sdk` `verifyJob.test.ts` |
| G2: program compliance; leaky program bounded | `notary-admission` and `notary-broker` Rust tests (`cargo test --workspace`) |
| G3: three templates activate with no code | `notary/e2e/test/templates.test.ts` and the three template jobs |
| G3: a new operator stands up a notary in under an hour | `notary/README.md` steps 1 to 3 timed in a clean worktree of HEAD: TypeScript dependency builds 15 s, host install and build 10 s, `cargo build --locked` 21 s (fresh `target`), then `run-local.sh` about 4 to 6 minutes. **Warm caches** (pnpm store and cargo registry already populated), so first-time downloads are not included; the Docker route is not timed |
| G4: a replica killed mid-vote loses no ballots | `notary/e2e/run-three.sh` (kills host C's enclave holding the job, a non-leader; the standby that takes over was started in advance) |
| G4: all replicas lost, new epoch, resubmission | `notary/e2e` `vote` phase (the operator restart API, `EPOCH_TOTAL_LOSS`; no enclave process is killed) |
| G4: handoffs in the job log; signed receipts | `notary/e2e/run-three.sh`; every submit checks its receipts |
| G5: no AWS formats outside the attestation modules | `notary/scripts/check-aws-isolation.sh`, `check-isolation-tests-ran.sh` |
