import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from membership_card_verifier.stages.stage6 import verify_stage6
from membership_card_verifier.types import CardEntry, EasAttestation


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


CHAIN = ["0x" + "a" * 64]


async def test_fetch_annotations_false_returns_empty_without_network_calls():
    rpc = mock_rpc()
    ipfs = mock_ipfs()
    result = await verify_stage6(CHAIN, rpc, ipfs, SimpleNamespace(fetch_annotations=False))
    assert len(result.annotations) == 0
    rpc.get_eas_annotations.assert_not_called()
    ipfs.fetch.assert_not_called()


async def test_recommended_annotators_endpoint_fetch_failure_proceeds_with_empty_list():
    rpc = mock_rpc(
        get_eas_annotations=AsyncMock(return_value=[])
    )
    result = await verify_stage6(
        CHAIN,
        rpc,
        mock_ipfs(),
        SimpleNamespace(
            fetch_annotations=True,
            additional_annotators=[],
            trusted_roots=None,
            max_chain_depth=None,
        ),
    )
    assert len(result.annotations) == 0
    assert any(e.code == "RECOMMENDED_ANNOTATORS_FETCH_FAILED" for e in result.errors)


async def test_additional_annotators_are_included_even_if_recommended_list_fails():
    annotator_addr = "0x" + "b" * 64
    attestation = EasAttestation(
        uid="0x" + "c" * 64,
        attester=annotator_addr,
        cid="QmAnnotation",
        update_code=400,
        effective_date="2026-06-20T00:00:00Z",
    )
    content = {"note": "looks fine"}

    rpc = mock_rpc(
        get_eas_annotations=AsyncMock(return_value=[attestation]),
        get_card_entry=AsyncMock(
            return_value=CardEntry(
                exists=True,
                log_head_cid="QmAnnotator",
                policy_address="0x",
                last_press_address="0x",
                forward_to=None,
            )
        ),
        is_policy_authorizer=AsyncMock(return_value=False),
    )
    ipfs = mock_ipfs(
        {
            "QmAnnotation": json.dumps(content).encode("utf-8"),
        }
    )

    result = await verify_stage6(
        CHAIN,
        rpc,
        ipfs,
        SimpleNamespace(
            fetch_annotations=True,
            additional_annotators=[annotator_addr],
            trusted_roots=None,
            max_chain_depth=None,
        ),
    )

    assert len(result.annotations) == 1
    assert result.annotations[0].eas_uid == attestation.uid
    assert result.annotations[0].is_recommended_annotator is False


async def test_annotation_ipfs_fetch_failure_omits_annotation_and_records_error():
    annotator_addr = "0x" + "b" * 64
    attestation = EasAttestation(
        uid="0x" + "c" * 64,
        attester=annotator_addr,
        cid="QmMissing",
        update_code=400,
        effective_date="2026-06-20T00:00:00Z",
    )

    rpc = mock_rpc(
        get_eas_annotations=AsyncMock(return_value=[attestation])
    )
    result = await verify_stage6(
        CHAIN,
        rpc,
        mock_ipfs(),
        SimpleNamespace(
            fetch_annotations=True,
            additional_annotators=[annotator_addr],
            trusted_roots=None,
            max_chain_depth=None,
        ),
    )

    assert len(result.annotations) == 0
    assert any(e.code == "ANNOTATION_FETCH_FAILED" for e in result.errors)
