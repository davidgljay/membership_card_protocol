# Digital Notaries — Step 6.6 Review: Errata and Questions for David

Summary: [milestones/notary-phase-6-summary.md](milestones/notary-phase-6-summary.md) · Earlier: [notary-questions-5.7.md](notary-questions-5.7.md), [-6.3](notary-questions-6.3.md), [-6.4](notary-questions-6.4.md), [-6.5](notary-questions-6.5.md)

**Update 2026-11-21: David accepted all recommendations.** See "Resolutions" at the end. Before that, no spec text had been edited. Items marked **spec** need your approval for a spec change. Two gaps were fixed in code during the review and are listed last.

| ID | Subject | Kind | Needs |
|---|---|---|---|
| R1 | The job-log kind `closed` is listed in §28 but never written, and no process says when | spec/code mismatch | your decision |
| R2 | Nine error codes in the broker and host appear in no spec | **spec** addition | your approval |
| R3 | Derived-card jobs have no wallet code (`derived.ts`) and no real-process end-to-end run | open scope | your decision: now or Phase 7 |
| R4 | Derived-card jobs are single-replica, so G4 does not cover them | known scope limit | confirm it is intended for v1 |
| R5 | No CI workflow runs the notary tests | gap | your decision |
| R6 | Vestigial `e2e/fixtures/tally.wasm` and its test | cleanup | your approval to delete |

---

## R1. `closed` job-log kind is never written

**Spec.** `protocol-objects.md §28`, `kind`: "`opened`, `epoch_started`, `handoff`, `replica_lost`, `replicated`, `closed`, `notarized`, `issued`, `aborted`". No process spec says when a `closed` record is written; the anchored kinds (§28) do not include it.

**Code.** The broker writes every other kind (`joblog.rs`, `jobs.rs`, `handoff.rs`, `replication.rs`, `close.rs`, `derive.rs`). Nothing writes `closed`. Verifiers accept it (the `JobLogKind` type), and nothing depends on it.

**Options.** (a) Remove `closed` from §28. (b) Define it: a record written when the close begins (state `CLOSING`), unanchored like `replicated`. It would let a reader see that a close started and did not finish. **Recommendation:** (a), because no verifier step uses it and a `closed` record that is not anchored proves nothing.

## R2. Nine error codes appear in code and in no spec

Found by comparing every code-like string in the broker and host production code with `specs/`. All behave as described; none is asserted by name in a test (their behavior is tested, for example the rollback refusal by its effect).

| Code | Where | Meaning |
|---|---|---|
| `HANDOFF_ALREADY_HELD` | `handoff.rs`, `keyring.rs` | a handoff of a job key (at that epoch) or an identity the receiver already holds |
| `HANDOFF_PAYLOAD_INVALID` | `handoff.rs`, `keyring.rs` | the handed-over secret does not form a key (an X-Wing secret or an ML-DSA seed) |
| `HANDOFF_PROGRAM_UNAVAILABLE` | `handoff.rs` | the receiver cannot fetch the job's program from its host by CID, or the bytes do not match |
| `HANDOFF_RECORD_INVALID` | `handoff.rs` | the `HandoffRecord` is malformed, or its `receiver_signature` does not verify |
| `JOB_KEY_MISSING` | `jobs.rs` | an attestation was requested for a job key this enclave does not hold |
| `RECIPIENT_UNREADABLE` | `cards_oracle.rs` | a private-output recipient's primary card, or its head, cannot be read or decrypted |
| `STATE_BLOB_UNKNOWN_CARD`, `STATE_VERSION_REGRESSION` | `propagation.rs`, `handoff.rs` | a blob load for a card whose identity this enclave does not hold; a handoff whose state version is below one this holder's heartbeats showed (this one also raises an alert) |
| `TEMPLATE_KEY_NOT_EXPOSED` | `keyring.rs` | a re-seed was requested for a template key that is not marked exposed |

`STATE_BLOB_INVALID`, `STATE_BLOB_UNAVAILABLE` and `STATE_ROLLBACK` are recorded in `notary-questions-6.5.md` but not in the specs. **Recommendation:** add all twelve to the error tables of `notary_runtime.md §16` and `notary_replication_and_recovery.md`, as was done for ten codes in 5.7 (Q6). I will write the rows when you approve.

## R3. Derived cards have no wallet code and no real-process run

`wallet_sdk.md §7b.7` specifies `requestDerivedCard`, the holder countersign and `renewDerivedCards`. They are not built (6.4: "wallet `derived.ts` not built"). The derived-card flow is tested through the broker (18 + 7 tests), the TypeScript verifier over a fixture the broker wrote, and the host's schedulers, but never through the wallet or through real processes. The G1 objective (issued, verifies, not linkable) does not need it, and the plan did not make it a Done-when.

**Options.** (a) Build `derived.ts` and a derived-card scenario in `notary/e2e` now (a Sonnet-sized step: about 250 lines plus a driver). (b) Leave both to Phase 7.1, where "one passing test per acceptance criterion" needs the scenario anyway. **Recommendation:** (b). 7.1 has to build the real-process derived scenario, and `derived.ts` is its dependency.

## R4. Derived-card jobs are single-replica

