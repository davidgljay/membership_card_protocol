# notary/e2e: step 5.5 end to end against the simulator

One aggregate job runs through the real code end to end. Only the chain, IPFS and EAS are simulated:

1. **Setup.** The world is registered on the simulated chain: governance list cards (4-of-5 P-256 approvals), the policy, the requester, the operator, and three contributors with `notary_input` sub-cards.
2. **Genesis.** The operator calls `/genesis`. The policy holder runs algorithm G and signs the offer, and the enclave countersigns it. The notary card is then registered, and identity-log `seq` 0 is anchored (E26). Last, the policy holder approves the card.
3. **The job.**
   - The requester calls `POST /jobs`.
   - The wallet fetches the announcement through the OHTTP gateway and runs algorithm W.
   - Three contributors seal their inputs to the job key and submit them. Each checks the host receipt and the sealed validation receipt.
4. **Close.** After `closes_at`, the host sends the stored ciphertexts in `close_chunk`. The enclave runs the tally program and publishes the notarization. Algorithm N then verifies it, and the public output is `{ "no": 1, "yes": 2 }`.

The parties:

| Party | What runs | Simulated? |
|---|---|---|
| Enclave | `notary-runtime --mode broker`, attesting through the fake enclave service (`notary/sim`, binary `fake-enclave`) under the deterministic test root | Only the attestation service |
| Host | `notary/host`, with `CHAIN_PROVIDER=sim` and `IPFS_PROVIDER=sim` | No |
| Chain, IPFS, EAS | `src/sim-chain.ts` | Yes: the Phase 7 clients replace it |
| Every other party | `src/driver.ts`, using the wallet SDK and the verifier: operator, policy holder, requester, wallets, verifier | No: real SDK code |

Run it either way:

```bash
bash e2e/run-local.sh      # as processes: node >= 22, `pnpm -C host build`, `cargo build -p notary-runtime -p notary-sim`
```

```bash
bash e2e/run-compose.sh    # in docker-compose (deploy/docker-compose.sim.yml)
```

**Shortcuts in `src/reads.ts` (Phase 7 adapter work, not product code).** The read adapters stand where the `CardVerifier`-backed adapters will stand, and take three shortcuts. None of them is imported by product code.

- W5 `satisfies` always returns true. The test policy has no requester predicate.
- Algorithm E is given the simulator's known PCR0 as the genesis PCR0, not one parsed from the genesis attestation.
- The notarization reads report `chainValid: true` for the policy and the notary card.

The driver submits with `submitNotaryInputWithRetry`, which retries `INPUT_CHAIN_REF_UNKNOWN`: the enclave does not wait for a header it has not been sent (lifecycle B3, amended 2026-11-13).

The host is not restarted: it serves the card it creates through `/genesis` (`notary_host.md` §4).

**Test values only.** Every key in `sim.env`, every key in `world.ts` and the test root in `fixtures/pins.json` are public test values.

To regenerate the fixtures:

- `fixtures/pins.json`: `node --experimental-strip-types src/world.ts --pins fixtures/pins.json --root "$(../target/debug/fake-enclave --print-root)"`
- `fixtures/tally.wasm`: `UPDATE_E2E_FIXTURE=1 cargo test -p notary-broker --test broker e2e_tally_fixture`
