# Notary Phase 5 Summary — Runtime, Verifier Support and Host

Dates: 2026-11-12 to 2026-11-13 · Progress history: [notary-phase-5-progress.md](notary-phase-5-progress.md) · Errata from the review: [notary-questions-5.7.md](../notary-questions-5.7.md) · Code plan: [notary-code-plan.md](../notary-code-plan.md) (§8.3 traceability, §11 capacity)

## What was done

Steps 5.0–5.7 of the implementation plan. The specs were approved at CP3, so Phase 5 is code and tests only. **Nothing is committed (CP11).**

| Step | Result |
|---|---|
| 5.0 Questions | Answered at CP5 (E1–E19) |
| 5.1 Types and serialization | `notary-types` (Rust) and the TypeScript types agree on every shared vector. X-Wing draft-06 and ML-DSA-44 interoperate in both directions (CP9 checkpoint 1 passed). |
| 5.2 Simulator and attestation | `notary-attest` (Rust) and `notary-attestation` (TypeScript) parse the same documents; the 49 simulator documents are judged identically by both, and every `ATT_*` code has a failing fixture. The AWS root is pinned. |
| 5.3 Runtime core | `notary-worker` on wasmi 2.0.0 with a frozen fuel table (CP9 checkpoint 4 passed), `notary-admission` (A1–A11), `notary-crypto`, `notary-broker` (keyring, lists, chain, jobs, inputs, close, job log, genesis), `notary-runtime` with seccomp, UIDs and rlimits, `notary-lint`, `notary-guest` |
| 5.3a Card checks in Rust | `notary-cards`, a line-by-line port of the verifier's Stages 2–4, the predicates and B5–B8. The TypeScript verifier generates 58 contributor cases and 21 algorithm R cases; Rust agrees on all of them; CI regenerates and compares. |
| E31 and batch 2 | Algorithm R (policy, requester and list reads over `fetch`), the single-operator disclosure and switch (E32, E34), the identity-log `seq` 0 record (E26, E35). Spec batches applied. |
| 5.4 Wallet and verifier | Algorithms W, G, N, L, E; consent model; sealing and receipts; inclusion; watch and resubmission; `verifier/notary` subpath; `getGovernanceKeyset` and `getNotaryLogAnchors` |
| 5.5 Host | nitropack service: receipts, job intake, inputs, the enclave protocol, snapshots and updates, schedulers, the OHTTP gateway, monitoring. **The end-to-end path runs in docker-compose against the simulator.** |
| 5.6 Capacity benchmark | ≈ 290 inputs/s per broker thread; close ≈ 2.3 ms per input. Initial deployment decided: one c6g.large per operator (code-plan §11). |
| 5.7 This review | See "Review" below |

## What the review checked

- **Names, objects and codes.** The object fields and `type` strings are held against the specs by the shared vectors (`notary/vectors/`), which both languages check. The host routes (host §5: 10 of 10), the host-to-enclave message kinds (runtime §9: all 14 are handled), and the host configuration (§4) were compared one by one. The error codes were compared mechanically: every code in the six notary specs and `protocol-objects.md §20–§34` was looked up in the code and in the tests, and the reverse (codes in the code and in no spec).
- **Algorithms.** W, G, N, L, E, R, A and B1–B11 were checked through their tests (one per code) and by reading the highest-risk code: `create_job` (step 17), `check_input` (B1–B11), the close, genesis and countersign, the identity log, admission. The review did **not** re-derive every step of every algorithm line by line. Where a step has a test that fails if the step is removed, the test was trusted.
- **AWS isolation.** `check-aws-isolation.sh` passed, and its patterns were widened (below).

## Coverage map (spec requirement → test)

