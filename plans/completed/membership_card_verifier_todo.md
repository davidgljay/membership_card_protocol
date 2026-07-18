# membership-card-verifier — Deferred TODOs

Non-urgent improvements to the verifier package (TS + Python), noted while
building consumers against it rather than acted on immediately, since fixing
them now would mean refactoring an already-shipped, tested package for a
distinction no current caller actually needs yet. Items 5–7 are the
exception to "non-urgent": each is a protocol-required check the spec
already documents in detail that the code silently never performs.

---

## 1. `evaluate_policy_match` collapses distinct failure reasons into one `False`

**Where:** `evaluate_policy_match(chain, conditions) -> Optional[bool]` (`policy_match.py` / TS equivalent), and by extension every field that surfaces its result (`policy_match` on `EnvelopeVerificationResult`/`SignatureVerificationResult`/`CardVerificationResult`).

**The problem:** a caller gets `True`, `False`, or `None` (conditions not supplied) — nothing else. `False` is returned for at least two meaningfully different situations that a caller currently cannot distinguish from the return value alone:

1. **No card in the chain was issued under the requested `policy_id` at all** — the chain simply doesn't include that policy anywhere.
2. **A card in the chain *was* issued under the requested `policy_id`, but its fields don't satisfy the supplied `field_match` conditions** — the policy matched, the field check didn't.

These are different failure modes with different operational meaning (one says "wrong credential entirely," the other says "right credential, doesn't currently qualify") but today's boolean return makes them indistinguishable to any caller — including `matrix-policy-module`'s `predicates.py`, which currently just treats any `False` as "this policy entry didn't match" without being able to say *why*, and can't surface a more specific deny reason in its own logs as a result.

**Why this hasn't been fixed:** distinguishing these would mean changing `evaluate_policy_match`'s return shape (e.g. a small result type or reason enum instead of a bare `bool`) across a package that's already shipped with 101 TS tests / 130 Python tests built against the current boolean contract, for a distinction no current consumer (`matrix-policy-module`, `client-sdk`'s `discoverRooms`) actually needs today — every current call site only needs "did it match," not "why didn't it."

**Recommendation for whenever this is revisited:** replace the bare `bool` with a small tagged result (e.g. `{ matched: bool, reason?: "no_policy_match" | "field_mismatch" }`, or an equivalent discriminated type per language), keep a boolean-coercion path for existing callers that don't care, and add reason-specific test cases to both language's suites plus the cross-language interop vectors. Not blocking anything today — revisit if/when a caller (e.g. richer audit logging, or a future UI surfacing *why* a card doesn't qualify for a room) actually needs the distinction.

**Raised:** 2026-07-12, during Phase 3 (`matrix-policy-module`) build-out.

**Status (2026-07-17): Implemented and fully tested**, both languages. `evaluate_policy_match`/`evaluate_policy_match` now returns a discriminated `PolicyMatchResult { matched, reason? }` (`"no_policy_match"` | `"field_mismatch"`), and `matrix-policy-module`'s deny logs surface the specific reason instead of a bare "policy_violation". Spec: [`plans/g1-policy-match-reason-spec.md`](../g1-policy-match-reason-spec.md).

---

## 2. `verifyCard`/`verify_card` can never return chain data — even with `returnChain: true` — and this caused a real, shipped bug

**Where:** `CardVerifier.verifyCard()` (TS, `packages/verifier/src/CardVerifier.ts`) / `CardVerifier.verify_card()` (Python, `packages/verifier-py/.../card_verifier.py`). Both are intentionally, correctly identical: given a bare card address with no known public key, neither can decrypt that card's `CardDocument` (decryption requires the pubkey), so `chain: ChainLink[]` is hardcoded to `[]` unconditionally — `returnChain: true` has no effect on this path at all, unlike `verifyEnvelope`/`verify_envelope`, which does populate a real chain from Stage 3 when a full signed envelope (carrying the pubkey via its signature) is available.

**This is not, by itself, a bug** — it's a correct consequence of the address-only input `verifyCard` accepts. `matrix-policy-module`'s `chain_context.py` documents this exact limitation and correctly avoids relying on `verify_card`'s chain for anything (its use there — the watcher's post-time revocation re-check — only ever needs `revocation`/`is_currently_valid`, never `chain`, since chain topology was already captured once at join time via `verify_envelope`).

