import os

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed, decode_dss_signature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from membership_card_verifier.crypto import (
    aes256gcm_decrypt,
    hkdf_sha3_256,
    keccak256,
    ml_dsa44_verify,
    secp256r1_phase1_verify,
)
from membership_card_verifier.errors import CardProtocolError


def test_keccak256_empty_input_produces_known_hash() -> None:
    assert keccak256(b"") == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def test_hkdf_sha3_256_matches_reference_output_length() -> None:
    ikm = bytes([0x42] * 32)
    result = hkdf_sha3_256(ikm, "card-content-v1")
    assert len(result) == 32
    # deterministic: same inputs produce same output
    assert hkdf_sha3_256(ikm, "card-content-v1") == result
    assert hkdf_sha3_256(ikm, "different-info") != result


def test_aes256gcm_decrypt_decrypts_valid_ciphertext() -> None:
    key = os.urandom(32)
    nonce = os.urandom(12)
    plaintext = b"hello, card protocol"
    ciphertext_and_tag = AESGCM(key).encrypt(nonce, plaintext, None)
    encrypted = nonce + ciphertext_and_tag
    assert aes256gcm_decrypt(key, encrypted) == plaintext


def test_aes256gcm_decrypt_raises_on_tampered_ciphertext() -> None:
    key = os.urandom(32)
    nonce = os.urandom(12)
    plaintext = b"secret"
    ciphertext_and_tag = AESGCM(key).encrypt(nonce, plaintext, None)
    encrypted = bytearray(nonce + ciphertext_and_tag)
    encrypted[13] ^= 0xFF
    try:
        aes256gcm_decrypt(key, bytes(encrypted))
        assert False, "expected CardProtocolError"
    except CardProtocolError as e:
        assert e.code == "DECRYPTION_FAILED"


def test_aes256gcm_decrypt_raises_on_short_payload() -> None:
    try:
        aes256gcm_decrypt(os.urandom(32), b"short")
        assert False, "expected CardProtocolError"
    except CardProtocolError as e:
        assert e.code == "DECRYPTION_FAILED"


def _mldsa44_keypair():
    from cryptography.hazmat.primitives.asymmetric import mldsa

    priv = mldsa.MLDSA44PrivateKey.generate()
    pub = priv.public_key()
    return priv, pub


def test_ml_dsa44_verify_returns_true_for_valid_signature() -> None:
    priv, pub = _mldsa44_keypair()
    message = b"test message"
    signature = priv.sign(message)
    public_bytes = pub.public_bytes_raw()
    assert ml_dsa44_verify(public_bytes, message, signature) is True


def test_ml_dsa44_verify_returns_false_for_flipped_byte_in_signature() -> None:
    priv, pub = _mldsa44_keypair()
    message = b"test message"
    signature = bytearray(priv.sign(message))
    signature[1200] ^= 0xFF
    public_bytes = pub.public_bytes_raw()
    assert ml_dsa44_verify(public_bytes, message, bytes(signature)) is False


def _p256_keypair():
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key()
    return priv, pub


def _p256_sign_compact(priv, message: bytes) -> bytes:
    digest = hashes.Hash(hashes.SHA256())
    digest.update(message)
    msg_hash = digest.finalize()
    der_sig = priv.sign(msg_hash, ec.ECDSA(Prehashed(hashes.SHA256())))
    r, s = decode_dss_signature(der_sig)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def test_secp256r1_phase1_verify_returns_true_for_valid_signature() -> None:
    priv, pub = _p256_keypair()
    message = b"test message"
    signature = _p256_sign_compact(priv, message)
    public_bytes = pub.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )[1:]  # strip the 0x04 prefix to match the 64-byte x||y on-chain layout
    assert secp256r1_phase1_verify(public_bytes, message, signature) is True


def test_secp256r1_phase1_verify_returns_false_for_flipped_byte_in_signature() -> None:
    priv, pub = _p256_keypair()
    message = b"test message"
    signature = bytearray(_p256_sign_compact(priv, message))
    signature[0] ^= 0xFF
    public_bytes = pub.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )[1:]
    assert secp256r1_phase1_verify(public_bytes, message, bytes(signature)) is False
