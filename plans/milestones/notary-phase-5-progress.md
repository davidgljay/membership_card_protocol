# Digital Notaries — Phase 5 Progress (handoff note)

**Date:** 2026-11-12 · **Branch:** `notary` · **Nothing committed** (CP11). Everything is in the working tree.

## Status by step

| Step | State |
|---|---|
| 5.0 questions | **Done, ticked.** CP5 answered "OK to all" (Q11 downloads approved; E1 agreed). |
| 5.1 types and serialization | **Done, ticked.** TS and Rust agree on every vector; X-Wing and ML-DSA interop proven both ways (CP9 checkpoint 1 passed). |
| 5.2 simulator and attestation | **Done, ticked.** Simulator documents verify in Rust and TypeScript through the same parser path; every `ATT_*` code has a failing fixture. Real AWS documents: not tested (see Deviations). |
| 5.3 | **Done, ticked** (Opus session, 2026-11-12). CP9 checkpoint 4 (wasmi) passed. See "5.3 session" below. |
| 5.3a | **Done, ticked** (Opus, 2026-11-12). B5–B8 are ported and agree with TypeScript on all 58 cases. The policy, requester and list reads (W3–W5, W10, §12) are open (**E31**) and fail closed. |
| 5.4 wallet and verifier support | **Done, ticked** (its Done-when is met). Four items are deliberately deferred; see "5.4: deferred". |
| 5.5 host service | **Ticked 2026-11-13: the end-to-end path runs in docker-compose against the simulator** (see "5.5 end to end: done" below). Earlier status: built against a mock enclave. The Done-when (the end-to-end path in compose against the simulator) needs the runtime from 5.3 (and a chain, EAS and IPFS wired for real, Phase 7). See "5.5: built and not built". |
| 5.6 capacity benchmark | **Done, ticked** (2026-11-13). Results in code-plan §11. |
| 5.7 milestone review | **Done, ticked** (2026-11-13). Summary: `plans/milestones/notary-phase-5-summary.md`; errata: `plans/notary-questions-5.7.md`. |

