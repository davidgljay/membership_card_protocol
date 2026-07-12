from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from membership_card_verifier.stages.stage4 import verify_stage4
from membership_card_verifier.types import LogEntry


def mock_rpc(log_map: dict[str, list[LogEntry]]) -> AsyncMock:
    rpc = AsyncMock()

    async def _get_log_entries(addr: str) -> list[LogEntry]:
        return log_map.get(addr, [])

    rpc.get_log_entries.side_effect = _get_log_entries
    rpc.get_eas_annotations.return_value = []
    return rpc


SIGNING_TIME = "2026-06-01T00:00:00Z"
CHAIN = ["0xcard1"]
BASE_CONFIG = SimpleNamespace(
    revocation_freshness_window_seconds=300, reject_stale_revocation=True
)


@pytest.mark.asyncio
async def test_no_revocation_entries_not_revoked_was_valid_is_valid():
    rpc = mock_rpc({"0xcard1": []})
    result = await verify_stage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.status == "not_revoked"
    assert result.was_valid_at_signing_time is True
    assert result.is_currently_valid is True


@pytest.mark.asyncio
async def test_8xx_revocation_after_signing_time():
    rpc = mock_rpc(
        {
            "0xcard1": [
                LogEntry(
                    update_code=810,
                    effective_date="2026-06-15T00:00:00Z",
                    cid="Qm1",
                )
            ]
        }
    )
    result = await verify_stage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.status == "revoked"
    assert result.was_valid_at_signing_time is True
    assert result.is_currently_valid is False


@pytest.mark.asyncio
async def test_8xx_revocation_before_signing_time():
    rpc = mock_rpc(
        {
            "0xcard1": [
                LogEntry(
                    update_code=810,
                    effective_date="2026-05-01T00:00:00Z",
                    cid="Qm1",
                )
            ]
        }
    )
    result = await verify_stage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.was_valid_at_signing_time is False


@pytest.mark.asyncio
async def test_9xx_revocation_produces_loud_revocation_status():
    rpc = mock_rpc(
        {
            "0xcard1": [
                LogEntry(
                    update_code=900,
                    effective_date="2026-06-15T00:00:00Z",
                    cid="Qm1",
                )
            ]
        }
    )
    result = await verify_stage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.status == "loud_revocation"


@pytest.mark.asyncio
async def test_multiple_revocation_entries_earliest_governs():
    rpc = mock_rpc(
        {
            "0xcard1": [
                LogEntry(
                    update_code=810,
                    effective_date="2026-06-20T00:00:00Z",
                    cid="Qm2",
                ),
                LogEntry(
                    update_code=810,
                    effective_date="2026-06-10T00:00:00Z",
                    cid="Qm1",
                ),
            ]
        }
    )
    result = await verify_stage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG)
    assert result.revocation.effective_date == "2026-06-10T00:00:00Z"


@pytest.mark.asyncio
async def test_non_revocation_log_entries_appear_in_log_updates():
    rpc = mock_rpc(
        {
            "0xcard1": [
                LogEntry(
                    update_code=100,
                    effective_date="2026-06-01T00:00:00Z",
                    cid="QmUpdate",
                ),
            ]
        }
    )
    result = await verify_stage4(CHAIN, SIGNING_TIME, rpc, BASE_CONFIG)
    assert len(result.log_updates) == 1
    assert result.log_updates[0].update_code == 100
