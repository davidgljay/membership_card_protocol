import os

import pytest

from matrix_policy_module.membership_registry import MembershipRegistry, RegistryStateError

_KEY = os.urandom(32)


def _registry(tmp_path) -> MembershipRegistry:
    return MembershipRegistry(str(tmp_path / "registry.enc"), _KEY)


def test_resolve_card_hash_after_register(tmp_path) -> None:
    reg = _registry(tmp_path)
    reg.register("!room:matrix.internal", "@card_abc:matrix.internal", "0xcardhash", ["0xcardhash", "0xancestor"], "2026-07-12T00:00:00Z")
    assert reg.resolve_card_hash("!room:matrix.internal", "@card_abc:matrix.internal") == "0xcardhash"


def test_resolve_card_hash_missing_entry_returns_none(tmp_path) -> None:
    reg = _registry(tmp_path)
    assert reg.resolve_card_hash("!room:x", "@nobody:x") is None


def test_watch_set_survives_partial_leave(tmp_path) -> None:
    reg = _registry(tmp_path)
    reg.register("!room1:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")
    reg.register("!room2:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")

    reg.remove_membership("!room1:x", "@card:x")
    # Still a member of room2, so the watch-set still contains its addresses.
    assert reg.watched_addresses() == {"0xcard", "0xancestor"}

    reg.remove_membership("!room2:x", "@card:x")
    # No active membership depends on these addresses anymore.
    assert reg.watched_addresses() == set()


def test_memberships_for_address_used_for_force_part(tmp_path) -> None:
    reg = _registry(tmp_path)
    reg.register("!room1:x", "@card:x", "0xcard", ["0xcard", "0xancestor"], "2026-07-12T00:00:00Z")
    reg.register("!room2:x", "@other:x", "0xother", ["0xother"], "2026-07-12T00:00:00Z")

    assert reg.memberships_for_address("0xancestor") == [("!room1:x", "@card:x")]
    assert reg.memberships_for_address("0xother") == [("!room2:x", "@other:x")]
    assert reg.memberships_for_address("0xnonexistent") == []


def test_registry_survives_restart_encrypted_and_reloadable(tmp_path) -> None:
    path = str(tmp_path / "registry.enc")
    reg1 = MembershipRegistry(path, _KEY)
    reg1.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    raw = (tmp_path / "registry.enc").read_bytes()
    assert b"0xcard" not in raw  # file contents are unreadable without the key
    assert b"@card:x" not in raw

    reg2 = MembershipRegistry(path, _KEY)
    assert reg2.resolve_card_hash("!room:x", "@card:x") == "0xcard"


def test_wrong_key_fails_loudly_not_silently_empty(tmp_path) -> None:
    path = str(tmp_path / "registry.enc")
    reg1 = MembershipRegistry(path, _KEY)
    reg1.register("!room:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")

    wrong_key = os.urandom(32)
    with pytest.raises(RegistryStateError):
        MembershipRegistry(path, wrong_key)


def test_reconcile_prunes_stale_and_reports_unregistered_live_memberships(tmp_path) -> None:
    reg = _registry(tmp_path)
    reg.register("!room1:x", "@card:x", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")
    reg.register("!room2:x", "@stale:x", "0xstale", ["0xstale"], "2026-07-12T00:00:00Z")

    # Synapse reports room1 member still present, room2 member gone (left while
    # the module was down), and a third live membership the registry never
    # recorded (a lost/corrupted entry).
    live = {("!room1:x", "@card:x"), ("!room3:x", "@unregistered:x")}
    unregistered = reg.reconcile(live)

    assert unregistered == [("!room3:x", "@unregistered:x")]
    assert reg.resolve_card_hash("!room2:x", "@stale:x") is None  # pruned
    assert reg.resolve_card_hash("!room1:x", "@card:x") == "0xcard"  # kept


def test_first_boot_with_no_file_starts_empty(tmp_path) -> None:
    reg = MembershipRegistry(str(tmp_path / "does-not-exist.enc"), _KEY)
    assert reg.watched_addresses() == set()
    assert reg.resolve_card_hash("!room:x", "@card:x") is None