## Tests (all run at the end of this session)

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/` | all pass: notary-types vectors (6), X-Wing interop (2), ML-DSA interop (3), attestation codes (2, 49 cases), AWS-root fingerprint (1), simulator (3 + 1 fixture writer) |
| `pnpm test` in `notary/vectors-tools` | 22 passed; `pnpm run check`: vectors up to date (23 files) |
| `pnpm test` in `notary/attestation-ts` | 81 passed (52 attestation + 20 notarization + 9 genesis) |
| `membership_card_verifier/packages/verifier-rpc-provider`: `pnpm test` | 29 passed, 9 skipped (pre-existing integration tests that need a chain) |
| `pnpm test` in `notary/host` | 69 passed (7 files); `pnpm run typecheck` and `typecheck:server` clean; `nitro build` succeeds; the built server answers over HTTP |
| `relay`: `npx vitest run tests/unit/oblivious-targets.test.ts` | 3 passed (`uuid-lifecycle` needs a Redis at `::1:6379`: pre-existing, unrelated) |
| `membership_card_verifier/packages/verifier`: `pnpm test` | 248 passed (includes the new notary tests; no regression) |
| `wallet-sdk/packages/wallet-sdk`: `pnpm test`, `pnpm run typecheck` | 231 passed, 1 todo; typecheck clean |
| `notary/scripts/check-aws-isolation.sh` | OK; a planted `cabundle` probe makes it fail |

## 5.4: done and left

**Done** (in `wallet-sdk/.../src/notary/`):
- algorithm W, steps W1–W15, tested with real simulator attestations: all six G2 rejections (wrong PCR0, debug mode, program hash ≠ `program_cid`, mismatched nonce, stale, notary not approved, parameters out of bounds) plus every other W step;
- the consent model (policy and job only; requester text separate and labelled; custom-program label; participation and derived-card disclosures);
- the inclusion check and Merkle inclusion paths;
- wallet object types (§21–§26) and the side-effect-free `notary-types` subpath;
- in the verifier: `src/notary/{canonical,types,attest}.ts` and the `./notary` subpath export.

**Added after David accepted the E6/E7 proposals:** algorithm L (`verifier/src/notary/lists.ts`, 11 tests) and `wallet/.../submit.ts` (sealing, `receipt_sealed`, receipt checks, persist-before-send; 12 tests). A real bug found on the way: `parseCanonicalNotary` leaked a raw `SyntaxError`; fixed.

**Also added after E12–E14 were decided:** algorithm N / `verifyNotarization` (`verifier/src/notary/notarization.ts`, 20 tests) and algorithm G (`genesis.ts`, 9 tests), both against real simulator attestations.

**Added in the last two passes:** algorithm E (`exposure.ts`, 14 tests); Stage 4 step 5a (`expires_at`, 6 tests); `VerifierConfig.notary`, optional `RpcProvider` methods and `NOTARY_CODES`; `getGovernanceKeyset` and `getNotaryLogAnchors` in `verifier-rpc-provider` (8 tests); the core-entry isolation test (3); wallet `link.ts`, `job.ts`, `watch.ts` (15 tests).

## 5.4: deferred (not blocking the Done-when)

- **Wiring Stage 5 step 3a into `CardVerifier`** (Phase 7): the logic (`verifyNotaryIssuedCard`, E17 accepted) and the Stage 5 hook are built and tested; what remains is the adapter that supplies the notary card lookup and reads.
- **Wallet `derived.ts`** (6.4) and **`notary_output` messaging** (6.1/6.4).
- **The `CardVerifier`-backed adapters** for `NotaryChainReads`, `NotarizationReads` and `ExposureReads` (Phase 7 wiring; the algorithms take them as injected reads and are tested with mocks plus real simulator attestations).
- **Rust `notary-cards` and the broker's `lists`** (5.3 and 5.3a).

## 5.5: built and not built

**Built and tested (69 host tests, plus the route files typechecked and the built server run over HTTP):**
- config validation (every problem reported at once); KV interface and the §7 keys with retention (ciphertexts deleted at finalize, 30-day receipts and job records, permanent logs, current-and-previous blobs);
- host receipts signed with K_host; job intake validated against the policy (requester signature, `min_live`, local replica cards, `program_cid` bytes against their CID digest) and `create_job` to a local enclave; announcements pinned as exact raw bytes and served; status;
- input ingress: size, job known and open, strict shape, store **before** receipt (a storage failure issues no receipt), forward the exact sealed input, `receipt_sealed` passed through untouched; undecryptable inputs dropped; unavailable enclaves keep the ciphertext;
- the framed enclave protocol, a socket transport (the same for the vsock proxy and the simulator), a session with timeouts and `NH_ENCLAVE_UNAVAILABLE`;
- the enclave-request dispatcher (pin exact bytes, serve by CID, index logs, `eas_anchor` → receipt or backlog alert, `chain_submit` unchanged, `deliver`, peer relay, `need_replica`, sanitized alerts, `fetch`);
- never-filtered policy snapshots and updates; monitoring that cannot carry job data; operator-token routes; the peer relay; the OHTTP gateway with a real HPKE round trip, and the two oblivious-only routes (a direct request gets 403 `NH_DIRECT_FORBIDDEN`);
- the relay registers the notary host as a third destination kind (3 tests).

**Not built or not verified:**
- the **end-to-end path** (needs the runtime, 5.3): the compose files are written, not run;
- the **mock enclave proves plumbing only**: it holds no keys, runs no program and checks no input;
- production **chain, EAS, IPFS (Kubo) and gas-wallet implementations** (viem calls): interfaces and the EAS data encoding exist; wiring is Phase 7;
- **block-header streaming** (`chain_headers`, header RLP), **re-attestation timers**, **snapshot refresh timers** and the **`close_chunk` / re-replication flows**: the message plumbing exists, the schedulers and the multi-replica flows belong with 5.3 and 6.3;
- `src/delivery`, `src/peer` clients are thin interfaces (HTTP posts); no relay-side integration test.

## Deviations and decisions to know about

1. **No real AWS attestation document tested.** I searched for a public recorded sample. The only one found (`pontifex`'s `tests/mock-attestation-doc.cose`) is sanitized (`certificate` is `[3,4]`), so it can't exercise chain validation, and I did not add it. The AWS root was downloaded (approved, Q11), verified against AWS's documented fingerprint and pinned in `notary/deploy/aws/`. The real-document parser test waits for Phase 8.
2. **Rust COSE parsing is hand-written on `ciborium`, without `coset`** (Q14 expected `coset`). `Sig_structure` is 20 lines and a manual check keeps the strictness rules explicit. `ciborium` accepts indefinite-length CBOR; the TypeScript decoder rejects it (so TS is stricter on malformed documents). Noted in the `aws.rs` header.
3. **Simulator naming.** The spec calls it the "fake NSM service". To satisfy the G5 grep (Q16: simulator modules contain none of the AWS terms), it is `FakeEnclave`, and the clock call is `attested_time_ms`.
4. **`DeriveKeyPair` differs between the two X-Wing libraries** (E8); the protocol doesn't use it.
5. **Neither ML-DSA implementation is audited** (E9). Interop is proven; flagged for the security review.
6. **TypeScript attestation uses `@noble/curves` 1.9.7 with `prehash: true`** (its default is no prehash); a bug here made every valid chain fail until found, and the 49 shared cases now guard it.
7. **`NsmBackend`** (feature `nsm`) is written and compiles on macOS but is untested until Phase 8.
8. **Q1 (5.5 and 5.6)** was approved as recommended: 5.5 would be built against a mock enclave without ticking; 5.6 not started. I ran out of this session before 5.5.

## Open errata needing David (full text in `plans/notary-questions-phase-5.md`)

- **E6** (blocks algorithm L, N, cosignatures): is the signed message the 32 raw digest bytes or the base64url text of `H(body)`?
- **E7** (blocks receipts): nonce and aad of `receipt_sealed`.
- **E2, E3, E10, E11**: spec lines to add or clarify (strict unknown fields; EAS "indexed by `job_hash`"; `inst_key_hash` in W13; `issuer_card` is a pointer but compared with a CID).
- Pending: **permission to add a sanitized sample document** is not requested; no action needed.

## Next session, in order

1. (E12–E14 decided.)
2. (5.4 done.)
3. 5.5: finish after 5.3 exists: run the compose against the simulator, wire the real chain/EAS/IPFS services, add the header-streaming and refresh schedulers, then tick.
4. Stop at 5.3 and tell David.


---

## 5.3 session (Opus, 2026-11-12)

Brief: `plans/notary-opus-prompt-5.3.md`. Decisions and errata: `plans/notary-questions-5.3.md` (D1–D12, E20–E27). Nothing committed (CP11).

### Built

- **`notary-worker`**: the `notary_v1` engine on **wasmi =2.0.0** with an explicitly set and frozen fuel table, eager compilation and every §6-rejected feature off; the seven-import ABI; per-run fresh instances; fuel and memory limits; the §8 protocol.
- **CP9 checkpoint 4 passed.** Every §6-rejected feature (20 modules plus a component) is refused, and the four allowed extensions are accepted. A five-program fuel corpus gives identical fuel and output in debug, release, portable-dispatch, Linux aarch64 and Linux x86_64 builds (`vectors/fuel/corpus.json`).
- **`notary-admission`**: algorithm A1–A11, the deferred-feature refusals, and the lint warnings. **`notary-lint`**: the CLI.
- **`notary-crypto`**: production wrappers. Secrets are mlocked and zeroized. Covers ML-DSA-44, X-Wing draft-06 (raw secrets, no `derive_keypair`), E7 receipts, secp256r1 under E12, hashes and HKDF.
- **`notary-broker`**:
  - `keyring` (I1–I3; job keys only with an `Admitted` proof; key lineage and exposure);
  - `lists` (algorithm L, floors, no regression);
  - `chain` (RLP headers, hash linkage, freshness floor);
  - `transforms`, `joblog` (anchor-gated), `params` (W6/B9);
  - `jobs` (step-17 checks, admission before any key, attestation, `opened` record, the announcement only after its anchor);
  - `inputs` (B1–B4, B9–B11, sealed receipts);
  - `close` (chain time AND attested time; the notarization with its cosignature over H(body); counted inputs, commitment, dropped-after-acceptance; `k_min`);
  - genesis and countersign (G2), abort, and the `CardOracle` / `Workers` / `HostIo` seams.
- **`notary-runtime`** binary:
  - `--mode worker` runs under its own UID, rlimits, and a seccomp filter exactly matching runtime §3's list;
  - `--mode broker` runs the host loop with queued fetches, per-job worker processes and the wall-clock kill.
- **`notary-guest`**: the guest library for templates (no_std, no floats, canonical output, fixed point). It builds for wasm32.
- **Cross-language list vectors**: `vectors/lists/cases.json` is written by Rust (14 cases, ECDSA and ML-DSA keysets), and the TypeScript `verifyListApproval` agrees on every case.

### Tested (commands run at the end of the session)

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/` | 71 passed, 0 failed (per-crate counts in code-plan §8.3) |
| `cargo test -q --release -p notary-worker --test cp9`; same with `--features portable-dispatch` | 7 passed each |
| `cargo test -p notary-worker --test cp9` and `-p notary-runtime --test worker_process` in `rust:1.96` linux/arm64 | 7 and 2 passed (sandbox verified) |
| `cargo test -p notary-worker --test cp9` in `rust:1.96` linux/amd64 (emulated) | 7 passed. The sandbox test can't run under emulation (E27). |
| `pnpm test` in `notary/vectors-tools` | 37 passed (incl. 15 new list cross-checks) |
| `notary/scripts/check-aws-isolation.sh` | OK |

