"""Step 10 integration tests: chain_context.py against a real (crypto-wise)
join attestation envelope, verified through membership_card_verifier's real
CardVerifier — only RPC/IPFS are mocked, per that package's own test
convention (tests/integration/test_full_pipeline.py). Reused directly here
via sys.path, since this is the same monorepo and there is no reason to
re-author fixture-building crypto helpers matrix-policy-module doesn't own.

Per messaging_protocol.md, protocol messages (and, per
matrix_join_attestation_and_revocation.md §1, join attestations) are signed
by a sub-card, not a master card directly — verify_envelope's Stage 2
expects a SubCardDocument shape for the signer, so the fixture below builds
the full root -> parent -> master -> sub-card chain the same way
test_full_pipeline.py does, not a simplified two-hop version.

Exercises the full path an actual join-attestation verification takes:
attestation envelope -> chain_context.walk_join_attestation_chain ->
extract_chain -> predicates.evaluate_room_predicate, matching how module.py's
join hook will use these together in Step 12.
"""

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

_VERIFIER_PY_ROOT = (
    Path(__file__).resolve().parents[3] / "membership_card_verifier" / "packages" / "verifier-py"
)
sys.path.insert(0, str(_VERIFIER_PY_ROOT))

from membership_card_verifier import CardVerifier, VerifierConfig  # noqa: E402
from membership_card_verifier.types import CardEntry, EnvelopeVerificationResult, PressAuthEntry, SubCardEntry  # noqa: E402
from tests.fixtures import (  # noqa: E402
    encrypt_for_card,
    generate_keypair,
    make_card_doc,
    make_sub_card_doc,
    sign,
)
from tests.integration._helpers import b64url, mock_ipfs, mock_rpc  # noqa: E402

from matrix_policy_module.chain_context import extract_chain, walk_join_attestation_chain  # noqa: E402
from matrix_policy_module.predicates import evaluate_room_predicate  # noqa: E402

POLICY_CID = "QmRoomPolicy"


def _build_join_attestation_fixture():
    """root (trusted) <- parent <- holder (master) <- sub (signs the attestation)."""
    root = generate_keypair()
    parent = generate_keypair()
    holder = generate_keypair()
    sub = generate_keypair()
    app = generate_keypair()
    app_cert_root = generate_keypair()
    press = generate_keypair()

    parent_doc = make_card_doc(
        parent.public_key, root.secret_key, parent.secret_key, press.secret_key, [b64url(root.public_key)]
    )
    parent_doc["policy_id"] = POLICY_CID
    parent_doc["status"] = "active"
    PARENT_CID = "QmParent"

    holder_doc = make_card_doc(
        holder.public_key,
        parent.secret_key,
        holder.secret_key,
        press.secret_key,
        [b64url(parent.public_key)],
    )
    holder_doc["policy_id"] = POLICY_CID
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
    enc_parent_doc = encrypt_for_card(parent.public_key, json.dumps(parent_doc).encode("utf-8"))
    enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

    payload = {
        "message": "join-attestation",
        "protocol_version": "0.1",
        "timestamp": "2026-07-12T00:00:00Z",
        "matrix_user_id": "@card_placeholder:matrix.internal",
        "server_name": "matrix.internal",
    }
    envelope = {
        "payload": payload,
        "signatures": [
            {"public_key": b64url(sub.public_key), "signature": sign(sub.secret_key, payload)}
        ],
    }

    sub_card_entry = SubCardEntry(
        master_card_address=holder.address,
        registration_log_head="0x",
        sub_card_doc_cid=SUB_CID,
        active=True,
        registered_at="2026-01-01T00:00:00Z",
        deregistered_at=None,
    )
    press_entry = PressAuthEntry(
        press_public_key=press.public_key.hex(),
        mldsa44_key_hash="0x",
        active=True,
        authorized_at="2026-01-01T00:00:00Z",
        revoked_at=None,
    )

    def make_card_entry(cid: str) -> CardEntry:
        return CardEntry(
            log_head_cid=cid, policy_address="0x" + "f" * 64, last_press_address=press.address,
            forward_to=None, exists=True,
        )

    async def get_card_entry(addr: str):
        return {
            sub.address: make_card_entry(SUB_CID),
            holder.address: make_card_entry(MASTER_CID),
            parent.address: make_card_entry(PARENT_CID),
            app.address: make_card_entry(APP_CID),
        }.get(addr)

    async def is_policy_authorizer(addr: str) -> bool:
        return addr == root.address

    async def get_sub_card_entry(addr: str):
        return sub_card_entry if addr == sub.address else None

    rpc = mock_rpc(
        get_card_entry=AsyncMock(side_effect=get_card_entry),
        is_policy_authorizer=AsyncMock(side_effect=is_policy_authorizer),
        get_press_authorization=AsyncMock(return_value=press_entry),
        get_sub_card_entry=AsyncMock(side_effect=get_sub_card_entry),
    )
    ipfs = mock_ipfs(
        {SUB_CID: enc_sub_doc, MASTER_CID: enc_master_doc, PARENT_CID: enc_parent_doc, APP_CID: enc_app_doc}
    )

    return root, app_cert_root, rpc, ipfs, envelope


@pytest.mark.asyncio
async def test_walk_join_attestation_chain_produces_usable_chain() -> None:
    root, app_cert_root, rpc, ipfs, envelope = _build_join_attestation_fixture()
    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            app_certification_root=app_cert_root.address,
            trusted_roots=[root.address],
            return_chain=True,
        )
    )

    result = await walk_join_attestation_chain(verifier, envelope)
    assert result.signatures[0].chain_reaches_trusted_root is True
    assert result.signatures[0].is_currently_valid is True

    chain = extract_chain(result)
    assert len(chain) >= 1
    assert any(link.card_content.get("policy_id") == POLICY_CID for link in chain)


@pytest.mark.asyncio
async def test_extracted_chain_satisfies_room_predicate() -> None:
    root, app_cert_root, rpc, ipfs, envelope = _build_join_attestation_fixture()
    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            app_certification_root=app_cert_root.address,
            trusted_roots=[root.address],
            return_chain=True,
        )
    )

    result = await walk_join_attestation_chain(verifier, envelope)
    chain = extract_chain(result)

    matching_doc = {
        "policies": [
            {"ref_type": "cid", "ref": POLICY_CID, "field_match": {"field": "status", "regex": "^active$"}}
        ]
    }
    assert evaluate_room_predicate(matching_doc, chain) == (True, None)

    non_matching_doc = {"policies": [{"ref_type": "cid", "ref": "QmSomeOtherPolicy"}]}
    assert evaluate_room_predicate(non_matching_doc, chain) == (False, "no_policy_match")


@pytest.mark.asyncio
async def test_extract_chain_empty_when_no_signatures() -> None:
    result = EnvelopeVerificationResult(
        envelope_id="", verified_at="", protocol_version="0.1", signatures=[]
    )
    assert extract_chain(result) == []
