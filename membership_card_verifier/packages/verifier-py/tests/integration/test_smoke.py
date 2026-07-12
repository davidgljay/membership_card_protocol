import base64
import json
from unittest.mock import AsyncMock

from membership_card_verifier.card_verifier import CardVerifier
from membership_card_verifier.types import CardEntry, PressAuthEntry, SubCardEntry, VerifierConfig

from tests.fixtures import encrypt_for_card, generate_keypair, make_card_doc, make_sub_card_doc, sign

DUMMY_APP_CERT_ROOT = "0x" + "d" * 64


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _make_envelope(public_key: bytes, secret_key) -> dict:
    payload = {
        "message": "hello world",
        "protocol_version": "0.1",
        "timestamp": "2026-06-20T00:00:00Z",
    }
    signature = sign(secret_key, payload)
    return {
        "payload": payload,
        "signatures": [{"public_key": _b64url(public_key), "signature": signature}],
    }


def _mock_rpc(**overrides) -> AsyncMock:
    rpc = AsyncMock()
    rpc.get_card_entry.return_value = None
    rpc.is_policy_authorizer.return_value = False
    rpc.get_press_authorization.return_value = None
    rpc.get_sub_card_entry.return_value = None
    rpc.get_log_entries.return_value = []
    rpc.get_eas_annotations.return_value = []
    for name, value in overrides.items():
        setattr(rpc, name, value)
    return rpc


def _mock_ipfs(responses: dict[str, bytes] | None = None) -> AsyncMock:
    responses = responses or {}
    ipfs = AsyncMock()

    async def _fetch(cid: str) -> bytes:
        if cid in responses:
            return responses[cid]
        raise Exception(f"CID not found: {cid}")

    ipfs.fetch.side_effect = _fetch
    return ipfs


async def test_full_pipeline_verifies_sub_card_signed_envelope_end_to_end():
    root = generate_keypair()
    parent = generate_keypair()
    holder = generate_keypair()
    sub = generate_keypair()
    app = generate_keypair()
    app_cert_root = generate_keypair()
    press = generate_keypair()

    policy_doc = {"field_definitions": {}}
    policy_bytes = json.dumps(policy_doc).encode("utf-8")
    POLICY_CID = "QmPolicy"

    parent_doc = make_card_doc(
        parent.public_key,
        root.secret_key,
        parent.secret_key,
        press.secret_key,
        [_b64url(root.public_key)],
    )
    parent_doc["policy_id"] = POLICY_CID
    PARENT_CID = "QmParent"

    master_doc = make_card_doc(
        holder.public_key,
        parent.secret_key,
        holder.secret_key,
        press.secret_key,
        [_b64url(parent.public_key)],
    )
    master_doc["policy_id"] = POLICY_CID
    master_doc["active_subcards"] = [_b64url(sub.public_key)]
    MASTER_CID = "QmMaster"

    sub_doc = make_sub_card_doc(
        holder.public_key, holder.secret_key, app.public_key, app.secret_key, sub.public_key
    )
    SUB_CID = "QmSub"

    app_card_doc = make_card_doc(
        app.public_key,
        app_cert_root.secret_key,
        app.secret_key,
        press.secret_key,
        [_b64url(app_cert_root.public_key)],
    )
    APP_CID = "QmApp"

    enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
    enc_master_doc = encrypt_for_card(holder.public_key, json.dumps(master_doc).encode("utf-8"))
    enc_parent_doc = encrypt_for_card(parent.public_key, json.dumps(parent_doc).encode("utf-8"))
    enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

    envelope = _make_envelope(sub.public_key, sub.secret_key)

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
            log_head_cid=cid,
            policy_address="0x" + "f" * 64,
            last_press_address=press.address,
            forward_to=None,
            exists=True,
        )

    async def get_card_entry(addr: str):
        if addr == sub.address:
            return make_card_entry(SUB_CID)
        if addr == holder.address:
            return make_card_entry(MASTER_CID)
        if addr == parent.address:
            return make_card_entry(PARENT_CID)
        if addr == app.address:
            return make_card_entry(APP_CID)
        return None

    async def is_policy_authorizer(addr: str) -> bool:
        return addr == root.address

    async def get_sub_card_entry(addr: str):
        return sub_card_entry if addr == sub.address else None

    rpc = _mock_rpc(
        get_card_entry=AsyncMock(side_effect=get_card_entry),
        is_policy_authorizer=AsyncMock(side_effect=is_policy_authorizer),
        get_press_authorization=AsyncMock(return_value=press_entry),
        get_sub_card_entry=AsyncMock(side_effect=get_sub_card_entry),
    )
    ipfs = _mock_ipfs(
        {
            SUB_CID: enc_sub_doc,
            MASTER_CID: enc_master_doc,
            PARENT_CID: enc_parent_doc,
            APP_CID: enc_app_doc,
            POLICY_CID: policy_bytes,
        }
    )

    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            trusted_roots=[root.address],
            app_certification_root=app_cert_root.address,
        )
    )
    result = await verifier.verify_envelope(envelope)

    assert len(result.envelope_id) == 64
    int(result.envelope_id, 16)  # must be valid hex
    assert len(result.signatures) == 1

    sig0 = result.signatures[0]
    assert sig0.signature_valid is True
    assert sig0.scope_clean is True
    assert sig0.chain_reaches_trusted_root is True
    assert sig0.is_currently_valid is True
    assert sig0.was_valid_at_signing_time is True
    assert sig0.revocation.status == "not_revoked"
    assert sig0.policy_compliant is True
    assert sig0.press_subsequently_revoked is False
    assert [
        e for e in sig0.errors if not (e.stage == 5 and e.code == "NON_COMPLIANCE_REPORT_FAILED")
    ] == []
    assert sig0.app_card_chain_valid is True


async def test_stage2_card_not_found_skips_stages_3_through_5():
    sub = generate_keypair()
    rpc = _mock_rpc(get_card_entry=AsyncMock(return_value=None))
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=_mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
    )
    envelope = _make_envelope(sub.public_key, sub.secret_key)
    result = await verifier.verify_envelope(envelope)
    r = result.signatures[0]
    assert r.scope_clean is False
    assert r.chain_reaches_trusted_root == "skipped"
    assert r.was_valid_at_signing_time == "skipped"
    assert r.is_currently_valid == "skipped"
    assert r.policy_compliant == "skipped"