### Bugs found and fixed on the way

- Counted inputs were sorted by base64url text, which fails N8 for most sets. Now sorted by raw bytes (D11), found by the broker close test.
- Rust's exit path made `sigaltstack` calls outside the seccomp list (D10).

### Not done

- **5.3a `notary-cards`**: the Rust card-check port, the TypeScript vector generator, the CI regeneration check and the coverage map. Until it exists, the runtime binary refuses every job (fail-closed oracle). The broker's card-dependent checks are tested only through a test oracle.
- **5.5**: the compose run end to end with the real runtime; the host-side header-streaming, snapshot-refresh and `close_chunk` schedulers. These need 5.3a for any job to open.
- **5.6**: the capacity benchmark.
- **Not built in 5.3, by plan:** per-input jobs (6.4); epochs and restarts (6.2); multi-replica acknowledgments, cosigning and handoff (6.3); private `notary_output` delivery (6.1). The broker refuses each with `NH_UNSUPPORTED`.
- **Cross-language check of a broker-produced notarization** with the TypeScript `verifyNotarization`. The Rust test checks the same signatures, commitment and hashes. The TypeScript run belongs with 5.5.

### Needs David

Errata **E20, E21, E24, E25** need one-line spec approvals. **E26** asks whether a first identity-log record is intended, and with which `kind`, which affects algorithm E. **E27** needs a native x86_64 Linux run of the sandbox test.


