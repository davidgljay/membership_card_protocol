"""Tests that hard rejections propagate the correct "skipped" semantics to downstream stages."""

import json
from unittest.mock import AsyncMock

from membership_card_verifier.card_verifier import CardVerifier
from membership_card_verifier.types import CardEntry, SubCardEntry, VerifierConfig

from tests.fixtures import encrypt_for_card, generate_keypair, make_card_doc, make_sub_card_doc
from tests.integration._helpers import b64url, make_envelope, mock_ipfs, mock_rpc

DUMMY_APP_CERT_ROOT = "0x" + "d" * 64


async def test_stage2_card_not_found_skips_stages_3_5():
    sub = generate_keypair()
    rpc = mock_rpc(get_card_entry=AsyncMock(return_value=None))
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=mock_ipfs(), app_certification_root=DUMMY_APP_CERT_ROOT)
    )
    result = await verifier.verify_envelope(make_envelope(sub.public_key, sub.secret_key))
    r = result.signatures[0]
    assert r.scope_clean is False
    assert r.chain_reaches_trusted_root == "skipped"
    assert r.was_valid_at_signing_time == "skipped"
    assert r.is_currently_valid == "skipped"
    assert r.policy_compliant == "skipped"


async def test_stage2_decryption_failure_skips_stages_3_5():
    sub = generate_keypair()
    rpc = mock_rpc(
        get_card_entry=AsyncMock(
            return_value=CardEntry(
                log_head_cid="QmSub",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
                exists=True,
            )
        )
    )
    # Provide garbage bytes that will fail AES-GCM auth
    ipfs = mock_ipfs({"QmSub": bytes([0xAA] * 40)})
    verifier = CardVerifier(
        VerifierConfig(rpc=rpc, ipfs=ipfs, app_certification_root=DUMMY_APP_CERT_ROOT)
    )
    result = await verifier.verify_envelope(make_envelope(sub.public_key, sub.secret_key))
    r = result.signatures[0]
    assert r.scope_clean is False
    assert r.chain_reaches_trusted_root == "skipped"
    assert r.was_valid_at_signing_time == "skipped"
    assert r.is_currently_valid == "skipped"
    assert r.policy_compliant == "skipped"


async def test_stage3_depth_exceeded_skips_stages_4_5():
    sub = generate_keypair()
    holder = generate_keypair()
    app = generate_keypair()
    app_cert_root = generate_keypair()
    issuer = generate_keypair()
    press = generate_keypair()
    fake_ancestor = generate_keypair()

    sub_doc = make_sub_card_doc(
        holder.public_key, holder.secret_key, app.public_key, app.secret_key, sub.public_key
    )
    # Master card has ancestry_pubkeys pointing to fake_ancestor (which points to itself —
    # causes depth exceeded in stage 3)
    master_doc = make_card_doc(
        holder.public_key,
        issuer.secret_key,
        holder.secret_key,
        press.secret_key,
        [b64url(fake_ancestor.public_key)],
    )
    # Add sub-card to active_subcards so Stage 2 passes
    master_doc["active_subcards"] = [b64url(sub.public_key)]
    ancestor_doc = make_card_doc(
        fake_ancestor.public_key,
        issuer.secret_key,
        fake_ancestor.secret_key,
        press.secret_key,
        [b64url(fake_ancestor.public_key)],  # cycle
    )
    # App card chains to app_cert_root (direct hop) — stage 2 must pass before stage 3 runs
    app_card_doc = make_card_doc(
        app.public_key,
        app_cert_root.secret_key,
        app.secret_key,
        press.secret_key,
        [b64url(app_cert_root.public_key)],
    )

    enc_sub = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
    enc_master = encrypt_for_card(holder.public_key, json.dumps(master_doc).encode("utf-8"))
    enc_ancestor = encrypt_for_card(
        fake_ancestor.public_key, json.dumps(ancestor_doc).encode("utf-8")
    )
    enc_app = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

    sub_entry = SubCardEntry(
        master_card_address=holder.address,
        registration_log_head="0x",
        sub_card_doc_cid="QmSub",
        active=True,
        registered_at="2026-01-01T00:00:00Z",
        deregistered_at=None,
    )

    async def get_card_entry(addr: str):
        if addr == sub.address:
            return CardEntry(
                log_head_cid="QmSub",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
                exists=True,
            )
        if addr == holder.address:
            return CardEntry(
                log_head_cid="QmMaster",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
                exists=True,
            )
        if addr == app.address:
            return CardEntry(
                log_head_cid="QmApp",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
                exists=True,
            )
        return CardEntry(
            log_head_cid="QmAncestor",
            policy_address="0x",
            last_press_address="0x",
            forward_to=None,
            exists=True,
        )

    rpc = mock_rpc(
        get_card_entry=AsyncMock(side_effect=get_card_entry),
        get_sub_card_entry=AsyncMock(return_value=sub_entry),
        is_policy_authorizer=AsyncMock(return_value=False),
    )
    ipfs = mock_ipfs(
        {"QmSub": enc_sub, "QmMaster": enc_master, "QmAncestor": enc_ancestor, "QmApp": enc_app}
    )

    verifier = CardVerifier(
        VerifierConfig(
            rpc=rpc,
            ipfs=ipfs,
            max_chain_depth=2,
            app_certification_root=app_cert_root.address,
        )
    )
    result = await verifier.verify_envelope(make_envelope(sub.public_key, sub.secret_key))
    r = result.signatures[0]
    # Stage 2 should pass (scope_clean: true)
    assert r.scope_clean is True
    # Stage 3 fails with depth exceeded
    assert r.chain_reaches_trusted_root is False
    assert any(e.code == "CHAIN_DEPTH_EXCEEDED" for e in r.errors)
    # Stages 4-5 still run (they don't depend on stage3 having succeeded)
    assert r.was_valid_at_signing_time != "skipped"
    assert r.is_currently_valid != "skipped"
