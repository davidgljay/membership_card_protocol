# Phase 4 (Integration Testing) Milestone Summary — Wave 2 Matrix/relay suites

Part of `plans/integration-testing-implementation-plan.md`. Full rationale:
`plans/integration-testing-strategic-plan.md`.

## Summary

All five Wave 2 suites — `matrix_room_membership`, `matrix_join_attestation_and_revocation`,
`message_routing`, `notification_relay`, `room_discovery` — exist, run
against the live local stack, and pass: combined with Wave 1, 110 tests
green across all 12 suite files, 23 deliberately deferred (`it.todo`), 0
failures. Getting there required closing a real gap Wave 1 never
hit: this stack's Synapse has no Application Service wired up for
wallet-service's shadow-account bridge (a known, previously-documented
TODO, not a surprise), which would have blocked every Matrix suite from
provisioning a test identity at all. Rather than take on that
infrastructure project mid-suite-authoring, the Matrix suites bypass it
entirely — registering test Matrix users directly via Synapse's admin
API at the exact address format a real shadow account would have
(`suites/support/matrixAdmin.ts`), which is a full substitute for
everything the *policy module* itself checks, even though it means Wave
2 doesn't exercise wallet-service's own AS-integration code. The first
run found two real, previously-unknown bugs in `matrix_policy_module` —
see `integration_tests/reports/2026-07-21-wave-2.md` for full detail;
this document is the coverage checklist and process retrospective.

## Goal 2 (coverage) checklist, against the strategic plan's actual wording

The strategic plan names Wave 2 as "matrix room membership/attestation,
message routing, notification relay, room discovery" — all four
named areas (five suites, since the matrix spec set splits into two
files) are **done**, all passing, all against the live stack:

- **`matrix_room_membership.md` + `matrix_join_attestation_and_revocation.md`**
  — full coverage of what's reachable: room creation and all four initial
  room-state assertions (join_rules, encryption, card.policy,
  power_levels), every join-deny path not requiring a real chain walk
  (missing attestation, malformed attestation, and — new relative to the
  closest precedent test — a *validly-signed* attestation for a
  nonexistent card, which is what surfaced the Twisted/asyncio chain-walk
  bug), and post-time membership-registry resolution (which is what
  surfaced the creator-auto-join gap). Scenarios requiring a *satisfying*
  card remain out of reach — this stack's Synapse points its policy
  module at real Arbitrum Sepolia (deliberately not part of the local
  nitro-devnode migration) and this repo has no IPFS-pinning capability,
  the same investigated (not assumed) limitation
  `wallet-service/test/integration/matrix-room-lifecycle.test.ts` already
  documents against its own separate stack.
- **`message_routing.md`** — binding-announcement construction/signing/
  posting/lookup, nonce-replay rejection, timestamp-based conflict
  resolution, message delivery to self-hosted cards, UUID pool
  registration with proof of sub-card key control. The spec's
  cross-wallet-service routing scenario isn't testable with this stack's
  single wallet-service instance; self-routing is exercised instead,
  noted rather than faked.
- **`notification_relay.md`** — device/UUID registration, credential
  replenishment, blob storage via `POST /deliver/{uuid}`, `GET /pending`'s
  atomic drain behavior, `POST /ack`'s staggered-delete scheduling, device
  isolation, and card-hash blindness (the relay never requires or accepts
  a `card_hash` anywhere in its API). SSE/WebSocket streaming delivery and
  actual push dispatch are out of scope — not fakeable without holding a
  live connection or real APNs/FCM credentials, decided as not worth the
  complexity for this suite specifically.
- **`room_discovery.md`** — `GET /matrix/room-index`'s shape, caching
  headers, and empty-state handling; `buildRoomDiscoveryEnvelope`'s
  signature verified against the verifier package's own crypto (matching
  every other suite's cross-package convention). Everything requiring a
  session token, a populated room index, or a real chain-walk is honestly
  deferred — this suite has the thinnest real coverage of the five, for
  legitimate, documented reasons (both the AS-wiring gap above and a
  second, smaller one: `wallet-service-postgres` has no host port
  mapping in this stack, so the one available workaround for seeding a
  real room-index entry — `insertRoomIndexEntry`, a directly-callable
  function — isn't reachable from a suite running on the host).

## Goal 3 (reporting) checklist

`integration_tests/reports/2026-07-21-wave-2.md` triages all six
findings: two `fix-now` candidates (the chain-walk crash — real,
consequential, needs proper scoping rather than a rush fix; the creator
auto-join registry gap — smaller, well-understood), three `defer` (AS
wiring, the missing Postgres port mapping, single-instance topology
accepted as environment scope), zero `test-bug` (two placeholder
assertions were caught and fixed *before* landing in committed suites,
not left for this report to catch afterward — see "Process notes"
below).

## Process notes / deviations worth recording

- **Escalation to Sonnet, per the plan's own rule.** The implementation
  plan's 4.2 step says to delegate remaining Wave-2 suites to Haiku "one
  delegation per spec," with escalation to Sonnet "if a spec is ambiguous
  or the pattern doesn't fit." That triggered for both Matrix-attestation
  suites: the AS-wiring investigation and the direct-Synapse-registration
  bypass needed to exist before *any* suite could be written, so those two
  were authored directly rather than delegated. `message_routing.spec.ts`
  and `notification_relay.spec.ts` delegated cleanly once that shared
  groundwork existed; `room_discovery.spec.ts` also delegated cleanly,
  though its real coverage stayed thin for reasons outside the delegate's
  control (the same AS gap, plus the DB port-mapping issue).
- **Independent re-verification caught two real issues in delegated
  suites before they landed**: `message_routing.spec.ts`'s first draft
  hand-rolled RFC 8785 canonicalization instead of reusing `app-sdk`'s
  (exactly the kind of drift risk this session's cross-package
  canonicalize checks exist to catch); `room_discovery.spec.ts`'s first
  draft included two `expect(true).toBe(true)` placeholder assertions
  presented as real test coverage. Both fixed before commit — worth
  continuing to independently re-run and read every delegated suite
  rather than trusting the delegate's own pass/fail report, same
  discipline established in Phase 3.
- **A real infra decision was made deliberately, not accidentally**:
  rather than wire up the missing Application Service (a genuine, bounded
  infrastructure project — copyable from `wallet-service/docker-compose.yml`'s
  own working setup, but with real open questions, like whether
  wallet-service's file-based AS-token reading even survives its
  `cloudflare-module`/workerd build target), the direct-Synapse-bypass
  approach was chosen instead for Wave 2's own scope. This was the right
  call for getting Wave 2 done, but it means wallet-service's own
  AS-integration code path remains completely unexercised by this
  environment — worth remembering as a real coverage gap distinct from
  "the policy module works," not just an implementation detail.

## What's next

**⛔ Checkpoint (per the implementation plan):** before Phase 5 (Wave 3 —
full spec coverage) begins, review
`integration_tests/reports/2026-07-21-wave-2.md` and decide which
`fix-now`/`defer` items to act on and who owns them. In particular: #3
(the chain-walk crash) is the more consequential of the two `fix-now`
candidates — it's the first live evidence of a bug in code every future
chain-walk-dependent suite (including Wave 1's own deferred tests) will
eventually need to exercise, so its priority is worth judging against how
much of the Wave 3/4 roadmap depends on that path working, not just
against this report's own immediate scope.
