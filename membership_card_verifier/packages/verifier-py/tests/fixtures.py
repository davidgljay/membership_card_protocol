"""Shared crypto fixtures for stage tests."""

import base64
import os
from dataclasses import dataclass
from typing import Any

from cryptography.hazmat.primitives.asymmetric import mldsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from membership_card_verifier.canonicalize import canonicalize
from membership_card_verifier.crypto import hkdf_sha3_256, keccak256


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


@dataclass
class Keypair:
    secret_key: mldsa.MLDSA44PrivateKey
    public_key: bytes
    address: str


def generate_keypair() -> Keypair:
    priv = mldsa.MLDSA44PrivateKey.generate()
    pub = priv.public_key()
    public_key = pub.public_bytes_raw()
    address = keccak256(public_key)
    return Keypair(secret_key=priv, public_key=public_key, address=address)


def sign(secret_key: mldsa.MLDSA44PrivateKey, data: Any) -> str:
    data_bytes = canonicalize(data)
    signature = secret_key.sign(data_bytes)
    return _b64url_encode(signature)


def encrypt_for_card(pubkey: bytes, plaintext: bytes) -> bytes:
    content_key = hkdf_sha3_256(pubkey, "card-content-v1")
    nonce = os.urandom(12)
    ciphertext_and_tag = AESGCM(content_key).encrypt(nonce, plaintext, None)
    return nonce + ciphertext_and_tag


def make_card_doc(
    recipient_pubkey: bytes,
    issuer_sk: mldsa.MLDSA44PrivateKey,
    holder_sk: mldsa.MLDSA44PrivateKey,
    press_sk: mldsa.MLDSA44PrivateKey,
    ancestry_pubkeys: list[str] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if ancestry_pubkeys is None:
        ancestry_pubkeys = []
    if extra is None:
        extra = {}

    recipient_pubkey_b64 = _b64url_encode(recipient_pubkey)
    issuer_pub = mldsa.MLDSA44PrivateKey.generate().public_key().public_bytes_raw()
    press_pub = mldsa.MLDSA44PrivateKey.generate().public_key().public_bytes_raw()

    offer: dict[str, Any] = {
        "policy_id": "QmFakePolicyCID",
        "issuer_card": keccak256(issuer_pub),
        "press_card": keccak256(press_pub),
        "protocol_version": "0.1",
        "issued_at": "2026-06-20T00:00:00Z",
        "ancestry_pubkeys": ancestry_pubkeys,
        **extra,
    }

    issuer_sig_input = dict(offer)
    issuer_sig = sign(issuer_sk, issuer_sig_input)

    holder_sig_input = {
        **offer,
        "issuer_signature": issuer_sig,
        "recipient_pubkey": recipient_pubkey_b64,
    }
    holder_sig = sign(holder_sk, holder_sig_input)

    press_sig_input = {**holder_sig_input, "holder_signature": holder_sig}
    press_sig = sign(press_sk, press_sig_input)

    return {
        **press_sig_input,
        "press_signature": press_sig,
        "issuer_signature": issuer_sig,
        "holder_signature": holder_sig,
    }


def make_sub_card_doc(
    holder_pubkey: bytes,
    holder_sk: mldsa.MLDSA44PrivateKey,
    app_pubkey: bytes,
    app_sk: mldsa.MLDSA44PrivateKey,
    recipient_pubkey: bytes,
) -> dict[str, Any]:
    holder_address = keccak256(holder_pubkey)
    app_address = keccak256(app_pubkey)

    base: dict[str, Any] = {
        "holder_primary_card": holder_address,
        "holder_primary_card_pubkey": _b64url_encode(holder_pubkey),
        "app_card": app_address,
        "app_card_pubkey": _b64url_encode(app_pubkey),
        "capabilities": ["note"],
        "recipient_pubkey": _b64url_encode(recipient_pubkey),
        "issued_at": "2026-06-20T00:00:00Z",
        "attestation_level": "T2",
    }

    app_sig = sign(app_sk, base)
    holder_sig_input = {**base, "app_signature": app_sig}
    holder_sig = sign(holder_sk, holder_sig_input)

    return {**holder_sig_input, "holder_signature": holder_sig}
