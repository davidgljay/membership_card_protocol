# Strategic Plan — membership-card-verifier Deferred TODOs

Source: `plans/completed/membership_card_verifier_todo.md` (7 items, raised 2026-07-12 through 2026-07-17)
Companion: `implementation-plan.md` (not yet written)

## Goals

**G1. Verifier failure signals carry enough information for callers to explain *why*, not just *whether*, a policy check failed.**
`evaluate_policy_match` currently returns a bare `bool`/`None`, collapsing "wrong credential entirely" and "right credential, doesn't currently qualify" into the same `False`. No caller can produce a specific deny reason today.

**G2. `verifyCard`/`verify_card` can no longer silently mislead a caller into believing it populates chain data when it structurally cannot.**
The address-only entry point always returns `chain: []`; this already caused a total, silently-shipped functional failure in two call sites (`discoverRooms` in both `client-sdk` and `wallet-service`) before being caught in review. The footgun itself — not just its one confirmed instance — remains unfixed.

**G3. On-chain event history is actually retrievable, not stubbed everywhere it's called.**
`RpcProvider.getCardEventLog` has no real implementation anywhere in the codebase; every test suite mocks it. Stage 4's `HISTORY_MISMATCH` cross-check currently provides no real security assurance because it always degrades against an empty event log.

**G4. Matrix deployments actually enforce revocation via live on-chain events, not just via whatever backstop exists independently.**
The `Watcher` daemon is fully built and unit-tested but is never constructed by `PolicyModule.__init__`. No running deployment today subscribes to `CardHeadUpdated` events at all — revocation has no live event-driven path in production.

**G5. The chain walk reads correct data for every ancestor, not just ones that have never been updated.**
Stage 3 unconditionally parses every fetched ancestor as a genesis `CardDocument`. Any ancestor that has ever received a post-genesis update is actually a `LogEntry` (whose current fields live under `card_state`, and which has no `ancestry_pubkeys` at all), so the chain walk currently reads the wrong shape of data for any such ancestor.

**G6. A sub-card's `capabilities`, `valid_until`, and `attestation_level` are actually checked, not just specified.**
All three are protocol-required hard-reject checks per `card_verifier.md §7.2`, fully specified with dedicated error codes. None runs in either language port today — a sub-card with an out-of-scope message type, an expired validity window, or an insufficient attestation level currently still passes Stage 2.

**G7. `addressed_to_verifier` reflects a real check, not a hardcoded constant.**
`card_verifier.md` fully specifies a config field, a per-call override, and a Stage 7 pipeline stage for this. None of it exists in code; every result-construction site returns `false` unconditionally, regardless of whether the verifier was actually an intended recipient.

## Rationale

**G1** matters for operational and UX reasons, not correctness: nothing is broken today, but every current consumer (`matrix-policy-module`'s `predicates.py`, `client-sdk`'s `discoverRooms`) is unable to log or surface *why* a card didn't qualify for a room. That gap compounds as audit logging and any future "why was I denied" UI get built — better to close it once, deliberately, than have each consumer invent its own workaround later.

**G2** matters because it isn't hypothetical risk — it already caused a real, shipped, total-failure bug (both discovery paths silently returning zero eligible rooms for every card) that only surfaced because David caught it in a Phase 4 milestone review, not because a test failed (both test suites mocked around the real implementation). The instance was fixed same-day, but the underlying API shape — an entry point that accepts `returnChain: true` and silently ignores it — is still there for the next caller to walk into.

**G3** is the most consequential item of the four: it's not a footgun, it's a missing implementation. Stage 4's on-chain history cross-check is part of the verification story described in `registry_contract.md §7`, but today it verifies nothing, because there's no real `eth_getLogs`-backed event querying anywhere in the codebase. Any caller currently trusting `HISTORY_MISMATCH` for real freshness/tamper assurance is getting a pass-through no-op, not a check.

**G4** is the other consequential item: the entire event-driven revocation design in `matrix_join_attestation_and_revocation.md §3.1` — built, unit-tested, config-wired into `homeserver.yaml` rendering — is inert in every real deployment because of a one-line wiring gap (a TODO at the construction site). This is the difference between "revocation works" and "revocation is fully implemented but never runs."

