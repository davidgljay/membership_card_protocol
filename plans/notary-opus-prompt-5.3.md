You are continuing Phase 5 of the Digital Notaries project in this repository (card_protocol), on the `notary` branch. The Sonnet session finished 5.0, 5.1, 5.2, 5.4 and a mock-enclave version of 5.5, and committed it (`1d932532`, `55aa1ef0`). Your job is the Opus steps: **5.3 (runtime core)** and **5.3a (`notary-cards`)**, then the 5.5 and 5.6 items that were waiting on them. Do not redesign anything.

## Read first, in this order
1. `plans/milestones/notary-phase-5-progress.md`: what is done, tested, deferred, and the deviations.
2. `plans/notary-questions-phase-5.md`: every decision made (CP5 answers, errata E1–E19). Decided: E1 (empty Merkle root = SHA-256 of the empty string), E6 (cosignatures and list approvals sign the 32 raw digest bytes), E7 (`receipt_sealed` nonce and aad), E12 (ECDSA digest is the message hash), E13, E14, E17. Pending David's decision: E15, E16. Spec text edits are pending David's approval.
3. `plans/notary-implementation-plan.md` steps 5.3, 5.3a, 5.5, 5.6 and the Clarification Checkpoints.
4. `plans/notary-code-plan.md`: §2 (layout), §2.1 (broker modules), §4 (build order), §5 (dependencies), §6 (risks), §7 (tests, especially §7.5 on keeping `notary-cards` in step with the TypeScript verifier), §8 (traceability).
5. Specs: `object_specs/notary_runtime.md` (all), `process_specs/notary_lifecycle.md` (Appendix A and B), `notary_replication_and_recovery.md` and `derived_card_revocation_propagation.md` only for the parts 5.3 touches, `protocol-objects.md` §2.1, §20–§34, `card_verifier.md` Stages 2–5, `card_validation.md`.

## Scope
- **5.3:** `notary-crypto` (zeroizing, mlocked secrets; the ML-DSA, X-Wing and ChaCha wrappers; no `derive_keypair`, see E8), `notary-admission` (algorithm A, A1–A11, and the lint warnings), `notary-worker` (wasmi, fuel, memory and wall limits, broker–worker framing §8), `notary-broker` modules `host_proto`, `keyring`, `jobs`, `inputs`, `chain`, `lists`, `transforms`, `close` (single replica), `joblog`, `workers`, `bin/notary-runtime` (`--mode broker|worker`), `notary/lint`, `notary-guest`. The broker must implement exactly the host–enclave messages in `notary_runtime.md` §9; the host in `notary/host` already speaks them (`notary/host/src/enclave/protocol.ts`, `mock.ts`), so use it as the contract and do not change the host except for bugs.
- **5.3a:** `notary-cards`, the Rust port of the verifier checks B1–B11 need, plus the TypeScript vector generator `membership_card_verifier/scripts/gen-notary-conformance.ts`, the CI regeneration check and the coverage map (code-plan §7.5).
- **Then:** finish 5.5 (run `notary/deploy/docker-compose.sim.yml` end to end against the simulator, using the real runtime; wire the header-streaming and refresh schedulers) and do 5.6 (benchmark, record results and the instance-size recommendation in code-plan §11, flag anything contradicting the strategic plan's economics).

## Reuse, don't rebuild
`notary-types` (JCS, `H`, CIDs, Merkle, `user_data`, objects), `notary-attest` (`AttestationBackend`, `SimulatorBackend`, shared V6–V12 in `verify.rs`), `notary-sim` (fake enclave service with a controllable clock), the shared vectors in `notary/vectors/`, and the TypeScript twins as the reference for behavior.

## Hard rules (unchanged from the first prompt)
- Terminology: "AWS Nitro Enclaves" or "the enclave"; "nitropack" for the web framework; never bare "Nitro" (`nitro-devnode` excepted).
- Specs are approved: do not edit spec text. If the code cannot match a spec, or the spec is ambiguous or wrong, record an erratum in a new `plans/notary-questions-5.3.md` and ask. Never deviate silently.
- Ask immediately, and do not guess, about anything that affects security or a spec. Library or interface choices that don't, make yourself, record with a one-line rationale, and move on.
- CP9: wasmi must give deterministic fuel across builds of the pinned version and must be able to disable everything runtime §6 rejects. Current releases are 2.0.0 and 1.0.9: choose, justify, and test the checkpoint **before** writing templates or depending on it. If wasmi, `memsec`, `seccompiler` or any required primitive proves unworkable, stop and propose options; do not substitute quietly.
- G5: only `notary-attest::aws`, `notary-attestation` and `notary/deploy` may parse the AWS attestation format. `notary/scripts/check-aws-isolation.sh` enforces it; keep it passing.
- Do not refactor `press/`, the verifier core or other existing code beyond what the code plan lists. Report bugs found outside notary code, do not fix them (CP10).
- No changes under `contracts/`, no on-chain transactions or governance publication (CP7). No AWS resources, nothing that costs money (CP8).
- Do not commit or push unless David asks (CP11).
- Tick a step in `notary-implementation-plan.md` only when its "Done when" is met and its tests pass. Run the tests; do not assume they pass. Keep the traceability table in code-plan §8.3 accurate (real module paths and test names).

## Environment notes
Rust is pinned to 1.96.0 in `notary/rust-toolchain.toml`. Isolation tests (seccomp, UIDs, rlimits) need Linux; on macOS use the Linux container and say so. `file:` dependencies are copies: after rebuilding the verifier or wallet, run `pnpm install` in `notary/` and in `wallet-sdk/` to refresh them. Rust-side vectors are written with `NOTARY_WRITE_VECTORS=1 cargo test`. Tests to keep green: `cargo test --workspace` in `notary/`; `pnpm test` in `notary/{vectors-tools,attestation-ts,host}`; the verifier, `verifier-rpc-provider` and wallet-sdk suites.

## When you stop
Update `plans/milestones/notary-phase-5-progress.md` (done, tested, left, deviations), and for each step report: what was built, the test command and its actual result, and any open question or erratum. If something failed or was skipped, say so plainly. 5.7 (the milestone review) is a separate session.