| Requirement | Test |
|---|---|
| Algorithm A1–A11, `ADM_DP_UNSUPPORTED`, `ADM_FEATURE_UNSUPPORTED`, both `LINT_*` | `cargo test -p notary-admission` (14 tests) |
| §6 rejected features, fuel determinism, ABI, fresh instance per run (CP9 checkpoint 4) | `notary-worker/tests/cp9.rs` (7) in five builds |
| Worker protocol (§8); worker sandbox (§3) | `notary-runtime/tests/worker_process.rs` (1 on macOS, 2 on Linux arm64) |
| Output checks and privacy transforms (§11), leaky program bounded | `notary-broker/tests/transforms.rs` (5) |
| Keys, I1–I3, lineage, erasure per job (§4, §15) | `notary-broker/tests/keyring.rs` (4); `broker.rs::genesis_ignores_host_keys_and_countersign_checks_g2` (I2); drop-zeroize in `notary-crypto/tests/wrappers.rs` |
| No job key before admission; `JOB_*`, `ADM_DEDICATED_REQUIRED`, `IDENTITY_LOG_PENDING` | `broker.rs`: `create_job_refuses_before_any_key_exists`, `shared_isolation_needs_the_verified_allowlist`, `a_dedicated_enclave_takes_a_new_job_once_the_old_one_has_ended`, `multi_replica_jobs_are_refused_until_step_6_3` |
| B1–B4, B9–B11, `REVISION_CONFLICT`, receipts | `broker.rs`: `inputs_receipts_and_checks`, `b2_b3_b4_and_b11_rejections` |
| B5–B8 | 58 vectors (`vectors/cards/cases.json`), checked in Rust (`notary-cards/tests/conformance.rs`, `notary-broker/tests/cards_oracle.rs`) and TypeScript |
| Algorithm R | 21 vectors, both languages; `notary-broker/tests/list_reads.rs` |
| Algorithm L, rule E, `LIST_VERSION_REGRESSION` | `vectors/lists/cases.json` (20), both languages; `notary-broker/tests/lists.rs` |
| Close by chain and attested time, `k_min`, notarization, `CLOSE_NOT_DUE` | `broker.rs`: `close_needs_both_clocks_and_produces_a_verifiable_notarization`, `k_min_suppresses_and_the_program_does_not_run` |
| Isolation between jobs | `broker.rs::jobs_are_isolated_from_each_other` |
| `ATT_*` (13 codes) | 49 simulator documents, Rust and TypeScript (`att_codes.rs`, `attestation-ts` tests) |
| Algorithm W (every `JOB_*`, the six G2 rejections) | wallet `verifyJob.test.ts` (32 with real attestations) |
| Algorithm N (every `NOT_*`), G, E | `attestation-ts/test/{notarization,genesis,derived}.test.ts`; verifier `exposure.test.ts` |
| Host §5–§7, §13, `NH_*` codes, never-filtered snapshots, retention | host tests (78); every `NH_*` in host §14 has a test |
| Gateway and direct-route refusal | `gateway.test.ts` (7) |
| End to end (genesis, `seq` 0, job, W, three inputs, close, N) | `notary/e2e/run-local.sh`, `run-compose.sh` |

**Requirements with no test** (the gaps):

- **Worker sandbox on x86_64.** Verified on Linux arm64 only (E27). On arm64 the whole workspace, including the sandbox and wall-clock tests, passes in a `rust:1.96` container (88 tests).
- **Differential fuzzing** (§7.5 mechanism 4) is built after the review (`fuzz-notary-conformance.ts`, `notary-fuzz.yml`, nightly, not gating); 3,600 mutants gave no disagreement.
- **`DERIVE_*`, `HANDOFF_*`.** Phase 6 (6.3, 6.4); no code and no test yet, as planned.
- **Propagation, state blob, epoch restart, multi-replica close.** Phase 6.
- **Host re-attestation** (`REATTEST_INTERVAL_SECONDS` is validated and unused). Phase 6.3.
- **Real AWS attestation document.** None tested (Phase 8).
- **Host `fetch` kinds `press_auth:` and `events:`.** The host answers `null`; nothing in the sim stack uses them.

## Deviations and how each was resolved

