# integration_tests/fixtures

Shared test key material, a permissive test policy, and a live-stack
card-minting helper for `integration_tests`' suites and harnesses (Phase 2
onward). See `plans/integration-testing-implementation-plan.md`'s Step 2.1.

## What's here

- **`src/keys.ts`** — `deriveSeed`/`deriveKeypair`: deterministic ML-DSA-44
  keypairs from a label (`sha256("card-protocol-integration-fixture:" +
  label)` as the seed), so fixture output is stable across runs against a
  stack started from a clean volume. `InMemorySecureKeyProvider`: a real
  (not mocked-signature) `SecureKeyProvider` implementation backed by
  these keys, for driving `app-sdk`'s offer-assembly functions outside a
  browser/RN keystore.
- **`src/policy.ts`** — `buildPermissiveTestPolicy(pressCardCid)`: a
  minimal policy document with no predicates, so it never triggers
  press's chain-of-trust evaluation (that only runs for targeted issuance
  to an *existing* card — see the function's own doc comment).
- **`src/ipfs.ts`** — `pinJsonToKubo`: pins JSON to the stack's Kubo node
  via the same `/api/v0/add?cid-version=1&pin=true` call press's own
  `kubo` IPFS provider uses.
- **`src/mintCard.ts`** — `mintCard`: mints a full card against a live
  press using `app-sdk`'s real `assembleAndSignTargetedOffer` (not a
  reimplementation) for the issuer side, and spec-conformant direct
  ML-DSA-44 signing for the holder side (see the function's doc comment
  for why it doesn't route through `wallet-sdk`'s full keyring/review
  flow — that's Phase 2's harness scope, 2.2/2.3, not this fixture's).

This package does *not* reuse `contracts/test_params`, `press/test`,
`relay/tests`, or `wallet-service/test` as originally scoped — each turned
out to hold only per-test throwaway fixtures (deterministic keys
generated inline, no shared exported module), not something importable.
`press/test/unit/serialization.test.ts`'s `specs/serialization-
conformance.json` corpus is the one genuinely shared, spec-conformant
artifact found across those four; it's a canonicalization conformance
suite, not card/key fixtures, so it isn't re-exported here either.

## Prerequisites

The fixture policy CID (and therefore the on-chain policy address it's
registered under) is a pure function of `pressCardCid` — pin the same
content, get the same CID, every time, as long as press's
`PRESS_CARD_CID` config value doesn't change. That means minting a card
requires two one-time on-chain governance calls (`registerPolicy`,
`authorizePress`) for this fixture's specific policy address and press's
own on-chain identity — already done for the current
`contracts/deployments/sepolia.json` deployment. If the deployment is ever
redeployed, or `PRESS_CARD_CID`/`PRESS_SECP256R1_PRIVATE_KEY` change, these
need to be redone — see `integration_tests/reports/phase-1-environment-
notes.md`'s "Press's chain integration" entry for the exact `cast send`
commands used and why each parameter is shaped the way it is (especially
`press_address` needing to be a left-padded bytes32, and `press_pubkey`
needing to be *press's own* secp256r1 public key, not the deployer's).

## Running

```sh
cd integration_tests
docker compose up -d --wait ipfs press   # or the full stack
cd fixtures
npm install
npx vitest run                            # exercises mintCard against the live stack
```

`test/mintCard.test.ts` is a live-stack smoke test, not run as part of any
component's own `npm test` — it's what proves 2.1's "Done when: a fixture
helper can produce a signed card accepted by the live press."
