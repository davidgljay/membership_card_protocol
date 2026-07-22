# Phase 3 (Integration Testing) Milestone Summary — Wave 1 core suites + report

Part of `plans/integration-testing-implementation-plan.md`. Full rationale:
`plans/integration-testing-strategic-plan.md`.

## Summary

All seven Wave 1 core suites — `card_signing`, `card_offering_and_acceptance`,
`card_validation`, `card_updates`, `open_offer_creation`,
`open_offer_acceptance_new_wallet`, `open_offer_acceptance_existing_wallet`
— exist, run against the live local stack, and pass: 44 tests green, 10
deliberately deferred (`it.todo`) with each deferral tied to a specific,
documented blocker rather than a guess. The first run found one real,
unfixed product bug (open-offer issuance drops ancestry, mirroring a bug
already fixed in the targeted-offer path) and one test-infrastructure gap
(no suite-level helper yet mints a card whose chain actually reaches a
registered trusted root) — both triaged in
`integration_tests/reports/2026-07-21-wave-1.md` per Goal 3's reporting
convention. See that report for full detail; this document is the
higher-level checklist and process retrospective.

## Goal 2 (coverage) checklist, against the strategic plan's actual wording

> "Wave 1: integration tests exist and run for card_signing,
> card_offering_and_acceptance, card_validation, card_updates,
> open_offer_creation, and both open_offer_acceptance specs."

All six named specs (seven suites, since both open_offer_acceptance specs
get their own file) — **done**, all passing, all against the live stack
(not mocked). Coverage depth varies by spec, which is expected and
documented rather than papered over:

- **`card_signing.md`** — full coverage. Every phase (assembly,
  canonicalization, signing, parallel co-signing, edits, retractions,
  forwarding via `ForwardPackage`) and one error path, all client-side per
  the spec's own scope, cross-checked against `@membership-card-protocol/verifier`'s
  independently-vendored crypto rather than app-sdk's own.
- **`card_offering_and_acceptance.md`** — full coverage of the happy path
  (offer assembly → delivery → countersignature → finalization) plus two
  error paths (invalid holder signature, permissive-policy field
  validation), all against real press HTTP endpoints.
- **`open_offer_creation.md`** — full coverage: assembly, signing, offer ID
  derivation, short-form claim link generation, tamper-detection on both
  `issuer_pubkey` and `proposed_fields`, and the spec's own client-side
  validation rules (rejects an unconstrained offer without explicit
  acknowledgment, rejects a past `expires_at`). The spec's Phase 3 *hosted*
  claim-link form is out of scope — the spec itself flags that as an
  unresolved open architecture question (no component currently owns
  hosting), not a gap in this suite.
- **`open_offer_acceptance_new_wallet.md`** / **`_existing_wallet.md`** —
  claim assembly/signing and the P-06 (invalid recipient signature) error
  path covered against real press HTTP endpoints; the full happy-path claim
  is `it.todo`, blocked on the chain-of-trust test-identity gap above (not
  a defect in either spec's implementation — `evaluatePredicates` correctly
  rejects a chain that doesn't resolve). Confirmed the two specs are
  protocol-identical at the press API boundary; the "existing vs. new
  wallet" distinction is wallet-service/keyring scope, invisible to press.
- **`card_updates.md`** — signing/canonicalization and four error paths
  (invalid signature, stale timestamp, immutable-field rejection attempt,
  non-existent target card — the last of which surfaced the inconsistent
  400-vs-500 handling noted in the report) covered; the successful-update
  and revocation paths are `it.todo`, same chain-of-trust blocker.
- **`card_validation.md`** — the shallowest of the seven, by necessity: its
  entire subject is the chain-of-trust/revocation machinery that the same
  test-identity gap blocks most directly. Covers `CardVerifier`'s
  address-binding behavior and the negative case (a card outside
  `trustedRoots` correctly fails); the central "sign an envelope, walk it
  to a trusted root, confirm every stage" test is `it.todo`. Flagged in the
  report as the natural first beneficiary once the test-identity gap is
  addressed.

## Goal 3 (reporting) checklist

> "Issues from Wave 1's report are triaged (fix now / defer / test bug)
> before Wave 2 authoring begins."

**Done** — `integration_tests/reports/2026-07-21-wave-1.md` triages all
four findings: one `fix-now` (open-offer ancestry propagation — small,
proven pattern already applied to the sibling handler), three `defer`
(chain-of-trust test-identity helper, inconsistent error-status handling
for missing target cards, `card_validation.spec.ts`'s resulting shallower
coverage). No finding required rewriting a wrong test assertion — the
`it.todo` deferrals reflect real blockers, not incorrect test logic — so
"test-bug-tagged failures fixed" has nothing outstanding to do.

## Process notes / deviations worth recording

- **Suite-writing was delegated per-spec to Haiku after the pattern-setter
  (`card_signing.spec.ts`, done directly), per the implementation plan's
  own 3.2 guidance.** Each delegation included the established conventions,
  the shared `support/liveCard.ts` helper, and a sibling suite as a
  structural template; each was independently re-typechecked and re-run
  (not just trusted from the delegate's report) before being accepted. One
  delegate's suite (`card_validation.spec.ts`) came back weaker than
  intended — most of its tests exercise `CardVerifier.verifyCard()`'s
  address-binding rather than the spec's actual central object
  (`SignedMessageEnvelope` via `verifyEnvelope()`) — accepted anyway since
  the honest reason is the same test-identity gap affecting every other
  chain-dependent suite, not a delegate quality problem; logged for
  revisiting once that gap closes rather than re-delegated immediately.
- **A real, cross-file version of the nonce-collision problem surfaced only
  when running all seven suites together**, not from any single file in
  isolation: vitest parallelizes across test files by default, and every
  suite's `beforeAll` hits press's single gas wallet. Fixed via
  `suites/vitest.config.ts`'s `fileParallelism: false`. Worth remembering
  for Wave 2: "each suite passes alone" is not sufficient proof `npm test`
  (the full run) will be green.
- **One shared fixture changed**: `integration_tests/fixtures/src/policy.ts`'s
  `buildPermissiveTestPolicy` now sets `allow_open_offers: true` (was
  `false`) — required for the open-offer suites, harmless for suites that
  don't touch open offers.

## Checkpoint outcome

Reviewed same day. Decision: fix the `fix-now` item immediately rather than
deferring to Wave 2. `press/src/handlers/open-offer.ts` now propagates
`[offer.issuer_pubkey]` as `ancestry_pubkeys` (mirroring the targeted-offer
path's fix), with a new regression test in `press/test/unit/errors.test.ts`.
Full press suite (172 tests) and all 7 Wave-1 integration suites (44 tests,
10 `it.todo`) reconfirmed green against the rebuilt press container. The
three `defer` items stand as deferred — no other action requested at this
checkpoint.

## What's next

Phase 4 (Wave 2 — matrix and relay flows) is unblocked.
