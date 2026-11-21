# Notary Phase 6 Summary — The Four Use Cases

Dates: 2026-11-13 to 2026-11-21 · Errata and questions from the review: [notary-questions-6.6.md](../notary-questions-6.6.md) · Earlier: [phase 6 questions](../notary-questions-phase-6.md), [6.3](../notary-questions-6.3.md), [6.4](../notary-questions-6.4.md), [6.4a](../notary-questions-6.4a.md), [6.4b](../notary-questions-6.4b.md), [6.5](../notary-questions-6.5.md) · Phase 5: [notary-phase-5-summary.md](notary-phase-5-summary.md)

## What was done

| Step | Result |
|---|---|
| 6.0 Questions | Answered (OK to all, 2026-11-14) |
| 6.0a Contributor-policy hardening | `contributor_policies` in the notarization, algorithm N14, closed contributor set, snapshot-only contributor cards |
| 6.1 Aggregation | the `aggregate` template and policy; `notary-messaging` and private outputs |
| 6.2 Voting | the `vote` and `vote-yna` templates; epoch restart with wallet resubmission |
| 6.3 Replication *(Opus)* | handoff P1–P5, quorum acknowledgment and cosigned close, re-replication, rolling and migration upgrades, key exposure, the three-host compose scenario |
| 6.4a, 6.4b | registry write-gate and governance payload binding (devnode only; deploying is W8) |
| 6.4 Derived cards | the `derive` template; `dup_tag`, the anonymity set, batched issuance through the notary as press |
| 6.5 Propagation *(Opus)* | `expiry_only` and `sealed_link`, the state blob, the watch loop, batched and delayed revocation |
| 6.6 This review | below |

## What the review did

