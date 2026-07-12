"""Cross-language interop vectors generated from the real, built JS package.

See ../../verifier/scripts/gen-interop-vectors.mjs for the generator.
Any failure here means the Python port is not byte-compatible with the JS package.
"""

import json
from pathlib import Path

import pytest

from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.crypto import (
    aes256gcm_decrypt,
    hkdf_sha3_256,
    keccak256,
    ml_dsa44_verify,
    secp256r1_phase1_verify,
)

VECTORS_DIR = Path(__file__).resolve().parent.parent / "vectors"


def _load(name: str) -> list[dict]:
    return json.loads((VECTORS_DIR / name).read_text(encoding="utf-8"))["cases"]


CANONICALIZE_CASES = _load("canonicalize_vectors.json")
KECCAK256_CASES = _load("keccak256_vectors.json")
HKDF_CASES = _load("hkdf_vectors.json")
AES_GCM_CASES = _load("aes_gcm_vectors.json")
MLDSA44_CASES = _load("mldsa44_vectors.json")
SECP256R1_CASES = _load("secp256r1_vectors.json")


@pytest.mark.parametrize("case", CANONICALIZE_CASES, ids=[c["id"] for c in CANONICALIZE_CASES])
def test_canonicalize_matches_js(case: dict) -> None:
    result = canonicalize(case["input"])
    assert result.hex() == case["expected_hex"]
    assert result.decode("utf-8") == case["expected_json"]


@pytest.mark.parametrize("case", KECCAK256_CASES, ids=[c["id"] for c in KECCAK256_CASES])
def test_keccak256_matches_js(case: dict) -> None:
    input_bytes = bytes.fromhex(case["input_hex"])
    assert keccak256(input_bytes) == case["expected_hex"]


@pytest.mark.parametrize("case", HKDF_CASES, ids=[c["id"] for c in HKDF_CASES])
def test_hkdf_sha3_256_matches_js(case: dict) -> None:
    ikm = bytes.fromhex(case["ikm_hex"])
    result = hkdf_sha3_256(ikm, case["info"])
    assert result.hex() == case["expected_hex"]


@pytest.mark.parametrize("case", AES_GCM_CASES, ids=[c["id"] for c in AES_GCM_CASES])
def test_aes256gcm_decrypt_matches_js(case: dict) -> None:
    key = bytes.fromhex(case["key_hex"])
    encrypted = bytes.fromhex(case["encrypted_hex"])
    result = aes256gcm_decrypt(key, encrypted)
    assert result.hex() == case["expected_plaintext_hex"]


@pytest.mark.parametrize("case", MLDSA44_CASES, ids=[c["id"] for c in MLDSA44_CASES])
def test_ml_dsa44_verify_matches_js(case: dict) -> None:
    public_key = bytes.fromhex(case["public_key_hex"])
    message = bytes.fromhex(case["message_hex"])
    signature = bytes.fromhex(case["signature_hex"])
    assert ml_dsa44_verify(public_key, message, signature) is case["expected_valid"]


@pytest.mark.parametrize("case", SECP256R1_CASES, ids=[c["id"] for c in SECP256R1_CASES])
def test_secp256r1_phase1_verify_matches_js(case: dict) -> None:
    public_key = bytes.fromhex(case["public_key_hex"])
    message = bytes.fromhex(case["message_hex"])
    signature = bytes.fromhex(case["signature_hex"])
    assert secp256r1_phase1_verify(public_key, message, signature) is case["expected_valid"]