---

## 5.3a session (Opus, 2026-11-12)

Decisions: **E28** (a TypeScript predicate evaluator is the reference), **E29** (trusted, app-certification and login-service roots pinned in the image). Errata: **E30** (snapshot fields), **E31** (policy and list reads, open). All in `plans/notary-questions-5.3.md`. Nothing committed.

### Built

- **TypeScript reference** (verifier `notary` subpath):
  - `predicates.ts`: the spec's predicate system with parameter references. Fail-closed, with a regex subset shared with Rust.
  - `contributor.ts` (`checkContributor`): B5–B8 over a card world, running the verifier's **real** Stage 2/3/4 code.
- **Generator** `verifier/scripts/gen-notary-conformance.ts`: deterministic worlds with real ML-DSA keys and AES-GCM card documents. 58 cases (one per check, accepting and rejecting) and a coverage map of 35 checks, written to `notary/vectors/cards/`.
- **`notary-cards`** (Rust): Stage 2, 3 and 4, the predicates, B5–B8 and the root key. A line-by-line port, including the verifier's lenient base64url decoding of chain keys and `decryptCardHead`'s merge rule.
- **CI**: `notary/scripts/check-card-vectors.sh` regenerates the vectors in check mode and runs the Rust conformance test. `integration_tests/run.sh` gains three notary steps (Rust workspace, AWS isolation, card vectors).
- **Enclave oracle** `SnapshotOracle`: evidence first, then whole-policy snapshots, then per-card fetches, every object CID-checked. It's wired into `notary-runtime` in place of the fail-closed placeholder.
- **Host** snapshot builder: per-card event history and `sub_card_doc_cid` (E30).

