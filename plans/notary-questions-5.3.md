# Digital Notaries — Step 5.3 / 5.3a Decisions and Errata

Brief: [notary-opus-prompt-5.3.md](notary-opus-prompt-5.3.md) · Earlier decisions: [notary-questions-phase-5.md](notary-questions-phase-5.md) · Code plan: [notary-code-plan.md](notary-code-plan.md)

Library and interface choices that don't affect security or a spec are made here with a one-line rationale. Anything that does is marked **needs David** and is not acted on until answered. No spec text has been edited.

---

## Decisions (made, no approval needed)

| # | Decision | Rationale |
|---|---|---|
| D1 | **wasmi `=2.0.0`**, not 1.0.9 | 2.0.0 lets the runtime set the per-operator fuel table and the dynamic fuel costs explicitly (`Config::operator_cost`, `Config::fuel_cost`) and refuse start functions (`allow_start_fn(false)`). 1.0.9 has neither knob, so its fuel table would be whatever its internals do. Both can disable floats and every proposal §6 rejects. |
| D2 | wasmi features: `std`, `validate`, `deterministic`, `auto-dispatch` (no defaults, so no `memory64`, `simd`, `wat`) | `auto-dispatch` is required: without it wasmi always uses tail-call dispatch, which overflows the native stack in unoptimized builds. With it, optimized builds use tail calls and unoptimized builds use the portable loop. |
| D3 | Compilation mode **eager** | Lazy modes charge fuel for translation at first call, which would make fuel depend on call order. Eager charges nothing at run time. |
| D4 | Fuel table: wasmi 2.0.0's operator table (1 per operator; 0 for `unreachable`, `return`, `else`, `end`), set explicitly, with dynamic costs `{ bytes_copied_per_fuel: 64, fuel_per_bytes_translated: 7, fuel_per_bytes_validated: 2 }` set explicitly | Freezing in code means a wasmi upgrade can't silently change fuel. `tests/cp9.rs::operator_table_is_frozen` hashes every table entry. |
| D5 | Wall-clock limit enforced by the broker killing the worker process, not inside wasmi | wasmi 2.0.0 has no epoch interruption; the spec already assigns this to the broker (runtime §8). |
| D6 | Memory over the limit is reported as `memory` via `StoreLimits::trap_on_grow_failure(true)` | Plain Wasm semantics would return −1 from `memory.grow`; trapping makes the reason observable and deterministic. |
| D7 | Admission uses `wasmparser =0.228.0`, the version wasmi 2.0.0 uses | Admission and execution validate with the same parser. |
| D8 | The broker is a synchronous message handler. `fetch` blocks for its `fetch_result` and queues other host messages; job-log anchoring is event-driven | Simplest correct shape for §9: the host may stall a fetch (a denial of service, allowed by L1), but can't reorder the broker's state. |
| D9 | Card-chain checks (policy read W3/W4/W10, requester predicate W5, contributor B5–B8, list histories) go through a `CardOracle` trait | Mirrors the TypeScript `NotaryChainReads`; `notary-cards` (5.3a) implements it. Until then the runtime binary uses a fail-closed oracle that refuses every job and input. |
| D10 | Worker processes exit with `_exit` | Rust's normal exit path calls `sigaltstack`, which is not on runtime §3's syscall list. Exiting with `_exit` keeps the seccomp filter exactly the spec list (read fd 0, write fd 1, `exit_group`, `mmap`, `munmap`, `brk`, `futex`). |
| D11 | Counted inputs are sorted by raw 32-byte `input_hash`, not by the base64url text | Matches the TypeScript `inputCommitment` and N8. Found by the broker close test: sorting the text fails N8 for most input sets. |
| D12 | `notary-guest` parses payloads with small field readers, not a JSON library | Keeps templates float-free and tiny; full JSON is unnecessary for the v1 payload shapes. |

## CP9 checkpoint 4 — wasmi suitability: **passed** (2026-11-12)

`notary/runtime/crates/notary-worker/tests/cp9.rs`:
- **Rejection:** 20 modules, one per §6-rejected feature, plus a component binary. The `notary_v1` engine refuses every one: floats (local, const, param, global, saturating conversions), SIMD, shared memory, atomics, reference types (externref, two tables, `ref.null`), tail calls, exceptions, `memory64`, multi-memory, start function, extended constants, wide arithmetic, custom page sizes, GC, and a component. The four allowed extensions (mutable-global, sign-extension, multi-value, bulk-memory) are accepted.
- **Determinism:** five corpus programs (a 100,000-iteration loop, recursive Fibonacci, bulk memory copy and fill, multi-value calls with sign extension, a 200-input tally reading inputs and parameters). Fuel and output hashes are recorded in `notary/vectors/fuel/corpus.json`. Identical results in five builds:

  | Build | Dispatch | Result |
  |---|---|---|
  | macOS aarch64, debug | portable loop (auto fallback) | 7 passed |
  | macOS aarch64, release | tail calls | 7 passed |
  | macOS aarch64, release, `--features portable-dispatch` | portable loop | 7 passed |
  | Linux aarch64 (`rust:1.96` container), release | tail calls | 7 passed |
  | Linux x86_64 (`rust:1.96`, emulated), release | tail calls | 7 passed |

- **Not covered:** a different Rust compiler version. The toolchain is pinned to 1.96.0 for reproducible images anyway.

---

## Errata and questions

