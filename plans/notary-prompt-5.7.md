You are doing step **5.7, the Phase 5 milestone review** of the Digital Notaries project. The repository is card_protocol, and you work on the `notary` branch. Every Phase 5 build step (5.0–5.6) is done and committed; the latest commits are `4d09f6d3`, `03caadc6` and `50a42d20`. **Your job is to review, not to build.** Check that the code matches the approved specs, that the tests cover what the specs require, and that the AWS-specific code stays isolated. Then fix small deviations, record the rest as errata, and write the Phase 5 summary.

## The step, from `plans/notary-implementation-plan.md`
- **What:** check that the code matches the specs (names, objects, checks); that test coverage maps to the specs; and that nothing outside the attestation modules and image packaging references AWS-specific formats.
- **Done when:** deviations are fixed in code or recorded as spec errata for David, and `plans/milestones/notary-phase-5-summary.md` is written.

## Read first, in this order
1. `plans/milestones/notary-phase-5-progress.md`. It is the full history: what each step built and tested, the deviations, and the open items.
2. The errata and decisions:
   - `plans/notary-questions-phase-5.md` (E1–E19);
   - `plans/notary-questions-5.3.md` (E20–E35, and the resolutions);
   - the approved wording batches, `plans/notary-spec-wording-e31.md` and `plans/notary-spec-wording-batch2.md`. Both are applied to the specs.
3. `plans/notary-code-plan.md`:
   - §2: the layout;
   - §7: the tests, especially §7.5 on how `notary-cards` is kept in step with the TypeScript verifier;
   - §8.3: the traceability table. It should name real modules and tests; check that it does;
   - §11: the capacity results and the decided initial deployment.
4. The specs:
   - `specs/object_specs/notary_runtime.md`, `notary_host.md` and `card_verifier.md` (the notary sections);
   - `specs/process_specs/notary_lifecycle.md` (including Appendices A and B), `notary_replication_and_recovery.md` and `derived_card_revocation_propagation.md`;
   - `specs/protocol-objects.md` §2.1, §2.2 and §20–§34.

## What to review
**1. The code matches the specs.** For each spec section that Phase 5 implements, compare it with the code. Check:
- object fields and types;
- `type` strings;
- error codes, including the §16 runtime codes and the host's §14 codes;
- algorithms V, W, G, N, L, E and R, step by step, and admission A1–A11;
- checks B1–B11;
- host–enclave messages (runtime §9), host routes (host §5) and configuration (host §4);
- the job-log and identity-log kinds.

The code is in:
- `notary/runtime/crates/*` and `notary/runtime/bin/notary-runtime`;
- `notary/host`;
- `notary/attestation-ts`;
- `membership_card_verifier/packages/verifier/src/notary`;
- `wallet-sdk/packages/wallet-sdk/src/notary`.

**2. The tests cover the specs.** Build a coverage map, spec requirement → test, for:
- the algorithm steps;
- every error code;
- the security invariants (runtime §1 and host §2).

List each requirement that has no test. The cross-language vectors (`notary/vectors/`) and their checks count as tests.

**3. AWS isolation (G5).** `notary/scripts/check-aws-isolation.sh` must pass. Also read for references to AWS formats that the script's patterns would miss. Only `notary-attest::aws`, `notary/attestation-ts` and `notary/deploy` may parse the AWS attestation format.

**4. Known items to judge.** These were raised during the build. Decide whether each one is a real deviation, test-only scaffolding, or something already recorded:
- **Log-record time.** The broker stamps a job-log or identity-log record's `at` with the enclave's attested clock (`now_iso` in `notary-broker/src/host_proto.rs`). §28 says `at` is chain time.
- **Identity-log `seq` 0.** It is written at countersign, which E35 approved. Check that the spec text, the code and the tests agree.
- **Notary card addresses.** `NOTARY_CARD_ADDRESSES` is static host configuration, so the host has to be restarted after genesis (`notary/e2e/run-compose.sh`). Judge whether that is acceptable for operators or worth a spec question.
- **Simulator wiring in the host.** The host's `CHAIN_PROVIDER=sim` / `IPFS_PROVIDER=sim` clients (`notary/host/src/sim`) and the `memory:` storage URL must not be usable by mistake in production. Check config validation and startup.
- **The e2e read adapters.** The adapters in `notary/e2e/src/reads.ts` take shortcuts:
  - W5 `satisfies` always passes;
  - algorithm E is given the simulator's known PCR0;
  - the notarization reads report `chainValid: true`.

  Confirm that none of this reaches product code, and that the gaps are listed as Phase 7 adapter work.
