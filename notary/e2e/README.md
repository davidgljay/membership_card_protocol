# notary/e2e: step 5.5 end to end against the simulator

One aggregate job runs through the real code end to end. Only the chain, IPFS and EAS are simulated:

1. **Setup.** The world is registered on the simulated chain: governance list cards (4-of-5 P-256 approvals), the policy, the requester, the operator, and three contributors with `notary_input` sub-cards.
2. **Genesis.** The operator calls `/genesis`. The policy holder runs algorithm G and signs the offer, and the enclave countersigns it. The notary card is then registered, and identity-log `seq` 0 is anchored (E26). Last, the policy holder approves the card.
3. **The job.**
   - The requester calls `POST /jobs`.
   - The wallet fetches the announcement through the OHTTP gateway and runs algorithm W.
   - Three contributors seal their inputs to the job key and submit them. Each checks the host receipt and the sealed validation receipt.
4. **Close.** After `closes_at`, the host sends the stored ciphertexts in `close_chunk`. The enclave runs the committed `aggregate` template (`templates/modules/aggregate.wasm`, step 6.1) over the three values (3, 7, 12) and publishes the notarization. The result is private: the notarization carries only its recipient, and the count, sum and buckets (`{ "count": 3, "sum": 22, … }`) reach the listed recipient's sub-card as a `notary_output` message. Algorithm N verifies the notarization. The driver also restarts the job at epoch 1 after the inputs (a total loss) and the three wallets resubmit their stored ballots (G4).

