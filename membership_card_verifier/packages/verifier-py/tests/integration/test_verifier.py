from unittest.mock import AsyncMock

import pytest

from membership_card_verifier.card_verifier import CardVerifier
from membership_card_verifier.errors import CardProtocolError
from membership_card_verifier.types import CardEntry, VerifierConfig

from tests.fixtures import generate_keypair, sign
from tests.integration._helpers import b64url, make_envelope, mock_ipfs, mock_rpc

DUMMY_APP_CERT_ROOT = "0x" + "e" * 64


def test_constructor_rejects_missing_rpc():
    with pytest.raises(CardProtocolError):
        CardVerifier(
            VerifierConfig(rpc=None, ipfs=mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
        )


def test_constructor_rejects_missing_ipfs():
    with pytest.raises(CardProtocolError):
        CardVerifier(
            VerifierConfig(rpc=mock_rpc(), ipfs=None, app_certification_root=DUMMY_APP_CERT_ROOT)
        )


def test_constructor_rejects_missing_app_certification_root():
    with pytest.raises(CardProtocolError):
        CardVerifier(
            VerifierConfig(rpc=mock_rpc(), ipfs=mock_ipfs(), app_certification_root=None)
        )


async def test_verify_envelope_returns_deterministic_envelope_id():
    sub = generate_keypair()
    envelope = make_envelope(sub.public_key, sub.secret_key, message="hello")

    rpc = mock_rpc(get_card_entry=AsyncMock(return_value=None))
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
    )

    r1 = await verifier.verify_envelope(envelope)
    r2 = await verifier.verify_envelope(envelope)
    assert r1.envelope_id == r2.envelope_id
    assert len(r1.envelope_id) == 64
    int(r1.envelope_id, 16)


async def test_verify_envelope_returns_one_result_per_signature_entry():
    sub1 = generate_keypair()
    sub2 = generate_keypair()
    payload = {
        "message": "multi-sig",
        "protocol_version": "0.1",
        "timestamp": "2026-06-20T00:00:00Z",
    }
    envelope = {
        "payload": payload,
        "signatures": [
            {"public_key": b64url(sub1.public_key), "signature": sign(sub1.secret_key, payload)},
            {"public_key": b64url(sub2.public_key), "signature": sign(sub2.secret_key, payload)},
        ],
    }

    rpc = mock_rpc(get_card_entry=AsyncMock(return_value=None))
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
    )
    result = await verifier.verify_envelope(envelope)
    assert len(result.signatures) == 2
    assert result.signatures[0].signature_valid is True
    assert result.signatures[1].signature_valid is True


async def test_verify_card_with_known_trusted_root_returns_chain_reaches_trusted_root_true():
    card = generate_keypair()
    rpc = mock_rpc(
        get_card_entry=AsyncMock(
            return_value=CardEntry(
                log_head_cid="QmCard",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
                exists=True,
            )
        ),
        is_policy_authorizer=AsyncMock(return_value=True),
        get_log_entries=AsyncMock(return_value=[]),
    )
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
    )
    result = await verifier.verify_card(card.address)
    assert result.signature_valid is None
    assert result.chain_reaches_trusted_root is True
    assert result.scope_clean == "skipped"


async def test_stage2_hard_rejection_propagates_skipped_to_stages_3_5():
    sub = generate_keypair()
    envelope = make_envelope(sub.public_key, sub.secret_key)

    rpc = mock_rpc(get_card_entry=AsyncMock(return_value=None))
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
    )
    result = await verifier.verify_envelope(envelope)
    sig = result.signatures[0]
    assert sig.scope_clean is False
    assert sig.chain_reaches_trusted_root == "skipped"
    assert sig.was_valid_at_signing_time == "skipped"
    assert sig.is_currently_valid == "skipped"
    assert sig.policy_compliant == "skipped"
