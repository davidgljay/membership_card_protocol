"""Full end-to-end integration test.

Scenario: a sub-card signs an envelope. The sub-card's master card has one ancestor
which is a trusted root. No revocations. Policy has no required fields. Press is authorized.

All crypto is real (no mocking of crypto primitives). Only RPC and IPFS are mocked.
"""

import json
from unittest.mock import AsyncMock

from membership_card_verifier.card_verifier import CardVerifier
from membership_card_verifier.types import CardEntry, PressAuthEntry, SubCardEntry, VerifierConfig

from tests.fixtures import encrypt_for_card, generate_keypair, make_card_doc, make_sub_card_doc, sign
from tests.integration._helpers import b64url, mock_ipfs, mock_rpc


async def test_verifies_a_sub_card_signed_envelope_end_to_end():
    # Build the trust chain: root <- parent <- master <- sub-card
    root = generate_keypair()  # trusted root (in PolicyAuthorizerKeys)
    parent = generate_keypair()  # parent card
    holder = generate_keypair()  # master card holder (primary card)
    sub = generate_keypair()  # sub-card (the signer)
    app = generate_keypair()  # app that requested the sub-card
    app_cert_root = generate_keypair()  # app-certification policy root
    press = generate_keypair()  # press that registered the cards

    policy_doc = {"field_definitions": {}}
    policy_bytes = json.dumps(policy_doc).encode("utf-8")
    POLICY_CID = "QmPolicy"

    parent_doc = make_card_doc(
        parent.public_key,
        root.secret_key,
        parent.secret_key,
        press.secret_key,
        [b64url(root.public_key)],
    )
    parent_doc["policy_id"] = POLICY_CID
    PARENT_CID = "QmParent"

    master_doc = make_card_doc(
        holder.public_key,
        parent.secret_key,
        holder.secret_key,
        press.secret_key,
        [b64url(parent.public_key)],
    )
    master_doc["policy_id"] = POLICY_CID
    master_doc["active_subcards"] = [b64url(sub.public_key)]
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
        [b64url(app_cert_root.public_key)],
    )
    APP_CID = "QmApp"

    enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
    enc_master_doc = encrypt_for_card(holder.public_key, json.dumps(master_doc).encode("utf-8"))
    enc_parent_doc = encrypt_for_card(parent.public_key, json.dumps(parent_doc).encode("utf-8"))
    enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

    payload = {
        "message": "hello world",
        "protocol_version": "0.1",
        "timestamp": "2026-06-20T00:00:00Z",
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

    rpc = mock_rpc(
        get_card_entry=AsyncMock(side_effect=get_card_entry),
        is_policy_authorizer=AsyncMock(side_effect=is_policy_authorizer),
        get_press_authorization=AsyncMock(return_value=press_entry),
        get_sub_card_entry=AsyncMock(side_effect=get_sub_card_entry),
    )
    ipfs = mock_ipfs(
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
    int(result.envelope_id, 16)
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


async def test_rejects_sub_card_whose_app_card_does_not_chain_to_app_certification_root():
    root = generate_keypair()
    holder = generate_keypair()
    sub = generate_keypair()
    app = generate_keypair()
    app_cert_root = generate_keypair()  # the configured cert root
    wrong_root = generate_keypair()  # app card chains to this, not app_cert_root
    press = generate_keypair()

    policy_doc = {"field_definitions": {}}
    policy_bytes = json.dumps(policy_doc).encode("utf-8")
    POLICY_CID = "QmPolicy"

    master_doc = make_card_doc(
        holder.public_key,
        root.secret_key,
        holder.secret_key,
        press.secret_key,
        [b64url(root.public_key)],
    )
    master_doc["policy_id"] = POLICY_CID
    master_doc["active_subcards"] = [b64url(sub.public_key)]
    MASTER_CID = "QmMaster"

    sub_doc = make_sub_card_doc(
        holder.public_key, holder.secret_key, app.public_key, app.secret_key, sub.public_key
    )
    SUB_CID = "QmSub"

    # App card terminates at wrong_root, not app_cert_root — should be rejected
    app_card_doc = make_card_doc(
        app.public_key, wrong_root.secret_key, app.secret_key, press.secret_key, []
    )
    APP_CID = "QmApp"

    enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
    enc_master_doc = encrypt_for_card(holder.public_key, json.dumps(master_doc).encode("utf-8"))
    enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

    payload = {"message": "hello", "protocol_version": "0.1", "timestamp": "2026-06-20T00:00:00Z"}
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
        if addr == app.address:
            return make_card_entry(APP_CID)
        return None

    async def is_policy_authorizer(addr: str) -> bool:
        return addr == root.address

    async def get_sub_card_entry(addr: str):
        return sub_card_entry if addr == sub.address else None

    rpc = mock_rpc(
        get_card_entry=AsyncMock(side_effect=get_card_entry),
        is_policy_authorizer=AsyncMock(side_effect=is_policy_authorizer),
        get_press_authorization=AsyncMock(return_value=None),
        get_sub_card_entry=AsyncMock(side_effect=get_sub_card_entry),
    )
    ipfs = mock_ipfs(
        {
            SUB_CID: enc_sub_doc,
            MASTER_CID: enc_master_doc,
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
    sig0 = result.signatures[0]

    assert sig0.scope_clean is False
    assert sig0.app_card_chain_valid is False
    assert any(e.code == "APP_CARD_CHAIN_NOT_TRUSTED" for e in sig0.errors)
    # Stages 3-6 should be skipped
    assert sig0.chain_reaches_trusted_root == "skipped"
    assert sig0.was_valid_at_signing_time == "skipped"
    assert sig0.is_currently_valid == "skipped"
    assert sig0.policy_compliant == "skipped"
