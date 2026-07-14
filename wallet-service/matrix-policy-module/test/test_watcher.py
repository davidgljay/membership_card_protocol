import asyncio
import os

import pytest
from membership_card_verifier import RevocationStatus

from matrix_policy_module.cache import ChainWalkCache
from matrix_policy_module.membership_registry import MembershipRegistry
from matrix_policy_module.watcher import Watcher

_KEY = os.urandom(32)


def _not_revoked() -> RevocationStatus:
    return RevocationStatus(status="not_revoked", code=None, effective_date=None, data_freshness_seconds=0)


def _revoked(code: int) -> RevocationStatus:
    return RevocationStatus(status="revoked", code=code, effective_date="2026-07-12", data_freshness_seconds=0)


def _loud_revoked(code: int) -> RevocationStatus:
    return RevocationStatus(status="loud_revocation", code=code, effective_date="2026-07-12", data_freshness_seconds=0)


class _FakeAdminClient:
    def __init__(self, fail_times: int = 0) -> None:
        self.calls: list[tuple[str, str]] = []
        self._fail_times = fail_times

    async def force_part(self, room_id: str, matrix_user_id: str) -> None:
        if self._fail_times > 0:
            self._fail_times -= 1
            raise RuntimeError("synapse admin API unreachable")
        self.calls.append((room_id, matrix_user_id))


class _FakeSubscription:
    def __init__(self) -> None:
        self.get_logs_since_calls: list[tuple[int, int | str]] = []

    async def connect(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def subscribe_card_head_updated(self):
        return
        yield  # pragma: no cover - makes this an async generator

    async def get_logs_since(self, from_block: int, to_block=None):
        self.get_logs_since_calls.append((from_block, to_block))
        return []


def _make_watcher(tmp_path, revocation_by_address: dict, admin_client=None, backstop_interval_seconds=3600):
    registry = MembershipRegistry(str(tmp_path / "registry.enc"), _KEY)

    async def refresh(address: str):
        status = revocation_by_address.get(address, _not_revoked())
        return status, status.status == "not_revoked"

    cache = ChainWalkCache(refresh_revocation=refresh)
    watcher = Watcher(
        registry=registry,
        cache=cache,
        admin_client=admin_client or _FakeAdminClient(),
        subscription=_FakeSubscription(),
        backstop_interval_seconds=backstop_interval_seconds,
        force_part_retry_base_delay_seconds=0.001,
    )
    return watcher, registry


@pytest.mark.asyncio
async def test_event_for_unwatched_address_is_ignored(tmp_path) -> None:
    admin_client = _FakeAdminClient()
    watcher, registry = _make_watcher(tmp_path, {"0xcard": _revoked(801)}, admin_client)
    # No membership registered for 0xcard at all.
    await watcher.handle_card_head_updated("0xcard")
    assert admin_client.calls == []


@pytest.mark.asyncio
async def test_revocation_triggers_force_part_for_every_dependent_membership(tmp_path) -> None:
    admin_client = _FakeAdminClient()
    watcher, registry = _make_watcher(tmp_path, {"0xancestor": _revoked(801)}, admin_client)
    registry.register("!room1:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")
    registry.register("!room2:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")

    await watcher.handle_card_head_updated("0xancestor")

    assert set(admin_client.calls) == {("!room1:x", "@card:x"), ("!room2:x", "@card:x")}
    # Membership entries removed after successful force-part.
    assert registry.resolve_card_hash("!room1:x", "@card:x") is None
    assert registry.resolve_card_hash("!room2:x", "@card:x") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("status_factory", [lambda: _revoked(801), lambda: _loud_revoked(901)])
async def test_force_part_identical_for_8xx_and_9xx(tmp_path, status_factory) -> None:
    admin_client = _FakeAdminClient()
    watcher, registry = _make_watcher(tmp_path, {"0xcard": status_factory()}, admin_client)
    registry.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    await watcher.handle_card_head_updated("0xcard")
    assert admin_client.calls == [("!room:x", "@card:x")]


@pytest.mark.asyncio
async def test_non_revocation_does_not_force_part(tmp_path) -> None:
    admin_client = _FakeAdminClient()
    watcher, registry = _make_watcher(tmp_path, {"0xcard": _not_revoked()}, admin_client)
    registry.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    await watcher.handle_card_head_updated("0xcard")
    assert admin_client.calls == []
    assert registry.resolve_card_hash("!room:x", "@card:x") == "0xcard"


@pytest.mark.asyncio
async def test_force_part_retries_on_failure_then_succeeds(tmp_path) -> None:
    admin_client = _FakeAdminClient(fail_times=2)
    watcher, registry = _make_watcher(tmp_path, {"0xcard": _revoked(801)}, admin_client)
    registry.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    await watcher.handle_card_head_updated("0xcard")
    assert admin_client.calls == [("!room:x", "@card:x")]
    assert registry.resolve_card_hash("!room:x", "@card:x") is None


@pytest.mark.asyncio
async def test_force_part_permanent_failure_leaves_membership_intact(tmp_path) -> None:
    admin_client = _FakeAdminClient(fail_times=100)
    watcher, registry = _make_watcher(tmp_path, {"0xcard": _revoked(801)}, admin_client)
    registry.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    await watcher.handle_card_head_updated("0xcard")
    # Force-part never succeeded — membership (and thus post-time deny floor
    # via a revoked cache entry) remains, per §3.3's failure table.
    assert registry.resolve_card_hash("!room:x", "@card:x") == "0xcard"


@pytest.mark.asyncio
async def test_backstop_loop_catches_missed_revocation(tmp_path) -> None:
    admin_client = _FakeAdminClient()
    watcher, registry = _make_watcher(tmp_path, {"0xcard": _revoked(801)}, admin_client, backstop_interval_seconds=60)
    registry.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    stop_event = asyncio.Event()

    async def _stop_after_one_pass():
        await asyncio.sleep(0.05)
        stop_event.set()

    watcher._backstop_interval_seconds = 0.01  # speed up for the test
    await asyncio.gather(watcher.run_backstop_loop(stop_event), _stop_after_one_pass())

    assert admin_client.calls == [("!room:x", "@card:x")]


@pytest.mark.asyncio
async def test_catch_up_marks_stale_during_replay_and_clears_after(tmp_path) -> None:
    watcher, registry = _make_watcher(tmp_path, {})
    assert watcher.is_catching_up is False
    await watcher.catch_up(from_block=100, to_block=200)
    assert watcher.is_catching_up is False  # cleared after completion
    assert watcher._subscription.get_logs_since_calls == [(100, 200)]


@pytest.mark.asyncio
async def test_watch_set_ref_counting_after_room_leave(tmp_path) -> None:
    admin_client = _FakeAdminClient()
    watcher, registry = _make_watcher(tmp_path, {}, admin_client)
    registry.register("!room1:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")
    registry.register("!room2:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")

    registry.remove_membership("!room1:x", "@card:x")
    assert "0xancestor" in registry.watched_addresses()  # still depended on by room2

    registry.remove_membership("!room2:x", "@card:x")
    assert "0xancestor" not in registry.watched_addresses()

    # An event for the now-unwatched address is a no-op.
    await watcher.handle_card_head_updated("0xancestor")
    assert admin_client.calls == []
