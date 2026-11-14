You are doing step **6.3, Replication**, of Phase 6 of the Digital Notaries project, in the repository card_protocol on the `notary` branch (HEAD `381cf8c7` or later). This step is Opus work: it is the subtlest security code in the project. Phases 1–5 and steps 6.0, 6.0a, 6.1 and 6.2 are done. The broker so far runs **one replica**; your job is to make a job run on several enclaves, survive the loss of one, move between runtime builds, and handle key exposure.

## Read first, in this order
1. `plans/milestones/notary-phase-5-progress.md` (the running log, including the 6.0a, 6.1 and 6.2 sections at the end) and `plans/milestones/notary-phase-5-summary.md`.
2. `plans/notary-questions-phase-6.md`. **Every question is answered "OK to all".** Q5–Q9 are your design brief (restated below). Also read its "Decisions made during 6.1 / 6.2" sections.
3. `plans/notary-questions-5.7.md` (the Phase 5 review errata, all closed) and `plans/notary-questions-5.3.md` (E20–E35).
4. `plans/notary-implementation-plan.md`, step 6.3 and the Clarification Checkpoints. `plans/notary-code-plan.md`: §2.1 (broker modules: `replication`, `state_blob`, `derive`, `propagation` are not built yet), §6, §7, §8.3 (traceability: keep it current).
5. The specs, read closely because 6.3 implements them:
   - `specs/process_specs/notary_replication_and_recovery.md` (all of it: §1–§9, algorithm P, error paths);
   - `specs/object_specs/notary_runtime.md` (§4 key lineage and invariants I1–I3, §9 the host–enclave protocol, §10 states, §12 lists, §16 codes);
   - `specs/process_specs/notary_lifecycle.md` (phases 0–7, Appendix A.1 algorithm V, A.4 algorithm N, A.6 algorithm E, A.7 algorithm R, and the threat model T1–T10, L1–L10);
   - `specs/object_specs/notary_host.md` (§5 routes, §9 anchoring, §11 enclave manager and peer relay);
   - `specs/protocol-objects.md` §20–§34, especially §28 JobLogRecord, §29 HandoffRecord, §30 Heartbeat, §34 lists (`close_compat`, `retire_reason`).

## What 6.3 must deliver (implementation plan, "Done when")
Tests cover:
- killing one replica mid-vote with **no ballots lost**;
- **re-replication** back to `min_live`;
- a **refused handoff for each mismatch case** (P1–P5, `HANDOFF_OVER_CAPACITY`);
- **every handoff appearing in the log**;
- a **rolling upgrade** of a live vote with no ballots lost;
- an **incompatible upgrade by migration epoch**;
- an **emergency retirement** that makes the notary card unusable and re-keys its jobs (`key_exposure` epochs, algorithm E).

