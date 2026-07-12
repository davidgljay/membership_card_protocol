import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional

from membership_card_verifier.types import (
    LogUpdate,
    RevocationStatus,
    RpcProvider,
    VerificationError,
)


@dataclass
class Stage4Result:
    revocation: RevocationStatus
    was_valid_at_signing_time: bool | Literal["skipped"]
    is_currently_valid: bool | Literal["skipped"]
    log_updates: list[LogUpdate]
    errors: list[VerificationError]


async def verify_stage4(
    chain_card_addresses: list[str],
    signing_timestamp: str,
    rpc: RpcProvider,
    config,
) -> Stage4Result:
    freshness_window = (
        config.revocation_freshness_window_seconds
        if hasattr(config, "revocation_freshness_window_seconds")
        and config.revocation_freshness_window_seconds is not None
        else 300
    )
    reject_stale = (
        config.reject_stale_revocation
        if hasattr(config, "reject_stale_revocation")
        and config.reject_stale_revocation is not None
        else True
    )

    errors: list[VerificationError] = []
    log_updates: list[LogUpdate] = []

    fetched_at = time.time()

    # Parallel log fetches for all cards in the chain
    async def _fetch_one(addr: str):
        entries = await rpc.get_log_entries(addr)
        return addr, entries

    all_logs = await asyncio.gather(
        *(_fetch_one(addr) for addr in chain_card_addresses)
    )

    # Collect non-revocation updates (1xx–7xx) and find earliest revocation
    earliest_revocation: Optional[tuple[int, str]] = None

    for addr, entries in all_logs:
        for entry in entries:
            code = entry.update_code
            if 100 <= code <= 799:
                log_updates.append(
                    LogUpdate(
                        card_address=addr,
                        update_code=code,
                        cid=entry.cid,
                        effective_date=entry.effective_date,
                    )
                )
            elif code >= 800:
                # 8xx or 9xx revocation
                if earliest_revocation is None or entry.effective_date < earliest_revocation[1]:
                    earliest_revocation = (code, entry.effective_date)

    data_freshness = int(time.time() - fetched_at)
    is_stale = data_freshness > freshness_window

    if is_stale:
        errors.append(
            VerificationError(
                stage=4,
                code="STALE_REVOCATION_DATA",
                message=f"Revocation data is {data_freshness}s old (limit: {freshness_window}s)",
            )
        )

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"

    if not earliest_revocation:
        is_currently_valid = False if (is_stale and reject_stale) else True
        return Stage4Result(
            revocation=RevocationStatus(
                status="not_revoked",
                code=None,
                effective_date=None,
                data_freshness_seconds=data_freshness,
            ),
            was_valid_at_signing_time=True,
            is_currently_valid=is_currently_valid,
            log_updates=log_updates,
            errors=errors,
        )

    code, effective_date = earliest_revocation
    is_8xx = 800 <= code <= 899
    status: Literal["revoked", "loud_revocation"] = "revoked" if is_8xx else "loud_revocation"

    was_valid_at_signing = signing_timestamp < effective_date
    is_currently_valid = now < effective_date
    if is_stale and reject_stale:
        is_currently_valid = False

    return Stage4Result(
        revocation=RevocationStatus(
            status=status,
            code=code,
            effective_date=effective_date,
            data_freshness_seconds=data_freshness,
        ),
        was_valid_at_signing_time=was_valid_at_signing,
        is_currently_valid=is_currently_valid,
        log_updates=log_updates,
        errors=errors,
    )
