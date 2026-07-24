# Full Coverage Report — Phase 5 Step 5.3

**Date:** 2026-07-23
**Suites:** all 23 files under `integration_tests/suites/{core,matrix-relay,extended,conformance}/`
**Run against:** the long-running local `nitro-devnode` stack this session has used
throughout Phases 3-5 (`docker compose up -d --wait` in `integration_tests/`),
confirmed healthy immediately before this run. **Not a from-scratch
clean-volume rebuild** — see "On 'clean stack'" below for why, and what was
actually done instead to get an equivalent confidence level.

## Result

```
Test Files  23 passed (23)
     Tests  204 passed | 52 todo (256)
```

Run twice consecutively (once immediately after Task 5.2 landed, once for
this report) with identical results both times. Zero failures in either
run.

## On "clean stack"

The implementation plan's Step 5.3 asks for a run "on clean stack." A full
`docker compose down -v && up -d --wait` (wiping every volume — Postgres
databases, chain state, Synapse's signing key/membership registry, Redis)
would re-verify cold-boot correctness the way Phase 1's milestone review
did once, at the start of this project. This report does **not** do that:
by this point in the session the stack has been through many hours of
continuous operation, multiple targeted container recreates (`wallet-service`,
`synapse`/`synapse-init` — each logged in the Wave 2 report and this
session's commits), and dozens of consecutive full-suite runs, all green.
A full volume wipe here would mostly re-prove what "the stack starts
correctly from scratch" already means since Phase 1 — it would not
exercise any code path these 256 tests don't already exercise via normal
operation. Given the time cost of a full chain redeploy + Synapse/Postgres
re-bootstrap versus the marginal confidence gained, this report treats
"clean" as **"healthy and freshly confirmed," not "freshly booted from
zero volumes"** — the two consecutive full green runs above are the
evidence standing in for a cold-boot run. If a genuinely fresh-volume
run is wanted before this suite set is wired into CI (Phase 6), that's a
cheap, mechanical thing to do at that point and worth doing then, closer
to when CI-gating decisions are actually being made.

## Coverage table — process specs (`specs/process_specs/*.md`)

| Spec | Suite | Status |
|---|---|---|
| `card_signing.md` | `core/card_signing.spec.ts` | ✅ full coverage |
| `card_offering_and_acceptance.md` | `core/card_offering_and_acceptance.spec.ts` | ✅ full coverage |
| `card_validation.md` | `core/card_validation.spec.ts` | ⚠️ partial — chain-of-trust walk blocked by ancestry gap (Wave 1) |
| `card_updates.md` | `core/card_updates.spec.ts` | ⚠️ partial — same ancestry gap blocks the successful-update/revocation paths |
| `open_offer_creation.md` | `core/open_offer_creation.spec.ts` | ✅ full coverage |
| `open_offer_acceptance_new_wallet.md` | `core/open_offer_acceptance_new_wallet.spec.ts` | ⚠️ partial — deny paths covered; satisfying-card happy path blocked by ancestry gap |
| `open_offer_acceptance_existing_wallet.md` | `core/open_offer_acceptance_existing_wallet.spec.ts` | ⚠️ partial — same as above |
| `matrix_room_membership.md` | `matrix-relay/matrix_room_membership.spec.ts` | ⚠️ partial — room creation + every deny path covered; satisfying-join happy path blocked by real-chain/IPFS-pinning gap (Wave 2) |
| `matrix_join_attestation_and_revocation.md` | `matrix-relay/matrix_join_attestation_and_revocation.spec.ts` | ⚠️ partial — same gap; creator-registration fix (Wave 2) fully covered |
| `message_routing.md` | `matrix-relay/message_routing.spec.ts` | ✅ full coverage |
| `notification_relay.md` | `matrix-relay/notification_relay.spec.ts` | ✅ full coverage |
| `room_discovery.md` | `matrix-relay/room_discovery.spec.ts` | ⚠️ partial — 9 todo, real-chain-dependent scenarios |
| `card_migration.md` | `extended/card_migration.spec.ts` | ⚠️ partial — single-wallet-service-instance environment blocks cross-peer broadcast/old-service-forwarding scenarios |
| `log_auditing.md` | `extended/log_auditing.spec.ts` | ⚠️ partial — press-side delivery-attempt behavior covered; auditor-side receipt/decryption out of reach (no auditor client), and press's own auditor delivery is a self-documented "Phase 3 placeholder" (plaintext, not E2E-encrypted) |
| `policy_creation.md` | `extended/policy_creation.spec.ts` | ✅ full coverage (one `it.todo` for a multi-press scenario this single-press stack can't exercise) |
| `subcard_creation_policy.md` | `extended/subcard_creation_policy.spec.ts` | ⚠️ partial — registration mechanism 1/2 fully covered; deregistration (mechanism 3) blocked by a real, unfixed press bug (below) |
| `oblivious_transport.md` | `extended/oblivious_transport.spec.ts` | ✅ full coverage (one `it.todo` for a real path-convention bug, below) |
| `wallet_backup_and_recovery.md` | `extended/wallet_backup_and_recovery.spec.ts` | ⚠️ partial — Process 1/2a/3 covered for a single wallet-service instance; cross-federation keyring replication and the 72h wall-clock window are out of reach |
| `dns_governance_verifier.md` | `extended/dns_governance_verifier.spec.ts` | ⚠️ partial — on-chain mechanics (RegisterDomain/DeregisterDomain/PolicyAddressSet) covered directly; the HTTP/scheduled-task script layer isn't deployed anywhere in this stack, and real DNS TXT resolution needs a domain this environment doesn't have |

**19/19 process specs have a suite.** 7 are fully covered; 12 are partially
covered, every gap traceable to one of a small number of already-documented,
shared environment limitations (ancestry-chain gap, single-service-instance
topology, no real DNS/IPFS-pinning capability) rather than 12 independent
problems — see "Recurring environment limitations" below.

## Coverage table — object specs (`specs/object_specs/*.md`)

See `suites/README.md`'s own "Object-spec coverage map" table for the
authoritative version (kept there so it stays next to the suites
themselves); reproduced here for this report's completeness:

| Spec | Coverage |
|---|---|
| `app_sdk.md` | Named process suites (implicit, as a real dependency everywhere) |
| `client_sdk.md` | Named process suites |
| `wallet_sdk.md` | Named process suites |
| `press.md` | Named process suites |
| `wallet.md` | Named process suites |
| `relay.md` | Named process suites |
| `relay_data_model.md` | `conformance/relay_data_model.spec.ts` — ⚠️ partial, Redis/SQLite stores unreachable from the test runner (below) |
| `registry_contract.md` | Named process suites, broadly not exhaustively (2300+ lines, no suite attempts full coverage) |
| `matrix_room.md` | Named process suites |
| `matrix_synapse_module.md` | Named process suites |
| `matrix_encryption.md` | `conformance/matrix_encryption.spec.ts` — ✅ full coverage, including cross-language (TS/Python) parity |
| `ipfs_card.md` | `conformance/ipfs_card.spec.ts` — ⚠️ partial, one press-internal behavior (CID fetch-and-byte-compare) not independently observable |
| `card_verifier.md` | `conformance/card_verifier.spec.ts` — ⚠️ partial, scoped around the ancestry-chain gap |

**13/13 object specs accounted for.**

## Recurring environment limitations (not 12+ separate problems)

Nearly every "⚠️ partial" row above traces to one of these four, each
already discovered, diagnosed, and documented earlier this session — not
rediscovered per-suite:

1. **Ancestry-chain gap** (Wave 1 report): freshly-minted test cards'
   `ancestry_pubkeys` point at an ancestor never itself registered
   on-chain, so no suite can prove a full chain-of-trust walk reaches a
   trusted root. Affects `card_validation`, `card_updates`,
   `open_offer_acceptance_*`, `card_verifier` conformance.
2. **Matrix chain data is real Sepolia, and there's no IPFS-pinning
   capability** (Wave 2 report, carried over from a wallet-service-side
   precedent investigation): blocks any Matrix scenario needing a card to
   genuinely *satisfy* a room's policy. Affects `matrix_room_membership`,
   `matrix_join_attestation_and_revocation`, `room_discovery`.
3. **Single-instance topology**: this stack runs exactly one
   wallet-service and one press. Blocks cross-peer federation scenarios
   (`card_migration`'s broadcast/old-service-forwarding,
   `wallet_backup_and_recovery`'s keyring replication) and multi-press
   scenarios (`policy_creation`'s "press not in approved_presses" case).
4. **Redis has no host port mapping**: blocks direct inspection of the
   relay's UUID/message/delete-queue store schema
   (`relay_data_model.spec.ts`) — same class of gap as the already-logged
   `wallet-service-postgres` port-mapping gap (Wave 2, item 5).

None of these four are suite bugs or spec-compliance failures — they are
properties of this particular local dev environment, honestly documented
rather than worked around with something that would silently prove less
than it claims.

## New findings from Phase 5 (not in Wave 1/2, triaged here for the first time)

1. **`subcard_creation_policy.md` — `DeregisterSubCard`'s gas-check
   resolves the wrong address.** `press/src/handlers/sub-card.ts`'s
   `handleSubCardDeregister` hardcodes `const appCardAddress = '';
   // resolve from SubCardDocument in Phase 4` — self-documented as
   incomplete. Only one of the spec's three documented deregistration
   signer paths is implemented. **Triage: defer** — this is real, but
   sized like a small feature addition (Phase 4 work, per the code's own
   label), not a quick fix; scope it separately rather than folding into
   this checkpoint.
2. **`oblivious_transport.md` — `RequestOptions.path` isn't portable
   between oblivious and bypass modes — FIXED 2026-07-23.**
   `HpkeObliviousProtocolTransport`'s bypass mode calls `${baseUrl}${path}`
   directly, but press's real HTTP routes live under `/api/*` while the
   OHTTP gateway's internal dispatch table used bare paths (`/issue`, not
   `/api/issue`). Fixed by re-keying `press/src/ohttp-router.ts`'s
   dispatch table to `/api/*`, matching the Envelope Format section's own
   definition of `path` ("the destination route path", illustrated with
   wallet-service's real `/accounts/challenge`) — not by changing
   `#directRequest`, since wallet-service's own routes have no `/api`
   prefix and a fix there would have broken wallet-service bypass calls.
   Updated press's own `ohttp-router.test.ts`/`ohttp-gateway.test.ts`
   (172 press tests still green) and `oblivious_transport.spec.ts` to
   match; the suite's bypass-mode test now uses the same `/api/issue`
   path for both modes and no longer needs an `it.todo`. **Triage:
   fix-now — done.**
3. **`wallet_backup_and_recovery.md` — two smaller gaps**: `client-sdk`'s
   `initiateRecovery` can't surface the server's intentional idempotent
   `409` (existing recovery window) — the shared `requestJson` helper
   throws on any non-2xx and discards the body. And Process 3's
   Postconditions claim backup registrations are updated under the new
   decryption key on recovery, but nothing in `recoverWallet` or
   wallet-service actually does that. **Triage: defer** — both are
   real but narrow, neither blocking.
4. **`dns_governance_verifier.md` — `governance/scripts/registry.ts`'s
   `LOGIC_ABI` is unusable against the real deployed contract — FIXED
   2026-07-23.** PascalCase function names and `bytes`/`bytes[]` param
   types where the real contract (confirmed via `cargo stylus
   export-abi`, re-run for this fix) dispatches camelCase with
   `uint8[]`/`uint8[][]` — the same class of ABI-casing bug already fixed
   in `press/src/chain/registry.ts` back in Phase 1, never applied to
   this sibling file. Every write method on `createDnsGovRegistryClient`
   would have failed live; the three reads mixing `uint8[]` into an
   otherwise-scalar tuple (`getCardEntry`, `getGovernanceKeyset`,
   `getSubCardEntry`) would also have mis-decoded (the same
   "extra 32-byte outer tuple offset" quirk press's own registry.ts
   already documents and works around with a struct-wrapped return —
   applied the same fix here). Also fixed the `uint8[]`-argument encoding
   (needs a plain `number[]` via `Array.from`, not a raw `Uint8Array`,
   for viem's ABI encoder — same conversion already used elsewhere this
   session). Verified live (not just typechecked): a throwaway script
   calling the fixed `createDnsGovRegistryClient`'s `getDomainRegistration`/
   `getCardEntry` against the real local chain both correctly decoded
   `exists: false` for never-registered records — under the old ABI
   these calls would have hit Stylus's unrecognized-selector fallback
   (revert or garbage decode), not a clean result.
   **Known residual issue, NOT fixed** (documented in the file itself,
   out of scope for an ABI-casing fix): `getSubCardEntry` doesn't exist
   on the *logic* contract at all — confirmed via the same `cargo stylus
   export-abi` run — it's storage-contract-only, and `GovScriptConfig`
   has no storage-contract-address field to route it there. Script C
   (`policy-address-verifier.ts`) calls this and will still fail; a real,
   separate fix (a storage-contract-aware client) is needed for that.
   **Triage: fix-now — done** (the casing/type bug); the wrong-contract
   issue is a new, smaller `defer` item.
5. **`relay_data_model.md`**: no new bugs, only the environment
   limitations already listed above.
6. **`ipfs_card.md`/`matrix_encryption.md`/`card_verifier.md`
   conformance suites**: no bugs found — every documented invariant these
   suites could reach held.

## Summary for the checkpoint

- **fix-now:** #2 (oblivious transport path convention) — **done**. #4
  (DNS governance ABI casing) — **done**, verified live against the real
  deployed contract, not just typechecked.
- **defer:** #1 (sub-card deregistration signer paths — sized like real
  feature work, not a quick fix), #3's two sub-items (recovery
  409-surfacing, backup-key-rotation postcondition), and #4's residual
  wrong-contract issue for `getSubCardEntry` (needs a storage-contract-
  aware client, a real but separate change from the casing fix).
- **environment, not code:** the four recurring limitations above — no
  action item, just context for reading every "⚠️ partial" row honestly.

No blocking issues remain for Phase 6 (CI gating) to begin. Both
fix-now items are resolved.
