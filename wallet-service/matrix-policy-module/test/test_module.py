"""Step 12 integration tests: PolicyModule's join/post hooks, wiring together
attestation verification, predicate evaluation, the membership registry, and
the chain-walk cache. attestation.verify_join_attestation and the injected
open-item resolver (room_policy_resolver) are faked here — their own
correctness is covered by test_attestation.py, test_membership_registry.py,
and test_predicates.py individually; this file covers module.py's own wiring
logic (does it call the right thing, in the right order, with the right
deny-by-default behavior on every failure path).

Per the 2026-07-12 wire-transport resolution: the join attestation rides in
the m.room.member join event's own content (a custom namespaced key), and is
verified inside check_event_for_spam — user_may_join_room structurally can't
see it and is always a permissive pass-through."""

import os

import pytest
from membership_card_verifier import ChainLink, RevocationStatus

import matrix_policy_module.module as module_mod
from matrix_policy_module.attestation import AttestationResult
from matrix_policy_module.module import _JOIN_ATTESTATION_CONTENT_KEY, PolicyModule

NOT_SPAM = object()


class _FORBIDDEN:
    pass


class _FakeErrors:
    Codes = type("Codes", (), {"FORBIDDEN": _FORBIDDEN()})


class _FakeApi:
    NOT_SPAM = NOT_SPAM
    errors = _FakeErrors()

    def __init__(self) -> None:
        self.registered: dict = {}

    def register_spam_checker_callbacks(self, **kwargs) -> None:
        self.registered.update(kwargs)


class _FakeRoomPolicyResolver:
    def __init__(self, policy_id=None) -> None:
        self._policy_id = policy_id

    async def get_policy_id(self, room_id: str):
        return self._policy_id


POLICY_ID = "QmRoomPolicy"
MATCHING_DOC = {"policies": [{"ref_type": "cid", "ref": POLICY_ID}]}
NON_MATCHING_DOC = {"policies": [{"ref_type": "cid", "ref": "QmOtherPolicy"}]}


def _config(tmp_path) -> dict:
    return {
        "arbitrum_rpc_url": "http://localhost:8545",
        "arbitrum_rpc_ws_url": "ws://localhost:8546",
        "registry_contract_address": "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        "ipfs_gateway_url": "https://ipfs.example.com/ipfs",
        "matrix_server_name": "matrix.internal",
        "membership_registry_path": str(tmp_path / "registry.enc"),
        "membership_registry_key_path": str(_write_key(tmp_path)),
        "enforcement_matrix_user_id": "@matrix-policy-bot:matrix.internal",
    }


def _write_key(tmp_path) -> "os.PathLike":
    key_path = tmp_path / "registry.key"
    key_path.write_bytes(os.urandom(32))
    return key_path


def _not_revoked() -> RevocationStatus:
    return RevocationStatus(status="not_revoked", code=None, effective_date=None, data_freshness_seconds=0)


def _revoked() -> RevocationStatus:
    return RevocationStatus(status="revoked", code=801, effective_date="2026-07-12", data_freshness_seconds=0)


def _chain(policy_id: str) -> list[ChainLink]:
    return [ChainLink(card_address="0xcard", public_key="pk", card_content={"policy_id": policy_id})]


def _make_module(tmp_path, room_policy_resolver=None) -> tuple[PolicyModule, _FakeApi]:
    api = _FakeApi()
    mod = PolicyModule(
        _config(tmp_path),
        api,
        room_policy_resolver=room_policy_resolver or _FakeRoomPolicyResolver(POLICY_ID),
    )
    return mod, api


class _FakeEvent:
    def __init__(self, room_id: str, sender: str, event_type: str = "m.room.message", content: dict | None = None) -> None:
        self.room_id = room_id
        self.sender = sender
        self.type = event_type
        self.content = content or {}


def _join_event(room_id: str, sender: str, envelope: dict | None) -> _FakeEvent:
    content = {"membership": "join"}
    if envelope is not None:
        content[_JOIN_ATTESTATION_CONTENT_KEY] = envelope
    return _FakeEvent(room_id, sender, event_type="m.room.member", content=content)


def _async_return(value):
    async def _inner(*args, **kwargs):
        return value

    return _inner


