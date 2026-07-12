import base64

import pytest
from cryptography.hazmat.primitives.asymmetric import mldsa

from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.errors import CardProtocolError
from membership_card_verifier.stages.stage1 import verify_stage1
from membership_card_verifier.types import SignatureEntry


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def make_valid_entry(payload):
    priv = mldsa.MLDSA44PrivateKey.generate()
    pub = priv.public_key()
    canonical = canonicalize(payload)
    sig = priv.sign(canonical)
    entry = SignatureEntry(
        public_key=b64url(pub.public_bytes_raw()),
        signature=b64url(sig),
    )
    return entry, priv


class TestStage1SignatureValidity:
    def test_valid_signature_returns_signature_valid_true(self):
        payload = {"message": "hello", "timestamp": "2026-06-20T00:00:00Z"}
        entry, _ = make_valid_entry(payload)
        result = verify_stage1(entry, payload)
        assert result.signature_valid is True
        assert len(result.public_key_bytes) == 1312

    def test_invalid_signature_wrong_message_returns_signature_valid_false(self):
        payload = {"message": "hello", "timestamp": "2026-06-20T00:00:00Z"}
        entry, _ = make_valid_entry(payload)
        result = verify_stage1(entry, {**payload, "message": "tampered"})
        assert result.signature_valid is False

    def test_wrong_length_public_key_throws_invalid_public_key_length(self):
        payload = {"message": "hello", "timestamp": "2026-06-20T00:00:00Z"}
        short_key = b64url(b"\x00" * 32)
        _, _ = make_valid_entry(payload)
        entry = SignatureEntry(
            public_key=short_key,
            signature=b64url(b"\x00" * 2420),
        )
        with pytest.raises(CardProtocolError) as exc_info:
            verify_stage1(entry, payload)
        assert exc_info.value.code == "INVALID_PUBLIC_KEY_LENGTH"

    def test_wrong_length_signature_throws_invalid_signature_length(self):
        payload = {"message": "hello", "timestamp": "2026-06-20T00:00:00Z"}
        valid_entry, _ = make_valid_entry(payload)
        short_sig = b64url(b"\x00" * 16)
        entry = SignatureEntry(
            public_key=valid_entry.public_key,
            signature=short_sig,
        )
        with pytest.raises(CardProtocolError) as exc_info:
            verify_stage1(entry, payload)
        assert exc_info.value.code == "INVALID_SIGNATURE_LENGTH"