Also in scope: job-scope, identity-scope and template-scope handoff (the template scope is for 6.4's `dup_tag` key; build the transfer, not the derivation), heartbeats, quorum acknowledgment of inputs (§4), the cosigned close (§5, steps 14–19), leadership, and lifting the single-replica restrictions below.

## The design is decided (Phase 6 questions Q5–Q9, all approved)
- **Q5, peer wire format.** One envelope, canonical JSON: `{ "type": "notary.peer.v1", "kind", "from", "to", "body", "instance_signature" }`, signed by the sender's `K_inst`. Instance id is `SHA-256(K_inst)`. Kinds: `hello` (challenge), `handoff_offer`, `handoff_payload`, `handoff_ack`, `input_forward`, `input_ack`, `close_body`, `close_cosign`, `close_mismatch`, `heartbeat`, `replica_gone`. The host relays bytes and never parses them. Add a new §35 to `protocol-objects.md` and the new message kinds to runtime §9. A host-to-enclave **`peer_directory { peers: [{ instance, notary_card, inst_pubkey, attestation, host_url }] }`** is an *untrusted hint* saying where to send; every peer still passes algorithm P. The enclave never trusts it.
- **Q6, timers.** A new host-to-enclave **`tick {}`** message, about once a second, carrying **no time**. The enclave reads the attested clock **at most once per tick** and runs every due timer against that reading: heartbeats (30 s), liveness window (120 s), acknowledgment timeout (60 s), handoff attestation age (5 min), the per-input key grace, and later 6.4's issuance boundaries. All protocol time decisions use the attested clock, never header or host time. A host that withholds ticks only slows timers.
- **Q7, handoff capacity.** The sender computes each notary card's live instance count from **the anchored job log it holds** (`handoff` and `replicated` records for that card, minus `replica_lost`). Heartbeats may only *lower* the count. Algorithm N gets a warning `NOTARIZATION_REPLICA_OVER_CAPACITY` when any card has more live instances than `replica_set` allows, checked from the public log. Amend replication step 7 and lifecycle A.4.
- **Q8, ciphertext sync.** The handoff payload carries the dedupe index (every counted `input_hash`). The receiving enclave tells its host **`need_inputs { job_hash, hashes }`** (new enclave-to-host message). The host fetches the missing `SealedInput`s from peer hosts through `/peer` and **checks `H(sealed) == input_hash` itself** before storing. A host can only withhold, never inject. Amend host §11–§12 and runtime §9.
- **Q9, tests.** An **in-process multi-broker harness**: several real `Broker`s joined by a controllable message bus (`HostBus`) standing in for hosts. The bus can **drop, delay, reorder, replay and rewrite** any message and records what each "host" saw. Each broker has its own simulated attested clock. Test every threat note in replication §2–§9 directly. Runtime upgrades use the simulator's two builds with different PCR0s and `close_compat` (`notary-sim` already supports a different PCR0 per fake enclave via `EnclaveConfig::pcr0_seed`). At the end add **one docker-compose scenario with three hosts and three Redis instances** (kill one replica mid-vote, re-replicate, close); it becomes the base for step 7.1.

The spec wording for Q5–Q9 was approved as described above. Write it into the specs with an "Amended 2026-11-.. (6.3)" line, as the 6.0a, 6.1 and 6.2 sessions did. Anything you add **beyond** what Q5–Q9 describes goes in a new `plans/notary-questions-6.3.md` and is marked in the spec "for David's review". Never guess on a security point.

## What exists (reuse it)
- `notary-broker` (`notary/runtime/crates/notary-broker/src`): `host_proto` (message dispatch), `keyring` (identities, job keys per (job, epoch), key lineage, `apply_retirements`, `erase_job_epoch`), `jobs` (`create_job` and `restart_job`, `announce_after`, `Job` state), `inputs` (B1–B11, sealed receipts with `acks: 1`), `close` (single-replica close with its own cosignature and `close_quorum: 1`), `joblog` (anchor-gated records, `ANCHORED_KINDS`), `lists`, `chain`, `cards_oracle`.
- **Restrictions to lift** (they currently answer `NH_UNSUPPORTED` or assume one replica): `create_job` refuses `n != 1` (`jobs.rs`, "multi-replica jobs arrive in step 6.3"); `restart_job` accepts only `total_loss` for a job the enclave holds (the other reasons and a job it doesn't hold need the identity handoff); `inputs.rs` writes `"acks": 1`; `close.rs` cosigns alone with `close_quorum` from `q` but assumes q = 1; the host and enclave have no heartbeat, handoff or peer path (`peer_message` is accepted and ignored).
- Objects already defined in `notary-types` and the host's `types.ts`: `HandoffRecord` (§29), `Heartbeat` (§30), `StateBlobHeader` (§31), `PropagationBatch` (§32). Verifier side: algorithm E (`verifier/src/notary/exposure.ts`), algorithm N with `JOB_LOG_FORK`/`GAP`/`EPOCH_TOTAL_LOSS` warnings, algorithm V (`attest.ts`), the attestation fixtures builders in `notary/sim`.
- Host: `src/handlers/enclave-requests.ts` (peer_send, need_replica, publish, anchor), `src/peer`, the `/peer` route, `handleRestartJob` (6.2), the schedulers (`headersTick`, `snapshotsTick`, `closeTick`), `ReplicaStarter` (`need_replica`).
- Wallet: `watch.ts` already resubmits on a higher epoch and tells the user by reason; `submit.ts` checks `acks >= quorum` on receipts.
- Templates `aggregate`, `vote`, `vote-yna` and `notary-messaging` exist (6.1, 6.2). Use `vote-yna` as the program for "kill one replica mid-vote" tests.

## Hard rules (unchanged)
- **Terminology:** "AWS Nitro Enclaves" or "the enclave" for the TEE; "nitropack" for the web framework; never a bare "Nitro" (`nitro-devnode` excepted).
- **Specs are approved text.** Apply only the Q5–Q9 amendments above, marked as such. Where code and spec disagree and the spec is right, fix the code with a test. Where the spec is wrong or ambiguous, record an erratum and ask. **Ask David immediately about anything that affects security or a spec.** This step is where such questions are most likely: expect to find gaps in algorithm P, the handoff payload, leadership under partition, and the identity/template scopes. Library and interface choices that affect neither get decided by you with a one-line note.
- **CP9 stop:** if a failure means NSM time, determinism or an interop check cannot hold, stop and tell David.
- **G5:** only `notary-attest::aws`, `notary/attestation-ts` and `notary/deploy` may parse the AWS attestation format; `notary/scripts/check-aws-isolation.sh` must keep passing. Production code must not name the AWS module.
- **CP7:** no changes under `contracts/`, no on-chain action. **CP8:** no AWS resources. **CP10:** report bugs outside notary code, do not fix them. 6.4a (the write gate) is *not* part of this step.
- **Don't redesign.** Bigger changes to the approved design go to David as a proposal.
- **Do not push.** Commit only when David asks. Tick 6.3 in `plans/notary-implementation-plan.md` only when its "Done when" holds and the tests pass. Run the tests; do not assume they pass. Keep code-plan §8.3 and `plans/milestones/notary-phase-5-progress.md` current.
- The enclave **never** accepts an imported identity key except by handoff (invariant I2), never exports a key except by handoff (I1), and an exposed key is never handed on (P5). Test each of these as an invariant, not only on the happy path.

## Tests to keep green (last results, 2026-11-14)
| Suite | How to run | Last result |
|---|---|---|
| Rust | `cargo test --workspace` in `notary/` | 123 |
| Host | `pnpm test` in `notary/host` (+ `pnpm run typecheck`, `typecheck:server`) | 85 |
| Vector tools | `pnpm test` in `notary/vectors-tools` | 46 |
| Attestation | `pnpm test` in `notary/attestation-ts` | 94 |
| Verifier | `pnpm test` in `membership_card_verifier/packages/verifier` | 276 |
| Wallet SDK | `pnpm test`, `pnpm run typecheck` in `wallet-sdk/packages/wallet-sdk` | 240 + 1 todo |
| App SDK | `pnpm test` in `app-sdk/packages/app-sdk` | 193 |
| Card vectors | `notary/scripts/check-card-vectors.sh` | passes |
| AWS isolation | `notary/scripts/check-aws-isolation.sh` | passes |
| Templates | `notary/templates/build.sh <aggregate\|vote\|vote-yna> --check` | passes |
| End to end | `notary/e2e/run-local.sh`, then `notary/e2e/run-compose.sh` | passes |

## Environment notes (things that cost time before)
- Node: use 22 (`export PATH=$HOME/.nvm/versions/node/v22.23.0/bin:$PATH`). The shell is zsh: unquoted variables are not word-split and an unmatched glob is an error, so put multi-step scripts in `bash` or a file.
- Rust is pinned to 1.96.0 (`notary/rust-toolchain.toml`, with the `wasm32-unknown-unknown` target).
- **`file:` dependencies are copies.** After rebuilding the verifier, the wallet SDK or the App SDK, run `pnpm install --force` in `notary/` and in `wallet-sdk/` to refresh them, or tests see stale code.
- **`dist/` is git-ignored** (`notary/**/dist/`). Anything that must be committed must not live there (the template modules are in `notary/templates/modules/`).
- Rebuild before the e2e run when Rust or host code changed: `cargo build -p notary-runtime -p notary-sim` and `pnpm -C notary/host build`. A stale process on port 3000 or a leftover compose stack makes `run-local.sh` fail in odd ways: `pkill -f ".output/server/index.mjs"` and `docker compose -p notary-sim -f notary/deploy/docker-compose.sim.yml down -v`.
- The compose Dockerfiles copy selected workspace members: add any new crate or template directory to `notary/deploy/Dockerfile.runtime-sim` and any file the e2e driver reads to `Dockerfile.e2e`.
- Seccomp, UID and rlimit tests need Linux. On macOS use `docker run --rm -v "$PWD":/repo -w /repo/notary -e CARGO_TARGET_DIR=/tmp/t rust:1.96 cargo test --workspace` and say so. Native x86_64 is still unverified (E27).
- Two enclaves in one test process need distinct `pcr0_seed`s only when you want different runtimes; the fake enclave's attested clock is controllable per instance (`set_clock_ms`).
- The first header after boot must be within 10 minutes of the attested clock (runtime §13); a multi-broker harness must feed each broker headers near its own simulated clock.

## Deliverables
1. The code and tests above, with a traceability row per piece in code-plan §8.3.
2. The spec amendments for Q5–Q9, each marked, and `plans/notary-questions-6.3.md` for anything beyond them (spec quote, code location, what differs, recommendation).
3. The multi-broker harness as reusable test support (6.4 and 6.5 will use it), and the three-host compose scenario.
4. A short section appended to `plans/milestones/notary-phase-5-progress.md` ("6.3 done" or "6.3 stopped at …") with test commands and actual results.

## When you stop
Report plainly: what you built and checked; the exact test commands and their results; every spec amendment and every question you recorded for David; anything you could not verify (for example the three-host compose run, or Linux-only tests); and, if you stopped early, which parts of the "Done when" list are met and which are not. Do not tick 6.3 unless every item is covered by a passing test.