@pytest.mark.asyncio
async def test_registers_both_callbacks(tmp_path) -> None:
    mod, api = _make_module(tmp_path)
    assert api.registered["user_may_join_room"] == mod.user_may_join_room
    assert api.registered["check_event_for_spam"] == mod.check_event_for_spam


@pytest.mark.asyncio
async def test_user_may_join_room_always_defers(tmp_path) -> None:
    # Structurally can't see the attestation on this callback — always a
    # permissive no-op; check_event_for_spam is the real gate.
    mod, api = _make_module(tmp_path)
    result = await mod.user_may_join_room("@card_x:matrix.internal", "!room:x", False)
    assert result is api.NOT_SPAM


# ---- join, via check_event_for_spam on the m.room.member/join event ----


@pytest.mark.asyncio
async def test_join_denied_when_no_attestation_in_event_content(tmp_path) -> None:
    mod, api = _make_module(tmp_path)
    result = await mod.check_event_for_spam(_join_event("!room:x", "@card_x:matrix.internal", envelope=None))
    assert result is api.errors.Codes.FORBIDDEN


@pytest.mark.asyncio
async def test_join_denied_when_attestation_invalid(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)

    async def _fake_verify(*args, **kwargs):
        return AttestationResult(valid=False, deny_reason="attestation_invalid")

    monkeypatch.setattr(module_mod, "verify_join_attestation", _fake_verify)
    event = _join_event("!room:x", "@card_x:matrix.internal", envelope={"payload": {}, "signatures": []})
    result = await mod.check_event_for_spam(event)
    assert result is api.errors.Codes.FORBIDDEN