- **Ran everything** at the end (below), including both end-to-end scenarios: `e2e/run-local.sh` (one real runtime, the real host, the wallet SDK and the verifier; ran in about a minute) and `e2e/run-three.sh` (three operators' hosts in docker-compose, one enclave stopped mid-job).
- **Mapped each G1 and G4 objective to tests**, reading the tests that carry the claim (below), not only their names.
- **Checked the four use cases for consistency**: the shared input, receipt, close and log paths, and where they diverge.
- **Compared error codes mechanically** with the specs, as in 5.7: every code in the two Phase 6 process specs is in code and in a test (19 of 19); the other direction found twelve codes in production code that no spec lists (R2).
- **Found and fixed two gaps** (below). It did **not** re-derive every step of every Phase 6 algorithm line by line; where a step has a test that fails if the step is removed, the test was trusted.

## Objectives and covering tests

### G1 — trusted analyses

| Objective | Covering tests | Notes |
|---|---|---|
| **Aggregation with ≥ k**: an independent verifier accepts the notarization from CIDs and chain data | `e2e/run-local.sh`: the aggregate template, three contributors, a total-loss restart, and **algorithm N in the TypeScript verifier accepts the final notarization** (ran in the review). `broker.rs::close_needs_both_clocks_and_produces_a_verifiable_notarization` (signature, cosignature over the raw digest, input commitment, `contributor_policies`, key erasure after the anchor). `attestation-ts/test/notarization.test.ts` (20: every `NOT_*` code). `templates/aggregate/tests/module.rs` | The verifier is a different implementation from the signer (Rust broker, TypeScript N) |
| **Aggregation with < k**: "insufficient participation" | `broker.rs::k_min_suppresses_and_the_program_does_not_run`; `templates/aggregate`: `small_cells_are_suppressed_by_the_runtime_and_empty_ones_stay_zero`; `notarization.test.ts`: a correctly suppressed notarization is valid, and N9 refuses a wrong `suppressed` | The real-process scenario runs with `k_min` 3 and three contributors; the suppressed case is covered at unit level on both sides, not end to end |
| **Vote**: a tally matching the cast ballots, finalized only after `closes_at` by chain time | `broker.rs::the_vote_template_counts_each_cards_latest_ballot_and_closes_only_when_both_clocks_say_so`; `close_needs_both_clocks…` (`CLOSE_NOT_DUE` in both orders: chain past and attested clock not, and the reverse); `replication.rs::a_vote_forms_by_handoff_acknowledges_by_quorum_and_closes_cosigned`; three-host scenario (four ballots counted, N verifies); `templates/vote*/tests/module.rs` | "Chain time" is the header chain plus the attested clock; a host can delay a close but not bring it forward |
| **Derived card**: only the projected fields, passes standard verification | `derive.rs::derived_cards_are_offered_countersigned_released_in_a_batch_and_registered` (only the projected value, verbatim; three signatures; `issued_at` is the boundary, not the request time); `e2e/test/derived.test.ts` (7: **the TypeScript verifier's Stages 1–6 and Stage 5 step 3a** over a fixture the real broker wrote; a notary with no `AuthorizePress` under `T` fails Stage 5); `templates/derive/tests/module.rs` (the module copies the projected values byte for byte); `derive.rs::refusals_at_job_creation` (a protocol field cannot be a projected field) | "Standard verification" means the verifier's stages over the simulated chain, with `verifyNotaryIssuedCard` called directly (6.4 Q11); `CardVerifier` wiring is 7.1 |
| **Derived card**: cannot be linked to the source card by the host's records | **New in this review:** `derive.rs::the_hosts_records_never_name_a_source_card` (scans everything the operator holds through issuance and a revocation; 4 holders × 10 identifier forms × 8 record sets; negative control). `derive.rs`: the job log says only a count; `e2e/test/derived.test.ts`: four cards carry distinct tags, one expiry, one `issued_at` | Before this review the claim was only indirect. Timing, batch size and the successor rule's codes are the disclosed residue (L8) |
| **`sealed_link`**: a source revocation revokes the derived card within the batching window; the host's records alone cannot match the two | `derive.rs::a_source_revocation_is_propagated_within_the_batching_window_with_the_mapped_code` (nothing before `min_delay`; one `BatchUpdateCardHeads` at the window; codes 820 and 920, never the source subcode; both signatures by `K_id`), `revocations_below_the_minimum_batch_are_held_and_dropped_at_expiry`, `the_successor_rule_and_a_fixed_derived_code`, `only_updates_signed_by_a_certified_press_count`; `e2e/test/derived-revoked.test.ts` (the verifier reads the propagated revocations); the unlinkability test above covers the propagation traffic | |
| **`expiry_only`**: the card lapses at its expiry | `derive.rs::expiry_only_keeps_no_link_and_the_card_lapses_at_expiry`; `verifier` Stage 4 step 5a tests | The objective text says `valid_until`; the spec's field is `expires_at` |
| *(Deferred)* all four on real AWS Nitro Enclaves | Phase 8 | |

### G4 — failure tolerance

| Objective | Covering tests |
|---|---|
| **Killing any single replica mid-vote loses no ballots; re-replication back to `min_live`** | `replication.rs::killing_one_replica_mid_vote_loses_no_ballots`, `re_replication_restores_min_live_and_every_handoff_is_logged`; **the three-host scenario** (an enclave stopped mid-job: `replica_lost`, a standby handed the job, a fourth ballot acknowledged by a quorum, all four counted, cosigned by distinct instances, N verifies; ran in the review) |
| **Killing all replicas: a new epoch, wallets resubmit, the tally is each card's latest valid ballot** | `broker.rs::an_epoch_restart_re_keys_the_job_and_the_resubmitted_ballots_count`, `a_vote_survives_an_epoch_restart_when_the_wallets_resubmit`; `e2e/run-local.sh` (restart at epoch 1; the three wallets resubmit stored inputs without re-signing; the users are told; N verifies with `EPOCH_TOTAL_LOSS`); wallet `linkJobWatch.test.ts` (the watcher) |
| **Every key handoff appears in the job log; voters hold enclave-signed receipts** | `replication.rs::re_replication_restores_min_live_and_every_handoff_is_logged`, `the_sender_refuses_a_handoff_for_each_mismatch`, `a_rolling_upgrade_of_a_live_vote_loses_no_ballots`, `an_incompatible_upgrade_moves_the_job_by_a_migration_epoch`, `an_emergency_retirement_kills_the_card_and_re_keys_its_jobs`; three-host scenario ("opened, then a handoff record per receiver"; "C's identity handoff is in its identity log, anchored"); receipts: `broker.rs::inputs_receipts_and_checks`, wallet `submit.test.ts`, three-host scenario ("a host receipt and a validation receipt acknowledged by a quorum") |

**Scope of G4:** it is proved for statement jobs (aggregate and vote). Derived-card jobs are single-replica by decision (R4).

## The four use cases: consistency

| Path | Aggregate and vote | Derived card | Consistent? |
|---|---|---|---|
| Admission and `create_job` | one path (`jobs.rs`); mode picks the fields (`aggregate`: `closes_at`; `per_input`: `ends_at` and `key_period`) | same path, then `derive_job_checks` | Yes |
| Input checks | B1–B9 in the shared `check_input`, then B10, B11 | B1–B9 in the same function, then D1–D4 and the offer | Yes |
| Receipt | `ValidationReceipt`, sealed under the exported key, `acks ≥ q` | the same object, plus `derived_offer` and the countersign reject reasons | Yes |
| Result | one `Notarization` at close, cosigned by q, `counted_inputs`, `contributor_policies` | no notarization; an `issued` record carrying a count only, and registered cards | By design |
| Log kinds | `opened`, `epoch_started`, `handoff`, `replica_lost`, `replicated`, `notarized`, `aborted` | `opened`, `issued`, `epoch_started` (key rotation), `handoff` (identity, template) | **`closed` is never written (R1)** |
| Epochs | restart on total loss; resubmission by the wallet | rotation each `key_period` with an hour of grace; no restart | Differs by design |
| Replication | N replicas, quorum acknowledgment | one replica (R4) | Differs by decision |
| Verification | algorithm N | Stage 5 step 3a (G, shape, E, source kind) and Stage 4 | Yes |
| Host retention | ciphertexts until the `notarized` record, then deleted | **was: never deleted, jobs never ended. Fixed (below)** | Yes, now |
| Wallet | W, consent, submit, inclusion, watch | W and consent; **`derived.ts` not built (R3)** | Gap |

## Gaps found and fixed

1. **The host kept per-input ciphertexts and never ended per-input jobs** (`notary_host.md §7`). Fixed in `host/src/{handlers/inputs,schedulers/index,storage/index}.ts`, with 6 tests (a negative control and a mutation check). Details in R-fixed 1 of [notary-questions-6.6.md](../notary-questions-6.6.md).
2. **The unlinkability objective had no direct test.** Added `the_hosts_records_never_name_a_source_card`, with a harness change (every enclave-to-host message is now recorded in full) and high-entropy source identifiers in `derive.rs`. Details in R-fixed 2.
3. `notary/e2e/README.md` described the step 5.5 tally program; the run has used the aggregate template since 6.1. Corrected.

## Open items for David (all in [notary-questions-6.6.md](../notary-questions-6.6.md))

R1 (`closed` log kind), R2 (twelve codes with no spec row; I'll write the rows on approval), R3 (wallet `derived.ts` and a real-process derived scenario: now or in 7.1), R4 (derived-card jobs are single-replica), R5 (no CI workflow runs the notary tests), R6 (delete the vestigial tally fixture). **Resolved afterwards:** R1, R2 and R6 were done, R3 and R5 moved to Phase 7, R4 confirmed (`notary-questions-6.6.md`, Resolutions).

**Carried, unchanged by this review:** E27 (the worker sandbox on native x86_64; verified on arm64 only), E33 (`LogEntry` and the intent signature), E9 (the signature libraries are unaudited), the CP10 press predicate report, W8 (deploying 6.4a and 6.4b beyond the devnode: a separate CP7 approval; rerun the pre-upgrade scan first), and the Phase 7 adapter work listed in the Phase 5 summary.

## Tests (run at the end of the review, 2026-11-21)

| Command | Result |
|---|---|
| `cargo test --workspace` in `notary/runtime` | 189 passed, 0 failed (190 before R6 deleted the fixture check test) |
| `pnpm test` in `notary/host` | 104 passed (10 files) |
| `pnpm test` in `notary/attestation-ts` | 95 passed |
| `pnpm test` in `notary/vectors-tools`; `pnpm run check` | 48 passed; vectors up to date (24 files) |
| `pnpm test` in `notary/e2e` | 12 passed |
| `bash notary/e2e/run-local.sh` | passed (aggregate template, private output, total-loss restart, resubmission, algorithm N) |
| `bash notary/e2e/run-three.sh` | passed (three hosts, one enclave stopped mid-job, re-replication, a fourth ballot, cosigned notarization, algorithm N) |
| verifier `pnpm test` | 276 passed |
| wallet SDK `pnpm test`, `pnpm run typecheck` | 242 passed, 1 todo; typecheck clean |
| `notary/scripts/check-aws-isolation.sh` | OK |

Not run: the Linux container isolation tests (E27), the nightly fuzz job, the integration stack (`integration_tests/`, Phase 7), anything on Sepolia or mainnet.
