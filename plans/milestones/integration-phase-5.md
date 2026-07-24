# Phase 5 (Integration Testing) Milestone Summary — Wave 3 full spec coverage

Part of `plans/integration-testing-implementation-plan.md`. Full rationale:
`plans/integration-testing-strategic-plan.md`.

## Summary

Every process spec (19/19) and every object spec (13/13) in `specs/` now
maps to a real, passing integration suite — either a dedicated
`extended/`/`conformance/` file (Wave 3's own contribution: 7 process
suites + 4 conformance suites, 11 new files) or a named suite from an
earlier wave that already exercises it as a real dependency. All 23 suite
files pass together, twice consecutively: 204 tests green, 52 `it.todo`
for documented, evidence-based gaps, 0 failures. Two new real bugs were
found and triaged this phase (an `HpkeObliviousProtocolTransport` path-
convention mismatch, and a DNS-governance-scripts ABI-casing bug identical
in shape to one already fixed in press earlier this session); everything
else traces to four recurring, already-diagnosed environment limitations,
not new problems.

## Goal 2 (coverage) checklist, against the strategic plan's actual wording

> Every process spec in `specs/process_specs/` has a suite; every object
> spec maps to either a conformance suite or a named process suite.

**Done**, both halves — see `integration_tests/reports/2026-07-23-full-coverage.md`'s
two coverage tables for the full spec-by-spec accounting, and
`integration_tests/suites/README.md`'s "Object-spec coverage map" for the
object-spec table's canonical location (kept there so it's next to the
suites themselves, not just in a dated report).

Coverage depth varies deliberately, same posture as every earlier wave:
7 of 19 process specs are fully covered; 12 are partially covered, with
every gap in those 12 traced to one of four shared environment
limitations (ancestry-chain resolution, Matrix's real-Sepolia/no-IPFS-
pinning constraint, single-wallet-service/single-press topology, Redis
having no host port mapping) rather than 12 independent problems worth
chasing separately. Of the 4 object-spec conformance suites, 2
(`matrix_encryption`, and effectively `ipfs_card` bar one press-internal
check) reach full coverage; `relay_data_model` and `card_verifier` are
partial for the same reasons.

## Goal 3 (reporting) checklist

> Issues from the full-coverage report are triaged before CI gating
> begins.

**Done** — `integration_tests/reports/2026-07-23-full-coverage.md`'s
"Summary for the checkpoint" section triages every open finding:
`fix-now` (2), `defer` (2 items covering 3 sub-findings), and
`environment, not code` (the 4 recurring limitations, explicitly called
out as not action items). No finding required rewriting a wrong test
assertion.

## Disposition of every open failure (explicit, per this phase's own
"Done when" wording)

Since Wave 3 introduced no new outright test *failures* (0 across 256
tests, both full-suite runs), "every open failure" here means every
`it.todo` and every logged bug:

- **`it.todo`s (52 total)**: every one traces to one of the four
  environment limitations listed above, or — for a small number — to a
  feature genuinely not yet implemented (sub-card deregistration signer
  paths (b)/(c); the DNS scripts' HTTP/scheduled-task layer not being
  deployed anywhere in this stack). None are masking an incorrect test;
  each carries its own evidence-based comment in its suite file.
- **Logged bugs**: dispositioned in the full-coverage report's own
  numbered findings list — 2 `fix-now` candidates, 3 `defer` sub-findings,
  explicit reasoning for each.

## Process notes worth carrying into Phase 6

- **The wallet_backup_and_recovery account-creation rate limit (5/hour,
  IP-hashed) makes "run twice consecutively" awkward for that one suite**
  specifically — a second run within the same hour genuinely 429s, not
  flakiness. Whoever wires Phase 6's CI gating needs to either space out
  retries for that suite, use a per-run IP/identity that doesn't share
  the bucket, or accept it as a known CI consideration rather than
  treating a 429 there as a real failure.
- **This phase's full-coverage run was NOT a from-scratch clean-volume
  rebuild** — see the report's own "On 'clean stack'" section for the
  reasoning. Worth doing a genuine cold-boot run once, closer to when
  Phase 6's CI gating decisions are actually being made, since that's
  the point where "does this reliably pass from zero" actually matters
  operationally.
- **Delegation pattern held up well at this scale**: of Wave 3's 11 new
  suites, 6 were delegated to Haiku, 3 to Sonnet (per the plan's own
  "Sonnet-grade" flagging for `oblivious_transport`/`wallet_backup_and_
  recovery`/`dns_governance_verifier`), 2 written directly. Every
  delegated suite was independently re-typechecked and re-run (not
  trusted from the delegate's own report) before being accepted, per
  this session's established practice — this caught nothing wrong in any
  of them, but the practice itself is what makes that clean record
  credible rather than assumed.

## Checkpoint outcome

Reviewed same day. Decision: fix both `fix-now` candidates immediately
rather than deferring.

- **Oblivious transport path convention**: `press/src/ohttp-router.ts`'s
  dispatch table re-keyed to match press's real `/api/*` routes, matching
  the Envelope Format spec section's own definition of `path`. Press's
  own unit tests updated and green (172 tests);
  `extended/oblivious_transport.spec.ts`'s bypass-mode test no longer
  needs its `it.todo`.
- **DNS governance ABI casing**: `governance/scripts/registry.ts`'s
  `LOGIC_ABI` fixed to camelCase/`uint8[]`, mirroring the exact pattern
  already proven correct in `press/src/chain/registry.ts`. Verified live
  (not just typechecked) against the real deployed contract. One new,
  smaller residual issue found and documented, not fixed:
  `getSubCardEntry` targets the wrong contract entirely (logic, not
  storage) — deferred as its own item, since fixing it needs a
  storage-contract-aware client, a real but separate change.

Full integration suite (23 files) reconfirmed green twice consecutively
after both fixes: 204 tests passing, 51 `it.todo` (one fewer than before
the oblivious-transport fix).

## What's next

Phase 6 (entry-point script and CI gating) is unblocked.