**G5, G6, and G7 are the most consequential items of the seven, more so than G1–G4.** All three are silent divergences between a fully-specified, security-relevant check and code that never performs it, discovered only by direct code inspection after the spec-consistency review's Step A passes had already closed. G6 and G7 in particular mean a relying party reading `card_verifier.md` and trusting the documented result fields (`policy_match`-adjacent capability/expiry/attestation enforcement, `addressed_to_verifier`) is currently trusting checks that don't run — the field exists and looks meaningful, but the value is either never computed correctly (G6, silently permissive) or a hardcoded constant (G7, always `false`). G5 is a correctness bug, not a missing feature: any chain containing an updated ancestor is walked using the wrong document shape, with no error raised to signal it.

## Key Objectives

**G1**
- `evaluate_policy_match`/TS equivalent returns a discriminated result (e.g. `{ matched, reason? }`) distinguishing `no_policy_match` from `field_mismatch`, in both languages.
- A boolean-coercion path exists so all 101 TS / 130 Python existing tests continue to pass unmodified (or with only mechanical updates, not semantic rewrites).
- `matrix-policy-module`'s `predicates.py` surfaces the specific reason in its deny logs.
- New reason-specific test cases exist in both language suites and the cross-language interop vectors.

**G2**
- `verifyCard`/`verify_card` accepts an optional caller-supplied pubkey or `CardDocument`, and populates a real `chain` when provided — falling back to today's `chain: []` only when it isn't.
- Existing callers (`client-sdk`'s corrected `discoverRooms` envelope path, `wallet-service`'s signed-envelope endpoint) are unaffected — no regression to the Phase 4 same-day fix.
- Test coverage exists proving `returnChain: true` + supplied pubkey/document produces a non-empty chain, and that the no-extra-input path is unchanged.

**G3**
- A real `RegistryContract.getCardEventLog` implementation exists (in `verifier-rpc-provider` or a companion helper) performing chunked `eth_getLogs` queries for `CardRegistered`/`CardHeadUpdated`, starting from the registry's deploy block or a caller-supplied starting block.
- Provider block-range-limit errors are handled by retrying with a smaller window.
- `press.md`'s Open Question OQ-B3 is updated to reflect the current `getCardEventLog` interface (not the pre-redesign `getLogEntries()` naming).
- Stage 4's `HISTORY_MISMATCH` check is exercised against real event data in at least one integration test.

**G4**
- `PolicyModule.__init__` constructs and starts a `Watcher` using the already-rendered config keys, with clean startup/shutdown/reconnect behavior matching Synapse's module lifecycle.
- The satisfying-card-join and revocation-force-part smoke tests referenced in `plans/matrix-implementation-plan.md` Phase 6 run end-to-end against a live (or realistic test) registry contract at least once.
- No currently-passing unit test for `Watcher`/`CardHeadEventSubscription` needs semantic changes — only the wiring at the construction site changes.

**G5**
- Stage 3's per-hop ancestor fetch branches on the decrypted object's shape (genesis `CardDocument` vs. post-genesis `LogEntry`) before reading fields.
- For a `LogEntry` ancestor, current field values are read from `card_state` and `ancestry_pubkeys` is resolved from the genesis document (via `history[0]`), not read directly off the `LogEntry`.
- A new test case in both language ports exercises the chain walk through an ancestor with at least one post-genesis update, asserting the walk completes correctly rather than silently misreading or short-circuiting.

**G6**
- `VerifierConfig` gains `acceptedAttestationLevels` (default `["T2"]`) in both language ports.
- `verifyStage2`/`verify_stage2` gains the message-type parameter needed to evaluate `capabilities` (relevant only to `verifyEnvelope`, not `verifyCard`).
- All three checks (`CAPABILITY_NOT_GRANTED`, `SUBCARD_EXPIRED`, `ATTESTATION_LEVEL_INSUFFICIENT`) are implemented exactly per `card_verifier.md §7.2` steps 7/8/14, hard-rejecting on failure.
- New test cases cover each of the three rejection conditions plus a passing case, in both language ports.

