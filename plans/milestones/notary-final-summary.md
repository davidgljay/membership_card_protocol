# Notary Final Summary (step 7.4)

Dates: Phase 7 ran 2026-11-21 to 2026-11-23 · Earlier phases: [1](notary-phase-1-summary.md), [2](notary-phase-2-summary.md), [3](notary-phase-3-summary.md), [5](notary-phase-5-summary.md), [6](notary-phase-6-summary.md) · Questions and findings: [notary-questions-phase-7.md](../notary-questions-phase-7.md) · Dependencies: [notary-dependency-audit.md](../notary-dependency-audit.md)

## Where things stand

**The notary work is not finished, and this review does not declare it so.** What is left in Phase 7:

- **7.2 (adversarial suite): built.** Tranche 1 (a hostile requester or contributor against an honest host) and tranche 2 (a hostile-host harness: the host's real handlers with hostile services, against the real enclave) cover the plan's list through real processes, with mutation checks and controls, including a literal kill of every replica process and a replayed old state blob. Caveat: the rollback test shows the outcome (the survivor keeps every link), not which of three layered defences stops the replay.
- **7.1 (spec-derived integration suite): done.** The AWS tests are skipped by design, the cold start was timed in a clean worktree with warm caches (under 7 minutes), the `sealed_link` bound and the aggregate below-`k_min` case are tested through real processes.

7.3 (operator docs) is done. Real-hardware work (Phase 8) is deferred until AWS is provisioned.

**Gaps the review found in the host** (details under Findings): scheduled re-attestation is not implemented, which is a real functional gap for jobs longer than a day; and nothing starts replacement replicas (`need_replica` is an in-memory stub). The chain-ID check and four monitoring alerts the review found missing were added.

## What Phase 7 did

| Step | Result |
|---|---|
| 7.0 Questions | Answered, as recommended (2026-11-21) |
| CI | `.github/workflows/notary-ci.yml` written; **it has never run on GitHub** |
| Wallet `derived.ts`, 6.5a wiring | Built: `requestDerivedCard`, `checkDerivedOffer`, `buildCountersign`, renewal; field control (`derivable: false`) enforced by the enclave and read by the wallet |
| Q6 adapters | The e2e reads use the verifier's own checks (`cardSatisfies`, `cardChainValid`) and the attestation module's PCR0; the shortcuts are gone. Stage 5 step 3a is wired into `CardVerifier` through an injected hook |
| 7.1 real-process scenarios | `run-local.sh` runs six phases: aggregation (with total loss and resubmission), a vote (a replaced ballot, a below-`k_min` vote, total loss, five of the six wallet rejections, inclusion checks), derived cards with `sealed_link` revocation, and derived cards with `expiry_only`. `run-three.sh` runs three hosts and kills a replica mid-vote |
| 7.1 production clients | Kubo, chain reader and feed, gas-wallet submitter and EAS anchorer, tested against the real registry and EAS on a local devnode; wired into host startup (`CHAIN_PROVIDER=rpc`); `integration_tests/run.sh --with-notary` |
| Dependencies | Audit written; images build from lockfiles with `--locked` and digest-pinned base images; `nitropack` moved to `devDependencies`; Dependabot configured |
| 7.2 Adversarial suite | tranche 1 (`adversarial` phase of `run-local.sh`) and tranche 2 (`notary/e2e/hostile/`, nine tests: the enclave's program check, dropped inputs, a forked chain feed, a debug-mode and a wrong-PCR0 enclave at genesis, a leaky program in three modes); mutation checks on eleven defences, ten caught; timing correlation (L8) measured in the `derive` phase |
| 7.3 Docs | `notary/README.md`, `notary/OPERATOR.md` |
| 7.4 review fixes | chain-ID check at start, the four alerts, host and runtime spec status lines, the host config and route tables, `approved_presses` wording |

Decisions made with David during Phase 7: derived-card issuer control (C+D), E11, F4a/F4b, and `approved_presses` entries are press card document CIDs (an unreadable listed pointer is `PRESS_UNREADABLE`).

## What this review did

- **Ran every suite and scenario fresh** (the table at the end).
- **Had the specs, code, READMEs, ADR-013 and plans cross-checked independently** by a separate Opus reviewer (read-only, nothing run). I **verified its four most important findings against the code** before relying on them; the rest are listed as reported and unverified.
- **Mapped each strategic objective to tests** (below), reading what the tests assert.
- **Fixed what was mine to fix:** overstated claims in `OPERATOR.md`, stale statements in READMEs and one source comment, the last `approved_presses` "pointer" lines in the specs, and a G5 terminology failure the isolation check caught in my own new docs (bare "Nitro").
- It did **not** re-read every spec line or every Rust crate (the reviewer did not read `notary_lifecycle.md`, the replication spec body, `oblivious_transport.md` or most Rust crates either).

## Objectives and covering tests

| Objective | Evidence | Status |
|---|---|---|
| **G1** aggregation at ≥ `k_min`; below it `insufficient_participation` | e2e `job` phase (algorithm N accepts it); `vote` phase second vote (two voters, `k_min` 3, algorithm N accepts the notarization); Rust `broker.rs`, `templates/aggregate` for the aggregate template below `k_min` | Met. The below-`k_min` case is not run on an aggregate job through real processes |
| **G1** vote, closing only on chain and enclave time | e2e `vote` phase: chain-only warp leaves it open; both clocks close it | Met |
| **G1** derived card: projected fields only, verifies, unlinkable | e2e `derive` phase (Stages 3, 4, 6, Stage 5 step 3a, algorithm E; scan of chain transactions with a control); Rust `derive.rs::the_hosts_records_never_name_a_source_card` (scan of everything the host holds) | Met. The real-process scan covers chain transactions only |
| **G1** `sealed_link` and `expiry_only` | e2e `derive` (an uncertified press revokes nothing; two certified revocations go out as one batch with mapped codes 820 and 920) and `expiry` phases | Met. There is no explicit upper-bound assertion on `min_delay + batch_window`; the warp lands past it |
| **G1** all four on real AWS Nitro Enclaves | none | **Deferred** (Phase 8) |
| **G2** the wallet's six rejections | `verifyJob.test.ts` covers all six; the `vote` phase runs five against a real announcement | Met. Debug-mode and mismatched-nonce attestations need a forged document, so only unit-tested |
| **G2** inclusion in `input_commitment` | `vote` phase, with a control for a replaced ballot and a wrong commitment | Met |
| **G2** consent screen from policy and job | `verifyJob.test.ts` (requester text only as labelled text) | Met (unit) |
| **G2** non-compliant programs refused; non-allowlisted `shared` refused | Rust `notary-admission` (`admission.rs`, a1 to a12) | Met (in process) |
| **G2** leaky program bounded | Rust `transforms.rs` | Met (in process) |
| **G3** three templates activate with no code | `notary/e2e/test/templates.test.ts` (the running policy differs from the committed template only in the community's fields) and the three template jobs | Partly. Nothing is published to a real registry (governance, CP7) |
| **G3** operator stands up a notary in under an hour | docs written; README steps 1 to 3 pass in a clean copy | **Not shown.** No timed run |
| **G4** single replica killed mid-vote, re-replication to `min_live` | `run-three.sh` (vote, host C's enclave killed, standby takes over, fourth ballot, tally correct); Rust `replication.rs` | **Partly**: only a non-leader is killed and the standby was started in advance, because the host cannot start replicas (finding 1) |
| **G4** all replicas lost, new epoch, resubmission | `vote` and `job` phases (the operator restart API, `EPOCH_TOTAL_LOSS`); Rust `broker.rs` | Met. No enclave process is killed in this test |
| **G4** handoffs in the job log, signed receipts | `run-three.sh`, `replication.rs`, every submit checks its receipts | Met |
| **G5** specs, ADR, README section | specs and ADR-013 exist and were reviewed before code | Met. Some spec status lines are stale (finding 8) |
| **G5** integration tests pass against the simulator and Nitro | simulator: yes; Nitro: none | **Deferred** |
| **G5** no AWS formats outside the attestation modules | `check-aws-isolation.sh` passes | Met. E27 (the Linux isolation tests) closes only on an x86_64 Linux run, and CI has never run |

## Findings

### Verified against the code

1. **The host cannot start replicas.** `server/plugins/startup.ts` passes `replicas: mem.replicas`, the in-memory test recorder, in both stacks. A `need_replica` request "succeeds" without starting anything. Re-replication in `run-three.sh` works because host C's standby was started in advance. Documented in `OPERATOR.md` and the `startup.ts` header; a real `ReplicaStarter` depends on how enclaves are launched (Phase 8). **Open.**
2. **Scheduled re-attestation is not implemented, and it matters.** `REATTEST_INTERVAL_SECONDS` is parsed and unused, and the enclave has no request for it (it re-attests at an epoch change or a handoff). Wallets refuse an announcement whose attestation is older than `maxAttestationAgeSeconds` (86,400 by default), so a job that runs longer than a day, such as a week-long vote, becomes unjoinable for new contributors. This is a functional gap against G4, and the fix is a new host-to-enclave message, so a runtime change and a spec change (`notary_runtime.md` §9). Documented in the host spec, `OPERATOR.md` and this summary. **Open, needs a decision.**
3. **`EXPECTED_CHAIN_ID`** was validated and never compared. **Fixed:** the host refuses to start when the RPC reports another chain (`chainIdProblem`, unit-tested; not run against a live wrong endpoint).
4. **Most monitoring alerts were never raised.** **Fixed:** `monitorTick` raises `enclaves_attested`, `replicas_below_min_live`, `gas_balance_low` (new `GAS_BALANCE_LOW_WEI`) and `snapshot_lag`, every 30 seconds, at most every five minutes each; 6 tests with controls.

### Reported by the cross-check, not verified by me

5. `cards_oracle.rs` turns `PRESS_UNREADABLE` into "no certified presses" (it drops the whole list on the first read), and no signal reaches the operator; a pointer whose key hashes to another address is skipped silently. Documented in `OPERATOR.md`. **Open.**
6. **Fixed:** `notary_host.md` §4, §5, §13, §14 and the status lines (host and runtime), the write-gate "until then" note, and the `derived_card_revocation_propagation.md` step 2 wording.
7. Smaller, **open**: the code plan names `suites/notary/aggregation.spec.ts`, `vote.spec.ts` and an `adversarial/` directory that do not exist (the mapping is the e2e phases and `e2e/hostile/`); `templates/build.sh` comment says `.cid`, it writes `.sha256`; `run.sh` checks `aggregate vote vote-yna` modules but not `derive`, and CI has no template check; the e2e CI job builds without `--locked`; `notary-questions-phase-7.md` says "none changes a spec" though F2, F4, F5 and F7 did; some dates read 2026-11-23 (UTC) where the local date was 2026-11-22.

### Found while building 7.2

8. A host that drops one acknowledged input below `k_min` forces the notarization to `suppressed: true`. It is detected (the count and the receipts show it), not prevented: a censorship lever the spec treats as detectable.
9. With the program hash check disabled the enclave still refused the wrong program (`ADM_SCHEMA_MISMATCH`): a second defence. A module with the right schema and different code is the case only the hash check stops.
10. Dedicated isolation allows one job per enclave, so the three leaky-program jobs each used an enclave of their own.
11. **Two product bugs found and fixed by the real-process tests.** (a) After a total loss the host could not restart a job unless one of its recorded replicas was alive (`handleRestartJob`); it now uses a surviving identity holder. (b) A holder that took a template over by handoff never learned the template policy's public key, so after the leader died it could not release a single revocation batch; the runtime now fetches the plain policy document (`learn_policy_key`). (b) changes the runtime, so its PCR0.
### Fixed in this review

`OPERATOR.md` (status row, alerts, `REATTEST_INTERVAL_SECONDS`, `EXPECTED_CHAIN_ID`, no replica starter, `PRESS_UNREADABLE` scope); `notary/README.md`; `startup.ts` header; `integration_tests/suites/notary/README.md`; `card_protocol_spec.md` and `protocol-objects.md` (the last `approved_presses` "pointer" lines); a G5 terminology failure the isolation check caught in the new docs.

## Open items

- **Decisions for David:** whether to tick 7.2 with rollback tested in process only and kill-all tested through the restart API; whether to build scheduled re-attestation (finding 2); how to split the commit (nothing from Phase 7 is committed).
- **Fix later:** findings 1, 5 and 7.
- **Carried:** E27 (closes only on a green x86_64 Linux run; CI has never run), E33, E9 (the signature libraries are unaudited; the post-quantum crates are pre-1.0), the CP10 press predicate report, W8 (step 8.3, CP7), F6 (operator-card revocation unchecked, pinned list-card keys do not rotate), the derive phase failing when its release boundary falls near UTC midnight (cause not isolated; a nightly CI run could hit it), one unexplained `NOTARY_NO_RECEIPT` flake in `run-three.sh`.
- **Not done by design (CP7 / Phase 8):** anything on Sepolia or mainnet, real AWS, the enclave image, cost figures.

## Tests (run at the end of the review)

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary` | 195 passed, 0 failed |
| `pnpm exec vitest run` in `notary/host` | 124 passed, 2 skipped (the live Kubo tests, which pass when `KUBO_API_URL` is set) |
| `bash notary/e2e/hostile/run-hostile.sh` | 9 passed (about 3.5 minutes) |
| `notary/e2e` vitest | 32 passed |
| `notary/attestation-ts`, `notary/vectors-tools` | 95 passed, 48 passed |
| verifier vitest | 305 passed |
| wallet SDK vitest | 269 passed, 1 todo |
| `check-aws-isolation.sh` | OK (after the wording fix; it failed first on the new docs) |
| `check-card-vectors.sh` | up to date; Rust agrees with every case |
| committed template modules (`aggregate`, `vote`, `vote-yna`) `--check` | reproduce |
| `bash notary/e2e/run-local.sh` | passed (aggregate, vote, derive, expiry) |
| `bash notary/e2e/run-three.sh` | passed (three hosts, a replica killed mid-vote, all four ballots counted, tally yes 2, no 1, abstain 1, algorithm N) |

Also run during Phase 7 (not re-run here): `integration_tests/suites/notary` against the devnode (`rpc_chain` 8, `eas_anchor` 7, through `run.sh --with-notary --suite`).

Not run: the Linux container isolation tests (E27), the nightly fuzz job, a full `run.sh --with-notary`, the notary CI workflow on GitHub, anything on Sepolia or mainnet or real AWS.