| ID | Where | Observation | Handling |
|---|---|---|---|
| **E20** | `notary_runtime.md` §9, §12 | §12 says the host supplies the list cards' documents and log entries, but §9 has no message for it. | Implemented: the broker reads list histories through `fetch` (`CardOracle::list_history`) before admission. **Needs David:** a one-line spec addition naming this path. |
| **E21** | §9 `create_job` | `create_job` carries the job and program, not the policy, yet the enclave needs the `notary` section for W3–W10 and admission. | Implemented: the broker fetches the policy at `policy_state_cid` through `fetch ipfs:` (`CardOracle::policy`). **Needs David:** a spec line saying so. |
| **E22** | §9 `chain_headers` | The header encoding isn't stated. | Decided: `{ number, header_rlp }`, `header_rlp` the base64url Ethereum-format block header RLP; hash = keccak256. Recorded here; the host scheduler (5.5) uses it. |
| **E23** | §8 `error.reason` | No reason exists for a run killed at its wall-clock limit. | Reported as `trap` (the broker kills the worker; the program sees nothing). No spec change needed unless David wants a distinct reason. |
| **E24** | §9 `genesis_ready` | The table lists `id_pubkey`, `chain_pubkey`, `attestation`. The completed request (needed for E17 `genesis_request`) isn't returned. | Implemented: `genesis_ready` also returns `request` and `notary_card`, and the request is published (pinned). The host ignores extra fields. **Needs David:** approve the two extra fields. |
| **E25** | §9 `close_chunk`, error tables | Nothing says what the enclave answers when close isn't due yet. | Implemented: `error` with code `CLOSE_NOT_DUE` (the host retries later). **Needs David:** add the code to the runtime §16 table. |
| **E26** | lifecycle step 9 | "Writes the first identity-log record", but no record `kind` is defined for it (§28 kinds are job-oriented; `handoff` is the only identity-log kind used elsewhere). | Not implemented: the identity log starts at the first identity handoff (6.3). **Needs David:** is a first record intended, and with which `kind`? Algorithm E walks the identity log to `seq` 0, so this affects it. |
| **E27** | Test coverage | The worker sandbox (seccomp, `no_new_privs`, rlimits) is verified on Linux arm64. On x86_64 the only available run was Docker's emulation on Apple Silicon, which can't host seccomp filters (the worker dies with SIGTRAP inside the translator). | Needs a native x86_64 Linux run (CI or Phase 8). Not claimed as verified. |

## Step 5.3a decisions (David, 2026-11-12)

| ID | Question | Decision |
|---|---|---|
| **E28** | B8 evaluates `contributor_predicate`, but no TypeScript code implements the spec's predicate system, so code-plan §7.5 had no reference to generate expected answers from. | **Add a spec-conformant TypeScript predicate evaluator** in `verifier/src/notary/predicates.ts`. The conformance vectors are generated from it, and `notary-cards` must agree. |
| **E29** | Where the enclave gets trusted roots for B7 (the TypeScript verifier uses configured `trustedRoots` or on-chain `PolicyAuthorizerKeys`; snapshots don't carry them). | **Pinned in the runtime image** (covered by PCR0). Adding a root means a new image. By the same reasoning, the `appCertificationRoot` and `loginServiceCertificationRoot` that Stage 2 needs for the signing sub-card (B5) are pinned too. |

## Bug outside notary code (CP10: reported, not fixed)

**`press/src/functions/predicates.ts` doesn't implement the predicate system.** `evaluatePredicate` handles only `chain_valid` and `field_match` (the latter logs and returns `true`), and **treats every other predicate type as passing** ("permissive default"). The spec's predicates (`any_of`, `issued_under_template`, `card_field_matches`, and so on) are therefore never enforced on `requester_predicate` / `recipient_predicate`. Any policy relying on them for issuance is unprotected at the press. The evaluator added for E28 could replace it, but that is a press change for David to schedule.

## Step 5.3a errata

| ID | Where | Observation | Handling |
|---|---|---|---|
| **E30** | `notary_host.md` §8, snapshot contents | Stage 2 needs each sub-card registration's `sub_card_doc_cid` (part of `SubCardRegistrations`, but the host's snapshot builder dropped it). Stage 4 needs each card's head-event history with block timestamps, for the provenance cross-check and authoritative revocation dates; §8 lists only "address, current head CID and last press address". | Implemented: snapshot entries carry `events: [{ cid, timestamp }]`, sub-card entries carry `sub_card_doc_cid`, and updates carry `timestamp` (`notary/host/src/chain/snapshots.ts`, tests updated). Per-card fetches use the same shapes: `card_head:` returns `{ head_cid, events }`, `subcard:` returns `{ master_card_address, sub_card_doc_cid, active }`. **Needs David:** approve the §8 wording. |
| **E31** | lifecycle step 17 (W3/W4/W10), runtime §12 | **How the enclave reads and trusts a policy card at `policy_state_cid`, a job requester's chain (W5), and a governance list card's version history (algorithm L) is not specified concretely.** The TypeScript side has the same gap: `NotaryChainReads.policyAtState` and the list histories are injected interfaces with no implementation (Phase 7 adapters). Open points: are policy and list card heads plain JSON on IPFS (as verifier Stage 5 assumes for `policy_id`) or encrypted under the card key? Is a policy's chain checked like a contributor's (Stage 3 to a pinned root)? How is a list card's history enumerated (registry events plus decrypting each head)? | **Not implemented; fails closed.** `SnapshotOracle::policy`, `requester_allowed` and `list_history` refuse, so the runtime binary opens no job. That also blocks the end-to-end run of 5.5 and a meaningful 5.6. **Needs David** before 5.5 can finish. |

## Code-plan deviation (5.3a)

The conformance generator lives at `membership_card_verifier/packages/verifier/scripts/gen-notary-conformance.ts` (run with `pnpm gen:notary-conformance` / `pnpm check:notary-conformance`), not at `membership_card_verifier/scripts/`, so that it resolves the verifier package's own dependencies and reads its built `dist/`.