| Deviation | Resolution |
|---|---|
| A dedicated enclave counted finished jobs and refused every later dedicated job | **Fixed**, with a test (`notary-questions-5.7.md`, "Fixed" 1) |
| Multi-replica jobs were keyed by a single enclave, against the file's own header | **Fixed**, with a test |
| The host fell back to in-memory chain, EAS and IPFS services under a production configuration | **Fixed** (`host/src/providers.ts`), with tests |
| The header scheduler skipped headers after a failed call, freezing an enclave's chain | **Fixed**, with a test |
| `run-local.sh` failed at `HEAD` on this machine (a wallet raced the first header tick) | The driver retries `INPUT_CHAIN_REF_UNKNOWN`; the cause is Q3 |
| A call to the AWS module in production runtime code that the G5 grep patterns could not see | **Fixed**; the script now fails on any production code that names the AWS module; probe tested |
| Four B-checks (B2, B3 mismatch, B4 late, B11) had no test | **Fixed**, one test |
| Log-record `at` uses the attested clock; §28 says chain time | **Resolved:** §28 follows the code; a failed clock is now an error, not 1970 |
| Identity-log `seq` 0 at countersign | **Consistent.** Spec step 9 (E26, E35), `host_proto.rs::on_countersign`, `broker.rs` and `exposure.test.ts` agree. |
| `NOTARY_CARD_ADDRESSES` is static; restart after genesis | **Resolved (Q4):** optional; genesis cards are served and remembered |
| Simulator wiring in the host | A real hazard, fixed (above); wording for §4 is Q5 |
| e2e read adapters take shortcuts (W5 `satisfies`, algorithm E's PCR0, `chainValid: true`) | **Test scaffolding only.** Nothing outside `notary/e2e` imports it; no product package depends on it. The shortcuts are now listed in `notary/e2e/README.md`, and under Phase 7 below. |
| Codes in code that no spec lists | Q6 |
| First header in the enclave chain is an unchecked anchor | **Resolved (Q7):** within 10 minutes of the attested time; spec §13 says so |
| Wallet SDK depends on an unpublished package; no CI for the wallet SDK | **Resolved (Q8):** optional peers; `wallet-sdk-ci.yml` added (unrun on GitHub) |

The wallet SDK's own build, typecheck and tests were run after the changes made in Phase 5: all pass. The Dockerfiles' removal of the wallet SDK's two provider devDependencies applies inside images only.

## Open items

**Resolved 2026-11-13** (specs amended, code and tests done): Q1 (`at`), Q2 (`ADM_RUNTIME_FULL`), Q3 (B3: no wait, the wallet retries), Q4 (genesis cards served without a restart), Q5, Q6, Q9 (`ipfs:` cache), Q10. Q7 (the first header must be near the attested time) and Q8 (optional peer dependencies and a wallet SDK CI workflow, not yet run on GitHub). **Nothing from the review is open except the carried items below.**

**Carried from earlier:**
- **E27.** The worker sandbox (seccomp, `no_new_privs`, rlimits) still needs a run on native x86_64 Linux. Docker's emulation on Apple Silicon can't host the filter. **Not claimed as verified.**
- **E33.** Whether `LogEntry` should carry its intent payload. A separate, protocol-wide question with its own privacy review. For list cards the press signature, the `prev_log_root` chain and the pinned holder key are checked; the intent signature is not.
- **E9.** Neither `@noble/post-quantum` nor RustCrypto `ml-dsa` has been audited. Interop is proven. This belongs in the Phase 8 security review.
- **The CP10 report.** `press/src/functions/predicates.ts` treats unknown predicates as passing, so `any_of`, `issued_under_template` and the rest are not enforced on `requester_predicate` or `recipient_predicate`. Reported in `notary-questions-5.3.md`; not fixed. The evaluator written for E28 (`verifier/src/notary/predicates.ts`) could replace it. This is a press change for David to schedule.

**Phase 7 dependencies** (the integration step):
- the production chain, EAS, gas-wallet and Kubo clients; the host refuses to start without them (`CHAIN_PROVIDER=rpc`, `IPFS_PROVIDER=kubo`);
- the `CardVerifier`-backed adapters for `NotaryChainReads`, `NotarizationReads` and `ExposureReads`, which replace `e2e/src/reads.ts`. They must supply a real W5 `satisfies`, parse the genesis PCR0 from the attestation (algorithm E), and verify the policy and notary card chains (`chainValid`);
- wiring Stage 5 step 3a into `CardVerifier`;
- the header-stream, snapshot-refresh and close schedulers over a real RPC feed;
- the integration suites (`integration_tests/suites/notary/`) and the governance scripts.

**Phase 8 dependencies** (real hardware, CP8):
- a real AWS attestation document through both parsers, and `NsmBackend` (written, untested);
- NSM limits and NSM time (CP9 checkpoints 2 and 3);
- the reproducible enclave image and PCR0;
- the capacity benchmark on Graviton inside an enclave, the vsock round-trip time, and the enclave memory figure;
- `mlock` inside an enclave (Q10);
- the x86_64 sandbox run (E27) if that platform is used.

**Phase 6 work** the broker already refuses (`NH_UNSUPPORTED`): epoch restarts, multi-replica jobs and handoff, per-input and derived-card jobs, propagation.

## Capacity findings and the decided initial deployment

Measured on Linux arm64 in Docker, one broker thread (full detail in code-plan §11):

| | |
|---|---|
| Input throughput | ≈ 290 inputs/s, independent of world size (1,000 or 10,000 cards) and of the number of concurrent jobs |
| Close | ≈ 2.3 ms per input (24 s for 10,000 inputs); linear and single-threaded |
| Held state per open job | ≈ 200 B per input |
| Close working set | ≈ 10–25 KB per input (≈ 100–250 MiB for a 10,000-input job) |

**Decided (David, 2026-11-13):** one c6g.large per operator, enclave 1 vCPU and about 1 GiB, on a 1-year savings plan, shared by the first communities: about $35–40 a month. `shared` (allowlisted) programs only. Phase 8 confirms the enclave memory figure.

**Findings flagged in 5.6, and what the review did with them:**
1. **`dedicated` isolation is one job per enclave.** Confirmed by the spec and the code. The review found and fixed a bug that made it one job per enclave *lifetime* (finished jobs counted).
2. **One broker thread per enclave.** A design fact; more input throughput needs more enclaves.
3. **7 vsock fetches per input, no cache.** Implemented 2026-11-13 (Q9): verified `ipfs:` objects are cached, never `card_head:` or `subcard:`. The saving is unmeasured; Phase 8 measures the vsock round trip.

## Checkpoints

- **CP9:** checkpoints 1 (X-Wing interop) and 4 (wasmi) passed. Checkpoints 2 and 3 (NSM limits and time) wait for Phase 8.
- **CP7, CP8:** untouched. No contract changes, no on-chain actions, no AWS resources.
- **CP10:** the press predicate report stands. Q8 (wallet SDK packaging) is a second outside-notary item, reported only.
- **CP11:** nothing committed.

## Tests (run at the end of the review)

See the end of [notary-phase-5-progress.md](notary-phase-5-progress.md), "5.7 review", for the commands and results.
