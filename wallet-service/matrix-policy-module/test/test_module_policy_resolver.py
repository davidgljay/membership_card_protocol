"""Tests for ModuleApiRoomPolicyResolver (matrix_policy_module.module),
the default RoomPolicyResolver added 2026-07-16 after the Step 20
live-stack integration test found that PolicyModule had no default at all
— every real Synapse deployment (which never passes room_policy_resolver
itself) silently ran with self._room_policy_resolver == None, making
check_event_for_spam defer to NOT_SPAM for every room, card-gated or not.
See module.py's ModuleApiRoomPolicyResolver docstring for the full story.

Exercises the resolver directly against a fake ModuleApi shaped like the
real synapse.module_api.ModuleApi.get_room_state contract confirmed live
(`{(event_type, state_key): Event}` mapping, Event exposing `.content`) —
not against a mock of this resolver's own behavior, which would just
re-assert the implementation.
"""

import pytest
from immutabledict import immutabledict

from matrix_policy_module.module import ModuleApiRoomPolicyResolver


class _FakeEvent:
    def __init__(self, content: dict) -> None:
        # A real synapse.events.EventBase's .content is an immutabledict,
        # not a plain dict (isinstance(immutabledict(...), dict) is
        # False) — using immutabledict here, not dict, is what makes these
        # tests actually able to catch a regression of the 2026-07-16 bug
        # where get_policy_id's `isinstance(content, dict)` check silently
        # failed against every real Synapse event. See
        # ModuleApiRoomPolicyResolver.get_policy_id's own comment.
        self.content = immutabledict(content)


class _FakeModuleApi:
    def __init__(self, state: dict) -> None:
        self._state = state
        self.calls: list[tuple[str, object]] = []

    async def get_room_state(self, room_id: str, event_filter=None):
        self.calls.append((room_id, event_filter))
        return self._state


@pytest.mark.asyncio
async def test_returns_policy_id_when_state_present() -> None:
    api = _FakeModuleApi({("m.card.policy", ""): _FakeEvent({"policy_id": "bafyroompolicy"})})
    resolver = ModuleApiRoomPolicyResolver(api)

    result = await resolver.get_policy_id("!room:matrix.internal")

    assert result == "bafyroompolicy"
    # Confirms the resolver filters get_room_state to exactly the one
    # state event it needs, rather than fetching all room state.
    assert api.calls == [("!room:matrix.internal", [("m.card.policy", "")])]


@pytest.mark.asyncio
async def test_returns_none_when_room_has_no_card_policy_state() -> None:
    api = _FakeModuleApi({})
    resolver = ModuleApiRoomPolicyResolver(api)

    result = await resolver.get_policy_id("!ungated-room:matrix.internal")

    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_policy_id_is_not_a_string() -> None:
    # Malformed state content (matrix_room_membership.md §4's
    # "malformed_predicate_document" territory one level up) — deny-by-
    # default relies on this collapsing to None (pass-through-then-deny at
    # the predicate-document-fetch stage), not on this resolver crashing.
    api = _FakeModuleApi({("m.card.policy", ""): _FakeEvent({"policy_id": 12345})})
    resolver = ModuleApiRoomPolicyResolver(api)

    result = await resolver.get_policy_id("!room:matrix.internal")

    assert result is None


@pytest.mark.asyncio
async def test_returns_none_when_content_is_missing_entirely() -> None:
    api = _FakeModuleApi({("m.card.policy", ""): _FakeEvent({})})
    resolver = ModuleApiRoomPolicyResolver(api)

    result = await resolver.get_policy_id("!room:matrix.internal")

    assert result is None
