import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from membership_card_verifier.stages.stage2 import verify_stage2
from membership_card_verifier.types import CardEntry, SubCardEntry
from tests.fixtures import (
    encrypt_for_card,
    generate_keypair,
    make_card_doc,
    make_sub_card_doc,
)


DUMMY_CERT_ROOT = "0x" + "f" * 64


def mock_rpc(**overrides) -> AsyncMock:
    rpc = AsyncMock()
    rpc.get_card_entry.return_value = None
    rpc.is_policy_authorizer.return_value = False
    rpc.get_press_authorization.return_value = None
    rpc.get_sub_card_entry.return_value = None
    rpc.get_card_event_log.return_value = []
    rpc.get_eas_annotations.return_value = []
    for name, value in overrides.items():
        setattr(rpc, name, value)
    return rpc


def mock_ipfs(responses: dict[str, bytes] | None = None) -> AsyncMock:
    responses = responses or {}
    ipfs = AsyncMock()

    async def _fetch(cid: str) -> bytes:
        if cid in responses:
            return responses[cid]
        raise Exception(f"CID not found: {cid}")

    ipfs.fetch.side_effect = _fetch
    return ipfs


class TestStage2SubCardToMasterLink:
    @pytest.mark.asyncio
    async def test_card_not_found_returns_scope_clean_false(self):
        sub = generate_keypair()
        rpc = mock_rpc(get_card_entry=AsyncMock(return_value=None))
        ipfs = mock_ipfs()
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=DUMMY_CERT_ROOT, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert result.errors[0].code == "CARD_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_decryption_failure_returns_scope_clean_false(self):
        sub = generate_keypair()
        rpc = mock_rpc(
            get_card_entry=AsyncMock(
                return_value=CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            )
        )
        ipfs = mock_ipfs({"QmSub": bytes([0xAA] * 40)})
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=DUMMY_CERT_ROOT, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert result.errors[0].code == "DECRYPTION_FAILED"

    @pytest.mark.asyncio
    async def test_address_binding_mismatch_returns_scope_clean_false(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()

        sub_doc_corrupt = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        sub_doc_corrupt["holder_primary_card"] = (
            "0000000000000000000000000000000000000000000000000000000000000001"
        )

        encrypted = encrypt_for_card(sub.public_key, json.dumps(sub_doc_corrupt).encode("utf-8"))
        rpc = mock_rpc(
            get_card_entry=AsyncMock(
                return_value=CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            )
        )
        ipfs = mock_ipfs({"QmSub": encrypted})
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=DUMMY_CERT_ROOT, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert result.errors[0].code == "ADDRESS_BINDING_MISMATCH"

    @pytest.mark.asyncio
    async def test_sub_card_not_in_master_registry_returns_scope_clean_false(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address="0xdifferent",
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs({"QmSub": enc_sub_doc, "QmMaster": enc_master_doc})
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=DUMMY_CERT_ROOT, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert result.errors[0].code == "ADDRESS_BINDING_MISMATCH"

    @pytest.mark.asyncio
    async def test_invalid_app_signature_returns_scope_clean_false(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        wrong_app_signer = generate_keypair()
        cert_root = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        # app_card_pubkey points at `app`, but the app_signature is produced by
        # a different keypair, so ML-DSA-44 verification against app.public_key
        # fails. holder_signature is computed over the doc as-is, so it remains
        # valid — isolating the failure to Step 13 (app_signature) only.
        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            wrong_app_signer.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]
        # App card would otherwise chain cleanly to cert_root — if the
        # fall-through bug regresses, this would let scope_clean end up true.
        app_card_doc = make_card_doc(
            app.public_key,
            cert_root.secret_key,
            app.secret_key,
            press.secret_key,
            [base64.urlsafe_b64encode(cert_root.public_key).decode("ascii").rstrip("=")],
        )

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )
        enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == app.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmApp",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs(
            {
                "QmSub": enc_sub_doc,
                "QmMaster": enc_master_doc,
                "QmApp": enc_app_doc,
            }
        )
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=cert_root.address, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert result.app_card_chain_valid is False
        assert any(e.code == "INVALID_APP_SIGNATURE" for e in result.errors)

    @pytest.mark.asyncio
    async def test_inactive_sub_card_returns_scope_clean_false(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=False,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at="2026-06-01T00:00:00Z",
                )
            ),
        )
        ipfs = mock_ipfs({"QmSub": enc_sub_doc, "QmMaster": enc_master_doc})
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=DUMMY_CERT_ROOT, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert any(e.code == "SUB_CARD_INACTIVE" for e in result.errors)

    @pytest.mark.asyncio
    async def test_happy_path_returns_scope_clean_true_with_master_card_doc(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        cert_root = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]
        app_card_doc = make_card_doc(
            app.public_key,
            cert_root.secret_key,
            app.secret_key,
            press.secret_key,
            [base64.urlsafe_b64encode(cert_root.public_key).decode("ascii").rstrip("=")],
        )

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )
        enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == app.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmApp",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs(
            {
                "QmSub": enc_sub_doc,
                "QmMaster": enc_master_doc,
                "QmApp": enc_app_doc,
            }
        )
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=cert_root.address, max_chain_depth=None),
        )
        assert result.scope_clean is True
        assert result.master_card_doc is not None
        assert result.app_card_chain_valid is True