**What went wrong (confirmed 2026-07-12, during Phase 4 milestone review, flagged by David):** Phase 4 Step 16b (`client-sdk`'s `discoverRooms`) and Step 16c (`wallet-service`'s server-side mirror) both called `cardVerifier.verifyCard(cardHash)` expecting a populated `chain`, on the mistaken assumption that `returnChain`/the verifier's own config would make this work the same way it does for `verifyEnvelope`. It doesn't and structurally can't. The result: both discovery functions **always received an empty chain**, meaning `evaluateRoomPredicate` **always evaluated false**, meaning **both discovery paths reported zero eligible rooms for every card, unconditionally** — a total functional failure, not a partial gap. It shipped with passing tests because both test suites mocked `verifyCard` to directly return a fabricated `chain`, never exercising the real `CardVerifier.verifyCard()` implementation this bug lived in.

**Fixed same-day, but the two call sites needed genuinely different fixes, not one shared patch:**
- **Step 16b (`client-sdk`)** — the caller (a card holder, running client-side) always holds their own card's private key, so it now constructs and signs a minimal self-attestation envelope locally (`buildRoomDiscoveryEnvelope`, exported from `client-sdk/packages/client-sdk/src/matrix/discovery.ts`) and calls `verifyEnvelope`, not `verifyCard` — the same shape Step 10/12's join-attestation chain-walk already correctly uses.
- **Step 16c (`wallet-service`)** — this one is *not* a simple call-site swap: `wallet-service` never holds a card's private key (by design — private keys stay client-side across this whole protocol), so it structurally cannot construct or sign an envelope itself, even though it's the one doing the chain-walk. The actual fix changes the endpoint's request shape: `POST /matrix/discover-rooms` now requires the caller to submit an already-signed envelope in the request body (built client-side via the same exported `buildRoomDiscoveryEnvelope` — signing needs only the local private key, no RPC/IPFS access, so this doesn't reintroduce the "needs local chain-walk capability" problem this fallback endpoint exists to avoid). The server then verifies the envelope's signature is genuinely valid *and* that its recovered `signer_card` matches the authenticated session's own `card_hash` (mirroring `matrix-policy-module/attestation.py`'s sender-binding discipline — never trust a claimed identity when the verified value is available) before trusting its chain data. This was a real gap in `room_discovery.md §3`'s own spec text, not just an implementation shortcut — the spec's original `{ "card_hash": "..." }`-only request body assumed the server could chain-walk from an identity alone, which was never actually possible once you trace through what `verifyEnvelope`/`verifyCard` each need.

**Recommendation for whenever this is revisited:** give `verifyCard`/`verify_card` an optional parameter (e.g. a caller-supplied public key, or an already-known `CardDocument`) that lets it populate a real chain when the caller *does* have more than a bare address available — falling back to today's `chain: []` behavior only when no such extra input is supplied. This would remove an entire class of "which function do I call" mistake for any future caller in either language who has the pubkey in hand but reaches for the address-only entry point instead, exactly as happened here. Not urgent — no current caller is broken by the *absence* of this option now that Step 16b/16c call the correct function instead; this is about closing the footgun for the next caller, not an active bug today.

**Raised:** 2026-07-12, during Phase 4 (`discoverRooms`/`discover-rooms` bugfix) — David's request.

**Status (2026-07-17): Implemented and fully tested**, both languages. `verifyCard`/`verify_card` now accept an optional `pubkey` on `VerifyCardOptions` that, when supplied and address-verified, populates a real Stage-3-walked chain; omitting it reproduces today's `chain: []` behavior exactly. Spec: [`plans/g2-verifycard-chain-spec.md`](../g2-verifycard-chain-spec.md).

---

## 3. `RpcProvider.getCardEventLog` has no real implementation anywhere — every caller stubs it

**Where:** `RpcProvider.getCardEventLog(cardAddress)` (`types.ts` / `types.py`), consumed by Stage 4 (`stage4.ts`/`stage4.py`) to reconstruct a card's ground-truth on-chain CID/timestamp history by replaying `CardRegistered`/`CardHeadUpdated` events (`registry_contract.md §7`) and cross-checking it against the IPFS-reported `history` array. `verifier-rpc-provider`'s `EthersRpcProvider.getCardEventLog` is a one-line pass-through to a caller-supplied `RegistryContract.getCardEventLog`, whose doc comment states event-querying is "the sole responsibility of the caller-supplied ABI/event-querying layer."

**The problem:** no concrete implementation of that event-querying layer exists anywhere in the codebase. `EthersRpcProvider`'s own test suite mocks `getCardEventLog` directly (`vi.fn().mockResolvedValue([...])` or `[]`); its integration test stubs it to always return `[]`, with a comment stating plainly that event replay/indexing "[is] not available as simple contract reads" in that test's stub RPC. Nothing in this package or `verifier-rpc-provider` actually performs a real `eth_getLogs`-style query against a live Arbitrum node — which in practice needs pagination/chunking, since most RPC providers cap the block range of a single `eth_getLogs` call (commonly a few thousand blocks, sometimes enforced only on free tiers), and needs a starting block (the registry contract's deploy block, or a per-card cached last-seen block) rather than querying from genesis every time. None of that exists yet.

**Why this hasn't been fixed:** the `card_state`/`history` full-repost redesign and the `getCardEventLog` interface it depends on were only added 2026-07-16 (see `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (i)); every consumer (press, wallet-service, the SDKs) is still catching up to the interface shape itself, so no one has yet had to point it at a real chain and hit this. `press.md`'s own Open Question OQ-B3 still describes the pre-redesign `getLogEntries()` name and framing and needs updating to reflect the current interface once this is addressed.

**Recommendation for whenever this is revisited:** implement a real `RegistryContract.getCardEventLog` (in `verifier-rpc-provider` or a new companion helper) that chunks `eth_getLogs` calls across the block range from the registry's deploy block (or a caller-supplied/cached starting block) to latest, filtered to `CardRegistered`/`CardHeadUpdated` for the given card address, merging results and handling provider-imposed range-limit errors by retrying with a smaller window. Consider whether per-card starting-block caching (to avoid re-scanning full history on every verification) belongs in this package or is a caller concern, matching the "thin package, caller supplies transport/caching" design principle already established for `RpcProvider`/`IpfsProvider` elsewhere. Not blocking today since Stage 4's `HISTORY_MISMATCH` cross-check degrades gracefully against an empty event log (treated as "no on-chain history to check against," not a hard failure) — but any caller relying on that cross-check for real security assurance, or on-chain timestamps for real freshness enforcement, is currently getting no actual verification from it.

**Raised:** 2026-07-16, during spec-consistency Phase 3 code-alignment work, prompted by David's question about open issues around on-chain event-log retrieval.

**Status (2026-07-17): Implemented and mock/unit-tested**, both languages — including a scope gap found during implementation: the Python side (`matrix-policy-module`'s `Web3RpcProvider`) had no `get_card_event_log` at all, not just TS. Both now do chunked, retrying `CardRegistered`/`CardHeadUpdated` event replay. **Live validation against a real Arbitrum RPC/registry contract has not occurred** — no such endpoint is available in this environment; this is a follow-up blocked on you provisioning one. Spec: [`plans/g3-event-log-spec.md`](../g3-event-log-spec.md), milestone: [`plans/milestones/phase-3-summary.md`](../milestones/phase-3-summary.md).

---

## 4. `matrix-policy-module`'s on-chain event `Watcher` is implemented and unit-tested, but never constructed — no running deployment actually subscribes to on-chain events

**Where:** `wallet-service/matrix-policy-module/src/matrix_policy_module/module.py`, `PolicyModule.__init__` (~lines 190-216) — the only entrypoint Synapse's module loader calls.

**The problem:** the event-driven revocation watcher described in `specs/process_specs/matrix_join_attestation_and_revocation.md §3.1` — a daemon holding a persistent `eth_subscribe("logs", ...)` WebSocket subscription to the registry contract's `CardHeadUpdated` event, filtered to an active watch-set of card/ancestor addresses, force-parting revoked members as events arrive — is fully implemented (`watcher.py`'s `Watcher` class, `rpc_provider.py`'s `CardHeadEventSubscription`) and unit-tested. The config schema to drive it (`arbitrum_rpc_ws_url`, `registry_contract_address`, `watcher_backstop_interval_seconds`, etc., `specs/object_specs/matrix_synapse_module.md` ~lines 90-118) is also fully designed and rendered into `homeserver.yaml` by `wallet-service/scripts/render-matrix-config.ts`. But `PolicyModule.__init__` never constructs or starts a `Watcher`, and no other process/container does either — there's an explicit TODO at the construction site. Net effect: no currently running Matrix deployment subscribes to on-chain events at all; revocation has no live event-driven path today, only whatever backstop/manual mechanism exists independently.

**Why this hasn't been fixed:** left as a deliberate TODO during the module's initial build-out rather than wired up in that pass — likely because wiring a long-lived WebSocket subscription into Synapse's module lifecycle (start/stop semantics, reconnect-on-drop, interaction with Synapse's own process model) is a separate design question from the watcher's internal logic, which is why the daemon itself could be built and tested in isolation first.

**Recommendation for whenever this is revisited:** construct and start the `Watcher` from `PolicyModule.__init__` (or an equivalent lifecycle hook Synapse's module loader supports for async startup), using the already-rendered config keys; confirm clean shutdown/reconnect behavior against Synapse's module lifecycle before relying on it in production; then exercise the on-chain-dependent smoke tests (satisfying-card join, revocation force-part) against a live registry contract, which per `plans/matrix-implementation-plan.md` Phase 6 have never actually been run end-to-end in this sandbox.

**Raised:** 2026-07-17, during a status check on whether the matrix configuration currently subscribes to on-chain events (it doesn't — this is a wiring gap, not a design or implementation gap).

**Status (2026-07-17): Implemented and unit-tested.** `PolicyModule.__init__` now constructs and starts the `Watcher` via `ModuleApi.run_as_background_process` (confirmed from Synapse source as the correct lifecycle mechanism). One related gap found and explicitly *not* closed: startup reconciliation against Synapse's live room-membership list has no `ModuleApi` enumeration method to build it from — flagged as a separate open gap, not silently dropped. **Live end-to-end validation (satisfying-card join, revocation force-part against a real chain + homeserver) has not occurred** — blocked on you provisioning a test registry contract and Matrix homeserver. Spec: [`plans/g4-watcher-wiring-spec.md`](../g4-watcher-wiring-spec.md), milestone: [`plans/milestones/phase-4-summary.md`](../milestones/phase-4-summary.md).

---

## 5. Stage 3's chain walk unconditionally parses a fetched ancestor as a `CardDocument`, never checking for a `LogEntry`

**Where:** `verifyStage3` (`stage3.ts` / `stage3.py`), the per-hop ancestor-resolution loop. For each ancestor address, it fetches `cardEntry.log_head_cid` from IPFS, decrypts it, and does `JSON.parse(...) as CardDocument` (TS) / an equivalent unconditional cast (Python) — with no check on whether the fetched object is actually a genesis `CardDocument` or a post-genesis `LogEntry`.

**The problem:** per the `card_state`/`history` full-repost redesign (`protocol-objects.md §3`, `ipfs_card.md §5`), `log_head_cid` points at a `LogEntry` for any card that has ever received a post-genesis update — and a `LogEntry`'s current field values live under `card_state`, not at the document's top level the way a genesis `CardDocument`'s fields do. `ancestry_pubkeys` (which this same loop reads on the next iteration via `currentDoc.ancestry_pubkeys`) is a genesis-only, immutable field per `protocol-objects.md §1`, so it's never present on a `LogEntry` at all — for any ancestor in the chain that has been updated even once, this code silently reads `undefined`/`None` where it expects an array, which (depending on how the surrounding logic handles that) most likely short-circuits the chain walk as if that ancestor were a root, or throws, rather than correctly reading `card_state` for current fields and falling back to the genesis document (reachable via `history[0]`) for `ancestry_pubkeys`.

**Why this hasn't been fixed:** the `card_state`/`history` redesign and the `getCardEventLog`-based Stage 4 fix (item 3, resolved 2026-07-16) both landed in the same pass that surfaced this — Stage 4 was fixed because it directly consumes `history`/`card_state`, but Stage 3's chain walk was flagged as a related, not-yet-fixed gap at the time (`plans/spec-consistency/inconsistencies/code-card.md` Finding 2b) rather than fixed alongside it, since it requires a different code change (branching on fetched-object shape, not just adding a new provider method).

**Recommendation for whenever this is revisited:** in the per-hop fetch, check the decrypted object's shape (e.g. presence of `entry_type`) before treating it as a `CardDocument`. If it's a `LogEntry`, read `card_state` for current field values and resolve `ancestry_pubkeys` from the genesis document instead (fetchable via the entry's own `history[0]`, per the redesign's guarantee that `history` always ends with every predecessor back to genesis) rather than re-fetching the whole chain from scratch. Add a test case exercising the chain walk through an ancestor that has at least one post-genesis update, in both language ports — no such test currently exists, which is why this has shipped undetected alongside the otherwise-complete Stage 4 fix.

**Raised:** 2026-07-17, during a review of open issues in `membership_card_verifier`'s handling of on-chain/IPFS history.

---

## 6. Stage 2's `capabilities`/`valid_until`/`attestation_level` checks are fully specified but never implemented

**Where:** `card_verifier.md §7.2` steps 7, 8, and 14 (and the corresponding `CAPABILITY_NOT_GRANTED`/`SUBCARD_EXPIRED`/`ATTESTATION_LEVEL_INSUFFICIENT` error codes in §9) describe three hard-reject checks a sub-card signature must pass. None of the three appears anywhere in `stage2.ts` or `stage2.py` — confirmed by direct search: zero matches for all three error code names in either file.

**The problem:** a sub-card whose signed message type isn't in its own `capabilities` array, or whose `valid_until` has passed, or whose `attestation_level` is `"T1"` when the governing policy requires `"T2"`, currently passes Stage 2 as long as its signatures and app-certification chain check out — none of the three protocol-required checks actually run. This is the same class of issue as item 5: the spec was updated (2026-07-16, Phase 2 Decision (a)) and both `card_verifier.md` and `card_validation.md` describe the checks in detail, but the code was never updated to match.

**Why this hasn't been fixed:** flagged as a Phase 3 Tier 2 backlog item (spec ahead of code, not a spec error) rather than fixed in that pass — implementing three new hard-reject checks plus their config plumbing (`VerifierConfig.acceptedAttestationLevels`) was scoped as follow-up work, not folded into the same-day fix batch.

**Recommendation for whenever this is revisited:** thread the message type being verified into `verifyStage2` (only relevant for the `verifyEnvelope` path, not `verifyCard`, which has no message to check against), add the three checks per `card_verifier.md §7.2` steps 7/8/14 exactly, and add `acceptedAttestationLevels` to `VerifierConfig` (default `["T2"]`). Add test cases for each of the three rejection conditions in both language ports, plus a confirming test that a sub-card satisfying all three still passes.

**Raised:** 2026-07-17, during a review of open issues in `membership_card_verifier`'s handling of on-chain/IPFS history.

---

## 7. Stage 7 (Recipient-Set Check) doesn't exist — `addressed_to_verifier` is hardcoded `false` everywhere

**Where:** `card_verifier.md §5` (`VerifierConfig.verifierCardAddress`), `§6.1`/`§7.7` (the per-call override and Stage 7 pipeline description), and `§8` (`addressed_to_verifier` on the result type) describe a full mechanism for a verifier to determine whether it was itself an intended recipient of a message. No `stage7.ts`/`stage7.py` file exists in either package, `VerifierConfig` has no `verifierCardAddress` field, `verifyEnvelope`'s TS signature doesn't even accept a per-call options parameter to carry an override, and every one of the five result-construction sites in both `CardVerifier.ts` and `card_verifier.py` sets `addressed_to_verifier: false` unconditionally.

**The problem:** this is the largest single gap between the verifier's spec and its code — a fully-specified config field, per-call override, and pipeline stage with zero code presence, silently reporting a plausible-looking default (`false`) rather than an obviously-broken one (e.g. `undefined` or a thrown error), which is exactly the shape of bug most likely to go unnoticed by a caller who reads `addressed_to_verifier` and trusts it.

**Why this hasn't been fixed:** flagged as a Phase 3 Tier 2 backlog item; this gap actually predates the Phase 2 amendment that added `verifierCardAddress` specifically to serve it — Stage 7 was fully specified before that, with no code ever written against it.

**Recommendation for whenever this is revisited:** add `verifierCardAddress?: string` to `VerifierConfig`, add a per-call override parameter to `verifyEnvelope`'s options (and the equivalent Python signature), and implement Stage 7 per `card_verifier.md §7.7`: confirm the configured (or per-call) address appears in `payload.recipients`, computing `addressed_to_verifier` accordingly instead of the current hardcoded `false`. Add test cases for: no address configured (current behavior, `false`), address configured and present in recipients (`true`), address configured and absent (`false`), and the per-call override taking precedence over construction-time config.

**Raised:** 2026-07-17, during a review of open issues in `membership_card_verifier`'s handling of on-chain/IPFS history.
