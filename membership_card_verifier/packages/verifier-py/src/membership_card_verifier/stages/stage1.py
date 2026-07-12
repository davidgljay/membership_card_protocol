import base64
from dataclasses import dataclass
from typing import Any

from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.crypto import ml_dsa44_verify, secp256r1_phase1_verify
from membership_card_verifier.errors import CardProtocolError
from membership_card_verifier.types import SignatureEntry


def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


@dataclass
class Stage1Result:
    signature_valid: bool
    public_key_bytes: bytes


def verify_stage1(entry: SignatureEntry, payload: Any) -> Stage1Result:
    scheme = entry.key_scheme or "mldsa44"

    if scheme == "secp256r1_phase1":
        return _verify_stage1_secp256r1_phase1(entry, payload)

    return _verify_stage1_mldsa44(entry, payload)


def _verify_stage1_mldsa44(entry: SignatureEntry, payload: Any) -> Stage1Result:
    public_key_bytes = _b64url_decode(entry.public_key)
    if len(public_key_bytes) != 1312:
        raise CardProtocolError(
            "INVALID_PUBLIC_KEY_LENGTH",
            f"mldsa44 public_key must be 1312 bytes after base64url decode, got {len(public_key_bytes)}",
        )

    signature_bytes = _b64url_decode(entry.signature)
    if len(signature_bytes) != 2420:
        raise CardProtocolError(
            "INVALID_SIGNATURE_LENGTH",
            f"mldsa44 signature must be 2420 bytes after base64url decode, got {len(signature_bytes)}",
        )

    canonical_payload = canonicalize(payload)
    valid = ml_dsa44_verify(public_key_bytes, canonical_payload, signature_bytes)

    return Stage1Result(signature_valid=valid, public_key_bytes=public_key_bytes)


def _verify_stage1_secp256r1_phase1(entry: SignatureEntry, payload: Any) -> Stage1Result:
    public_key_bytes = _b64url_decode(entry.public_key)
    if len(public_key_bytes) != 64:
        raise CardProtocolError(
            "INVALID_PUBLIC_KEY_LENGTH",
            f"secp256r1_phase1 public_key must be 64 bytes (x||y) after base64url decode, got {len(public_key_bytes)}",
        )

    signature_bytes = _b64url_decode(entry.signature)
    if len(signature_bytes) != 64:
        raise CardProtocolError(
            "INVALID_SIGNATURE_LENGTH",
            f"secp256r1_phase1 signature must be 64 bytes (r||s) after base64url decode, got {len(signature_bytes)}",
        )

    canonical_payload = canonicalize(payload)
    valid = secp256r1_phase1_verify(public_key_bytes, canonical_payload, signature_bytes)

    return Stage1Result(signature_valid=valid, public_key_bytes=public_key_bytes)