### Tested

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/` | 75 passed, 0 failed |
| `cargo test -p notary-cards --test conformance` | 2 passed (all 58 cases agree; coverage complete) |
| Planted predicate bug (`any_of` evaluated as `all_of`) | 2 disagreements reported, as expected; restored |
| `cargo test -p notary-broker --test cards_oracle` | 2 passed (58 cases × 3 deliveries; forged evidence refused, genuine accepted) |
| `notary/scripts/check-card-vectors.sh` | passes; with one planted stale verdict, exit 1 ("stale: notary/vectors/cards/cases.json") |
| verifier `pnpm test` | 252 passed |
| `pnpm test` in `notary/host`, `notary/vectors-tools`, `notary/attestation-ts` | 69, 37, 91 passed |
| `notary/scripts/check-aws-isolation.sh` | OK |

### Not done

- **E31, needs David:** the enclave can't yet read or trust a policy at `policy_state_cid`, a requester's chain, or a list card's history. These fail closed, so the runtime opens no job.
- **5.5:** the end-to-end compose run and the host's header, snapshot and close schedulers. Blocked by E31.
- **5.6:** the capacity benchmark. Input checking can now be measured in isolation (`notary-cards`), but an end-to-end measurement needs E31.
- **§7.5 mechanism 4 (nightly differential fuzzing):** not built.
- **The press's predicate stub** (CP10 report in `notary-questions-5.3.md`): reported, not fixed.


---

## E31 implementation (Opus, 2026-11-12)

The approved spec wording (`notary-spec-wording-e31.md`) is now implemented. Nothing committed.

**Built:**
- Algorithm R, in TypeScript (`readPolicy`, `requesterAllowed`) and Rust (`notary-cards::policy`), with 21 generated cases that Rust agrees on.
- List-history reads over `fetch` (`notary-cards::lists_read`), checking press signatures, `prev_log_root` and the holder intent signer (E33), with pinned list-card keys.
- `single_operator_quorums` in `list_approval`, plus rule E, in both languages; 6 new list vectors.
- Single-operator detection, the `SINGLE_OPERATOR_QUORUM` warning in N, the wallet's consent flag, disclosure and W7 refusal, and the enclave's step-17 refusal, which fails closed on unknown operators (E34).
- The runtime's `SnapshotOracle` now serves policy, requester and list reads, so the binary can open jobs given real card data.
- The CI vector check also runs the algorithm R conformance.

**Tested** (all run after the last change):

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/` | 79 passed, 0 failed |
| `notary/scripts/check-card-vectors.sh` | up to date; Rust agrees on all contributor and policy cases |
| `notary/scripts/check-aws-isolation.sh` | OK |
| verifier `pnpm test` | 257 passed |
| wallet-sdk `pnpm test` (after `pnpm install --force` refresh of `file:` copies) | 235 passed, 1 todo; 4 consecutive clean runs. A flaky assertion was fixed (see `notary-questions-5.3.md`). |
| `notary/host`, `notary/vectors-tools`, `notary/attestation-ts` | 69, 43, 91 passed |

