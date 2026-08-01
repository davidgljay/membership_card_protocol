# dev-tests

Integration test suites for the Card Protocol's process specs, run against a
**live deployed dev environment** — real dev `press`/`wallet-service`/
`relay`, real Arbitrum Sepolia, real IPFS — using the **npm-published SDKs**
(installed at the `next` dist-tag), not monorepo source. This is what
proves a real app/wallet developer's actual experience works, not just that
the source tree is internally consistent — see
[`plans/deployment/strategic-plan.md`](../plans/deployment/strategic-plan.md)
Goal 4 for the full rationale.

This is a separate suite from
[`integration_tests/`](../integration_tests/README.md), which runs against a
local, freshly-bootstrapped, fully mocked/self-governed stack (local Docker
Compose, local devnode chain, local IPFS) and is the fast, deterministic gate
for code correctness on every PR. `dev-tests` is slower, requires real
external services, and is the required gate before a prod deploy — not a
replacement for `integration_tests`.

## Prerequisite: dev governance must already be provisioned

Unlike `integration_tests`, which freely self-bootstraps a fresh policy on
every run via `contracts/deployments/local.json`'s `dev_governance_keypair`
(a keypair with unrestricted governance authority that only exists for the
local devnode), **dev-tests never bootstraps chain governance itself.**
`contracts/deployments/sepolia.json` has no equivalent keypair, and per the
strategic plan (Goal 3), contract/governance actions are deliberately
excluded from any automated script.

Before running any suite here, someone with real governance authority must,
**once, out-of-band**:

1. Register a permissive test policy on the dev Sepolia registry contract
   (mirrors `integration_tests/fixtures/src/policy.ts`'s
   `buildPermissiveTestPolicy`, pinned to real IPFS instead of the local
   stack's Kubo).
2. Call `AuthorizePress` to authorize the dev `press` deployment's
   secp256r1 key under that policy.
3. Record the resulting policy CID/address in `.env` as `DEV_TESTS_POLICY_ID`
   / `DEV_TESTS_POLICY_ADDRESS` (see `.env.example`).

Suites here read these from config; none of them call anything resembling
`ensureGovernanceBootstrap`.

## Narrower governance credentials (DNS + policy registration)

A few suites (`extended/dns_governance_verifier.spec.ts`,
`extended/policy_creation.spec.ts`) need live governance-signing authority
beyond "mint against a pre-provisioned policy" — they exercise
`RegisterDomain`/`DeregisterDomain`/`SetDnsGovernancePolicyAddress`
(DnsGovernanceBody) or `RegisterPolicy` (RootPolicyBody) directly. Rather
than share the Sepolia deployment's original bootstrap key, dev-tests holds
its **own**, narrower 2-of-3 quorum for just those two governance bodies —
see
[`plans/deployment/dev-governance-rotation-runbook.md`](../plans/deployment/dev-governance-rotation-runbook.md)
for the one-time setup (key generation + on-chain rotation, both steps you
run yourself, never through an agent session) and
`support/governance.ts` for how suites use it at test time. `extended/
log_auditing.spec.ts` remains blocked — it needs `AuthorizePress`
(PressRegistryBody), which was deliberately not part of this rotation; see
`phase-3-summary.md`.

## Running

```bash
cd dev-tests
cp .env.example .env   # fill in every value -- see .env.example's comments
npm install
npm test                              # every suite
npx vitest run suites/core/card_signing.spec.ts   # one file
```

Or via the repo-wide runner:

```bash
./run.sh                              # every suite
./run.sh --suite core/card_signing    # one suite file
```

`run.sh` does not stand up or tear down any infrastructure — unlike
`integration_tests/run.sh`, there is no local stack to bring up. It assumes
`scripts/deploy-all.sh dev` has already deployed the environment `.env`
points at.

## Layout

Mirrors `integration_tests/suites/`'s layout so porting stays mechanical:

```
dev-tests/
  run.sh
  .env.example
  support/            # mintCard/keys helpers, adapted from integration_tests/fixtures
                       # to use the published app-sdk and a pre-provisioned policy
                       # (no governance bootstrap, no local Kubo pinning);
                       # governance.ts for the narrower Body 0/Body 2 credentials
  suites/
    core/               # ported from integration_tests/suites/core/
    conformance/        # ported from integration_tests/suites/conformance/
    extended/           # ported from integration_tests/suites/extended/
    matrix-relay/       # ported from integration_tests/suites/matrix-relay/
```

## Porting status

See [`plans/deployment/phase-3-summary.md`](../plans/deployment/phase-3-summary.md)
for the current per-suite porting status — which suites are ported, which
are blocked (and why), and which are still pending.

## Verifying which SDK a suite actually uses

Every suite here must resolve `@membership-card-protocol/*` imports from
`node_modules` (installed from the registry), never from a monorepo `file:`
path. Confirm with:

```bash
node -e "const p=require('./package.json'); const bad=Object.entries({...p.dependencies}).filter(([,v])=>v.startsWith('file:')); if (bad.length) { console.error('file: deps found:', bad); process.exit(1); } console.log('clean');"
```
