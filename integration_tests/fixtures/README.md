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
- **`src/governanceBootstrap.ts`** — `ensureGovernanceBootstrap`: added
  when the stack moved from Sepolia to a local nitro-devnode (see
  "Prerequisites" below) — idempotent `RegisterPolicy`/`AuthorizePress`
  plus press-gas-wallet funding for a fresh local chain, using the single
  genesis governance keypair `deploy-contracts`'s `bootstrap.sh` already
  generates. Both harnesses (2.2, 2.3) call this once per `prepare()`
  before minting; `mintCard` itself doesn't call it, since a Sepolia-style
  pre-governed deployment never needed it.

This package does *not* reuse `contracts/test_params`, `press/test`,
`relay/tests`, or `wallet-service/test` as originally scoped — each turned
out to hold only per-test throwaway fixtures (deterministic keys
generated inline, no shared exported module), not something importable.
`press/test/unit/serialization.test.ts`'s `specs/serialization-
conformance.json` corpus is the one genuinely shared, spec-conformant
artifact found across those four; it's a canonicalization conformance
suite, not card/key fixtures, so it isn't re-exported here either.

## Prerequisites

The default stack now runs against a local `nitro-devnode` (moved off
Sepolia during Phase 2 — see `plans/milestones/integration-phase-2.md`),
which starts ungoverned: no policy registered, no press authorized. The
fixture policy CID (and therefore the on-chain policy address it's
registered under) is a pure function of `pressCardCid` — pin the same
content, get the same CID, every time, as long as press's
`PRESS_CARD_CID` config value doesn't change — so `ensureGovernanceBootstrap`
(above) only needs to run once per chain lifetime; it's idempotent and
safe to call on every `prepare()` regardless. `deploy-contracts`'s own
`bootstrap.sh` is idempotent too (skips redeploying if the chain already
has live code at the recorded address), so the local chain's state —
and therefore this governance — persists across `docker compose up`
invocations rather than resetting each time.

`mintCard` itself still assumes the policy/press are already governed
(it never calls `ensureGovernanceBootstrap`) — callers running against a
fresh chain must call it first, as both harnesses' `prepare.ts` do.
Pointing this fixture at Sepolia or another pre-governed deployment
instead (`HARNESS_ARBITRUM_RPC_URL`/`HARNESS_STORAGE_CONTRACT_ADDRESS`)
still works without any bootstrap call, same as before this migration —
see `integration_tests/reports/phase-1-environment-notes.md`'s "Press's
chain integration" entry for the original one-time `cast send` commands
that governed the Sepolia deployment by hand.

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