**E34 resolved (drop the enclave check; verifiers reject after the switch).** **Open:** E33 (LogEntry intent payload; suggested as a separate protocol-wide decision), E26 (first identity-log record), E27 (native x86_64 sandbox run). **Next:** 5.5 end-to-end in compose: the host's header-streaming, snapshot-refresh, list and close schedulers, the runtime pins file for the simulator stack, and the run itself. Then 5.6.

**After E34 (2026-11-12):** Rust 79 passed; verifier 257; wallet 235 + 1 todo; host 69; vector tools 43; attestation 92; card-vector and AWS-isolation checks pass.

**Batch 2 approved and applied (2026-11-12).** `plans/notary-spec-wording-batch2.md` is in the specs: E1, E2, E3, E6, E7, E10–E18 and E26. E26 is implemented (identity-log `seq` 0 written at countersign, jobs gated on its anchor, algorithm E requires it). E33 moved to a separate protocol-wide question. **E35 approved and applied.** **Open:** E27 (native x86_64 sandbox run). **Next:** 5.5 end to end, then 5.6.

## 5.5 end to end: in progress (2026-11-12, stopped at a usage limit)

Batch 2, E26 and E35 are committed in 4d09f6d3. **The 5.5 work below is uncommitted.**

**Built (not yet run end to end):**
- `notary/sim/src/bin/fake-enclave.rs`: the fake enclave service as a process (`--listen`, `--print-root`, `--print-pcr0`).
- `notary/e2e/` (new pnpm workspace package):
  - `src/sim-chain.ts`: the simulated registry, IPFS, block headers (Ethereum RLP, keccak hash), EAS and txs, as one HTTP service, plus `GET /world` (a `CardWorld`). Smoke-tested.
  - `src/world.ts`: a deterministic world (keys from seeds; governance list cards with 4-of-5 P-256 approvals; policy, chapter, app, requester, operator and contributor cards; `notary_input` sub-cards). Also `approveNotary` (policy field update after genesis) and `pins()`.
  - `fixtures/pins.json`: generated with the fake-enclave root.
  - `fixtures/tally.wasm`: the broker test's tally program, kept current by `broker.rs::e2e_tally_fixture_is_current`.
- `wallet-sdk` `package.json`: a new `./notary` subpath export.

**Still to do:**
1. Host: sim-chain clients for `IpfsService`, `EasAnchorer`, `ChainReader` (`card_head` → canonical `{head_cid, events}`, `subcard`), `PolicyReader` and `ChainSubmitter`; a `ChainFeed` interface; startup selection (e.g. `CHAIN_PROVIDER=sim` + `SIM_CHAIN_URL`).
2. Host schedulers (production code over `ChainFeed`): header streaming (`chain_headers`), snapshots for policies named in `contributor_predicate` (`policy_snapshot`, then `policy_updates`), and close (`close_chunk` with the stored sealed inputs after `closes_at`; on `job_closed`, retire the job and delete its ciphertexts).
3. `e2e/src/driver.ts`, in this order:
   - genesis via `/genesis`, then countersign;
   - register the notary card under `IDS.notaryCardPolicy`, then `approveNotary`;
   - restart the host with `NOTARY_CARD_ADDRESSES` set;
   - submit the job (`policy_state_cid` = the approval head);
   - the wallet runs `verifyNotaryJob` with `NotaryChainReads` over sim-chain (W10 `issuer_card` = the policy CID, per E11) and with the lists verified by algorithm L;
   - submit inputs through the OHTTP gateway;
   - wait for close;
   - check the notarization with TypeScript `verifyNotarization` (the chain view comes from sim-chain).