`create_job` for a derived-card job refuses more than one replica and an epoch restart (`NH_UNSUPPORTED`), by 6.4 D3 and 6.5 E11. G4 (replica kills, total loss and resubmission) is therefore proved for statement jobs only. After a total loss, the issuance pool and tag history are gone, and the sealed links return only if another holder's heartbeat carries the blob (6.5 E5). Confirm this is the intended v1 scope. If not, derived-card replication is a new step (the pool, the tag history and the template key already move by handoff; the missing part is the per-input quorum acknowledgment and the restart).

## R5. No CI workflow runs the notary tests

`.github/workflows/` has `notary-fuzz.yml` (nightly, not gating) and `wallet-sdk-ci.yml`. Nothing runs `cargo test --workspace`, the host, attestation, verifier-notary or e2e tests, or `check-aws-isolation.sh`. Code-plan §7.4 lists these checks as CI. **Recommendation:** add `notary-ci.yml` (Linux, which also runs the isolation tests, closing E27 for the platform the workflow runs on) as the first task of Phase 7. It is not written here: a new workflow is a CI change you may want to design (runners, caching, whether the compose scenarios run on every push).

## R6. Vestigial fixture

`notary/e2e/fixtures/tally.wasm` was the step 5.5 tally program. `run-local.sh` and the compose scenarios have used the aggregate template since 6.1. Only `notary-broker/tests/broker.rs::e2e_tally_fixture_is_current` still reads it. The e2e README now says so. **Recommendation:** delete both. Not done without your go-ahead.

---

## Fixed in code during the review

1. **The host kept per-input ciphertexts and never ended per-input jobs** (`notary_host.md §7`: "or the input's run completes … Then deleted"). A derived-card job's sealed inputs (a holder's source-card evidence, encrypted to the job key) stayed in the host's store for as long as the job record lived, which was forever: no code set the state `ended`. Now: the ciphertext is deleted when the enclave has answered it (success or refusal; an unavailable enclave keeps it for the retry), the host receipt stays; and `endTick` ends a per-input job at `ends_at` by chain time (inputs refused with `NH_JOB_CLOSED`, leftovers deleted). The ended record is kept 30 days, and for `sealed_link` at least `ends_at` + 2 periods + a day, because the source-policy watch reads it and periods run to 90 days. `host/src/{handlers/inputs,schedulers/index,storage/index}.ts`; 6 tests in `host/test/schedulers.test.ts`, including a negative control (an aggregate job keeps its ciphertexts until the close) and a mutation check (the tests fail without the change).
2. **"The host's records cannot link a derived card to its source card" had no direct test.** New `notary-broker/tests/derive.rs::the_hosts_records_never_name_a_source_card`: through issuance and a propagated revocation under `sealed_link`, it scans everything the operator would hold (every message the enclave sent in full, the stored ciphertexts, the chain submissions and batches, every pinned object, the anchors) for each source card's pointer, root key, `recipient_pubkey` and root-key hash, in text, base64url, hex and raw forms (4 holders × 10 needles over 8 record sets), with a negative control. It passes. The test first failed on a false positive: repeated-byte test identifiers alias with other repeated data once base64-encoded, so the source identifiers in `derive.rs` are now derived from SHA-256. The test harness (`support/mod.rs`) now records every enclave-to-host message in full (`Node::seen`). Residue the scan cannot show, and the specs disclose: timing and the batch size (L8).

---

## Resolutions (2026-11-21, David: "Accept recommendations")

- **R1 done.** `closed` removed from `protocol-objects.md §28` and from the verifier's `JobLogKind`.
- **R2 done.** Twelve codes added: five to `notary_runtime.md §16` (`JOB_KEY_MISSING`, `RECIPIENT_UNREADABLE`, `STATE_BLOB_UNKNOWN_CARD`, the three internal `STATE_BLOB_*`/`STATE_ROLLBACK` results, `TEMPLATE_KEY_NOT_EXPOSED`) and five to the error table of `notary_replication_and_recovery.md` (four `HANDOFF_*` codes and `STATE_VERSION_REGRESSION`).
- **R3** stays with step 7.1 (`derived.ts` and the real-process derived scenario are 7.1 dependencies).
- **R4** confirmed: derived-card jobs are single-replica in v1; G4 is proved for statement jobs only.
- **R5** recorded as the first task of Phase 7 (a `notary-ci.yml` workflow). Not written here.
- **R6 done 2026-11-21** (after the note below, David said "Yes, do it"): the capacity bench now builds its policy from the aggregate template and runs `aggregate.wasm` (a 200-input run accepted all 200); `e2e/fixtures/tally.wasm` and `e2e_tally_fixture_is_current` are deleted. The 2026-11-13 results file used the tally program, so it is not comparable to a new run.
- (Original R6 note, now resolved: and the recommendation was incomplete.** `notary/runtime/benches/capacity/src/main.rs` uses `e2e/fixtures/tally.wasm` as its default `--program`, so deleting the fixture breaks the capacity bench's default. Deleting needs the bench to be pointed at another program first. Left in place; tell me whether to repoint the bench at `aggregate.wasm` (its world file may need to change with it) and then delete both.
