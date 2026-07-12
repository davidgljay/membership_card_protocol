import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from membership_card_verifier.stages.stage3 import verify_stage3
from membership_card_verifier.types import CardEntry
from tests.fixtures import encrypt_for_card, generate_keypair, make_card_doc


def mock_rpc(**overrides) -> AsyncMock:
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


def mock_ipfs(responses: dict[str, bytes] | None = None) -> AsyncMock:
    responses = responses or {}
    ipfs = AsyncMock()

    async def _fetch(cid: str) -> bytes:
        if cid in responses:
            return responses[cid]
        raise Exception(f"CID not found: {cid}")

    ipfs.fetch.side_effect = _fetch
    return ipfs


async def test_chain_terminates_at_trusted_root_in_config():
    child = generate_keypair()
    grandchild = generate_keypair()
    press = generate_keypair()

    grandchild_doc = make_card_doc(
        grandchild.public_key,
        child.secret_key,
        grandchild.secret_key,
        press.secret_key,
        [base64.urlsafe_b64encode(child.public_key).decode("ascii").rstrip("=")],
    )

    async def _get_card_entry(addr: str):
        if addr == child.address:
            return CardEntry(
                exists=True,
                log_head_cid="QmChild",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
            )
        return None

    rpc = mock_rpc()
    rpc.is_policy_authorizer.return_value = False
    rpc.get_card_entry.side_effect = _get_card_entry
    ipfs = mock_ipfs()

    result = await verify_stage3(
        grandchild_doc,
        grandchild.address,
        rpc,
        ipfs,
        SimpleNamespace(trusted_roots=[child.address], max_chain_depth=64),
    )

    assert result.chain_reaches_trusted_root is True
    assert child.address in result.chain_card_addresses


async def test_chain_exhausted_without_trusted_root_returns_false():
    issuer = generate_keypair()
    holder = generate_keypair()
    press = generate_keypair()

    card_doc = make_card_doc(
        holder.public_key,
        issuer.secret_key,
        holder.secret_key,
        press.secret_key,
        [],
    )
    rpc = mock_rpc()
    rpc.is_policy_authorizer.return_value = False

    result = await verify_stage3(
        card_doc,
        holder.address,
        rpc,
        mock_ipfs(),
        SimpleNamespace(trusted_roots=[], max_chain_depth=64),
    )

    assert result.chain_reaches_trusted_root is False


async def test_card_with_empty_ancestry_and_is_policy_authorizer_true_reaches_trusted_root():
    issuer = generate_keypair()
    holder = generate_keypair()
    press = generate_keypair()

    card_doc = make_card_doc(
        holder.public_key,
        issuer.secret_key,
        holder.secret_key,
        press.secret_key,
        [],
    )
    rpc = mock_rpc()
    rpc.is_policy_authorizer.return_value = True

    result = await verify_stage3(
        card_doc,
        holder.address,
        rpc,
        mock_ipfs(),
        SimpleNamespace(trusted_roots=[], max_chain_depth=64),
    )

    assert result.chain_reaches_trusted_root is True


async def test_depth_exceeded_returns_chain_reaches_trusted_root_false_with_chain_depth_exceeded():
    issuer = generate_keypair()
    holder = generate_keypair()
    press = generate_keypair()
    fake_ancestor = generate_keypair()

    card_doc = make_card_doc(
        holder.public_key,
        issuer.secret_key,
        holder.secret_key,
        press.secret_key,
        [base64.urlsafe_b64encode(fake_ancestor.public_key).decode("ascii").rstrip("=")],
    )

    fake_enc_doc = encrypt_for_card(
        fake_ancestor.public_key,
        json.dumps(
            make_card_doc(
                fake_ancestor.public_key,
                issuer.secret_key,
                fake_ancestor.secret_key,
                press.secret_key,
                [base64.urlsafe_b64encode(fake_ancestor.public_key).decode("ascii").rstrip("=")],
            )
        ).encode("utf-8"),
    )

    rpc = mock_rpc()
    rpc.is_policy_authorizer.return_value = False
    rpc.get_card_entry.return_value = CardEntry(
        exists=True,
        log_head_cid="QmAncestor",
        policy_address="0x",
        last_press_address="0x",
        forward_to=None,
    )

    ipfs = mock_ipfs({"QmAncestor": fake_enc_doc})

    result = await verify_stage3(
        card_doc,
        holder.address,
        rpc,
        ipfs,
        SimpleNamespace(trusted_roots=[], max_chain_depth=2),
    )

    assert result.chain_reaches_trusted_root is False
    assert any(e.code == "CHAIN_DEPTH_EXCEEDED" for e in result.errors)