4. A runtime-sim Dockerfile (`notary-runtime` + `fake-enclave`, `--pins` = the fixture). Update `docker-compose.sim.yml`: sim-chain, redis, enclave-sim, host, driver.
5. Run it, tick 5.5, update code-plan §8.3. Then 5.6.

## 5.5 end to end: done (2026-11-13)

**Done when holds:** `notary/e2e/run-compose.sh` runs the end-to-end path in docker-compose against the simulator and passes. Linux arm64 containers run the real worker sandbox. `run-local.sh` runs the same path as processes.

The path is:
- genesis, with algorithm G;
- identity-log `seq` 0 anchored (E26);
- the job accepted;
- algorithm W through the OHTTP gateway, with the single-operator disclosure;
- 3 contributors' sealed inputs, each with a host receipt and an accepted validation receipt;
- close on chain time;
- a notarization counting 3 inputs with the public output `{no:1, yes:2}`;
- algorithm N, valid, with warning `SINGLE_OPERATOR_QUORUM`.

**Built since the previous note:**
- **Host simulated-chain clients:** `src/sim/`, used when `CHAIN_PROVIDER=sim` / `IPFS_PROVIDER=sim`.
- **`ChainFeed` and the schedulers:** `src/schedulers/`, covering headers, snapshots then updates, and close with `CLOSE_NOT_DUE` retried. 5 new tests (host: 74).
- **The mock enclave** answers `close_chunk`.
- **`/genesis`** now returns `request` and `notary_card` (E24).
- **Host startup:**
  - storage is mounted at run time from `EXTERNAL_KV_URL` (it was baked in at build time);
  - the enclave connection is retried for up to 60 s.
- **The e2e package:** `reads.ts` (wallet and verifier reads over the simulated chain, plus an OHTTP client), `driver.ts`, `README.md`.
- **Images:**
  - `Dockerfile.runtime-sim` (Debian trixie, to match the glibc of the build image);
  - `Dockerfile.e2e`;
  - `build-ts-deps.sh`, which builds the TypeScript dependency chain in images.
  - In images, the wallet's two provider devDependencies are dropped (only its tests use them), and `verifier-ipfs-provider`'s `workspace:*` is rewritten to `file:`.
- **Both Node images pin pnpm 9.6.0.** pnpm 10 refuses esbuild's install script.

**Simulated, not real (Phase 7 replaces them):** the chain, IPFS and EAS (`e2e/src/sim-chain.ts`), and the attestation service (fake enclave, test root). The adapters in `e2e/src/reads.ts` stand in for the Phase 7 `CardVerifier` adapters:
- W5 `satisfies` returns true, because the policy has no requester predicate;
- the genesis PCR0 passed to algorithm E is the simulator's known value, not parsed from the document;
- the notarization reads report `chainValid: true` for the policy and the notary card;
- the issuer is resolved per E11.

**Not covered by this run:** multiple replicas and operators (6.3), per-input jobs, derived cards, `policy_updates` changing a contributor mid-job, and the production chain/EAS/Kubo clients (Phase 7).

**Next:** 5.6 capacity benchmark.

## 5.6 capacity benchmark: done (2026-11-13)

The results and the provisional instance-size recommendation are in code-plan §11. The harness is `notary/runtime/benches/capacity` (with `run-linux.sh`), and the worlds come from `notary/e2e/src/bench-world.ts`.

