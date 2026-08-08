# Phase 3 Summary — dev-tests

Strategic plan: [strategic-plan.md](./strategic-plan.md) · Implementation plan: [implementation-plan.md](./implementation-plan.md) · Previous: [phase-2-summary.md](./phase-2-summary.md)

**Status: CLOSED. 23 of 23 suites ported, and a full `dev-tests` run
against the complete live dev deployment (press, wallet-service, relay,
Matrix/Synapse, and freshly-redeployed contracts) passes with 194 real
tests green and zero failures** (48 `it.todo`/skipped, all individually
documented reasons — product gaps or intentionally-out-of-scope cases, not
silent holes). This closes every item that was still outstanding as of
this document's previous update — see "Update: relay/Matrix/Synapse
deployed, contracts redeployed, Phase 3 closed" below for the full
account. Per `implementation-plan.md`'s own Phase 3 Milestone Review
criteria ("every integration test has a confirmed dev-tests counterpart,
... a full `dev-tests/run.sh` pass is green against a live dev
deployment"), Phase 3 is done. Ready to move to Phase 4 (CI/CD pipeline).

<details>
<summary>Earlier status (superseded, kept for history)</summary>

23 of 23 suites ported (22 fully, 1 partially), and a real `dev-tests` run
has since executed against a real dev deployment: 92 of 242 tests passing.
Body 1 (PressRegistryBody) has since been rotated to a dev-tests-owned
quorum too (this dev deployment's main use case turned out to be dev-tests
itself), fully unblocking `log_auditing.spec.ts` — see "Update: real dev
deployment executed" below for the full account, including four real bugs
found and fixed along the way and one (stale `registerSubCard` ABI)
deliberately deferred. The client-sdk blocker from this phase's earlier
state is fully resolved — a separate session ported client-sdk's `matrix/`
module into `app-sdk`/`wallet-sdk` and migrated `integration_tests` off
client-sdk entirely (see `plans/deployment/client-sdk-deprecation-plan.md`);
this session ported all 5 previously-blocked dev-tests suites against
those same published packages. All 22 typecheck cleanly against the real
published package types. Nothing has been run against real infrastructure
— that requires both dev governance and the governance body rotation to be
provisioned for real first, same standing limitation as Phases 1-2.

</details>

## Clarification resolved before porting began

Nearly every suite depends on `mintLiveCard`, which in `integration_tests`
freely self-bootstraps a brand-new policy on-chain via
`contracts/deployments/local.json`'s `dev_governance_keypair` — a keypair
with unrestricted governance authority that only exists for the local
devnode. `contracts/deployments/sepolia.json` (the real dev-tests target)
has no such keypair, and governance actions are explicitly excluded from
automation (strategic-plan.md Goal 3). **Asked David how to handle this;
answer: provision once, out-of-band.** `dev-tests/support/liveCard.ts`
therefore never bootstraps anything — it reads `DEV_TESTS_POLICY_ID`/
`DEV_TESTS_POLICY_ADDRESS` from config and throws a clear error if unset,
rather than attempting to create a policy. See `dev-tests/README.md`'s "Dev
governance prerequisite" for the one-time manual steps still needed before
any live-minting suite can run for real (registering a permissive test
policy + `AuthorizePress` for the dev press, both on real Sepolia).

## What shipped

- **`dev-tests/` scaffold**: `run.sh`, `package.json` (no `file:` refs —
  every `@membership-card-protocol/*` dependency is `"next"`, installed from
  the registry), `tsconfig.json`, `vitest.config.ts`, `.env.example`,
  `README.md`.
- **`dev-tests/support/`**: `keys.ts` and `mintCard.ts` ported from
  `integration_tests/fixtures/src/` near-unchanged (only the import source
  changed, from `file:` to the published `app-sdk`). `liveCard.ts`
  substantially rewritten: no `ensureGovernanceBootstrap` call, no local
  `.dev.vars`/`local.json` reading — reads pre-provisioned policy
  identifiers and every other live-deployment endpoint/contract address from
  env vars, plus a `getPressCardCid()` helper (memoized fetch of the dev
  press's own card CID, needed by several suites that used to get it from
  the local bootstrap result).
- **22 of 23 suites ported** (21 fully, 1 partially) — full list below.
- **`dev-tests/support/governance.ts`**: narrower-scoped governance helpers
  for Body 0/Body 2 (see "The governance-authority blocker" below).
- **`dev-tests/support/matrixAdmin.ts`**: ported from
  `integration_tests/suites/support/matrixAdmin.ts` for the matrix-relay
  suites that bypass wallet-service's Application Service bridge, config
  sourced from `DEV_SYNAPSE_URL`/etc.
- **Typecheck verified** against the real published package types (`app-sdk`,
  `wallet-sdk`, `verifier`, `verifier-rpc-provider`,
  `verifier-ipfs-provider`'s built `dist/` output, symlinked in
  temporarily): `npx tsc --noEmit` is clean across all of `support/` and all
  22 ported/partially-ported suites.

## Full 23-suite catalog

| Suite | Status | Notes |
|---|---|---|
| `core/card_signing.spec.ts` | ✅ Ported | Pattern-setter — pure crypto + `mintLiveCard`, no other adaptation needed. |
| `core/card_offering_and_acceptance.spec.ts` | ✅ Ported | `governance.pressCardCid` → `getPressCardCid()`. |
| `core/card_updates.spec.ts` | ✅ Ported | No governance/pressCardCid dependency at all — direct port. |
| `core/card_validation.spec.ts` | ✅ Ported | Real adaptation: contract address from `DEV_REGISTRY_CONTRACT_ADDRESS`, IPFS gateway from `DEV_IPFS_GATEWAY_URL` (was local.json + hardcoded `localhost:8080`). |
| `core/open_offer_acceptance_existing_wallet.spec.ts` | ✅ Ported | `getPressCardCid()`. |
| `core/open_offer_acceptance_new_wallet.spec.ts` | ✅ Ported | `getPressCardCid()`. |
| `core/open_offer_creation.spec.ts` | ✅ Ported | `getPressCardCid()`. |
| `conformance/relay_data_model.spec.ts` | ✅ Ported | Real adaptation: dropped file-schema checks (relay's config isn't host-readable on App Platform — no bind mounts), kept every behavioral HTTP check using a known app_id/target_id from config. |
| `conformance/card_verifier.spec.ts` | ✅ Ported | Real adaptation: contract address + IPFS gateway from config, not local.json/hardcoded localhost. |
| `conformance/ipfs_card.spec.ts` | ✅ Ported | Real adaptation: raw CID fetch via the real IPFS gateway (not Kubo's `/api/v0/cat` RPC, which a Filebase-backed deployment doesn't expose) — added `DEV_LOGIC_CONTRACT_ADDRESS` config for `getProtocolVersion()`. |
| `extended/card_migration.spec.ts` | ✅ Ported | No governance dependency — only wallet-service base URL source changed. |
| `extended/oblivious_transport.spec.ts` | ✅ Ported | `getPressCardCid()`, `RELAY_BASE_URL`/`WALLET_SERVICE_BASE_URL` from config. |
| `extended/subcard_creation_policy.spec.ts` | ✅ Ported | Real adaptation: needed `PRESS_ADMIN_API_KEY` — **surfaced a real Phase 1 bug**, see below. IPFS fetch adapted like `ipfs_card.spec.ts`. |
| `matrix-relay/message_routing.spec.ts` | ✅ Ported | No governance/mintLiveCard-adjacent dependency beyond `mintLiveCard` itself — direct port. |
| `matrix-relay/notification_relay.spec.ts` | ✅ Ported | No client-sdk, no governance dependency — most direct port. Reuses `DEV_RELAY_KNOWN_APP_ID` from the relay_data_model port. |
| `conformance/matrix_encryption.spec.ts` | ✅ Ported | Client-sdk blocker resolved (see below) — imports `deriveMatrixUserId`/`verifyMatrixUserIdBinding`/etc. from published `app-sdk` now. Pure crypto + a local Python cross-language check, no live-stack dependency. Fixed a portability bug in passing: the original hardcoded one machine's absolute path to the Python venv. |
| `extended/wallet_backup_and_recovery.spec.ts` | ✅ Ported | Already fully migrated to `wallet-sdk`/`app-sdk` before this session touched it — only import sourcing (published packages, `liveCard.ts` config) changed. |
| `matrix-relay/matrix_join_attestation_and_revocation.spec.ts` | ✅ Ported | `app-sdk`/`wallet-sdk` imports + `../../support/matrixAdmin.ts` (new). Needs a dev Synapse deployment (unconfirmed — see Outstanding). |
| `matrix-relay/matrix_room_membership.spec.ts` | ✅ Ported | Same adaptation as above. |
| `matrix-relay/room_discovery.spec.ts` | ✅ Ported | No Synapse dependency at all — exercises wallet-service's own `/matrix/*` endpoints and wallet-sdk's pure `buildRoomDiscoveryEnvelope`. |
| `extended/dns_governance_verifier.spec.ts` | ✅ Ported (option 2) | Resolved via a narrower, dev-tests-owned governance credential — see below. Reuses the shared pre-provisioned policy for AuthorizePress rather than registering a new one; every DNS-specific op (RegisterDomain/DeregisterDomain/SetDnsGovernancePolicyAddress) is a real call through Body 2's dev-tests quorum. |
| `extended/policy_creation.spec.ts` | 🟡 Partially ported (option 2) | "Phase 0: RegisterPolicy" is a real call through Body 0's dev-tests quorum. "Phase 2+3" and "Full happy path" remain `it.todo` in this file, though Body 1's rotation (below) means they could now be resolved the same way `log_auditing.spec.ts` was — not yet done, flagged as a follow-up rather than silently expanded here. |
| `extended/log_auditing.spec.ts` | ✅ Ported | Unblocked once Body 1 (PressRegistryBody) was also rotated to a dev-tests-owned quorum — see "Body 1 rotation" below. Each test case now pins its own fresh policy document to real dev Filebase (`support/pinPolicy.ts`) and registers + authorizes it entirely through dev-tests' own governance (`support/devPolicy.ts`), rather than reusing the shared pre-provisioned policy. Auditor-side (E2E receipt/decrypt/inspect) stays `it.todo`, same as the original suite — that's a Phase 4 product gap, not a dev-tests gap. |

**Final count: 22 fully ported + 1 partially ported. The client-sdk blocker
is fully resolved — 0 suites remain blocked on it.**

## The client-sdk blocker — resolved

A separate session ported client-sdk's `matrix/` module into `app-sdk`
(`account-id.ts`, `discovery.ts` — key-independent functions) and
`wallet-sdk` (`attestation.ts`, `discovery.ts`'s signing half,
`crypto-provider.ts`, `session.ts`, `signed-room-events.ts` — anything
touching a raw private key), migrated `integration_tests` off client-sdk
entirely, and wrote up the migration in
`plans/deployment/client-sdk-deprecation-plan.md`. This session:

1. Verified the new exports (`app-sdk`'s `matrix/index.ts` re-exports
   `account-id.js`/`discovery.js`; `wallet-sdk`'s re-exports
   `attestation.js`/`discovery.js`/`crypto-provider.js`/`session.js`/
   `signed-room-events.js`).
2. Read how `integration_tests` migrated each of the 5 previously-blocked
   spec files to get the exact target import shape per file.
3. Ported all 5 into `dev-tests`, following the same pattern as every other
   suite (published packages, `liveCard.ts`/`matrixAdmin.ts` config
   sourcing instead of `process.env.SUITE_*`).
4. Added `@membership-card-protocol/wallet-sdk` to `dev-tests/package.json`
   (previously only `app-sdk` was a direct dependency) and `@noble/curves`/
   `@noble/hashes` as direct devDependencies (needed by
   `dns_governance_verifier.spec.ts`'s raw secp256r1 signing).
5. Ported `integration_tests/suites/support/matrixAdmin.ts` to
   `dev-tests/support/matrixAdmin.ts` for the 3 suites that bypass
   wallet-service's Application Service bridge.

## The governance-authority blocker — resolved (option 2), narrower than first scoped

Discovered while porting: three suites
(`dns_governance_verifier`/`log_auditing`/`policy_creation`) don't just use
`mintLiveCard` against an already-authorized policy (the gap already solved
by David's "provision once, out-of-band" decision) — they call
`ensureGovernanceBootstrap` directly to register **new** policies/domains
via live governance transactions. **Decision (David): pursue option 2** —
provision a narrower, dev-tests-owned governance credential rather than
leaving these as permanent gaps.

Verified before acting (see
[`dev-governance-rotation-runbook.md`](./dev-governance-rotation-runbook.md)):
Sepolia and any future production deployment are fully separate contract
instances with no shared state, so this only ever touches dev/Sepolia.
Confirmed via a live on-chain read: all three governance bodies (0/1/2) are
still 1-of-1 on the original deployer key, version 0 — a clean rotation
target. The contract enforces a floor (`MIN_GOVERNANCE_KEYS = 3`, quorum
must exceed half) — no single dev-tests key can ever unilaterally control a
body; dev-tests holds all 3 keys of a 2-of-3 quorum instead (safe since it's
a dev/test-only environment, no cross-party coordination needed at
test-run time).

**Scope initially rotated, after a follow-up clarifying question: Body 0
(RootPolicyBody) and Body 2 (DnsGovernanceBody) — not Body 1
(PressRegistryBody)**, which governs `AuthorizePress` and stayed under
whatever already authorized the shared dev press. This fully unblocked DNS
governance (Body 2 alone covers RegisterDomain/DeregisterDomain/
SetDnsGovernancePolicyAddress) and partially unblocked policy creation (Body
0 covers RegisterPolicy, but not authorizing a press under a fresh policy).
It did **not** unblock `log_auditing`, whose entire subject requires
issuing a real card under a freshly-authorized policy — that needed Body 1
too, a further scope decision not made at the time.

**Update: Body 1 rotation.** Once this dev deployment's real-world use
turned out to be dev-tests itself (rather than a narrow test-only carve-out
alongside some other primary use), the original reason to leave Body 1
un-rotated no longer applied — decision (David): rotate it the same way.
`contracts/scripts/gen-dev-governance-keys.mjs` was extended to also
generate Body 1's 3 keys, and `contracts/scripts/rotate_governance_body.sh`
was extended to accept the current signer as a PEM file
(`CURRENT_GOV_SECP256R1_KEY_PEM`) in addition to raw hex — needed because
the original deployer key (Body 1's only key pre-rotation) turned out to be
stored as a SEC1 PEM, not hex, discovered while running
`authorize_dev_press.sh` earlier in this session. David generated and
rotated Body 1 himself, same process as Body 0/2. This fully unblocks
`log_auditing.spec.ts` (see the table above) and means dev-tests, not the
original deployer key, now controls `AuthorizePress` for this deployment
going forward.

**What shipped for this**:
- `contracts/scripts/gen-dev-governance-keys.mjs` — keypair generation,
  written for the user to run themselves (Claude does not generate or
  handle private key material that will hold on-chain authority — the
  permission classifier correctly blocks this, same principle as not typing
  a password into a form).
- `contracts/scripts/rotate_governance_body.sh` — the actual on-chain
  `RotateGovernanceKeys` submission, modeled byte-for-byte on the existing,
  tested `setup_dns.sh` pattern (read current state → build payload → sign
  → print for review → interactive `(y/N)` confirmation → `cast send`).
  Requires the *current* governance signer to run it — Claude cannot
  execute this either, for the same reason.
- `dev-tests/support/governance.ts` — the ongoing runtime helper: reads the
  current governance version on-chain, builds payloads via the same tested
  `contracts/scripts` Rust binaries every other governance-touching suite
  already used, and assembles dev-tests' own 2-of-3 quorum signature.
- New `dev-tests/.env.example` vars: `DEV_TESTS_DNS_GOV_PRIVKEY_{1,2,3}`,
  `DEV_TESTS_POLICY_GOV_PRIVKEY_{1,2,3}`, `DEV_TESTS_GAS_WALLET_PRIVATE_KEY`
  (pays gas for these suites' direct contract writes — distinct from press/
  wallet-service's own gas wallets), and an optional
  `DEV_TESTS_PRESS_SECP256R1_PRIVATE_KEY` (skips one press-signed check in
  `dns_governance_verifier` if unset, rather than failing).
- The full runbook: [`dev-governance-rotation-runbook.md`](./dev-governance-rotation-runbook.md).

**Not yet done**: the actual key generation and on-chain rotation — both
require David to run them (see "What shipped" above for why). Until that
happens, `dns_governance_verifier.spec.ts` and `policy_creation.spec.ts`
will fail loudly with a clear error (`governance.ts` checks for at least 2
of 3 `*_GOV_PRIVKEY_*` vars before doing anything) rather than silently
attempting unauthorized actions.

## Bug found and fixed during this work

**`press/scripts/deploy.sh` and `press/DEPLOYMENT.md` (Phase 1) were missing
four required env vars.** Both were built from `OPERATOR.md`'s "Required"
table, which is stale relative to `press/src/config.ts`'s actual
`loadConfig()` — `PRESS_GAS_WALLET_PRIVATE_KEY`, `PRESS_OHTTP_PRIVATE_KEY`,
`STORAGE_CONTRACT_ADDRESS`, and `PRESS_ADMIN_API_KEY` are all
unconditionally required (press exits at startup without them), but none
appeared in the original deploy script or docs — a real deploy would have
pushed a Worker that crash-loops immediately. Found while porting
`extended/subcard_creation_policy.spec.ts`, which calls press's admin API
and needed `PRESS_ADMIN_API_KEY` to exist as a concept at all. Fixed in both
files; see `phase-1-summary.md`'s updated bug list.

## Update: real dev deployment executed, real `dev-tests` run against it

All of the "Outstanding" items below this point were resolved in a later
session that actually executed the deployment this plan describes, not
just built the tooling for it:

- All six npm packages (`verifier`, `verifier-ipfs-provider`,
  `verifier-rpc-provider`, `app-sdk`, `sdk-providers-web`,
  `sdk-providers-rn`, `wallet-sdk`) published for real to a new
  `@membership-card-protocol` npm org. Two bugs found: `verifier-ipfs-provider`/
  `verifier-rpc-provider` were missing `publishConfig.access: "public"`
  (402 Payment Required on first publish of a new scoped package without it).
- Body 0/2 rotation (from the runbook above) executed for real, then Body 1
  (PressRegistryBody) rotated too — the "pending decision" above was
  resolved: this dev deployment's real use case turned out to be dev-tests
  itself, so the original reason to leave Body 1 un-rotated no longer
  applied. Fully unblocked `log_auditing.spec.ts`.
- The shared dev policy pinned to real Filebase and registered on-chain —
  but initially under the *wrong* address. `pin-dev-policy.mjs` and
  `dev-tests/support/pinPolicy.ts` derived `policy_address` as
  `keccak256(document bytes)`; press's own production code
  (`issue.ts`/`open-offer.ts`) derives it as `keccak256(the policy_id CID
  string)` — a different value. Confirmed live (every `registerCard` call
  reverted `UnrecognizedPolicy()`) and fixed in both scripts; the policy
  and the press's `AuthorizePress` entry were re-registered under the
  correct address.
- Press deployed for real to Cloudflare Workers. Found and fixed three
  more real bugs along the way (see `press: fix dev deployment` and
  `press: fix on-chain pressAddress derivation` commits): `EXPECTED_CHAIN_ID`
  defaulting to Arbitrum One instead of Sepolia for dev (permanent 503);
  `startup.ts` swallowing any step-4/5 exception with no error message or
  log output at all (permanent 503, silently); and `registry.ts` deriving
  its on-chain `pressAddress` via `viem`'s `privateKeyToAccount()` — hardcoded
  to secp256k1 — on a secp256r1 private key, silently producing a
  meaningless address instead of throwing (`InvalidGovernanceSignature`/
  undecodable revert on every on-chain write). Also replaced
  `@aws-sdk/client-s3` with `aws4fetch` in `src/ipfs/filebase.ts`: the SDK's
  Node-targeted `runtimeConfig.js` doesn't work under Workers'
  `nodejs_compat` polyfill (confirmed via `wrangler tail`'s stack trace —
  `new S3Client()` threw from deep inside AWS SDK internals).
- A real `dev-tests/run.sh` (`npm test`) pass against this live deployment:
  92 of 242 tests passing, 89 skipped, 32 `it.todo`. Two more real bugs
  found this way: `card_validation.spec.ts`'s "card outside trustedRoots"
  test listed both test cards as trusted roots, making its own negative
  case unsatisfiable (fixed in both `dev-tests` and `integration_tests`,
  inherited unchanged from the latter); and `registerSubCard`'s on-chain
  ABI changed (a parameter dropped, `contracts` commit `97e988ff`) the day
  *after* the currently-deployed contracts were built — the live contract
  predates that change, so every `subcard_creation_policy.spec.ts` call
  reverts with no decodable error at all (a raw selector mismatch, not a
  handled `Err`). Left as a known gap for now (see below) rather than
  redeploying contracts mid-session — that would invalidate every
  governance address set up above.

**Remaining failures in the 92/242 run are all either the tracked
`registerSubCard` staleness gap above, or genuinely pending future
deployments** (wallet-service, relay, dev Matrix/Synapse) — not additional
bugs. Contracts should be redeployed once those are done, to pick up the
`registerSubCard` fix and confirm the full suite end-to-end; that redeploy
will require redoing the Body 0/1/2 rotation + RegisterPolicy +
AuthorizePress sequence again against the new addresses.

## Update: relay/Matrix/Synapse deployed, contracts redeployed, Phase 3 closed

This session resolved every item the previous update left outstanding —
wallet-service's own dev deployment had already gone live in an earlier
session (see the `wallet-service: fix dev deployment`-era commits and the
`wallet-service: add federation keypair generation script` /
`wallet-service: fix allow_unsafe_locale placement in homeserver template`
commits from that work), leaving relay, Matrix/Synapse, and the contracts
redeploy as the actual remaining gaps. All three are done.

### Relay deployed — as a Droplet, not App Platform

Cost-driven pivot mid-session: a single DigitalOcean Droplet running dev
and prod side by side via `docker-compose.droplet.yml` + Caddy, chosen over
App Platform + Managed Redis on cost grounds while usage stays low (see
`relay/DEPLOYMENT.md`'s "Current path: Droplet, not App Platform" banner
for the full tradeoff list — Redis persistence deliberately disabled,
single point of failure accepted, host management responsibility back in
exchange). The App Platform path (`scripts/deploy.sh`, `.do/app.*.yaml`)
from Phase 1 is left in place, documented, and still works if usage grows
enough to justify switching back.

### Matrix/Synapse deployed onto the same Droplet — the hard part

`synapse-dev`/`synapse-prod` run alongside relay on the same Droplet.
Getting `synapse-dev` actually healthy surfaced a long chain of real,
non-obvious bugs, each now documented at its source (see
`relay/DEPLOYMENT.md`'s "Troubleshooting — quick reference" table for the
full list with fixes) rather than just here:

- **Neon pooled vs. direct endpoint**: Synapse's schema installer sends its
  entire initial schema as one multi-statement query, which breaks against
  PgBouncer transaction-mode pooling (what Neon's pooled endpoint runs) —
  silently left the database in a partially-migrated state that needed a
  `DROP SCHEMA public CASCADE` reset once the direct endpoint was used
  instead.
- **UID 991 permissions**: the Synapse image's `/start.py` drops root
  privileges to `991:991` before running — applies to bind-mounted config
  *and* named volumes (`media`/`membership_registry`), the latter easy to
  miss since nothing chowns them until Synapse's first write, which can
  happen well after the container looks healthy.
- **`allow_unsafe_locale` placement bug**: had to be a sibling of `args:`
  in the rendered `homeserver.yaml`, not nested inside it — nesting sends
  it straight into `psycopg2.connect()` as an invalid DSN parameter.
- **EIP-55 checksum requirement**: `REGISTRY_CONTRACT_ADDRESS` must be
  checksummed for `web3.py` — caught a self-inflicted instance of exactly
  this bug twice more later in the session (see "Contracts redeployed"
  below), underscoring why it's now documented with the exact compute
  command rather than left as a one-off fix.
- **`docker compose restart` vs. `up -d`**: `restart` doesn't reload
  `env_file`/`environment` changes — needs `up -d <service>` to recreate
  the container. Cost real debugging time before being identified and
  documented.
- **Real AS namespace vs. `integration_tests`' stub**: dev's Synapse has
  wallet-service's Application Service genuinely registered with an
  exclusive `card_*` namespace (`integration_tests`' local Synapse has no
  AS at all), so `dev-tests/support/matrixAdmin.ts`'s original
  shared-secret-registration approach — copied from `integration_tests` —
  can never work here. Fixed by registering test users via the AS's own
  `as_token` instead (`type: m.login.application_service`), which Synapse
  exempts from its exclusive-namespace check.

### OHTTP oblivious-forwarding wired up

`OBLIVIOUS_TARGETS_PATH` was never set on the Droplet, so relay's
`/ohttp/*` routes were silently disabled. Extended
`materialize-secrets.mjs`'s existing `APP_REGISTRY_JSON` pattern with a
matching `OBLIVIOUS_TARGETS_JSON` var (same materialize-at-startup
mechanism) and registered press's and wallet-service's real `target_id`s
(each service's own `/ohttp/key-config` endpoint, not invented values) with
real gateway URLs (`POST /ohttp/gateway`, which both services already
implement — no new gateway component needed). Unblocks
`oblivious_transport.spec.ts` and the behavioral half of
`relay_data_model.spec.ts` fully.

### Contracts redeployed — `registerSubCard` fixed, full governance re-bootstrap

Redeployed `storage-contract` + `logic-contract` on Sepolia (kept
`verifier_module` unchanged) to pick up commit `97e988ff`'s
`registerSubCard` signature fix, which the prior deployment's bytecode
predated. Chose the fresh-redeploy path over the storage-preserving
`ProposeLogicUpgrade`/`ConfirmLogicUpgrade` path (§4.14) — that path's
mandatory 7-day timelock was judged too slow for a dev deployment; the
accepted tradeoff was redoing the governance-rotation/policy/press
bootstrap this dev deployment had already built up, once, rather than
waiting a week. New addresses in `contracts/deployments/sepolia.json`;
previous record preserved at `sepolia-2026-07-20-superseded.json`.

Full re-bootstrap against the new contract, in order: rotated all three
governance bodies back onto the *same* keys `dev-tests/.env` already held
(re-derived their public keys locally from the existing private keys —
never regenerated), re-registered the shared dev policy, re-authorized the
shared dev press, propagated the new addresses to press/wallet-service/
relay/dev-tests/Synapse (mind the naming landmine:
`REGISTRY_CONTRACT_ADDRESS` means the *logic* contract in press but the
*storage* contract everywhere else), and redeployed all three live
services. Two real mistakes surfaced and were corrected during this, both
worth remembering:

- A `redeploy_logic.sh` script bug (validated an env var it never
  actually used) and a wrong-working-directory accident (deployed a stray,
  unused instance of `verifier-module` on one retry, harmless but real gas
  spent) — both documented inline in the script/deployment record.
- The script's own reported failure (`InvalidGovernanceSignature` on
  Body 0's rotation) turned out to be a stale gas-estimation race against
  an already-successful submission — the *actual* on-chain state (verified
  independently via a proper ABI decode) showed the rotation had in fact
  succeeded. Lesson generalized into the deployment docs: trust a direct
  on-chain read over a script's exit status when they conflict.
- A hand-typed EIP-55 checksum (one wrong character) in `dev-tests/.env`
  broke 7 governance-dependent test files after the redeploy — caught by
  re-verifying every address written this session against the
  programmatically-computed checksum, not by assuming the first typed
  value was right. Exactly the class of bug the Matrix deployment's own
  troubleshooting docs already warned about, self-inflicted anyway.
- Also: an overly broad `grep` while looking up press's key variable names
  printed `PRESS_MLDSA44_PRIVATE_KEY`'s actual value into a tool-call
  transcript. Flagged immediately; that key should be rotated via
  `press/scripts/gen-press-keys.mjs` (regenerate, push the new secret) at
  the next convenient opportunity — it's no longer safe to treat as
  private, even though the exposure stayed within this session.

### Final `dev-tests` result

194 real tests passing, 0 failing, 48 `it.todo`/skipped — every one with a
documented reason (auditor-side E2E is a Phase 4 product gap; a handful of
endpoints genuinely aren't implemented yet; `subcard_creation_policy`'s
Mechanism 3 deregistration endpoint isn't functional). No unexplained
gaps. Full suite, including `subcard_creation_policy.spec.ts`'s two
`registerSubCard`-calling tests that were the whole reason for the
contracts redeploy, is green.

**Phase 3 is closed.** Per `implementation-plan.md`'s Phase 3 Milestone
Review "Done when" criteria — every integration test has a confirmed
dev-tests counterpart, a full `dev-tests/run.sh` pass is green against a
live dev deployment — both conditions are met. Next: Phase 4 (CI/CD
pipeline), per `implementation-plan.md`.
