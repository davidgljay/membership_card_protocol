"""Step 12 (attestation half) tests: shadow-account derivation primitives,
plus full join-attestation verification against a real-crypto fixture built
the same way test_chain_context.py's is (same helpers, same chain shape —
verify_envelope's Stage 2 expects the signer to be a sub-card, per
messaging_protocol.md, so a single-hop "master card signs directly" fixture
doesn't work here). Built locally rather than reusing that module's fixture
directly, since this one needs matrix_user_id/card_hash/server_name to be
correct *before* signing — verify_join_attestation checks those fields
against the signature, so they can't be patched in afterwards."""

import base64
import datetime as dt
import json
import sys
from pathlib import Path

import pytest

_VERIFIER_PY_ROOT = (
    Path(__file__).resolve().parents[3] / "membership_card_verifier" / "packages" / "verifier-py"
)
sys.path.insert(0, str(_VERIFIER_PY_ROOT))

from membership_card_verifier import CardVerifier, VerifierConfig  # noqa: E402
from tests.fixtures import (  # noqa: E402
    encrypt_for_card,
    generate_keypair,
    make_card_doc,
    make_sub_card_doc,
    sign,
)
from tests.integration._helpers import b64url, mock_ipfs, mock_rpc  # noqa: E402

from matrix_policy_module.attestation import (  # noqa: E402
    derive_matrix_user_id,
    verify_join_attestation,
    verify_matrix_user_id_binding,
)

SERVER_NAME = "matrix.internal"


def _b64url_bytes(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


# ---- derivation primitives (matrix_encryption.md §3) ----


def test_verify_matrix_user_id_binding_true_for_matching_triple() -> None:
    uid = derive_matrix_user_id("aabbcc", SERVER_NAME)
    assert verify_matrix_user_id_binding("aabbcc", uid, SERVER_NAME) is True


def test_verify_matrix_user_id_binding_false_for_different_card() -> None:
    uid = derive_matrix_user_id("aabbcc", SERVER_NAME)
    assert verify_matrix_user_id_binding("ddeeff", uid, SERVER_NAME) is False


def test_verify_matrix_user_id_binding_false_for_different_server_name() -> None:
    uid = derive_matrix_user_id("aabbcc", SERVER_NAME)
    assert verify_matrix_user_id_binding("aabbcc", uid, "other.internal") is False


def test_derive_matrix_user_id_shape() -> None:
    uid = derive_matrix_user_id("aabbcc", SERVER_NAME)
    assert uid.startswith("@card_")
    assert uid.endswith(f":{SERVER_NAME}")


# ---- full verify_join_attestation flow ----
#
# root (trusted) <- holder (master, holds the card the attestation is about)
# <- sub (the actual signer) <- app — the same minimal shape
# test_chain_context.py's fixture uses, since verify_envelope's Stage 2
# requires the signer to resolve as a sub-card, not a bare master card.


def _build_attestation_fixture(
    *, matrix_user_id: str | None = None, server_name: str = SERVER_NAME, timestamp: str = "2026-07-12T00:00:00Z"
):
    root = generate_keypair()
    holder = generate_keypair()
    sub = generate_keypair()
    app = generate_keypair()
    app_cert_root = generate_keypair()
    press = generate_keypair()

    holder_doc = make_card_doc(
        holder.public_key, root.secret_key, holder.secret_key, press.secret_key, [b64url(root.public_key)]
    )
    holder_doc["policy_id"] = "QmRoomPolicy"
    holder_doc["status"] = "active"
    holder_doc["active_subcards"] = [b64url(sub.public_key)]
    MASTER_CID = "QmMaster"

    sub_doc = make_sub_card_doc(
        holder.public_key, holder.secret_key, app.public_key, app.secret_key, sub.public_key
    )
    SUB_CID = "QmSub"

    app_card_doc = make_card_doc(
        app.public_key, app_cert_root.secret_key, app.secret_key, press.secret_key, [b64url(app_cert_root.public_key)]
    )
    APP_CID = "QmApp"

    enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
    enc_master_doc = encrypt_for_card(holder.public_key, json.dumps(holder_doc).encode("utf-8"))
    enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

    # card_hash for a join attestation is the *signer's* card (the sub-card) —
    # matches attestation.py's own recomputation: keccak256(signatures[0].public_key).
    card_hash = sub.address
    resolved_matrix_user_id = (
        matrix_user_id if matrix_user_id is not None else derive_matrix_user_id(card_hash, server_name)
    )
    payload = {
        "message": "join-attestation",
        "protocol_version": "0.1",
        "timestamp": timestamp,
        "matrix_user_id": resolved_matrix_user_id,
        "server_name": server_name,
        "card_hash": _b64url_bytes(bytes.fromhex(card_hash)),
    }
    envelope = {
        "payload": payload,
        "signatures": [{"public_key": b64url(sub.public_key), "signature": sign(sub.secret_key, payload)}],
    }

    sub_card_entry_result = _sub_card_entry(holder.address, SUB_CID)

    def make_card_entry(cid: str):
        from membership_card_verifier.types import CardEntry

        return CardEntry(
            log_head_cid=cid, policy_address="0x" + "f" * 64, last_press_address=press.address,
            forward_to=None, exists=True,
        )

    async def get_card_entry(addr: str):
        return {
            sub.address: make_card_entry(SUB_CID),
            holder.address: make_card_entry(MASTER_CID),
            app.address: make_card_entry(APP_CID),
        }.get(addr)

    async def is_policy_authorizer(addr: str) -> bool:
        return addr == root.address

    async def get_sub_card_entry(addr: str):
        return sub_card_entry_result if addr == sub.address else None

    press_entry = _press_entry(press)

    rpc = mock_rpc(
        get_card_entry=get_card_entry,
        is_policy_authorizer=is_policy_authorizer,
        get_press_authorization=press_entry,
        get_sub_card_entry=get_sub_card_entry,
    )
    ipfs = mock_ipfs({SUB_CID: enc_sub_doc, MASTER_CID: enc_master_doc, APP_CID: enc_app_doc})

    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            app_certification_root=app_cert_root.address,
            trusted_roots=[root.address],
            return_chain=True,
        )
    )
    return envelope, verifier, card_hash, resolved_matrix_user_id


