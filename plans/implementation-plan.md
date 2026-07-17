Strategic plan: [strategic-plan.md](./strategic-plan.md)

# Implementation Plan — membership-card-verifier Deferred TODOs

Decisions locked in from strategic-plan.md open questions: G1 uses a plain discriminated
object (not a tagged-union type); G2 accepts a pubkey only (not a CardDocument alternative);
G3/G4 have no live RPC/registry/homeserver test environment available, so both phases stop at
implementation + mocked/unit-test validation, with live end-to-end validation flagged as a
blocked follow-up for David to provision later. Caching ownership for G3 (open question #3)
defaults to "caller concern," consistent with the package's existing thin-package philosophy,
unless Phase 3's research step finds that assumption doesn't hold.

**Agent assignment principle (token economy):** design/decision steps and anything
correctness-critical or novel (chunked `eth_getLogs` logic, Synapse lifecycle wiring) run
inline under the main session (Sonnet), since they need judgment and the full surrounding
context. Mechanical, fully-specified work — implementing a change once its exact shape is
written down, writing tests that follow an existing pattern, doc-string updates — is delegated
to Haiku subagents with a self-contained prompt (exact file paths, exact signatures, exact
logic), so those tokens run on the cheaper model instead of Sonnet.

---

## Phase 1: G1 — `evaluate_policy_match` reason codes

**1.1 — Design spec** (Who: Claude, inline)
What: Read `policy_match.py`, the TS equivalent, and every type that surfaces `policy_match`
(`EnvelopeVerificationResult`/`SignatureVerificationResult`/`CardVerificationResult` in both
languages), plus `matrix-policy-module/predicates.py` and the existing 101 TS / 130 Python
test files that assert on today's boolean contract. Write a spec doc fully specifying: the new
result shape (`{ matched: bool, reason?: "no_policy_match" | "field_mismatch" }` per language),
exactly where in `evaluate_policy_match` each reason is determined, the boolean-coercion path
for existing callers, and which existing tests need only mechanical updates (return-shape
unwrap) vs. none at all.
Context needed: `packages/verifier-py/.../policy_match.py`, TS equivalent path, both languages'
verification-result type definitions, `matrix-policy-module/predicates.py`,
`plans/membership_card_verifier_todo.md` item 1, strategic-plan.md §G1.
Done when: `plans/g1-policy-match-reason-spec.md` exists with exact file paths, function
signatures, and reason-determination logic — specific enough that an agent with no other
context can implement it correctly.

**1.2 — Implement Python side** (Who: Haiku agent)
What: Implement the spec from 1.1 in the Python package only.
Context needed: `plans/g1-policy-match-reason-spec.md` (full spec — no other context should be
required).
Done when: Python `evaluate_policy_match` and the surfacing result fields match the spec;
existing Python test suite still passes or is updated exactly as the spec directs.

**1.3 — Implement TS side** (Who: Haiku agent, run in parallel with 1.2)
What: Implement the spec from 1.1 in the TS package only.
Context needed: `plans/g1-policy-match-reason-spec.md`.
Done when: TS `evaluate_policy_match` and the surfacing result fields match the spec; existing
TS test suite still passes or is updated exactly as the spec directs.

**1.4 — Surface reason in matrix-policy-module deny logs** (Who: Haiku agent)
What: Update `predicates.py` to log the specific `reason` value instead of a bare "didn't
match," per the spec.
Context needed: `plans/g1-policy-match-reason-spec.md`, `matrix-policy-module/predicates.py`.
Done when: deny-path logging includes the reason string; no change to `predicates.py`'s
matching behavior, only its logging.

**1.5 — Reason-specific test cases** (Who: Haiku agent)
What: Add new test cases (both languages + cross-language interop vectors) exercising
`no_policy_match` vs `field_mismatch` specifically, per the spec's test-case list.
Context needed: `plans/g1-policy-match-reason-spec.md`, both languages' test directories,
interop vector location.
Done when: new tests exist and pass locally against the 1.2/1.3 implementations.

**Phase 1 Milestone Review** (Who: Claude, inline)
Context needed: `plans/g1-policy-match-reason-spec.md`, outputs of 1.2–1.5 (diffs), full
Python + TS test run output.
Done when: Python and TS implementations are consistent with each other and the spec, the full
existing suite (101 TS / 130 Python + new cases) passes, `predicates.py` logging verified
manually against a constructed `field_mismatch` case, and any spec gaps found during
implementation are resolved in-place before Phase 2 starts.

---

## Phase 2: G2 — `verifyCard`/`verify_card` chain-population footgun

**2.1 — Design spec** (Who: Claude, inline)
What: Read `CardVerifier.ts`, `card_verifier.py`, and how `client-sdk`'s corrected
`discoverRooms` and `wallet-service`'s signed-envelope endpoint currently obtain a pubkey
post-Phase-4-fix. Write a spec for an optional pubkey parameter (decision: pubkey only, not
`CardDocument`) that, when supplied, lets `verifyCard`/`verify_card` decrypt and populate a
real `chain` from Stage 3, falling back to `chain: []` when omitted — mirroring how
`verifyEnvelope`/`verify_envelope` already populates it.
Context needed: `packages/verifier/src/CardVerifier.ts`, Python equivalent,
`client-sdk/packages/client-sdk/src/matrix/discovery.ts`, `wallet-service`'s
`/matrix/discover-rooms` handler, `plans/membership_card_verifier_todo.md` item 2,
strategic-plan.md §G2.
Done when: `plans/g2-verifycard-chain-spec.md` exists with the exact parameter name, type,
Stage-3 decrypt/populate logic, and fallback behavior for both languages.

**2.2 — Implement TS side** (Who: Haiku agent)
What: Implement the spec from 2.1 in `CardVerifier.ts`.
Context needed: `plans/g2-verifycard-chain-spec.md`.
Done when: `verifyCard` accepts the optional pubkey and populates `chain` when supplied;
unchanged behavior (empty chain) when omitted.

**2.3 — Implement Python side** (Who: Haiku agent, run in parallel with 2.2)
What: Implement the spec from 2.1 in `card_verifier.py`.
Context needed: `plans/g2-verifycard-chain-spec.md`.
Done when: `verify_card` accepts the optional pubkey and populates `chain` when supplied;
unchanged behavior when omitted.

**2.4 — Tests** (Who: Haiku agent)
What: Add tests proving (a) `returnChain: true` + supplied pubkey produces a non-empty,
correct chain, and (b) the no-pubkey path is byte-for-byte unchanged from today.
Context needed: `plans/g2-verifycard-chain-spec.md`, both languages' `CardVerifier` test files.
Done when: both test cases exist and pass.

**2.5 — Regression check against the Phase 4 fix** (Who: Claude, inline)
What: Grep `client-sdk` and `wallet-service` for all `verifyCard`/`verify_card` call sites,
confirm none of them start relying on the new parameter in a way that reintroduces the
"wallet-service can't sign, so don't expect it to have a pubkey either" problem the Phase 4 fix
was built around. Run both packages' existing test suites.
Context needed: `client-sdk/packages/client-sdk/src/matrix/discovery.ts`, `wallet-service`'s
`/matrix/discover-rooms` handler, `plans/membership_card_verifier_todo.md` item 2's "Fixed
same-day" section (for what NOT to regress).
Done when: no call site regressed; both suites pass unchanged.

**Phase 2 Milestone Review** (Who: Claude, inline)
Context needed: `plans/g2-verifycard-chain-spec.md`, outputs of 2.2–2.5.
Done when: TS/Python implementations are consistent, all tests pass, 2.5's regression check is
clean, and any spec gaps are resolved before Phase 3 starts.

---

## Phase 3: G3 — real `getCardEventLog` implementation

**Clarification checkpoint:** no live Arbitrum RPC endpoint or deployed registry contract is
available in this environment (per strategic-plan.md open question #4/assumption). This phase
stops at implementation + mocked-provider tests. Do not represent this phase as "verified
against a live chain" anywhere in status updates or commit messages — flag live validation
explicitly as a blocked follow-up in the Phase 3 Milestone Review.

**3.1 — Research and design spec** (Who: Claude, inline — correctness-critical, keep in main
session)
What: Read `types.ts`/`types.py` (`RpcProvider.getCardEventLog`), `verifier-rpc-provider`'s
`EthersRpcProvider` and its existing mocked test suite, `registry_contract.md §7`
(`CardRegistered`/`CardHeadUpdated` event shapes), and Stage 4's `HISTORY_MISMATCH` logic in
`stage4.ts`/`stage4.py`. Decide and document: chunking strategy (block-range window size,
default and configurable), starting-block source (registry deploy block constant vs.
caller-supplied), retry-on-range-limit-error behavior, and confirm/override the caching-is-a-
caller-concern assumption from strategic-plan.md open question #3 — if research shows caching
needs to live inside the package, stop and flag this to David before proceeding (this
contradicts the plan's working assumption and changes the package's public surface).
Context needed: `verifier-rpc-provider` source and tests, `registry_contract.md §7`,
`stage4.ts`/`stage4.py`, `plans/membership_card_verifier_todo.md` item 3, strategic-plan.md
§G3, `plans/spec-consistency/inconsistencies/phase-3-consolidated-fixes.md` Tier 3 item (i).
Done when: `plans/g3-event-log-spec.md` exists specifying the exact chunking/retry algorithm,
function signature, and starting-block handling for both languages — and the caching-ownership
question is either confirmed or explicitly escalated.

**3.2 — Implement TS chunked event-log retrieval** (Who: Claude, inline — not delegated;
pagination/retry correctness against real RPC semantics is exactly the kind of logic where a
subtle off-by-one or missed-retry bug is expensive to catch later)
What: Implement `RegistryContract.getCardEventLog` (or the companion helper decided in 3.1) in
`verifier-rpc-provider`, per the 3.1 spec.
Context needed: `plans/g3-event-log-spec.md`, `verifier-rpc-provider` source.
Done when: implementation matches spec; existing mocked tests still pass.

**3.3 — Implement Python equivalent** (Who: Claude, inline, same rationale as 3.2)
What: Python-side equivalent of 3.2.
Context needed: `plans/g3-event-log-spec.md`, Python `verifier-rpc-provider` equivalent source.
Done when: implementation matches spec; existing mocked tests still pass.

**3.4 — Mocked-provider tests for chunking/retry** (Who: Haiku agent — mechanical once 3.1's
spec fixes the exact algorithm)
What: Write unit tests with a mocked RPC provider simulating: a range spanning multiple chunks,
a provider-imposed range-limit error mid-scan (verifying retry-with-smaller-window), and a
no-starting-block-cached case defaulting to the registry deploy block.
Context needed: `plans/g3-event-log-spec.md`, outputs of 3.2/3.3 (the actual implementation),
existing `EthersRpcProvider` test file as a pattern reference.
Done when: all three scenarios are covered and pass against the 3.2/3.3 implementations.

**3.5 — Update `press.md` OQ-B3** (Who: Haiku agent)
What: Update `press.md`'s Open Question OQ-B3 to reflect the current `getCardEventLog`
interface naming, replacing references to the pre-redesign `getLogEntries()` name.
Context needed: `press.md` (locate OQ-B3), `plans/g3-event-log-spec.md` for the correct current
signature/name.
Done when: OQ-B3 text matches the current interface; no other content in `press.md` altered.

**3.6 — Stage 4 integration check** (Who: Claude, inline)
What: Run Stage 4's `HISTORY_MISMATCH` cross-check against mocked-but-realistic event data
(from 3.4's fixtures) to confirm it now exercises real comparison logic instead of always
degrading against an empty log.
Context needed: `stage4.ts`/`stage4.py`, 3.4's test fixtures.
Done when: at least one integration test demonstrates `HISTORY_MISMATCH` correctly firing on a
genuine mismatch and correctly passing on a genuine match, using real (non-empty) event data.

**Phase 3 Milestone Review** (Who: Claude, inline)
Context needed: `plans/g3-event-log-spec.md`, outputs of 3.2–3.6.
Done when: TS/Python implementations are consistent, all mocked/unit tests pass, `press.md`
OQ-B3 is corrected, and the review explicitly records — in
`milestones/phase-3-summary.md` — that live-chain validation remains unvalidated and is a
follow-up blocked on David providing an RPC endpoint + deployed registry contract address.

---

## Phase 4: G4 — wire `Watcher` into `PolicyModule`

**Clarification checkpoint:** same as Phase 3 — no live Matrix homeserver or registry contract
is available for end-to-end validation. This phase stops at "wired and unit-tested."

**4.1 — Research Synapse lifecycle hook and resolve open question #5** (Who: Claude, inline)
What: Read `module.py`'s `PolicyModule.__init__`, `watcher.py`'s `Watcher` class,
`rpc_provider.py`'s `CardHeadEventSubscription`, and the vendored/installed Synapse module API
(check `.venv`/`site-packages` for Synapse's module interface docs or examples of other modules
performing async startup) to determine whether Synapse's module loader supports an async
startup hook, or whether `Watcher` must be started via `asyncio.create_task` from the
synchronous `__init__`. If the codebase and vendored Synapse source don't yield a definitive
answer, stop and ask David rather than guessing at production wiring semantics — this directly
affects production reliability (start/stop/reconnect behavior).
Context needed: `wallet-service/matrix-policy-module/src/matrix_policy_module/module.py`
(~lines 190-216), `watcher.py`, `rpc_provider.py`, Synapse's module API (search installed
package), `specs/object_specs/matrix_synapse_module.md` (~lines 90-118) for the config schema,
`plans/membership_card_verifier_todo.md` item 4, strategic-plan.md §G4.
Done when: a definitive answer on the lifecycle hook mechanism is documented (either found in
source, or confirmed by David), recorded at the top of `plans/g4-watcher-wiring-spec.md`.

**4.2 — Implement Watcher construction/start in PolicyModule** (Who: Claude, inline — not
delegated; wiring a long-lived subscription into a production module's lifecycle is exactly the
kind of change where getting reconnect/shutdown semantics wrong causes a silent production
outage, which is what this whole item exists to fix)
What: Construct and start the `Watcher` from `PolicyModule.__init__` (or the resolved lifecycle
hook from 4.1), using the already-rendered config keys (`arbitrum_rpc_ws_url`,
`registry_contract_address`, `watcher_backstop_interval_seconds`, etc.). Remove the existing
TODO at the construction site. Confirm clean shutdown/reconnect behavior against whatever
Synapse lifecycle mechanism 4.1 resolved.
Context needed: `plans/g4-watcher-wiring-spec.md`, `module.py`, `watcher.py`,
`specs/object_specs/matrix_synapse_module.md`.
Done when: `Watcher` is constructed and started on module init with no TODO remaining; existing
`Watcher`/`CardHeadEventSubscription` unit tests still pass unmodified (per strategic-plan.md
§G4 objective).

**4.3 — Unit tests for construction wiring** (Who: Haiku agent)
What: Write a unit test confirming `PolicyModule.__init__` constructs a `Watcher` with the
correct config values, mocking `Watcher.start` itself (not re-testing `Watcher`'s internal
logic, which is already covered).
Context needed: `plans/g4-watcher-wiring-spec.md`, outputs of 4.2, existing `PolicyModule` test
file as a pattern reference.
Done when: the test exists and passes, and fails if the construction call or a config key is
removed (sanity-check by temporarily breaking the wiring and confirming the test catches it).

**4.4 — Attempt smoke tests within sandbox constraints** (Who: Claude, inline)
What: Run the satisfying-card-join and revocation-force-part smoke tests referenced in
`plans/matrix-implementation-plan.md` Phase 6 against whatever mocked/sandbox test harness
exists today (not a live registry/homeserver, which isn't available). Document precisely what
was and wasn't exercised.
Context needed: `plans/matrix-implementation-plan.md` Phase 6, existing test harness for
`matrix-policy-module`.
Done when: sandbox-level smoke tests pass (or their absence/blockers are documented), and it's
explicitly recorded that live end-to-end validation against a real registry contract + Matrix
homeserver has not occurred.

**Phase 4 Milestone Review** (Who: Claude, inline)
Context needed: `plans/g4-watcher-wiring-spec.md`, outputs of 4.1–4.4.
Done when: the wiring is consistent with 4.1's resolved lifecycle mechanism, all sandbox-level
tests pass, and `milestones/phase-4-summary.md` explicitly records that live end-to-end
validation (satisfying-card join, revocation force-part against a real chain) remains a
follow-up blocked on David provisioning a test registry contract and Matrix homeserver.

---

## Phase 5: Close-out

**5.1 — Update the source TODO doc** (Who: Claude, inline)
What: Update `plans/membership_card_verifier_todo.md` to mark items 1–4 with their resolution
status: items 1 and 2 as implemented and fully tested; items 3 and 4 as implemented and
unit/mock-tested, with live validation flagged as blocked/pending David's infra. Link each item
to the relevant spec doc (`g1-...-spec.md` etc.) and milestone summary.
Context needed: outputs of Phases 1–4, `plans/membership_card_verifier_todo.md`.
Done when: the doc accurately reflects current status per item — do not mark anything "done"
that only has mock/unit validation as if it were live-validated.

**Clarification checkpoint:** confirm with David before editing `membership_card_verifier_todo.md` directly, since it's his tracking doc — show the proposed diff first.

**5.2 — Full-suite verification pass** (Who: Claude, inline)
What: Run the complete test suites for `verifier` (TS + Python), `client-sdk`, `wallet-service`,
and `matrix-policy-module` in one pass to confirm nothing across the four phases regressed
anything outside its own scope.
Context needed: none beyond running each package's existing test command.
Done when: all suites pass; a one-paragraph summary of the full change set (what shipped fully
tested vs. what's implemented-but-blocked-on-live-validation) is presented to David.

---

## Clarification Checkpoints (summary)

- **Phase 3, step 3.1:** if research shows event-log caching must live inside the shared
  package (not the caller), stop and confirm with David before implementing — this changes the
  package's public surface beyond what's currently assumed.
- **Phase 4, step 4.1:** if Synapse's module lifecycle hook mechanism isn't unambiguous from
  source, stop and ask David rather than guessing — this is production wiring, not a test-only
  concern.
- **End of Phase 3 and end of Phase 4:** explicitly present what was/wasn't live-validated
  before considering either phase "done" — neither should be described as fully verified given
  no live RPC/registry/homeserver access in this environment.
- **Phase 5, step 5.1:** show David the proposed diff to `membership_card_verifier_todo.md`
  before writing it, since it's his tracking document.
- **Any point:** if a Haiku agent's output doesn't match its spec doc closely enough to trust
  without a careful re-read, escalate that step to inline (Sonnet) rather than iterating with
  another Haiku round-trip — a second cheap-but-wrong attempt costs more in aggregate than doing
  it once, correctly, inline.
