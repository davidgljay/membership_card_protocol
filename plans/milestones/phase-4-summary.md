# Phase 4 (G4) Milestone Summary — wire `Watcher` into `PolicyModule`

Part of `plans/todo-implementation-plan.md`, resolving
`plans/completed/membership_card_verifier_todo.md` item 4. Full design spec:
`plans/g4-watcher-wiring-spec.md`.

## What shipped

- **Lifecycle hook resolved from source, not guessed:**
  `ModuleApi.run_as_background_process(desc, func, *args, **kwargs)`
  (confirmed in the installed Synapse's `synapse/module_api/__init__.py`) is
  a synchronous method safely callable from `PolicyModule.__init__` that
  fires an async function off as a managed background process — exactly the
  "schedule background work from sync `__init__`" mechanism the existing
  TODO comment flagged as unconfirmed.
- `PolicyModule.__init__` now constructs `CardHeadEventSubscription`,
  `ModuleApiForcePartClient`, and `Watcher` from the module's own config
  (`arbitrum_rpc_ws_url`, `registry_contract_address`,
  `enforcement_matrix_user_id`, `watcher_backstop_interval_seconds` — all
  pre-existing config fields, already parsed by `PolicyModuleConfig`), and
  starts both `run_subscription_loop` and `run_backstop_loop` via
  `api.run_as_background_process(...)`. The construction-site TODO comment
  is removed.
- Reconnect-on-drop needed no new code — it's already implemented inside
  `Watcher`/`CardHeadEventSubscription`'s own lifecycle (unit-tested
  separately, pre-existing). No explicit shutdown hook was wired: confirmed
  by source inspection that `ModuleApi` exposes none in the installed
  Synapse version — an honest absence, not a shortcut around one that
  exists.
- New unit test (`test_module.py`) confirms `PolicyModule.__init__`
  constructs a `Watcher` wired to the correct config values and starts both
  loops via `run_as_background_process` (mocking that call, not re-testing
  `Watcher`'s internal logic). Sanity-checked during implementation: the
  test was confirmed to fail when the wiring was temporarily removed, then
  passed again once restored.

## Explicit scope narrowing — flagged, not silently dropped

The pre-existing TODO comment also named a fourth step: startup
reconciliation (`MembershipRegistry.reconcile(...)` against Synapse's live
room-membership list). Research during 4.1 found **no `ModuleApi` method to
enumerate current membership across every card-gated room** — `reconcile()`
itself already exists and is already unit-tested, but there is no confirmed
way to produce the `live_memberships` set it needs. Per this phase's own
instruction to avoid guessing production wiring semantics, this was **not**
implemented with an invented enumeration mechanism. It remains open,
documented both in `plans/g4-watcher-wiring-spec.md` §2 and as an inline
"KNOWN GAP" comment at the construction site in `module.py`.

**Practical effect of the gap:** if the module restarts and a member left a
card-gated room while it was down, that stale registry entry is not pruned
at startup — it's still naturally corrected the next time that address's
post/join path is exercised (per `MembershipRegistry.reconcile`'s own
docstring on what "stale" means), just not proactively at boot. Not a
security gap (deny-by-default posture is unaffected), a staleness gap.

## Test results

- `matrix-policy-module`: 98/98 passing (97 pre-existing/from Phase 3 + 1 new
  construction-wiring test), including `test_watcher.py`'s full 10-test
  suite confirmed unaffected by this wiring change.
- No new mypy errors introduced (verified against the pre-change baseline —
  5 pre-existing `AsyncEth.contract` overload/union-attr errors unrelated to
  this change, same class of errors present before).

## What was NOT validated — explicitly flagged, blocked on David

Same constraint as Phase 3: **no live Matrix homeserver or deployed
registry contract is available in this sandbox.** Per
`plans/matrix-implementation-plan.md` Phase 6, the satisfying-card-join and
revocation-force-part smoke tests require both and have **not** been
executed as part of this phase — only sandbox-level unit/construction
testing was possible.

**Follow-up, blocked on David:** provision a test registry contract and
Matrix homeserver, then run the Phase 6 smoke tests (a card that satisfies a
room's policy successfully joins; a card revoked on-chain after joining gets
force-parted by the watcher within its detection window) against a real
deployment. Until then, do not describe the watcher's live event-driven
revocation path as end-to-end verified anywhere — only its construction,
wiring, and already-existing unit-level logic are.