@pytest.mark.asyncio
async def test_join_passthrough_when_room_has_no_policy(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A room with no m.card.policy state isn't card-gated at all — the
    # top-level "not card-gated" check fires before the join branch is even
    # reached, so an ordinary (non-card-gated) join proceeds normally, per
    # matrix_synapse_module.md: "for any other room... returns NOT_SPAM
    # unconditionally." This is not a deny path.
    mod, api = _make_module(tmp_path, room_policy_resolver=_FakeRoomPolicyResolver(None))

    async def _fake_verify(*args, **kwargs):
        return AttestationResult(valid=True, card_hash="0xcard", chain=_chain(POLICY_ID), revocation=_not_revoked(), is_currently_valid=True)

    monkeypatch.setattr(module_mod, "verify_join_attestation", _fake_verify)
    event = _join_event("!room:x", "@card_x:matrix.internal", envelope={"payload": {}, "signatures": [{}]})
    result = await mod.check_event_for_spam(event)
    assert result is api.NOT_SPAM
    # And, since this path never reaches _authorize_join_event, no membership
    # is registered for a room the module isn't gating in the first place.
    assert mod._registry.resolve_card_hash("!room:x", "@card_x:matrix.internal") is None


@pytest.mark.asyncio
async def test_join_denied_when_card_does_not_satisfy_policy(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)

    async def _fake_verify(*args, **kwargs):
        return AttestationResult(valid=True, card_hash="0xcard", chain=_chain("QmSomeOtherPolicy"), revocation=_not_revoked(), is_currently_valid=True)

    monkeypatch.setattr(module_mod, "verify_join_attestation", _fake_verify)
    monkeypatch.setattr(mod, "_fetch_predicate_document", _async_return(NON_MATCHING_DOC))
    event = _join_event("!room:x", "@card_x:matrix.internal", envelope={"payload": {}, "signatures": [{}]})
    result = await mod.check_event_for_spam(event)
    assert result is api.errors.Codes.FORBIDDEN
    assert mod._registry.resolve_card_hash("!room:x", "@card_x:matrix.internal") is None


@pytest.mark.asyncio
async def test_join_allowed_registers_membership_and_seeds_cache(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)

    async def _fake_verify(*args, **kwargs):
        return AttestationResult(
            valid=True, card_hash="0xcard", chain=_chain(POLICY_ID), revocation=_not_revoked(), is_currently_valid=True
        )

    monkeypatch.setattr(module_mod, "verify_join_attestation", _fake_verify)
    monkeypatch.setattr(mod, "_fetch_predicate_document", _async_return(MATCHING_DOC))

    event = _join_event("!room:x", "@card_x:matrix.internal", envelope={"payload": {}, "signatures": [{}]})
    result = await mod.check_event_for_spam(event)
    assert result is api.NOT_SPAM
    assert mod._registry.resolve_card_hash("!room:x", "@card_x:matrix.internal") == "0xcard"

    cached = await mod._cache.get("0xcard")
    assert cached.chain == _chain(POLICY_ID)


@pytest.mark.asyncio
async def test_join_denied_when_predicate_evaluator_throws(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)

    async def _fake_verify(*args, **kwargs):
        return AttestationResult(valid=True, card_hash="0xcard", chain=_chain(POLICY_ID), revocation=_not_revoked(), is_currently_valid=True)

    monkeypatch.setattr(module_mod, "verify_join_attestation", _fake_verify)
    monkeypatch.setattr(mod, "_fetch_predicate_document", _async_return({"policies": "not-a-list-shape"}))
    monkeypatch.setattr(
        module_mod,
        "evaluate_room_predicate",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    event = _join_event("!room:x", "@card_x:matrix.internal", envelope={"payload": {}, "signatures": [{}]})
    result = await mod.check_event_for_spam(event)
    assert result is api.errors.Codes.FORBIDDEN
    assert mod._registry.resolve_card_hash("!room:x", "@card_x:matrix.internal") is None


# ---- post ----


@pytest.mark.asyncio
async def test_post_allowed_for_non_card_gated_room(tmp_path) -> None:
    mod, api = _make_module(tmp_path, room_policy_resolver=_FakeRoomPolicyResolver(None))
    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal"))
    assert result is api.NOT_SPAM


@pytest.mark.asyncio
async def test_post_passthrough_for_non_content_bearing_event(tmp_path) -> None:
    mod, api = _make_module(tmp_path)
    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal", event_type="m.room.name"))
    assert result is api.NOT_SPAM


@pytest.mark.asyncio
async def test_post_denied_when_membership_not_registered(tmp_path) -> None:
    mod, api = _make_module(tmp_path)
    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal"))
    assert result is api.errors.Codes.FORBIDDEN


@pytest.mark.asyncio
async def test_post_denied_when_cached_revocation_status_is_revoked(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)
    mod._registry.register("!room:x", "@card_x:matrix.internal", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")
    mod._cache.seed_from_join("0xcard", _chain(POLICY_ID), _revoked(), False)

    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal"))
    assert result is api.errors.Codes.FORBIDDEN


@pytest.mark.asyncio
async def test_post_denied_when_no_longer_satisfies_policy(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)
    mod._registry.register("!room:x", "@card_x:matrix.internal", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")
    mod._cache.seed_from_join("0xcard", _chain("QmSomeOtherPolicy"), _not_revoked(), True)
    monkeypatch.setattr(mod, "_fetch_predicate_document", _async_return(NON_MATCHING_DOC))

    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal"))
    assert result is api.errors.Codes.FORBIDDEN


@pytest.mark.asyncio
async def test_post_allowed_when_registered_and_satisfies_policy(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)
    mod._registry.register("!room:x", "@card_x:matrix.internal", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")
    mod._cache.seed_from_join("0xcard", _chain(POLICY_ID), _not_revoked(), True)
    monkeypatch.setattr(mod, "_fetch_predicate_document", _async_return(MATCHING_DOC))

    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal"))
    assert result is api.NOT_SPAM


@pytest.mark.asyncio
async def test_post_denied_when_predicate_evaluator_throws(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod, api = _make_module(tmp_path)
    mod._registry.register("!room:x", "@card_x:matrix.internal", "0xcard", ["0xcard"], "2026-07-12T00:00:00Z")
    mod._cache.seed_from_join("0xcard", _chain(POLICY_ID), _not_revoked(), True)
    monkeypatch.setattr(mod, "_fetch_predicate_document", _async_return(MATCHING_DOC))
    monkeypatch.setattr(
        module_mod,
        "evaluate_room_predicate",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    result = await mod.check_event_for_spam(_FakeEvent("!room:x", "@card_x:matrix.internal"))
    assert result is api.errors.Codes.FORBIDDEN
