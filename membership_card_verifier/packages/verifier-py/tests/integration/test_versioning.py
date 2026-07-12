from unittest.mock import AsyncMock

from membership_card_verifier.card_verifier import CardVerifier
from membership_card_verifier.types import VerifierConfig

from tests.fixtures import generate_keypair, sign
from tests.integration._helpers import b64url, mock_rpc

DUMMY_APP_CERT_ROOT = "0x" + "a" * 64


def _mock_ipfs_rejects_all() -> AsyncMock:
    ipfs = AsyncMock()
    ipfs.fetch.side_effect = Exception("not found")
    return ipfs


def _make_verifier() -> CardVerifier:
    return CardVerifier(
        VerifierConfig(
            rpc=mock_rpc(),
            ipfs=_mock_ipfs_rejects_all(),
            app_certification_root=DUMMY_APP_CERT_ROOT,
        )
    )


async def test_proceeds_through_stages_normally_when_protocol_version_is_0_1():
    kp = generate_keypair()
    payload = {
        "message": "test",
        "protocol_version": "0.1",
        "timestamp": "2026-06-20T00:00:00Z",
    }
    envelope = {
        "payload": payload,
        "signatures": [
            {"public_key": b64url(kp.public_key), "signature": sign(kp.secret_key, payload)}
        ],
    }

    result = await _make_verifier().verify_envelope(envelope)
    assert result.protocol_version == "0.1"
    assert len(result.envelope_id) == 64
    int(result.envelope_id, 16)
    assert len(result.signatures) == 1
    assert result.signatures[0].signature_valid is True


async def test_returns_missing_protocol_version_error_without_throwing_when_absent():
    kp = generate_keypair()
    payload = {"message": "test", "timestamp": "2026-06-20T00:00:00Z"}
    envelope = {
        "payload": payload,
        "signatures": [
            {"public_key": b64url(kp.public_key), "signature": sign(kp.secret_key, payload)}
        ],
    }

    result = await _make_verifier().verify_envelope(envelope)
    assert result.protocol_version == "unknown"
    errors = [e for s in result.signatures for e in s.errors]
    assert any(e.code == "MISSING_PROTOCOL_VERSION" for e in errors)


async def test_returns_unknown_protocol_version_error_without_throwing_when_99_0():
    kp = generate_keypair()
    payload = {"message": "test", "protocol_version": "99.0", "timestamp": "2026-06-20T00:00:00Z"}
    envelope = {
        "payload": payload,
        "signatures": [
            {"public_key": b64url(kp.public_key), "signature": sign(kp.secret_key, payload)}
        ],
    }

    result = await _make_verifier().verify_envelope(envelope)
    assert result.protocol_version == "99.0"
    errors = [e for s in result.signatures for e in s.errors]
    assert any(e.code == "UNKNOWN_PROTOCOL_VERSION" for e in errors)
