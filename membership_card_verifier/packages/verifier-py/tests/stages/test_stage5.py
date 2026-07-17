import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from membership_card_verifier.stages.stage5 import verify_stage5
from membership_card_verifier.types import CardEntry, PressAuthEntry


def mock_rpc(**overrides) -> AsyncMock:
    rpc = AsyncMock()
    rpc.get_card_entry.return_value = None
    rpc.is_policy_authorizer.return_value = False
    rpc.get_press_authorization.return_value = None
    rpc.get_sub_card_entry.return_value = None
    rpc.get_card_event_log.return_value = []
    rpc.get_eas_annotations.return_value = []
    for name, value in overrides.items():
        setattr(rpc, name, value)
    return rpc


def mock_ipfs(responses: dict[str, bytes] | None = None) -> AsyncMock:
    responses = responses or {}
    ipfs = AsyncMock()

    async def _fetch(cid: str) -> bytes:
        if cid in responses:
            return responses[cid]
        raise Exception(f"CID not found: {cid}")

    ipfs.fetch.side_effect = _fetch
    return ipfs


CARD_ADDRESS = "0x" + "a" * 64
CARD_CID = "QmCard"
RAW_BYTES = b"{}"

BASE_CARD_DOC = {
    "policy_id": "QmPolicy",
    "issuer_card": "0x" + "b" * 64,
    "press_card": "0x" + "c" * 64,
    "recipient_pubkey": "AAEC",
    "issued_at": "2026-06-20T00:00:00Z",
    "ancestry_pubkeys": [],
    "issuer_signature": "sig1",
    "holder_signature": "sig2",
    "press_signature": "sig3",
}

BASE_CARD_ENTRY = CardEntry(
    log_head_cid=CARD_CID,
    policy_address="0x" + "d" * 64,
    last_press_address="0x" + "e" * 64,
    forward_to=None,
    exists=True,
)

ACTIVE_PRESS = PressAuthEntry(
    press_public_key="pub",
    mldsa44_key_hash="hash",
    active=True,
    authorized_at="2026-01-01T00:00:00Z",
    revoked_at=None,
)


async def test_compliant_card_with_valid_press_auth():
    """compliant card with valid press auth returns policy_compliant: true"""
    policy_doc = {"field_definitions": {}}
    rpc = mock_rpc(get_press_authorization=AsyncMock(return_value=ACTIVE_PRESS))
    ipfs = mock_ipfs({"QmPolicy": json.dumps(policy_doc).encode("utf-8")})
    config = SimpleNamespace(registry_endpoint=None)

    result = await verify_stage5(
        BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, config
    )

    assert result.policy_compliant is True
    assert result.press_subsequently_revoked is False


async def test_missing_required_field():
    """missing required field → policy_compliant: false"""
    policy_doc = {"field_definitions": {"required_field": {"required": True}}}
    rpc = mock_rpc(get_press_authorization=AsyncMock(return_value=ACTIVE_PRESS))
    ipfs = mock_ipfs({"QmPolicy": json.dumps(policy_doc).encode("utf-8")})
    config = SimpleNamespace(registry_endpoint=None)

    result = await verify_stage5(
        BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, config
    )

    assert result.policy_compliant is False
    assert result.non_compliance_reported is False


async def test_no_press_authorization_entry():
    """no press authorization entry → policy_compliant: false"""
    policy_doc = {"field_definitions": {}}
    rpc = mock_rpc(get_press_authorization=AsyncMock(return_value=None))
    ipfs = mock_ipfs({"QmPolicy": json.dumps(policy_doc).encode("utf-8")})
    config = SimpleNamespace(registry_endpoint=None)

    result = await verify_stage5(
        BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, config
    )

    assert result.policy_compliant is False


async def test_press_subsequently_revoked():
    """press subsequently revoked → policy_compliant: true, press_subsequently_revoked: true"""
    policy_doc = {"field_definitions": {}}
    revoked_press = PressAuthEntry(
        press_public_key="pub",
        mldsa44_key_hash="hash",
        active=False,
        authorized_at="2026-01-01T00:00:00Z",
        revoked_at="2026-06-10T00:00:00Z",
    )
    rpc = mock_rpc(get_press_authorization=AsyncMock(return_value=revoked_press))
    ipfs = mock_ipfs({"QmPolicy": json.dumps(policy_doc).encode("utf-8")})
    config = SimpleNamespace(registry_endpoint=None)

    result = await verify_stage5(
        BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, config
    )

    assert result.policy_compliant is True
    assert result.press_subsequently_revoked is True


async def test_non_compliance_post_failure():
    """non-compliance POST failure still returns a result"""
    policy_doc = {"field_definitions": {}}
    rpc = mock_rpc(get_press_authorization=AsyncMock(return_value=None))
    ipfs = mock_ipfs({"QmPolicy": json.dumps(policy_doc).encode("utf-8")})
    config = SimpleNamespace(registry_endpoint=None)

    result = await verify_stage5(
        BASE_CARD_DOC, BASE_CARD_ENTRY, CARD_ADDRESS, CARD_CID, RAW_BYTES, rpc, ipfs, config
    )

    assert result.policy_compliant is False
    assert result.non_compliance_reported is False
    assert any(e.code == "NON_COMPLIANCE_REPORT_FAILED" for e in result.errors)
