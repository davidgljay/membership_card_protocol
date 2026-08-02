# Phase 3 Summary — dev-tests

Strategic plan: [strategic-plan.md](./strategic-plan.md) · Implementation plan: [implementation-plan.md](./implementation-plan.md) · Previous: [phase-2-summary.md](./phase-2-summary.md)

**Status: 23 of 23 suites ported (22 fully, 1 partially).** Body 1
(PressRegistryBody) has since been rotated to a dev-tests-owned quorum too
(this dev deployment's main use case turned out to be dev-tests itself),
fully unblocking `log_auditing.spec.ts` — see the update below. The
client-sdk blocker from this
phase's earlier state is fully resolved — a separate session ported
client-sdk's `matrix/` module into `app-sdk`/`wallet-sdk` and migrated
`integration_tests` off client-sdk entirely (see
`plans/deployment/client-sdk-deprecation-plan.md`); this session ported all
5 previously-blocked dev-tests suites against those same published
packages. All 22 typecheck cleanly against the real published package
types. Nothing has been run against real infrastructure — that requires
both dev governance and the governance body rotation to be provisioned for
real first, same standing limitation as Phases 1-2.

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

## Outstanding before Phase 3 can close

- David needs to actually run the key-generation and rotation steps in
  `dev-governance-rotation-runbook.md` (Claude cannot, by design — see
  above). Until then, `dns_governance_verifier`/`policy_creation` will fail
  loudly at their env-var check, not silently.
- Whether to also rotate Body 1 (PressRegistryBody) — the one remaining
  decision, needed only to unblock `log_auditing.spec.ts` fully.
- Dev governance (the shared pre-provisioned policy) still needs to be
  provisioned for real (David, out-of-band) before *any* of the 22 ported
  suites can actually run green — this is a separate, earlier prerequisite
  than the governance body rotation above.
- A dev Matrix/Synapse deployment's existence needs confirming and its
  connection details (`DEV_SYNAPSE_URL`, `DEV_MATRIX_SERVER_NAME`,
  `DEV_MATRIX_ENFORCEMENT_USER_ID`, `DEV_MATRIX_REGISTRATION_SHARED_SECRET`)
  filled into `.env` before `matrix_join_attestation_and_revocation.spec.ts`
  or `matrix_room_membership.spec.ts` can run — per
  `wallet-service/DEPLOYMENT.md`'s "Out of scope" section, Synapse deploys
  as its own docker-compose service, separate from wallet-service's Worker
  deploy, with no clear dev-deployment path documented yet.
  `room_discovery.spec.ts` and every other ported suite need no Synapse
  dependency at all.
- A full `dev-tests/run.sh` pass against real dev infrastructure still needs
  to happen at least once — not possible in this session (no real deployed
  dev environment or provisioned/rotated governance exists yet).