**Headline (Linux arm64, one broker thread):**
- ≈ 290 inputs/s, the same for 1,000 and 10,000 inputs and for 1, 20 or 5 concurrent jobs;
- close ≈ 2.3 ms per input (24 s for 10,000);
- held per-input state ≈ 200 B;
- close working set ≈ 10–25 KB per input.

**Recommendation:** c7g.large per replica, with the enclave at 2 vCPU / 2 GiB, provisional until Phase 8.

**Flagged to David:**
1. `dedicated` means one job per enclave.
2. There is one broker thread per enclave.
3. Each input makes 7 vsock fetches, with no ancestor cache.

**Next:** 5.7 milestone review (a separate session).

**Initial deployment decided (David, 2026-11-13):** one c6g.large per operator (enclave 1 vCPU / ≈ 1 GiB), on a 1-year savings plan, shared by the first communities: ≈ $35–40/month. Details are in code-plan §11, "Initial deployment". Phase 8 confirms the enclave memory figure on real hardware.

## 5.7 review (2026-11-13)

Summary: [notary-phase-5-summary.md](notary-phase-5-summary.md). Errata and questions for David: [../notary-questions-5.7.md](../notary-questions-5.7.md) (Q1–Q10). Nothing committed (CP11).

**Fixed in code, each with a test:** a dedicated enclave counted finished jobs; multi-replica jobs were keyed by one enclave; the host fell back silently to in-memory chain, EAS and IPFS services under a production configuration; the header scheduler skipped headers after a failed call; four B-checks had no test; the G5 script could not see a call to the AWS module. The e2e driver retries `INPUT_CHAIN_REF_UNKNOWN` (B3's wait is not implemented: Q3). `run-local.sh` failed at `HEAD` on this machine for that reason.

**Tests run at the end of the review:**

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/` | 83 passed, 0 failed (was 80) |
| `pnpm test` in `notary/host` (+ `typecheck`, `typecheck:server`) | 78 passed (was 74); both typechecks clean |
| `pnpm test` in `notary/vectors-tools` | 43 passed |
| `pnpm test` in `notary/attestation-ts` | 92 passed |
| verifier `pnpm test` | 258 passed |
| wallet SDK `pnpm test`, `typecheck`, `build` | 235 passed, 1 todo; typecheck and build clean |
| `notary/scripts/check-card-vectors.sh` | up to date; Rust agrees on every case |
| `notary/scripts/check-aws-isolation.sh` | OK (and a planted `notary_attest::aws` probe in production code fails it) |
| `notary/e2e/run-local.sh` | END TO END: PASS |
| `notary/e2e/run-compose.sh` | END TO END: PASS (Linux arm64 containers) |

**Not run:** the Linux-only sandbox test on x86_64 (E27); the worker sandbox tests on Linux this session (the compose run uses Linux arm64 containers and exercised the worker process, but `cargo test` was run on macOS); nitropack and Rust 1.96 as pinned.

**Follow-up (2026-11-13), David approved Q1, Q2, Q3, Q5, Q6, Q9, Q10:** implemented and the specs amended; see "Resolution" in `plans/notary-questions-5.7.md`. Open: Q4, Q7, Q8 (recommendations given there). Tests after the follow-up: Rust 85 passed; host 78; vector tools 43; attestation 92; verifier 258; wallet SDK 237 + 1 todo; card-vector and AWS-isolation checks pass; `run-local.sh` and `run-compose.sh` pass.

**Q4 done (2026-11-13):** the host serves cards created through `/genesis` (no config, no restart). Open: Q7, Q8. Host tests 79; `run-local.sh` and `run-compose.sh` pass.

**Q7 and Q8 done (2026-11-13).** Q7: first header within 10 minutes of the attested time (runtime §13 amended). Q8: wallet SDK peers made optional; `.github/workflows/wallet-sdk-ci.yml` added (not yet run on GitHub). Rust 86 passed; host 79; wallet SDK 237 + 1 todo; both e2e runs pass. Every Q1–Q10 item is closed.
