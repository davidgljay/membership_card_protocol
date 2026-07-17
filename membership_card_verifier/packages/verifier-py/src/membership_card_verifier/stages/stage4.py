import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from membership_card_verifier.types import (
    ChainLink,
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
    chain: list[ChainLink],
    signing_timestamp: str,
    rpc: RpcProvider,
    config,
) -> Stage4Result:
    """
    Stage 4 — Revocation Check.

    There is no on-chain-enumerable per-entry log: the registry contract's
    `CardEntries` mapping stores only the current `log_head_cid`
    (`registry_contract.md §3.1`). "The log" for a card is reconstructed here from
    two independent sources, per `ipfs_card.md §5` / `protocol-objects.md §3`
    ("Provenance verification"):

     1. The card's current head content, already fetched and decrypted by Stage 3
        (`ChainLink.card_content`) — either the genesis `CardDocument` (never
        updated) or the most recent `LogEntry` (`entry_type`/`code`/`history`/
        `card_state`/`revocation`, per `protocol-objects.md §3`).
     2. The ground-truth on-chain event replay (`RpcProvider.get_card_event_log`),
        which returns only `{cid, timestamp}` pairs — never content.

    The head content tells us *what* the current state is (revoked or not, which
    field-update code if any); the on-chain event replay tells us *when* that
    became true (authoritative block timestamp) and lets us cross-check that the
    head's self-reported `history` claim matches the real on-chain record.
    """
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

    # Resolve on-chain CardEntry + event-log replay for every chain member in parallel.
    async def _fetch_one(link: ChainLink):
        card_entry, event_log = await asyncio.gather(
            rpc.get_card_entry(link.card_address),
            rpc.get_card_event_log(link.card_address),
        )
        return link, card_entry, event_log

    per_card = await asyncio.gather(*(_fetch_one(link) for link in chain))

    earliest_revocation: Optional[tuple[int, str]] = None
    any_content_available = False
    any_content_unavailable = False

    for link, card_entry, event_log in per_card:
        addr = link.card_address
        content: dict[str, Any] = link.card_content or {}
        head_cid = card_entry.log_head_cid if card_entry else None

        has_content = bool(content) and len(content) > 0
        if not has_content:
            # No decrypted content available for this chain member (e.g. verify_card,
            # which has no pubkey and therefore cannot decrypt anything — see §7.3/§7.4
            # "verify_card limitation" in card_verifier.md). We can still use the event
            # log for provenance bookkeeping, but cannot determine revocation status.
            any_content_unavailable = True
            continue
        any_content_available = True

        entry_type = content.get("entry_type")
        is_log_entry = entry_type == "field_update" or entry_type == "revocation"

        # Provenance cross-check: does the self-reported `history` (+ own CID) match
        # the ground-truth on-chain event replay, in count and order?
        history = content.get("history")
        if is_log_entry and isinstance(history, list) and head_cid:
            claimed = [*history, head_cid]
            actual = [e.cid for e in event_log]
            matches = len(claimed) == len(actual) and all(
                c == a for c, a in zip(claimed, actual)
            )
            if not matches:
                errors.append(
                    VerificationError(
                        stage=4,
                        code="HISTORY_MISMATCH",
                        message=f"On-chain event log does not match self-reported history for {addr}",
                    )
                )

        # Authoritative timestamp for the head entry: the on-chain event matching
        # `head_cid`, not the IPFS content's self-reported date (a compromised or
        # buggy press could misreport the latter; the on-chain block timestamp cannot
        # be forged after the fact).
        head_event = next((e for e in event_log if e.cid == head_cid), None) if head_cid else None

        if is_log_entry and entry_type == "revocation":
            code = int(content.get("code", 0))
            revocation_field = content.get("revocation") or {}
            reported_date = (
                revocation_field.get("effective_date")
                if isinstance(revocation_field, dict)
                else None
            )
            effective_date = head_event.timestamp if head_event else reported_date
            if not head_event:
                errors.append(
                    VerificationError(
                        stage=4,
                        code="NO_ONCHAIN_EVENT_FOR_HEAD",
                        message=f"No on-chain event found matching head CID for {addr}; falling back to self-reported effective_date",
                    )
                )
            if effective_date:
                if earliest_revocation is None or effective_date < earliest_revocation[1]:
                    earliest_revocation = (code, effective_date)
        elif is_log_entry and entry_type == "field_update":
            log_updates.append(
                LogUpdate(
                    card_address=addr,
                    update_code=int(content.get("code", 0)),
                    cid=head_cid or "",
                    effective_date=head_event.timestamp if head_event else "",
                )
            )
        # Else: genesis CardDocument, never updated — not revoked, no field updates.

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

    # No decrypted content anywhere in the chain (verify_card's address-only path):
    # revocation status cannot be determined from content we cannot decrypt.
    if not any_content_available and any_content_unavailable:
        return Stage4Result(
            revocation=RevocationStatus(
                status="unknown",
                code=None,
                effective_date=None,
                data_freshness_seconds=data_freshness,
            ),
            was_valid_at_signing_time="skipped",
            is_currently_valid="skipped",
            log_updates=log_updates,
            errors=errors,
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
