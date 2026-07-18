# G4 Spec — wire `Watcher` into `PolicyModule`

Implements `plans/todo-implementation-plan.md` Phase 4 (G4), resolving
`plans/completed/membership_card_verifier_todo.md` item 4.

## 1. Lifecycle hook — resolved (step 4.1's open question #5)

**Definitive answer, found in the installed Synapse source, not guessed:**
`synapse/module_api/__init__.py`'s `ModuleApi.run_as_background_process(desc, func, *args, bg_start_span=True, **kwargs)`
(~line 1658). It is a **synchronous** method — safely callable from
`PolicyModule.__init__` (which is itself sync, since Synapse's module loader
never awaits construction) — that fires `func` (an async function/coroutine)
off as a Synapse-managed background process and returns immediately. Its own
docstring: "This should be used to wrap processes which are fired off to run
in the background, instead of being associated with a particular request...
appropriate for... firing-and-forgetting in the middle of a normal synapse
async function." This is exactly the "schedule a background task on the
running event loop" mechanism the existing TODO comment in `module.py`
(~lines 189-216) flagged as "unconfirmed — needs research, not assumed."

No further escalation to David needed for the core startup-hook question —
call `self.api.run_as_background_process("card-protocol-watcher-subscription", self._watcher.run_subscription_loop)`
and a second call for the backstop loop, both from `__init__`.

**Shutdown/reconnect semantics — partially resolved, one gap flagged
honestly rather than guessed:**
- **Reconnect-on-drop:** already handled *inside* `Watcher` itself — nothing
  new needed. `run_subscription_loop`'s `finally: await self._subscription.close()`
  plus `CardHeadEventSubscription`'s own connect/close lifecycle, combined
  with `Watcher.catch_up(from_block, to_block)` (which sets `is_catching_up`
  during the gap-replay), is the existing, already-unit-tested reconnect
  design — wiring it into `PolicyModule` doesn't change this, it only starts
  it running.
- **Clean shutdown-on-process-exit:** **no dedicated shutdown hook exists on
  `ModuleApi`** in the installed Synapse version — confirmed by grepping
  `module_api/__init__.py` for any `shutdown`/`stop`/`addSystemEventTrigger`-
  style public method; none exists. Twisted's reactor does expose
  `addSystemEventTrigger`, but only via `self._hs.get_reactor()` — a private
  `ModuleApi` attribute (`_hs`), not part of its public surface, and this
  codebase's established discipline (see `watcher.py`'s own docstring on why
  it uses `update_room_membership` instead of a guessed admin-API endpoint)
  is to not reach into private/unconfirmed internals. **Decision: do not
  wire an explicit shutdown hook.** The background task started via
  `run_as_background_process` terminates when the Synapse process itself
  exits — acceptable for a long-running daemon subscription with no graceful-
  drain requirement documented anywhere in this module's specs. This
  matches the absence of any public teardown hook in this Synapse version;
  it is not a shortcut around one that exists.

## 2. Scope narrowing on the existing TODO comment's step 3 (startup
   reconciliation) — flagged, not implemented, not guessed

The existing TODO comment in `module.py` (~line 195) lists a fourth step:
"Call `self._registry.reconcile(...)` once at startup against Synapse's live
room-membership list... before the watcher starts consuming events."
`MembershipRegistry.reconcile(live_memberships: set[tuple[room_id, matrix_user_id]])`
already exists and is already unit-tested — but **producing that
`live_memberships` set requires enumerating every card-gated room's current
membership from Synapse, and no such enumeration method exists on
`ModuleApi`** (confirmed by grep: no `get_room_members`/`list_rooms`-style
call; `get_state_events_in_room` fetches state for one already-known room
ID, but this module has no independent list of "every card-gated room ID"
to iterate — the registry only tracks rooms it already knows about
reactively, which is exactly the set reconciliation is trying to correct
against ground truth).