5. **Derived cards (`--phase derive`, Phase 7).** A second notary card is created for the derive template (a notary card is issued under one policy; W10), the template is seeded, and three holders request derived cards.
6. **A vote (`--phase vote`, Phase 7).** The `vote-yna` template under its own policy card and notary card; three voters cast ballots through the wallet's input path and one replaces theirs (latest wins); every replica is then lost (operator restart at a new epoch, `EPOCH_TOTAL_LOSS`) and the wallets re-seal their stored latest ballots to the new key; with chain time past `closes_at` but the enclave's attested clock not, the job stays open; with both, it closes with the tally of the latest ballots, and algorithm N accepts it. (Phases run in the order `setup job vote derive`; a later phase starts from the clock an earlier one left, kept in the enclave offset file.)
7. **`expiry_only` (`--phase expiry`, Phase 7).** The derive template with `revocation_propagation: expiry_only` (its own policy card and notary card), for holders 3 to 5 (the `derive` phase revokes holders 0 and 1; the world registers six members). A press-signed revocation of a holder's source card causes no chain event and leaves the derived card valid; after time moves past `expires_at` a verifier reports all three as lapsed (`reason: expired`), with no chain event. Order: `setup job vote derive expiry`.
8. **Adversarial (`--phase adversarial`, Phase 7.2, first tranche).** Attacks through the host's real routes, each refused with the code the spec names, with the honest request accepted before and after as a control: a replayed job (the same job, nothing new opened); a program that is not on the allowlist asking for `shared` isolation (`ADM_NOT_ALLOWLISTED_FOR_SHARED`, from the enclave); a program_cid that is not the policy's (refused by the host's courtesy check, so not an enclave defence); a replayed sealed input (acknowledged again, counted once at close); a flipped bit; another job's input; a chain reference to a block that does not exist or is not that block; a signature by a key the card does not hold; a valid member of another policy; a payload that breaks the schema; an epoch-0 input replayed into epoch 1; an input after close. The attacks are made by a hostile requester or contributor against an honest host: attacks that need a hostile host or enclave (dropped inputs, state-blob rollback, a stale chain feed, a rogue-PCR0 or debug enclave) are the second tranche. Run after `setup`: `PHASES="setup adversarial" bash e2e/run-local.sh`.
9. **The hostile-host harness (`bash e2e/hostile/run-hostile.sh`, Phase 7.2 tranche 2).** The operator controls everything around the enclave, so the host's real handlers and schedulers run in the test process with services a test can make hostile, in front of the real `notary-runtime` broker (behind the fake enclave service) and the simulated chain. Nothing in the host or the enclave is changed: only what a hostile operator could change is. Tests: the enclave refuses a program that is not the policy's when the host skips its own check (`ADM_HASH_MISMATCH`); an input the enclave acknowledged but the host leaves out of the close is reported as `dropped_after_acceptance` and the contributor's `checkInclusion` says `NOT_COUNTED`; a host that feeds the enclave a forked chain (same numbers and timestamps, different blocks) gets a notarization that algorithm N refuses (`NOT_CHAIN_MISMATCH`), and honest wallets' inputs are rejected (`INPUT_CHAIN_REF_UNKNOWN`); an enclave in debug mode, and one whose PCR0 is not on the list, get no notary card at genesis (`ATT_DEBUG_MODE`, `ATT_RUNTIME_NOT_ACCEPTED`); and a deliberately leaky program (`notary/templates/leaky-test`, test only) is stopped by the runtime's output checks: an exact value is released only rounded to the schema's `round_to`, and an extra field gets nothing released (`OUTPUT_SCHEMA_VIOLATION`, the job aborts). It needs `cargo build -p notary-runtime -p notary-sim`; the default `vitest run` in `e2e/` excludes it.
   - The wallet reads the source policy's `derivable` flags (`nonDerivableFields`), and the enclave refuses a job that projects `home_address` (`JOB_FIELD_NOT_DERIVABLE`).
   - Each holder runs `requestDerivedCard` and countersigns the offer. Chain time and the enclave's attested clock are then moved to a minute past the offers' release boundary (`POST /warp` on the sim chain and `FAKE_ENCLAVE_OFFSET_FILE` for the fake enclave: the batch interval is at least an hour).
   - The enclave releases the batch and the host registers the cards through the sim chain's write gate. A verifier then checks each card: `CardVerifier` Stages 3, 4 and 6, and Stage 5 step 3a through the injected hook (genesis attestation, shape, algorithm E over the identity log anchored at genesis, `source_kind`).
   - The template is `sealed_link` with short timing (a one-hour minimum delay and hourly windows). A source update signed by a press the source policy does not approve revokes nothing. Two certified revocations are propagated after the delay as one `BatchUpdateCardHeads`, with the mapped codes 820 and 920. A verifier sees ordinary revocations, and the batch names no source card.
   - The anonymity set is 3 here (the template's default is 10).

The parties:

| Party | What runs | Simulated? |
|---|---|---|
| Enclave | `notary-runtime --mode broker`, attesting through the fake enclave service (`notary/sim`, binary `fake-enclave`) under the deterministic test root | Only the attestation service |
| Host | `notary/host`, with `CHAIN_PROVIDER=sim` and `IPFS_PROVIDER=sim` | No |
| Chain, IPFS, EAS | `src/sim-chain.ts` | Yes: the Phase 7 clients replace it |
| Every other party | `src/driver.ts`, using the wallet SDK and the verifier: operator, policy holder, requester, wallets, verifier | No: real SDK code |

Run it either way:

```bash
bash e2e/run-local.sh      # as processes (PHASES="setup vote" runs only those; HOLD=300 keeps the stack up on exit): node >= 22, `pnpm -C host build`, `cargo build -p notary-runtime -p notary-sim`
```

```bash
bash e2e/run-compose.sh    # in docker-compose (deploy/docker-compose.sim.yml)
```

**The read adapters in `src/reads.ts`** (what a wallet and a verifier read, over the simulated chain) use the verifier's own checks, not shortcuts: W5 `satisfies` and `chainValid` run Stages 3 and 4 over the card's chain (`cardSatisfies`, `cardChainValid` in `@membership-card-protocol/verifier/notary`), and algorithm E's genesis PCR0 is read from the genesis attestation by the platform module. None of this file is imported by product code.

The driver submits with `submitNotaryInputWithRetry`, which retries `INPUT_CHAIN_REF_UNKNOWN`: the enclave does not wait for a header it has not been sent (lifecycle B3, amended 2026-11-13).

The host is not restarted: it serves the card it creates through `/genesis` (`notary_host.md` §4).

**Test values only.** Every key in `sim.env`, every key in `world.ts` and the test root in `fixtures/pins.json` are public test values.

To regenerate the fixtures:

- `fixtures/pins.json`: `node --experimental-strip-types src/world.ts --pins fixtures/pins.json --root "$(../target/debug/fake-enclave --print-root)"`

**Three hosts (`bash e2e/run-three.sh`, about seven minutes; never run two at once, the containers share names).** Three operators' hosts, host C with two enclaves, running a vote (`THREE_JOB=aggregate` runs the aggregate job): formation by handoff, three ballots acknowledged by a quorum, the enclave holding the job stopped, `replica_lost` and re-replication to C's standby, a fourth ballot, and a notarization with all four ballots and the right tally (yes 2, no 1, abstain 1).

**Time of day.** The phases move the clock forward (about 6.5 hours in a full `run-local.sh`), and derived cards are issued per UTC day, so a run whose moved clock crosses UTC midnight during the `derive` or `expiry` phase fails there ("timed out waiting for holder N's card in the registry"). Seen starting at about 17:30 UTC (the moved clock reached midnight at `expiry`) and at 23:50 UTC. Start a full run outside roughly 16:30 to 18:30 UTC and 23:00 to 24:00 UTC, or run the phases separately. Cause not isolated: it is a test-harness clock effect, but a nightly CI run scheduled in those windows would hit it.
