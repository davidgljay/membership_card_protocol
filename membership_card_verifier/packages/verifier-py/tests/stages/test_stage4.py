from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from membership_card_verifier.stages.stage4 import verify_stage4
from membership_card_verifier.types import CardChainEvent, CardEntry, ChainLink


def mock_rpc(
    event_map: dict[str, list[CardChainEvent]],
    head_cid_overrides: dict[str, str] | None = None,
) -> AsyncMock:
    """
    Builds a mock RpcProvider whose `get_card_entry`/`get_card_event_log` responses
    for a given card address are driven by an explicit, ground-truth on-chain event
    list. `head_cid` defaults to the last event's cid (i.e. the on-chain head
    matches the latest event) unless overridden, so tests can also construct a
    head/event mismatch.
    """
    head_cid_overrides = head_cid_overrides or {}
    rpc = AsyncMock()

    async def _get_card_entry(addr: str) -> CardEntry:
        events = event_map.get(addr, [])
        last_event = events[-1] if events else None
        log_head_cid = head_cid_overrides.get(addr) or (last_event.cid if last_event else "")
        return CardEntry(
            log_head_cid=log_head_cid,
            policy_address="0x",
            last_press_address="0x",
            forward_to=None,
            exists=True,
        )

    async def _get_card_event_log(addr: str) -> list[CardChainEvent]:
        return event_map.get(addr, [])

    rpc.get_card_entry.side_effect = _get_card_entry
    rpc.get_card_event_log.side_effect = _get_card_event_log
    rpc.get_eas_annotations.return_value = []
    return rpc


def chain_link(card_address: str, card_content: dict) -> ChainLink:
    return ChainLink(card_address=card_address, public_key="", card_content=card_content)


SIGNING_TIME = "2026-06-01T00:00:00Z"
BASE_CONFIG = SimpleNamespace(
    revocation_freshness_window_seconds=300, reject_stale_revocation=True
)


@pytest.mark.asyncio
async def test_genesis_card_no_onchain_events_not_revoked_was_valid_is_valid():
    rpc = mock_rpc({"0xcard1": []}, {"0xcard1": "QmGenesis"})
    chain = [chain_link("0xcard1", {"policy_id": "QmPolicy"})]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.status == "not_revoked"
    assert result.was_valid_at_signing_time is True
    assert result.is_currently_valid is True
    assert result.errors == []


@pytest.mark.asyncio
async def test_8xx_revocation_after_signing_time():
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmRevoke", timestamp="2026-06-15T00:00:00Z"),
            ]
        }
    )
    chain = [
        chain_link(
            "0xcard1",
            {
                "entry_type": "revocation",
                "code": 810,
                "history": ["QmGenesis"],
                "revocation": {"effective_date": "2026-06-15T00:00:00Z"},
            },
        )
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.status == "revoked"
    assert result.revocation.effective_date == "2026-06-15T00:00:00Z"
    assert result.was_valid_at_signing_time is True
    assert result.is_currently_valid is False
    assert result.errors == []


@pytest.mark.asyncio
async def test_8xx_revocation_before_signing_time():
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis", timestamp="2026-04-01T00:00:00Z"),
                CardChainEvent(cid="QmRevoke", timestamp="2026-05-01T00:00:00Z"),
            ]
        }
    )
    chain = [
        chain_link(
            "0xcard1",
            {
                "entry_type": "revocation",
                "code": 810,
                "history": ["QmGenesis"],
                "revocation": {"effective_date": "2026-05-01T00:00:00Z"},
            },
        )
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.was_valid_at_signing_time is False


@pytest.mark.asyncio
async def test_9xx_revocation_produces_loud_revocation_status():
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmRevoke", timestamp="2026-06-15T00:00:00Z"),
            ]
        }
    )
    chain = [
        chain_link(
            "0xcard1",
            {
                "entry_type": "revocation",
                "code": 900,
                "history": ["QmGenesis"],
                "revocation": {"effective_date": "2026-06-15T00:00:00Z"},
            },
        )
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.status == "loud_revocation"


@pytest.mark.asyncio
async def test_multiple_chain_links_one_revoked_earliest_governs():
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis1", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmRevoke1", timestamp="2026-06-20T00:00:00Z"),
            ],
            "0xcard2": [
                CardChainEvent(cid="QmGenesis2", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmRevoke2", timestamp="2026-06-10T00:00:00Z"),
            ],
        }
    )
    chain = [
        chain_link(
            "0xcard1",
            {
                "entry_type": "revocation",
                "code": 810,
                "history": ["QmGenesis1"],
                "revocation": {"effective_date": "2026-06-20T00:00:00Z"},
            },
        ),
        chain_link(
            "0xcard2",
            {
                "entry_type": "revocation",
                "code": 810,
                "history": ["QmGenesis2"],
                "revocation": {"effective_date": "2026-06-10T00:00:00Z"},
            },
        ),
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.effective_date == "2026-06-10T00:00:00Z"


@pytest.mark.asyncio
async def test_non_revocation_log_entries_appear_in_log_updates_dated_by_onchain_event():
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmUpdate", timestamp="2026-06-01T00:00:00Z"),
            ]
        }
    )
    chain = [
        chain_link(
            "0xcard1",
            {"entry_type": "field_update", "code": 100, "history": ["QmGenesis"]},
        )
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert len(result.log_updates) == 1
    assert result.log_updates[0].update_code == 100
    assert result.log_updates[0].cid == "QmUpdate"
    assert result.log_updates[0].effective_date == "2026-06-01T00:00:00Z"


@pytest.mark.asyncio
async def test_history_mismatch_when_self_reported_history_disagrees_with_onchain_replay():
    # On-chain ground truth has two prior entries before the head...
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmMiddle", timestamp="2026-05-15T00:00:00Z"),
                CardChainEvent(cid="QmUpdate", timestamp="2026-06-01T00:00:00Z"),
            ]
        }
    )
    # ...but the IPFS head content only claims one predecessor, omitting QmMiddle.
    chain = [
        chain_link(
            "0xcard1",
            {"entry_type": "field_update", "code": 100, "history": ["QmGenesis"]},
        )
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert any(e.code == "HISTORY_MISMATCH" and e.stage == 4 for e in result.errors)


@pytest.mark.asyncio
async def test_no_history_mismatch_when_self_reported_history_matches_onchain_replay():
    rpc = mock_rpc(
        {
            "0xcard1": [
                CardChainEvent(cid="QmGenesis", timestamp="2026-05-01T00:00:00Z"),
                CardChainEvent(cid="QmMiddle", timestamp="2026-05-15T00:00:00Z"),
                CardChainEvent(cid="QmUpdate", timestamp="2026-06-01T00:00:00Z"),
            ]
        }
    )
    chain = [
        chain_link(
            "0xcard1",
            {
                "entry_type": "field_update",
                "code": 100,
                "history": ["QmGenesis", "QmMiddle"],
            },
        )
    ]
    result = await verify_stage4(chain, SIGNING_TIME, rpc, BASE_CONFIG)
    assert not any(e.code == "HISTORY_MISMATCH" for e in result.errors)