**Decision: this spec implements Watcher construction + starting the
subscription/backstop loops only (the item's actual title/ask — "wire
Watcher into PolicyModule"). Startup reconciliation is explicitly left as a
separate, still-open gap** — inventing a live-membership enumeration
mechanism now would be exactly the kind of guessed production wiring
semantics step 4.1's own instructions say to avoid. This is flagged in the
Phase 4 milestone summary as a known follow-up, not silently dropped.

## 3. Implementation — `PolicyModule.__init__`

Replace the TODO comment block in
`wallet-service/matrix-policy-module/src/matrix_policy_module/module.py`
(~lines 189-216) with:

```python
from matrix_policy_module.rpc_provider import CardHeadEventSubscription
from matrix_policy_module.watcher import ModuleApiForcePartClient, Watcher

# ... inside __init__, after self._cache is constructed:

subscription = CardHeadEventSubscription(
    self.config.arbitrum_rpc_ws_url, self.config.registry_contract_address
)
force_part_client = ModuleApiForcePartClient(api, self.config.enforcement_matrix_user_id)
self._watcher = Watcher(
    self._registry,
    self._cache,
    force_part_client,
    subscription,
    backstop_interval_seconds=self.config.watcher_backstop_interval_seconds,
)
# Synapse's module loader calls __init__ synchronously — ModuleApi.run_as_background_process
# is the confirmed (not guessed) mechanism for firing off long-running async work from here;
# see plans/g4-watcher-wiring-spec.md §1. No explicit shutdown hook is wired (see same
# section for why: none exists on ModuleApi in this Synapse version) — reconnect-on-drop is
# already handled inside Watcher/CardHeadEventSubscription's own lifecycle.
#
# KNOWN GAP, not fixed here (plans/g4-watcher-wiring-spec.md §2): startup reconciliation
# (self._registry.reconcile(...) against Synapse's live room-membership list) is not wired —
# no ModuleApi method exists to enumerate current membership across every card-gated room.
# A membership registered before this module restarted, where the member since left while
# the module was down, will remain in the registry as a stale entry until naturally corrected
# (see MembershipRegistry.reconcile's own docstring for what "stale" means here) — flagged as
# a follow-up, not silently dropped.
api.run_as_background_process("card-protocol-watcher-subscription", self._watcher.run_subscription_loop)
api.run_as_background_process("card-protocol-watcher-backstop", self._watcher.run_backstop_loop)
```

Placement: after `self._cache = ChainWalkCache(...)` (the watcher needs
`self._registry` and `self._cache`, both already constructed by that point)
and before the two `api.register_*_callbacks(...)` calls already at the end
of `__init__` (no ordering dependency between them, but keeping callback
registration last matches the method's existing structure).

**Store `self._watcher`** (not just a local variable) — tests need to
assert on its construction (step 4.3), and a future caller might need it
(e.g. for introspection/health checks), matching how `self._registry`/
`self._cache`/`self._verifier` are already stored as instance attributes
rather than locals.

## 4. Test — step 4.3 (unit, mocking `Watcher.start` — actually
   `run_subscription_loop`/`run_backstop_loop`, since `Watcher` has no
   single `start` method; see §3's actual call shape)

Add to `wallet-service/matrix-policy-module/test/test_module.py`, following
its existing `_make_module`/fixture patterns:

```python
def test_policy_module_constructs_watcher_with_correct_config(tmp_path, monkeypatch):
    """Confirms __init__ constructs a Watcher wired to this module's own
    config values, and starts both loops via ModuleApi.run_as_background_process
    — mocking run_as_background_process itself (not re-testing Watcher's
    internal loop logic, already covered in test_watcher.py)."""
    background_calls = []

    def _fake_run_as_background_process(desc, func, *args, **kwargs):
        background_calls.append((desc, func))

    mod, api = _make_module(tmp_path)  # or however this file's existing fixture wires api
    # If _make_module's fake api doesn't already have run_as_background_process, this test
    # needs to construct its own module instance with a fake api that does — follow
    # whichever pattern _make_module/_FakeApi already establishes in this file.

    assert mod._watcher is not None
    assert mod._watcher._backstop_interval_seconds == mod.config.watcher_backstop_interval_seconds
    assert isinstance(mod._watcher._subscription, CardHeadEventSubscription)
    assert mod._watcher._subscription._ws_url == mod.config.arbitrum_rpc_ws_url
    assert mod._watcher._subscription._contract_address == mod.config.registry_contract_address
    assert isinstance(mod._watcher._admin_client, ModuleApiForcePartClient)
    assert mod._watcher._admin_client._enforcement_sender == mod.config.enforcement_matrix_user_id

    # Both loops started via run_as_background_process, not called directly (would block).
    descs = [c[0] for c in background_calls]
    assert "card-protocol-watcher-subscription" in descs
    assert "card-protocol-watcher-backstop" in descs
```

**Sanity-check per the plan's own done-when:** temporarily comment out the
`self._watcher = Watcher(...)` line (or one of the `run_as_background_process`
calls) locally while iterating, confirm this test fails, then restore —
standard "does the test actually catch a break" check, not something to
leave as a permanent code comment.

Check whether `test_module.py`'s existing `_make_module`/`_FakeApi` fixture
already stubs every `PolicyModuleConfig` field this test needs
(`arbitrum_rpc_ws_url`, `registry_contract_address`,
`enforcement_matrix_user_id`, `watcher_backstop_interval_seconds`) — if the
existing fixture's config dict is missing any of these (likely, since
nothing previously read them), extend the fixture's config dict rather than
duplicating a whole new one, and confirm this doesn't break other tests
already using that fixture (these are all required fields per
`config.py`'s `PolicyModuleConfig.parse`, so the fixture almost certainly
already supplies them — if it does, no fixture change is needed at all,
only this new test).

## 5. Smoke tests within sandbox constraints — step 4.4

Per `plans/matrix-implementation-plan.md` Phase 6, the satisfying-card-join
and revocation-force-part smoke tests require a live Matrix homeserver and
deployed registry contract, neither available in this sandbox (same
constraint as Phase 3). What **can** be exercised without those: confirm
`test_watcher.py`'s existing unit tests (already covering
`handle_card_head_updated`, force-part retry, backstop loop, catch-up) still
pass unmodified now that `Watcher` is actually constructed elsewhere in the
codebase — i.e. confirm this wiring change didn't regress `Watcher`'s own
already-tested behavior. Document explicitly (in the Phase 4 milestone
summary) that this is the extent of validation possible here — live
satisfying-card-join and revocation-force-part smoke tests remain
unexecuted, a follow-up blocked on David provisioning a test registry
contract and Matrix homeserver, per the plan's own Phase 4 clarification
checkpoint.

## 6. Done-when checklist for 4.2/4.3/4.4

- 4.2: `Watcher` constructed and both loops started via
  `ModuleApi.run_as_background_process` in `PolicyModule.__init__`, per §3;
  the TODO comment block is removed (replaced by the shorter "known gap"
  note for startup reconciliation only, per §2); existing
  `Watcher`/`CardHeadEventSubscription` unit tests (`test_watcher.py`) still
  pass unmodified.
- 4.3: the new construction-wiring test from §4 exists, passes, and is
  confirmed to fail when the wiring is broken (sanity-checked once during
  implementation, not left broken).
- 4.4: `test_watcher.py`'s full existing suite passes; the Phase 4 milestone
  summary explicitly records that live end-to-end validation (satisfying-
  card join, revocation force-part against a real chain + homeserver) has
  not occurred, and that startup reconciliation (§2) remains a distinct,
  separately-flagged open gap — not resolved by this phase, not silently
  dropped either.
