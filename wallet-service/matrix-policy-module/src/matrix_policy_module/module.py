"""Synapse module entrypoint (Step 12).

Registers user_may_join_room and check_event_for_spam against Synapse's Spam
Checker callback category, **and** check_event_allowed against Synapse's
ThirdPartyEventRules callback category (see the "Join-attestation wire
transport" section below for why both categories turned out to be needed —
this corrects an earlier, wrong assumption that check_event_for_spam alone
was sufficient and that check_event_allowed could be skipped).

**Join-attestation wire transport — resolved 2026-07-12 (was an open item in
matrix_join_attestation_and_revocation.md §1), corrected 2026-07-16 (Step 20
live-stack integration test found the 2026-07-12 resolution's callback
choice was wrong):** `user_may_join_room`'s real signature is `(user, room,
is_invited)`, with no room for extra request content — a signed attestation
object cannot reach that callback at all, structurally, regardless of what
the client sends. The client embeds the attestation as a custom, namespaced
key (`io.cardprotocol.join_attestation`) in the `m.room.member` join event's
own content, same as always — Matrix event content is extensible by design,
the same mechanism MSC3083 (restricted rooms) uses to carry a signed join
authorization inside the join event itself.

**What was wrong, found by actually running a join against a real Synapse
process (this module had never been exercised live before Step 20):** the
2026-07-12 resolution assumed "state events (including `m.room.member`)
already pass through `check_event_for_spam`, which *does* receive the full
event object" — attributed to a matrix_synapse_module.md note. That's false
for the installed Synapse version. Traced through Synapse's own source:
`check_event_for_spam` is called from exactly one place,
`handlers/message.py`'s `_create_and_send_nonmember_event_locked` — a method
whose name says what it does. Joins never go through it: `room_member.py`'s
membership-update path calls `event_creation_handler.create_event` directly
and only ever invokes the Spam Checker category's `user_may_join_room`
(structurally blind to event content, as already known) before persisting
the join. **`check_event_for_spam` is never invoked for a join, full stop**
— every "join denied: ..." log line this module could ever have produced
was dead code in production; every join (attestation present or not, valid
or not) was silently allowed once `ModuleApiRoomPolicyResolver` was wired
(see that class's own docstring for the bug that masked this one:
before that fix, the module was *doubly* inert, so this gap wasn't visible
either). Confirmed live: a join with no attestation content, and separately
one with an empty `signatures` array, both returned Matrix's `200` success,
not the intended `403`.

The fix: `create_event` (which membership updates *do* call) runs the
ThirdPartyEventRules category's `check_event_allowed(event, state_events)`
callback — the "very experimental" one the 2026-07-12 note explicitly
rejected in favor of `check_event_for_spam`, on the strength of a citation
that turns out not to hold for joins specifically. `check_event_allowed` is
registered below and does the real join gating; `check_event_for_spam`'s
own join-shaped branch (`_authorize_join_event`) is kept only for direct
unit-test coverage of the shared decision logic (`_decide_join`) and as a
safety net should some future Synapse version route membership events
through it after all — it is not reachable via a real `/join` request today.
Ordinary (non-membership) posts are unaffected: `check_event_for_spam` does
run for `m.room.message` and other non-member events, exactly as before.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional, Protocol

# **Bug found and fixed 2026-07-16 (Step 20 live-stack integration test):**
# every branch below used to return `self.api.NOT_SPAM` /
# `self.api.errors.Codes.FORBIDDEN` — i.e. it read these off the *injected
# ModuleApi instance*. That's wrong: `NOT_SPAM` is a module-level sentinel
# exported from `synapse.module_api` (not an attribute of `ModuleApi`
# instances), and `Codes` lives at `synapse.api.errors.Codes` (ModuleApi
# instances have no `.errors` attribute at all). Against a real Synapse
# process this made *every single join attempt* — regardless of
# attestation validity or policy — crash with
# `AttributeError: 'ModuleApi' object has no attribute 'NOT_SPAM'` inside
# `user_may_join_room` (which unconditionally hit this line first, before
# `check_event_for_spam` / `_authorize_join_event` could even run),
# surfaced to the client as an opaque Matrix `M_UNKNOWN`/500, not the
# intended `M_FORBIDDEN`/403. Every unit test in `test/test_module.py`
# passed anyway because its `_FakeApi` test double defined `NOT_SPAM` and
# `errors.Codes.FORBIDDEN` as attributes *on the fake instance itself* —
# a mock shaped to match the (incorrect) calling code rather than the real
# `synapse.module_api.ModuleApi` surface, so the mismatch was invisible
# until this test ran against the real, live Synapse process. Fixed by
# importing both directly from where Synapse actually exports them, exactly
# as Synapse's own module-development docs show spam-checker callbacks
# doing it.
from synapse.api.errors import Codes
from synapse.module_api import NOT_SPAM

from matrix_policy_module.attestation import verify_join_attestation
from matrix_policy_module.cache import ChainWalkCache
from matrix_policy_module.chain_context import build_verifier
from matrix_policy_module.config import PolicyModuleConfig
from matrix_policy_module.ipfs_provider import HttpxIpfsProvider
from matrix_policy_module.membership_registry import MembershipRegistry
from matrix_policy_module.predicates import evaluate_room_predicate

logger = logging.getLogger(__name__)

_REVOKED_STATUSES = {"revoked", "loud_revocation"}
_CONTENT_BEARING_EVENT_TYPES = {"m.room.message"}
_JOIN_ATTESTATION_CONTENT_KEY = "io.cardprotocol.join_attestation"


class RoomPolicyResolver(Protocol):
    async def get_policy_id(self, room_id: str) -> Optional[str]: ...


class ModuleApiRoomPolicyResolver:
    """Default `RoomPolicyResolver`, backed by a real Synapse `ModuleApi`
    call — closes the "one open item" this module's docstring used to flag
    ("Synapse's exact ModuleApi call for reading a room's current
    `m.card.policy` state event content hasn't been confirmed"). Confirmed
    2026-07-16 against the installed Synapse version:
    `ModuleApi.get_room_state(room_id, event_filter)` returns a
    `{(event_type, state_key): Event}` mapping, filterable to exactly the
    one state event this module cares about.

    **Bug found and fixed 2026-07-16 (Step 20 live-stack integration
    test):** before this class existed, `PolicyModule.__init__` had no
    default for `room_policy_resolver` — Synapse's own module loader
    (`homeserver.yaml`'s `modules:` entry, `matrix/homeserver.yaml.template`)
    instantiates `PolicyModule(config, module_api)` with no
    `room_policy_resolver` keyword argument at all (that parameter exists
    purely for the test suite's `_FakeRoomPolicyResolver` doubles), so
    `self._room_policy_resolver` was always `None` in every real
    deployment. `_resolve_policy_id` treats `None` as "room has no
    `m.card.policy` state, not card-gated" (a legitimate, common case —
    most Matrix rooms aren't card-gated) — so a `None` resolver made
    `check_event_for_spam` defer to `NOT_SPAM` for every room
    unconditionally, including ones that *do* have real `m.card.policy`
    state. In effect, the entire card-gating mechanism was inert in every
    real deployment: any join or post succeeded regardless of attestation
    validity or policy satisfaction. Confirmed live, against this same
    integration test, before this fix: a join with no attestation content
    at all returned `200`, not the `403` `_authorize_join_event` was
    supposed to produce — `check_event_for_spam` never even reached the
    join-authorization branch, because its own top-of-function
    `_resolve_policy_id` call always returned `None` first.
    """

    def __init__(self, api: Any) -> None:
        self._api = api

    async def get_policy_id(self, room_id: str) -> Optional[str]:
        state = await self._api.get_room_state(room_id, [("m.card.policy", "")])
        event = state.get(("m.card.policy", ""))
        if event is None:
            return None
        content = getattr(event, "content", None)
        # **Bug found and fixed 2026-07-16 (Step 20 live-stack integration
        # test):** `isinstance(content, dict)` — a real Synapse EventBase's
        # `.content` is an `immutabledict` (confirmed live:
        # `synapse.util.frozenutils.freeze` produces one), which is a
        # Mapping but explicitly NOT a `dict` subclass
        # (`isinstance(immutabledict(...), dict)` is `False`). The
        # isinstance check above silently failed for every real Synapse
        # event, so this always returned None — masking
        # ModuleApiRoomPolicyResolver entirely, on top of (and only
        # discovered after fixing) the "resolver was never wired at all"
        # bug this class's own docstring describes. Duck-typing on `.get`
        # instead of gatekeeping on the concrete `dict` type is correct
        # here regardless of which Mapping implementation Synapse hands
        # this module.
        policy_id = content.get("policy_id") if hasattr(content, "get") else None
        return policy_id if isinstance(policy_id, str) else None


class PolicyModule:
    def __init__(
        self,
        config: dict,
        api: Any,
        *,
        room_policy_resolver: Optional[RoomPolicyResolver] = None,
        trusted_roots: Optional[list[str]] = None,
    ) -> None:
        self.config = PolicyModuleConfig.parse(config)
        self.api = api
        # Real deployments (Synapse's module loader, which never passes
        # room_policy_resolver — see ModuleApiRoomPolicyResolver's own
        # docstring for the bug this default fixes) get a real,
        # ModuleApi-backed resolver; tests inject a fake one explicitly.
        self._room_policy_resolver = room_policy_resolver or ModuleApiRoomPolicyResolver(api)
        self._verifier = build_verifier(self.config, trusted_roots or [])
        self._ipfs = HttpxIpfsProvider(self.config.ipfs_gateway_url)
        self._registry = MembershipRegistry.from_key_path(
            self.config.membership_registry_path, self.config.membership_registry_key_path
        )
        self._cache = ChainWalkCache(refresh_revocation=self._refresh_revocation)
        api.register_spam_checker_callbacks(
            user_may_join_room=self.user_may_join_room,
            check_event_for_spam=self.check_event_for_spam,
        )
        # check_event_allowed is the real join gate — see this class's
        # module-level docstring's "Join-attestation wire transport" section
        # (corrected 2026-07-16) for why check_event_for_spam alone, as
        # originally designed, can never see a join at all.
        api.register_third_party_rules_callbacks(check_event_allowed=self.check_event_allowed)

    async def _refresh_revocation(self, card_address: str):
        from matrix_policy_module.chain_context import verify_card_revocation

        result = await verify_card_revocation(self._verifier, card_address)
        return result.revocation, result.is_currently_valid

    # ---- join ----

    async def user_may_join_room(self, user: str, room: str, is_invited: bool) -> Any:
        # Structurally can't see the join attestation (no request content on
        # this callback) — always defers. The actual gate is
        # check_event_allowed (see module docstring's "Join-attestation wire
        # transport" section) — not check_event_for_spam, which turns out
        # never to be invoked for joins at all.
        return NOT_SPAM

    async def _decide_join(
        self, room_id: str, matrix_user_id: str, event_content: dict, policy_id: Optional[str]
    ) -> tuple[bool, Optional[str]]:
        """Shared join-authorization decision, independent of which Synapse
        callback contract (check_event_for_spam's Codes.FORBIDDEN/NOT_SPAM,
        or check_event_allowed's (bool, dict|None)) the caller needs to
        translate this into. Returns (allowed, deny_reason); deny_reason is
        None when allowed. On allow, also performs the registry/cache
        side effects (membership registration, revocation-cache seeding)
        that must happen exactly once, at the point the join is actually
        authorized."""
        if policy_id is None:
            return False, "room has no m.card.policy state"

        envelope = event_content.get(_JOIN_ATTESTATION_CONTENT_KEY)
        if envelope is None:
            return False, "no attestation presented"

        attestation = await verify_join_attestation(
            envelope,
            joining_matrix_user_id=matrix_user_id,
            server_name=self.config.matrix_server_name,
            freshness_seconds=self.config.join_attestation_freshness_seconds,
            verifier=self._verifier,
        )
        if not attestation.valid:
            return False, attestation.deny_reason

        predicate_document = await self._fetch_predicate_document(policy_id)
        if predicate_document is None:
            return False, "predicate document unreachable"

        satisfies_policy = self._safe_evaluate_predicate(predicate_document, attestation.chain, room_id, matrix_user_id)
        if satisfies_policy is not True:
            return False, "evaluation_error" if satisfies_policy is None else "policy_violation"

        watched_addresses = [link.card_address for link in attestation.chain] or [attestation.card_hash]
        self._registry.register(room_id, matrix_user_id, attestation.card_hash, watched_addresses, joined_at=_now_iso())
        if attestation.revocation is not None:
            self._cache.seed_from_join(
                attestation.card_hash, attestation.chain, attestation.revocation, attestation.is_currently_valid
            )

        return True, None

    async def check_event_allowed(self, event: Any, state_events: dict) -> tuple[bool, Optional[dict]]:
        """The real join gate (see module docstring's "Join-attestation
        wire transport" section) — Synapse's ThirdPartyEventRules
        `check_event_allowed` callback, confirmed live 2026-07-16 to be the
        one callback actually invoked for a `/join` request's resulting
        `m.room.member` event (`room_member.py`'s membership-update path
        calls `event_creation_handler.create_event`, which runs
        `check_event_allowed` — unlike `check_event_for_spam`, which that
        path never calls at all). `state_events` is the room's state
        immediately prior to this event, keyed `(event_type, state_key)`,
        handed to this callback directly by Synapse — no extra ModuleApi
        round-trip needed to read `m.card.policy` here, unlike
        `_resolve_policy_id`'s `check_event_for_spam` path."""
        if getattr(event, "type", None) != "m.room.member":
            return True, None
        content = getattr(event, "content", {})
        if content.get("membership") != "join":
            return True, None

        room_id = event.room_id
        matrix_user_id = event.sender

        policy_state_event = state_events.get(("m.card.policy", ""))
        policy_id: Optional[str] = None
        if policy_state_event is not None:
            policy_content = getattr(policy_state_event, "content", None)
            # See ModuleApiRoomPolicyResolver.get_policy_id's comment: a
            # real EventBase's .content is an immutabledict, not a dict
            # subclass — isinstance(x, dict) silently fails for it, so this
            # duck-types on .get instead (the same bug, found the same way,
            # fixed the same way, in the second of the two places it
            # existed).
            candidate = policy_content.get("policy_id") if hasattr(policy_content, "get") else None
            policy_id = candidate if isinstance(candidate, str) else None

        if policy_id is None:
            return True, None  # not a card-gated room — defer to normal event-auth

        allowed, reason = await self._decide_join(room_id, matrix_user_id, content, policy_id)
        if not allowed:
            logger.info("join denied for %s in %s: %s", matrix_user_id, room_id, reason)
            return False, None
        return True, None

    async def _authorize_join_event(self, event: Any) -> Any:
        # **Known unreachable in production against the installed Synapse
        # version, confirmed live 2026-07-16 — kept for direct unit-test
        # coverage of the shared _decide_join logic, and in case a future
        # Synapse version routes membership events through
        # check_event_for_spam after all.** See module docstring.
        room_id = event.room_id
        matrix_user_id = event.sender
        policy_id = await self._resolve_policy_id(room_id)
        allowed, reason = await self._decide_join(room_id, matrix_user_id, getattr(event, "content", {}), policy_id)
        if not allowed:
            logger.info("join denied for %s in %s: %s", matrix_user_id, room_id, reason)
            return Codes.FORBIDDEN
        return NOT_SPAM

    # ---- post ----

    async def check_event_for_spam(self, event: Any) -> Any:
        room_id = event.room_id
        policy_id = await self._resolve_policy_id(room_id)
        if policy_id is None:
            return NOT_SPAM  # not a card-gated room — defer to normal event-auth

        event_type = getattr(event, "type", None)
        if event_type == "m.room.member" and getattr(event, "content", {}).get("membership") == "join":
            return await self._authorize_join_event(event)

        if event_type not in _CONTENT_BEARING_EVENT_TYPES:
            return NOT_SPAM  # other state events pass through; power levels handle those

        matrix_user_id = event.sender
        card_hash = self._registry.resolve_card_hash(room_id, matrix_user_id)
        if card_hash is None:
            logger.info("post denied for %s in %s: membership_not_registered", matrix_user_id, room_id)
            return Codes.FORBIDDEN

        cached = await self._cache.get(card_hash)
        if cached.revocation.status in _REVOKED_STATUSES:
            logger.info("post denied for %s in %s: card revoked", matrix_user_id, room_id)
            return Codes.FORBIDDEN

        predicate_document = await self._fetch_predicate_document(policy_id)
        if predicate_document is None:
            logger.warning("post denied for %s in %s: predicate document unreachable", matrix_user_id, room_id)
            return Codes.FORBIDDEN

        satisfies_policy = self._safe_evaluate_predicate(predicate_document, cached.chain, room_id, matrix_user_id)
        if satisfies_policy is not True:
            reason = "evaluation_error" if satisfies_policy is None else "policy_violation"
            logger.info("post denied for %s in %s: %s", matrix_user_id, room_id, reason)
            return Codes.FORBIDDEN

        return NOT_SPAM

    # ---- shared helpers ----

    def _safe_evaluate_predicate(
        self, predicate_document: dict[str, Any], chain: list, room_id: str, matrix_user_id: str
    ) -> Optional[bool]:
        """Wraps predicates.evaluate_room_predicate so a bug or unexpected
        shape in the evaluator denies (per matrix_room_membership.md §4's
        "Predicate evaluation itself throws" row) rather than propagating an
        uncaught exception out of a Synapse callback with undefined
        allow/deny consequences. Returns None (denied, logged as
        evaluation_error) on any exception, True/False otherwise."""
        try:
            return evaluate_room_predicate(predicate_document, chain)
        except Exception:
            logger.exception("predicate evaluation raised for %s in %s", matrix_user_id, room_id)
            return None

    async def _resolve_policy_id(self, room_id: str) -> Optional[str]:
        # NOTE (still genuinely open, unlike the resolver-wiring gap this
        # module's docstring used to describe — that part is fixed, see
        # ModuleApiRoomPolicyResolver): this still doesn't distinguish "room
        # genuinely has no m.card.policy state" (pass through, per
        # matrix_synapse_module.md) from "state read failed" (should deny,
        # per matrix_room_membership.md §4's deny-by-default failure table —
        # a read failure is not the same as absence). Both still collapse to
        # None here: ModuleApiRoomPolicyResolver.get_policy_id returns None
        # for genuine absence, but an exception from
        # ModuleApi.get_room_state (network/DB error) currently propagates
        # uncaught rather than being distinguished and denied. Left as
        # flagged, not fixed, in this pass — Step 20's test doesn't exercise
        # a state-read failure, so nothing here was verified against that
        # case; closing it properly means auditing this against every row of
        # §4's failure table, which is more than this pass's scope.
        if self._room_policy_resolver is None:
            return None
        return await self._room_policy_resolver.get_policy_id(room_id)

    async def _fetch_predicate_document(self, policy_id: str) -> Optional[dict[str, Any]]:
        try:
            raw = await self._ipfs.fetch(policy_id)
            return json.loads(raw)
        except Exception:
            return None


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