class TestStage2AppCardChainWalk:
    @pytest.mark.asyncio
    async def test_direct_hop_app_card_chain_valid_true(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        cert_root = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]
        app_card_doc = make_card_doc(
            app.public_key,
            cert_root.secret_key,
            app.secret_key,
            press.secret_key,
            [base64.urlsafe_b64encode(cert_root.public_key).decode("ascii").rstrip("=")],
        )

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )
        enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == app.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmApp",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs(
            {
                "QmSub": enc_sub_doc,
                "QmMaster": enc_master_doc,
                "QmApp": enc_app_doc,
            }
        )

        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=cert_root.address, max_chain_depth=None),
        )
        assert result.scope_clean is True
        assert result.app_card_chain_valid is True
        assert not any(e.code == "APP_CARD_CHAIN_NOT_TRUSTED" for e in result.errors)

    @pytest.mark.asyncio
    async def test_multi_hop_chain_valid_true(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        intermediate = generate_keypair()
        cert_root = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]
        app_card_doc = make_card_doc(
            app.public_key,
            intermediate.secret_key,
            app.secret_key,
            press.secret_key,
            [
                base64.urlsafe_b64encode(intermediate.public_key)
                .decode("ascii")
                .rstrip("=")
            ],
        )
        intermediate_doc = make_card_doc(
            intermediate.public_key,
            cert_root.secret_key,
            intermediate.secret_key,
            press.secret_key,
            [base64.urlsafe_b64encode(cert_root.public_key).decode("ascii").rstrip("=")],
        )

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )
        enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))
        enc_intermediate_doc = encrypt_for_card(
            intermediate.public_key, json.dumps(intermediate_doc).encode("utf-8")
        )

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == app.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmApp",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == intermediate.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmIntermediate",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs(
            {
                "QmSub": enc_sub_doc,
                "QmMaster": enc_master_doc,
                "QmApp": enc_app_doc,
                "QmIntermediate": enc_intermediate_doc,
            }
        )

        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=cert_root.address, max_chain_depth=None),
        )
        assert result.scope_clean is True
        assert result.app_card_chain_valid is True

    @pytest.mark.asyncio
    async def test_chain_does_not_reach_root_scope_clean_false(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        wrong_root = generate_keypair()
        cert_root = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        import base64
        master_doc["active_subcards"] = [
            base64.urlsafe_b64encode(sub.public_key).decode("ascii").rstrip("=")
        ]
        app_card_doc = make_card_doc(
            app.public_key,
            wrong_root.secret_key,
            app.secret_key,
            press.secret_key,
            [],
        )

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )
        enc_app_doc = encrypt_for_card(app.public_key, json.dumps(app_card_doc).encode("utf-8"))

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == app.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmApp",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs(
            {
                "QmSub": enc_sub_doc,
                "QmMaster": enc_master_doc,
                "QmApp": enc_app_doc,
            }
        )

        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=cert_root.address, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert result.app_card_chain_valid is False
        assert any(e.code == "APP_CARD_CHAIN_NOT_TRUSTED" for e in result.errors)

    @pytest.mark.asyncio
    async def test_sub_card_not_in_active_subcards(self):
        sub = generate_keypair()
        holder = generate_keypair()
        app = generate_keypair()
        issuer = generate_keypair()
        press = generate_keypair()

        sub_doc = make_sub_card_doc(
            holder.public_key,
            holder.secret_key,
            app.public_key,
            app.secret_key,
            sub.public_key,
        )
        master_doc = make_card_doc(
            holder.public_key,
            issuer.secret_key,
            holder.secret_key,
            press.secret_key,
        )
        master_doc["active_subcards"] = []

        enc_sub_doc = encrypt_for_card(sub.public_key, json.dumps(sub_doc).encode("utf-8"))
        enc_master_doc = encrypt_for_card(
            holder.public_key, json.dumps(master_doc).encode("utf-8")
        )

        async def get_card_entry_impl(addr: str):
            if addr == sub.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmSub",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            if addr == holder.address:
                return CardEntry(
                    exists=True,
                    log_head_cid="QmMaster",
                    policy_address="0x",
                    last_press_address="0x",
                    forward_to=None,
                )
            return None

        rpc = mock_rpc(
            get_card_entry=AsyncMock(side_effect=get_card_entry_impl),
            get_sub_card_entry=AsyncMock(
                return_value=SubCardEntry(
                    master_card_address=holder.address,
                    registration_log_head="0x",
                    sub_card_doc_cid="QmSub",
                    active=True,
                    registered_at="2026-01-01T00:00:00Z",
                    deregistered_at=None,
                )
            ),
        )
        ipfs = mock_ipfs({"QmSub": enc_sub_doc, "QmMaster": enc_master_doc})
        result = await verify_stage2(
            sub.public_key,
            rpc,
            ipfs,
            SimpleNamespace(app_certification_root=DUMMY_CERT_ROOT, max_chain_depth=None),
        )
        assert result.scope_clean is False
        assert any(e.code == "SUB_CARD_NOT_IN_ACTIVE_DIRECTORY" for e in result.errors)