**G7**
- `VerifierConfig` gains `verifierCardAddress?: string` in both language ports; `verifyEnvelope`'s options parameter (added, since none currently exists in the TS signature) gains a per-call override.
- A new Stage 7 (`stage7.ts`/`stage7.py`) implements the Recipient-Set Check per `card_verifier.md §7.7`, replacing every hardcoded `addressed_to_verifier: false` with a real computed value.
- New test cases cover: no address configured, address configured and present in recipients, address configured and absent, and per-call override precedence over construction-time config.

## Open Questions

1. **G1 — result shape:** should the discriminated result be a plain object (`{ matched, reason? }`) or a proper tagged union/enum type per language? This affects the boolean-coercion strategy and how much of the 101+130 existing tests can stay untouched vs. need mechanical updates.
2. **G2 — API shape:** should the optional parameter be a raw pubkey, an already-fetched `CardDocument`, or both accepted as alternatives? Whichever is chosen needs to match how `client-sdk`/`wallet-service` already have this data available post-Phase-4-fix, to avoid introducing a second, unused way to get a chain.
3. **G3 — caching ownership:** does per-card starting-block caching (to avoid re-scanning full history every verification) belong inside `verifier-rpc-provider`, or is it a caller concern per the existing "thin package, caller supplies transport/caching" design principle? This determines whether G3's work touches the shared package's public surface or only its reference/example implementation.
4. **G3 — test environment:** implementing and validating chunked `eth_getLogs` needs *some* live or realistic Arbitrum RPC endpoint (mainnet, testnet, or a local fork). None is confirmed available in this sandbox. Does David have a testnet/fork endpoint and a deployed registry contract address to test against, or should this phase stop at implementation + mocked-provider tests and flag live validation as a follow-up?
5. **G4 — lifecycle hook:** does Synapse's module loader support an async startup hook, or does `Watcher` need to be started from a synchronous `__init__` (e.g. via `asyncio.create_task`)? This is a Synapse-API question that needs a definitive answer before the wiring step is written, not assumed.
6. **G4 — live validation:** per `plans/matrix-implementation-plan.md` Phase 6, the on-chain-dependent smoke tests have never been run end-to-end in this sandbox. Same question as #4 — is there a live/test registry contract and Matrix homeserver environment available, or does this phase stop at "wired and unit-tested" with live validation flagged as a follow-up requiring David to provision test infra?
7. **G5 — genesis-document re-fetch cost:** resolving `ancestry_pubkeys` for a `LogEntry` ancestor requires fetching the genesis document (via `history[0]`) in addition to the `LogEntry` itself already fetched — an extra IPFS round trip per updated ancestor per chain walk. Is this acceptable as-is, or should the genesis document's `ancestry_pubkeys` be cached alongside whatever per-card-event caching G3 introduces, so the two features compose rather than duplicating fetch logic?
8. **G6 — policy-supplied T1 acceptance:** `attestation_level: "T1"` is acceptable only when "the governing policy explicitly accepts it" (`protocol-objects.md §16` step 11) — but `acceptedAttestationLevels` as currently scoped is verifier-instance-wide, not per-policy. Is a single verifier instance ever expected to serve multiple policies with different T1-acceptance rules simultaneously, in which case a per-call override (mirroring G7's `verifierCardAddress` pattern) may be needed instead of instance-wide config alone?
9. **G7 — recipient-set field format:** is `payload.recipients` always a flat array of card addresses across every message type this package verifies, or does its shape vary enough (e.g. by message type, per `messaging_protocol.md`) that Stage 7 needs type-specific handling rather than one universal membership check?

**Assumption if unresolved:** absent answers, the implementation plan will default to (1) a plain discriminated object per language, (2) accepting either a pubkey or a `CardDocument` as alternatives, (3) caching left as a caller concern (consistent with existing package philosophy), (4)/(6) implementation + mocked/unit-test validation only, with live end-to-end validation called out as a blocked follow-up needing David to provision RPC/contract access, (7) accept the extra fetch for now and revisit only if G3's caching work makes it cheap to combine, (8) instance-wide config only, since no current caller is known to need per-policy T1 acceptance, and (9) a flat-array membership check, escalating to type-specific handling only if a concrete counterexample surfaces.
