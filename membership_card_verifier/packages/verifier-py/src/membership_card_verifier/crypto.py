from Crypto.Hash import keccak
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, mldsa
from cryptography.hazmat.primitives.asymmetric.utils import Prehashed, encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .errors import CardProtocolError


def keccak256(input: bytes) -> str:
    h = keccak.new(digest_bits=256)
    h.update(input)
    return h.hexdigest()


def hkdf_sha3_256(ikm: bytes, info: str) -> bytes:
    hkdf = HKDF(
        algorithm=hashes.SHA3_256(),
        length=32,
        salt=None,
        info=info.encode("utf-8"),
    )
    return hkdf.derive(ikm)


def aes256gcm_decrypt(key: bytes, nonce_plus_ciphertext: bytes) -> bytes:
    """Decrypts AES-256-GCM ciphertext.

    Encoding: 12-byte nonce || ciphertext || 16-byte GCM tag.
    """
    if len(nonce_plus_ciphertext) < 12 + 16:
        raise CardProtocolError(
            "DECRYPTION_FAILED", "Encrypted payload too short to contain nonce and GCM tag"
        )
    nonce = nonce_plus_ciphertext[:12]
    ciphertext_and_tag = nonce_plus_ciphertext[12:]

    try:
        return AESGCM(key).decrypt(nonce, ciphertext_and_tag, None)
    except InvalidTag as exc:
        raise CardProtocolError("DECRYPTION_FAILED", "AES-256-GCM authentication failure") from exc


def ml_dsa44_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Verifies an ML-DSA-44 signature.

    NOTE: mirrors the JS package's crypto notice — verification only, no private
    key material handled by this package.
    """
    try:
        pub = mldsa.MLDSA44PublicKey.from_public_bytes(public_key)
        pub.verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


def secp256r1_phase1_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Verifies a secp256r1 (P-256) signature using SHA-256 prehash.

    public_key: 64 bytes, x||y uncompressed (no 0x04 prefix), matching the on-chain
      StoragePressAuthEntry.press_public_key layout.
    message: raw canonical payload bytes (prehash is applied here).
    signature: 64 bytes, r||s compact format.
    """
    if len(public_key) != 64 or len(signature) != 64:
        return False

    uncompressed = b"\x04" + public_key

    digest = hashes.Hash(hashes.SHA256())
    digest.update(message)
    msg_hash = digest.finalize()

    try:
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), uncompressed)
        r = int.from_bytes(signature[:32], "big")
        s = int.from_bytes(signature[32:], "big")
        der_signature = encode_dss_signature(r, s)
        pub.verify(der_signature, msg_hash, ec.ECDSA(Prehashed(hashes.SHA256())))
        return True
    except (InvalidSignature, ValueError):
        return False
