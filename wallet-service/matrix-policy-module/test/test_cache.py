import pytest
from membership_card_verifier import ChainLink, RevocationStatus

from matrix_policy_module.cache import ChainWalkCache


def _not_revoked() -> RevocationStatus:
    return RevocationStatus(status="not_revoked", code=None, effective_date=None, data_freshness_seconds=0)


def _revoked() -> RevocationStatus:
    return RevocationStatus(status="revoked", code=901, effective_date="2026-07-12", data_freshness_seconds=0)


@pytest.mark.asyncio
async def test_cache_miss_triggers_walk_and_populates() -> None:
    calls: list[str] = []

    async def refresh(address: str) -> tuple[RevocationStatus, bool]:
        calls.append(address)
        return _not_revoked(), True

    cache = ChainWalkCache(refresh_revocation=refresh)
    result = await cache.get("0xabc")
    assert calls == ["0xabc"]
    assert result.revocation.status == "not_revoked"
    assert result.is_currently_valid is True


@pytest.mark.asyncio
async def test_subsequent_read_returns_cached_value_without_rewalking() -> None:
    calls: list[str] = []

    async def refresh(address: str) -> tuple[RevocationStatus, bool]:
        calls.append(address)
        return _not_revoked(), True

    cache = ChainWalkCache(refresh_revocation=refresh)
    await cache.get("0xabc")
    await cache.get("0xabc")
    assert calls == ["0xabc"]  # only one walk


@pytest.mark.asyncio
async def test_invalidate_and_refresh_rewalks_and_updates() -> None:
    call_count = 0

    async def refresh(address: str) -> tuple[RevocationStatus, bool]:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return _not_revoked(), True
        return _revoked(), False

    cache = ChainWalkCache(refresh_revocation=refresh)
    first = await cache.get("0xabc")
    assert first.is_currently_valid is True

    updated = await cache.invalidate_and_refresh("0xabc")
    assert updated.is_currently_valid is False
    assert updated.revocation.status == "revoked"

    # get() now reflects the refreshed value without re-walking again.
    again = await cache.get("0xabc")
    assert again.is_currently_valid is False
    assert call_count == 2


@pytest.mark.asyncio
async def test_seed_from_join_preserves_chain_across_refresh() -> None:
    async def refresh(address: str) -> tuple[RevocationStatus, bool]:
        return _revoked(), False

    cache = ChainWalkCache(refresh_revocation=refresh)
    chain = [ChainLink(card_address="0xabc", public_key="pk", card_content={"policy_id": "QmX"})]
    cache.seed_from_join("0xabc", chain, _not_revoked(), True)

    refreshed = await cache.invalidate_and_refresh("0xabc")
    assert refreshed.chain == chain  # chain content survives a revocation-only refresh
    assert refreshed.is_currently_valid is False


@pytest.mark.asyncio
async def test_drop_removes_entry_forcing_rewalk_on_next_get() -> None:
    calls: list[str] = []

    async def refresh(address: str) -> tuple[RevocationStatus, bool]:
        calls.append(address)
        return _not_revoked(), True

    cache = ChainWalkCache(refresh_revocation=refresh)
    await cache.get("0xabc")
    cache.drop("0xabc")
    await cache.get("0xabc")
    assert calls == ["0xabc", "0xabc"]