def _sub_card_entry(master_address: str, sub_cid: str):
    from membership_card_verifier.types import SubCardEntry

    return SubCardEntry(
        master_card_address=master_address,
        registration_log_head="0x",
        sub_card_doc_cid=sub_cid,
        active=True,
        registered_at="2026-01-01T00:00:00Z",
        deregistered_at=None,
    )


def _press_entry(press):
    from membership_card_verifier.types import PressAuthEntry

    async def _get(*args, **kwargs):
        return PressAuthEntry(
            press_public_key=press.public_key.hex(),
            mldsa44_key_hash="0x",
            active=True,
            authorized_at="2026-01-01T00:00:00Z",
            revoked_at=None,
        )

    return _get


@pytest.mark.asyncio
async def test_valid_attestation_verifies() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture()

    result = await verify_join_attestation(
        envelope, matrix_user_id, SERVER_NAME, freshness_seconds=300, verifier=verifier,
        now=dt.datetime.fromisoformat("2026-07-12T00:00:05+00:00"),
    )
    assert result.valid is True
    assert result.card_hash == card_hash
    assert len(result.chain) >= 1


@pytest.mark.asyncio
async def test_wrong_server_name_denied() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture()

    result = await verify_join_attestation(
        envelope, matrix_user_id, "different-server.internal", freshness_seconds=300, verifier=verifier,
    )
    assert result.valid is False
    assert result.deny_reason == "attestation_invalid"


@pytest.mark.asyncio
async def test_payload_server_name_mismatch_denied() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture(server_name="other.internal")

    result = await verify_join_attestation(
        envelope, matrix_user_id, SERVER_NAME, freshness_seconds=300, verifier=verifier,
    )
    assert result.valid is False
    assert result.deny_reason == "attestation_invalid"


@pytest.mark.asyncio
async def test_stale_timestamp_denied() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture()

    result = await verify_join_attestation(
        envelope, matrix_user_id, SERVER_NAME, freshness_seconds=300, verifier=verifier,
        now=dt.datetime.fromisoformat("2026-07-12T01:00:00+00:00"),  # 1hr later, > 300s window
    )
    assert result.valid is False
    assert result.deny_reason == "attestation_invalid"


@pytest.mark.asyncio
async def test_mismatched_joining_user_denied() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture()

    other_user_id = derive_matrix_user_id("deadbeef", SERVER_NAME)
    result = await verify_join_attestation(
        envelope, other_user_id, SERVER_NAME, freshness_seconds=300, verifier=verifier,
    )
    assert result.valid is False
    assert result.deny_reason == "attestation_invalid"


@pytest.mark.asyncio
async def test_tampered_card_hash_denied() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture()
    envelope["payload"]["card_hash"] = _b64url_bytes(bytes.fromhex("00" * 32))

    result = await verify_join_attestation(
        envelope, matrix_user_id, SERVER_NAME, freshness_seconds=300, verifier=verifier,
    )
    assert result.valid is False
    assert result.deny_reason == "attestation_invalid"


@pytest.mark.asyncio
async def test_missing_signatures_denied() -> None:
    envelope, verifier, card_hash, matrix_user_id = _build_attestation_fixture()
    envelope["signatures"] = []

    result = await verify_join_attestation(
        envelope, matrix_user_id, SERVER_NAME, freshness_seconds=300, verifier=verifier,
    )
    assert result.valid is False
    assert result.deny_reason == "attestation_invalid"