- **The 5.6 findings** in code-plan §11:
  - `dedicated` isolation admits one job per enclave;
  - each enclave runs one broker thread;
  - each input makes 7 per-card vsock fetches, with no ancestor cache.

  Record a caching proposal if it is warranted. **Do not implement it** without David's approval.
- **Still-open items, to record in the summary:**
  - **E27:** the worker sandbox still needs a run on native x86_64 Linux;
  - **E33:** a protocol-wide question for later, on whether `LogEntry` should carry its intent payload;
  - **E9:** neither ML-DSA library has been audited;
  - **The CP10 report:** `press/src/functions/predicates.ts` treats unknown predicates as passing. It was reported, not fixed.
- **Changes outside notary code during Phase 5:**
  - the wallet SDK's new `./notary` subpath export;
  - the Dockerfiles, which drop the wallet SDK's two provider devDependencies inside images.

  Check these didn't break the wallet SDK's own build or tests.

## Hard rules (unchanged)
- **Terminology:** write "AWS Nitro Enclaves" or "the enclave" for the TEE, and "nitropack" for the web framework. Never write a bare "Nitro" (`nitro-devnode` excepted).
- **Specs are approved. Do not edit spec text.** Where code and spec disagree:
  - if the spec is right, fix the code (with a test);
  - if the spec is wrong or ambiguous, record an erratum in a new `plans/notary-questions-5.7.md` and ask.
- **Ask David immediately** about anything that affects security or a spec. Don't guess.
- **Don't redesign.** Fix small, local deviations. Bring anything bigger to David as a proposal.
- **CP10:** report bugs outside notary code; don't fix them.
- **CP7:** no changes under `contracts/`, and no on-chain actions.
- **CP8:** no AWS resources.
- **CP11:** don't commit or push unless David asks.
- **Tests:** run them; don't assume they pass. Tick 5.7 only when its "Done when" holds.

## Tests to keep green
| Suite | How to run | Last result |
|---|---|---|
| Rust | `cargo test --workspace` in `notary/` | 80 |
| Host | `pnpm test` in `notary/host` | 74 |
| Vector tools | `pnpm test` in `notary/vectors-tools` | 43 |
| Attestation | `pnpm test` in `notary/attestation-ts` | 92 |
| Verifier | verifier suite | 258 |
| Wallet SDK | wallet-sdk suite | 235 + 1 todo |
| Card vectors | `notary/scripts/check-card-vectors.sh` | passes |
| AWS isolation | `notary/scripts/check-aws-isolation.sh` | passes |
| End to end | `notary/e2e/run-local.sh`, then `notary/e2e/run-compose.sh` | passes |

## Environment notes
- **Node:** the shell's default Node may be 18. Use Node 22 (`~/.nvm/versions/node/v22.23.0/bin`) for the e2e scripts and nitropack.
- **Rust** is pinned to 1.96.0.
- **Linux-only tests:** the seccomp, UID and rlimit tests need Linux. On macOS, use the Docker container and say so.
- **`file:` dependencies are copies.** After rebuilding the verifier or the wallet SDK, run `pnpm install` in `notary/` and in `wallet-sdk/` to refresh them.

## Deliverables
1. **Code fixes** for the deviations that are local and clearly the code's fault, each with a test.
2. **`plans/notary-questions-5.7.md`**, with every erratum or question for David. For each item, give the spec quote, the code location, what differs, and a recommendation.
3. **`plans/milestones/notary-phase-5-summary.md`**, written in the style of the earlier phase summaries in `plans/milestones/`. Cover:
   - what Phase 5 built;
   - the coverage map, with its gaps;
   - the deviations and how each was resolved;
   - the open items: errata, E27, E33, E9, the CP10 report, and the Phase 7/8 dependencies;
   - the capacity findings and the decided initial deployment.
4. **Updates** to the code plan's traceability table (§8.3) and to the progress note. Tick 5.7 if its "Done when" holds.

## When you stop
Report, plainly:
- what you checked;
- what you fixed, with the test command and its actual result;
- what you recorded for David;
- anything you skipped or couldn't verify.
