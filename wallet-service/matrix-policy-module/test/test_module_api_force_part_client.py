"""ModuleApiForcePartClient: confirms the in-process ModuleApi call shape
(no HTTP, no admin token) — resolved 2026-07-12 after confirming no Synapse
Admin API endpoint exists for forcing a room leave."""

import pytest

from matrix_policy_module.watcher import ModuleApiForcePartClient


class _FakeModuleApi:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def update_room_membership(self, sender, target, room_id, new_membership, content=None):
        self.calls.append(
            {"sender": sender, "target": target, "room_id": room_id, "new_membership": new_membership}
        )


@pytest.mark.asyncio
async def test_force_part_calls_update_room_membership_with_leave() -> None:
    api = _FakeModuleApi()
    client = ModuleApiForcePartClient(api, enforcement_sender="@matrix-policy-bot:matrix.internal")

    await client.force_part("!room:matrix.internal", "@card_abc:matrix.internal")

    assert api.calls == [
        {
            "sender": "@matrix-policy-bot:matrix.internal",
            "target": "@card_abc:matrix.internal",
            "room_id": "!room:matrix.internal",
            "new_membership": "leave",
        }
    ]
