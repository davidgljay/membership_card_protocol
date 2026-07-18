"""Arbitrum registry contract adapters.

`Web3RpcProvider` implements `membership_card_verifier.RpcProvider` (point
reads only), mirroring press/src/context.ts's `createRpcProvider` — same
honest-approximation choices carried over deliberately, not reinvented here:

- `is_policy_authorizer` always returns False. Trust roots for this module
  are the config's own trusted-root list (chain_context.py), the same
  "approximate for now" comment press/src/context.ts already carries — this
  module doesn't have a better on-chain signal for it either, since the
  registry contract has no boolean IsPolicyAuthorizer read function (only
  GetPolicyAuthorizer(policy_address) -> pubkey, which requires knowing the
  address is a policy in advance to be useful).
- `get_eas_annotations` always returns `[]`. EAS integration isn't
  implemented anywhere in this codebase yet (press's own adapter returns the
  same empty list) — this module's config sets `fetch_annotations=False`
  accordingly, mirroring press's `buildCardVerifier`.

`CardHeadEventSubscription` is the separate, genuinely-new piece the verifier
package has no equivalent of: a push subscription over the registry's
CardHeadUpdated event, for watcher.py (Step 11a). RpcProvider is a
point-read-only interface; event subscriptions are out of its scope by
design (matrix_synapse_module.md's package layout section says as much).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import httpx
from membership_card_verifier import (
    CardChainEvent,
    CardEntry,
    EasAttestation,
    LogUpdate,
    PressAuthEntry,
    SubCardEntry,
)
from web3 import AsyncWeb3
from web3.providers.persistent import WebSocketProvider

_ZERO_BYTES32 = "0x" + "00" * 32

_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "GetCardEntry",
        "stateMutability": "view",
        "inputs": [{"name": "card_address", "type": "bytes32"}],
        "outputs": [
            {"name": "log_head_cid", "type": "bytes"},
            {"name": "policy_address", "type": "bytes32"},
            {"name": "last_press_address", "type": "bytes32"},
            {"name": "forward_to", "type": "bytes32"},
            {"name": "exists", "type": "bool"},
        ],
    },
    {
        "type": "function",
        "name": "GetPressAuthorization",
        "stateMutability": "view",
        "inputs": [
            {"name": "policy_address", "type": "bytes32"},
            {"name": "press_address", "type": "bytes32"},
        ],
        "outputs": [
            {"name": "press_public_key", "type": "bytes"},
            {"name": "mldsa44_key_hash", "type": "bytes32"},
            {"name": "key_scheme", "type": "uint8"},
            {"name": "active", "type": "bool"},
            {"name": "next_sequence", "type": "uint64"},
            {"name": "authorized_at", "type": "uint64"},
            {"name": "revoked_at", "type": "uint64"},
        ],
    },
    {
        "type": "function",
        "name": "GetSubCardEntry",
        "stateMutability": "view",
        "inputs": [{"name": "sub_card_address", "type": "bytes32"}],
        "outputs": [
            {"name": "master_card_address", "type": "bytes32"},
            {"name": "registration_log_head", "type": "bytes"},
            {"name": "sub_card_doc_cid", "type": "bytes"},
            {"name": "active", "type": "bool"},
            {"name": "registered_at", "type": "uint64"},
            {"name": "deregistered_at", "type": "uint64"},
        ],
    },
]

_CARD_HEAD_UPDATED_ABI: dict[str, Any] = {
    "anonymous": False,
    "type": "event",
    "name": "CardHeadUpdated",
    "inputs": [
        {"name": "card_address", "type": "bytes32", "indexed": True},
        {"name": "prev_log_cid", "type": "bytes", "indexed": False},
        {"name": "new_log_cid", "type": "bytes", "indexed": False},
        {"name": "press_address", "type": "bytes32", "indexed": False},
        {"name": "timestamp", "type": "uint64", "indexed": False},
    ],
}

_CARD_REGISTERED_ABI: dict[str, Any] = {
    "anonymous": False,
    "type": "event",
    "name": "CardRegistered",
    "inputs": [
        {"name": "card_address", "type": "bytes32", "indexed": True},
        {"name": "policy_address", "type": "bytes32", "indexed": False},
        {"name": "press_address", "type": "bytes32", "indexed": False},
        {"name": "initial_log_cid", "type": "bytes", "indexed": False},
        {"name": "timestamp", "type": "uint64", "indexed": False},
    ],
}

_LOGIC_UPGRADE_CONFIRMED_ABI: dict[str, Any] = {
    "anonymous": False,
    "type": "event",
    "name": "LogicUpgradeConfirmed",
    "inputs": [
        {"name": "new_logic_address", "type": "address", "indexed": False},
        {"name": "confirmed_at", "type": "uint64", "indexed": False},
    ],
}


def _cid_bytes_to_string(raw: bytes) -> str:
    """Mirrors press/src/context.ts's cidBytesToString: CIDs are stored as UTF-8
    string bytes on-chain, so decode directly; empty bytes means "no CID"."""
    if not raw:
        return ""
    return raw.decode("utf-8")


_RANGE_LIMIT_ERROR_PATTERNS = (
    "block range",
    "range limit",
    "query returned more than",
    "exceeds range",
    "exceed maximum",
    "too many results",
    "limited to a",
    "-32005",  # common JSON-RPC "limit exceeded" error code, sometimes surfaced in the message
)


def _is_range_limit_error(e: Exception) -> bool:
    message = str(e).lower()
    return any(p in message for p in _RANGE_LIMIT_ERROR_PATTERNS)


class Web3RpcProvider:
    """Implements membership_card_verifier.RpcProvider against the registry
    contract, plus the IPFS log-chain walk get_log_entries needs (the
    contract only stores the current head CID, not history — see
    card_protocol_spec.md's append-only-log-on-IPFS model)."""

    def __init__(
        self,
        rpc_url: str,
        registry_contract_address: str,
        ipfs_gateway_url: str,
        max_log_walk: int = 64,
    ) -> None:
        self._w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(rpc_url))
        self._contract_address = registry_contract_address
        self._contract = self._w3.eth.contract(address=registry_contract_address, abi=_REGISTRY_ABI)
        self._ipfs_gateway_url = ipfs_gateway_url.rstrip("/")
        self._max_log_walk = max_log_walk

    async def get_card_entry(self, address: str) -> Optional[CardEntry]:
        try:
            result = await self._contract.functions.GetCardEntry(address).call()
        except Exception:
            return None
        log_head_cid, policy_address, last_press_address, forward_to, exists = result
        if not exists:
            return None
        return CardEntry(
            log_head_cid=_cid_bytes_to_string(log_head_cid),
            policy_address=policy_address,
            last_press_address=last_press_address,
            forward_to=None if forward_to == _ZERO_BYTES32 else forward_to,
            exists=exists,
        )

    async def is_policy_authorizer(self, address: str) -> bool:
        # Always False, deliberately — see module docstring above.
        return False

    async def get_press_authorization(
        self, policy_address: str, press_address: str
    ) -> Optional[PressAuthEntry]:
        try:
            result = await self._contract.functions.GetPressAuthorization(
                policy_address, press_address
            ).call()
        except Exception:
            return None
        press_public_key, mldsa44_key_hash, _key_scheme, active, _next_sequence, authorized_at, revoked_at = result
        if not active:
            return None
        return PressAuthEntry(
            press_public_key=_to_base64url(press_public_key),
            mldsa44_key_hash=mldsa44_key_hash,
            active=active,
            authorized_at=str(authorized_at),
            revoked_at=None if revoked_at == 0 else str(revoked_at),
        )

    async def get_sub_card_entry(self, sub_card_address: str) -> Optional[SubCardEntry]:
        try:
            result = await self._contract.functions.GetSubCardEntry(sub_card_address).call()
        except Exception:
            return None
        master_card_address, registration_log_head, sub_card_doc_cid, active, registered_at, deregistered_at = result
        return SubCardEntry(
            master_card_address=master_card_address,
            registration_log_head=_cid_bytes_to_string(registration_log_head),
            sub_card_doc_cid=_cid_bytes_to_string(sub_card_doc_cid),
            active=active,
            registered_at=str(registered_at),
            deregistered_at=None if deregistered_at == 0 else str(deregistered_at),
        )

    async def get_log_entries(self, card_address: str) -> list[LogUpdate]:
        """Walks the CID-linked log chain from the on-chain head, newest first —
        mirrors press/src/context.ts's getLogEntries exactly (same MAX_WALK,
        same prev_log_root field, same silent-truncate-on-fetch-failure
        behavior, since a partial log is still usable for revocation checks
        and stage4.py already treats missing entries as "not found" rather
        than raising)."""
        entries: list[LogUpdate] = []
        card_entry = await self.get_card_entry(card_address)
        if card_entry is None:
            return entries

        cid = card_entry.log_head_cid
        depth = 0
        async with httpx.AsyncClient() as client:
            while cid and depth < self._max_log_walk:
                try:
                    response = await client.get(f"{self._ipfs_gateway_url}/{cid}")
                    response.raise_for_status()
                    doc = json.loads(response.content)
                except Exception:
                    break
                code = doc.get("code")
                if code is not None:
                    entries.append(
                        LogUpdate(
                            card_address=card_address,
                            update_code=code,
                            effective_date=doc.get("effective_date", ""),
                            cid=cid,
                        )
                    )
                cid = doc.get("prev_log_root", "")
                depth += 1
        return entries

    async def get_card_event_log(self, card_address: str) -> list[CardChainEvent]:
        """Chunked, retrying CardRegistered/CardHeadUpdated replay for one card
        address, oldest-first — see plans/g3-event-log-spec.md §3 for the
        chunking/retry algorithm. Always scans from block 0 (no per-card
        starting-block cache — that's a caller concern per the spec; this
        provider has no persistence layer to keep one in)."""
        registered_contract = self._w3.eth.contract(address=self._contract_address, abi=[_CARD_REGISTERED_ABI])
        updated_contract = self._w3.eth.contract(address=self._contract_address, abi=[_CARD_HEAD_UPDATED_ABI])

        latest_block = await self._w3.eth.block_number

        min_window = 1
        window_size = 2000
        from_block = 0

        registered_logs: list[Any] = []
        updated_logs: list[Any] = []

        while from_block <= latest_block:
            to_block = min(from_block + window_size - 1, latest_block)
            try:
                registered, updated = await asyncio.gather(
                    registered_contract.events.CardRegistered().get_logs(
                        from_block=from_block, to_block=to_block, argument_filters={"card_address": card_address}
                    ),
                    updated_contract.events.CardHeadUpdated().get_logs(
                        from_block=from_block, to_block=to_block, argument_filters={"card_address": card_address}
                    ),
                )
                registered_logs.extend(registered)
                updated_logs.extend(updated)
                from_block = to_block + 1
            except Exception as e:
                if _is_range_limit_error(e) and window_size > min_window:
                    # Window forced smaller by a range-limit rejection — retry
                    # the same from_block with the smaller window. The window
                    # is not grown back afterward even if later chunks
                    # succeed; see this method's doc comment / the spec for why.
                    window_size = max(min_window, window_size // 2)
                    continue
                raise

        def _sort_key(log: Any) -> tuple[int, int]:
            return (log["blockNumber"], log["logIndex"])

        registered_logs.sort(key=_sort_key)
        updated_logs.sort(key=_sort_key)

        def _timestamp_iso(raw: int) -> str:
            return datetime.fromtimestamp(raw, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

        genesis = (
            [
                CardChainEvent(
                    cid=_cid_bytes_to_string(registered_logs[0]["args"]["initial_log_cid"]),
                    timestamp=_timestamp_iso(registered_logs[0]["args"]["timestamp"]),
                )
            ]
            if registered_logs
            else []
        )
        updates = [
            CardChainEvent(
                cid=_cid_bytes_to_string(log["args"]["new_log_cid"]),
                timestamp=_timestamp_iso(log["args"]["timestamp"]),
            )
            for log in updated_logs
        ]
        return genesis + updates

    async def get_eas_annotations(
        self, card_address: str, annotator_addresses: list[str]
    ) -> list[EasAttestation]:
        # Always [] — EAS integration isn't implemented anywhere in this
        # codebase yet; see module docstring above.
        return []


def _to_base64url(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@dataclass
class CardHeadUpdatedEvent:
    card_address: str
    prev_log_cid: str
    new_log_cid: str
    press_address: str
    timestamp: int
    block_number: int


class CardHeadEventSubscription:
    """Push subscription to the registry logic contract's CardHeadUpdated
    event, filtered to a caller-supplied watch-set. Genuinely new code — the
    verifier package's RpcProvider Protocol has no concept of event
    subscriptions, only point reads (matrix_synapse_module.md's package
    layout section). Used by watcher.py (Step 11a).

    Per registry_contract.md §7, all events are emitted by the *logic*
    contract, which is upgradeable — callers must call `repoint()` on a
    detected LogicUpgradeConfirmed and re-subscribe.
    """

    def __init__(self, ws_url: str, registry_contract_address: str) -> None:
        self._ws_url = ws_url
        self._contract_address = registry_contract_address
        self._w3: Optional[AsyncWeb3] = None

    async def connect(self) -> None:
        self._w3 = await AsyncWeb3(WebSocketProvider(self._ws_url)).__aenter__()

    async def close(self) -> None:
        if self._w3 is not None:
            await self._w3.provider.disconnect()
            self._w3 = None

    async def subscribe_card_head_updated(self) -> AsyncIterator[CardHeadUpdatedEvent]:
        """Yields every CardHeadUpdated event on the contract. Callers filter
        to their own watch-set — Ethereum's log filter topics only support
        exact-match/OR lists efficiently, and the watch-set changes far more
        often than a subscription should be torn down and rebuilt, so
        filtering by watch-set membership happens application-side in
        watcher.py, not via the subscription's topic filter itself."""
        assert self._w3 is not None, "call connect() first"
        contract = self._w3.eth.contract(address=self._contract_address, abi=[_CARD_HEAD_UPDATED_ABI])
        subscription_id = await self._w3.eth.subscribe("logs", {"address": self._contract_address})
        async for payload in self._w3.socket.process_subscriptions():
            log = payload["result"]
            try:
                event = contract.events.CardHeadUpdated().process_log(log)
            except Exception:
                continue
            args = event["args"]
            yield CardHeadUpdatedEvent(
                card_address=args["card_address"],
                prev_log_cid=_cid_bytes_to_string(args["prev_log_cid"]),
                new_log_cid=_cid_bytes_to_string(args["new_log_cid"]),
                press_address=args["press_address"],
                timestamp=args["timestamp"],
                block_number=log["blockNumber"],
            )

    async def get_logs_since(
        self, from_block: int, to_block: int | str = "latest"
    ) -> list[CardHeadUpdatedEvent]:
        """Catch-up query for a reconnect/outage gap (matrix_join_attestation_and_revocation.md §3.3)."""
        assert self._w3 is not None, "call connect() first"
        contract = self._w3.eth.contract(address=self._contract_address, abi=[_CARD_HEAD_UPDATED_ABI])
        logs = await contract.events.CardHeadUpdated().get_logs(from_block=from_block, to_block=to_block)
        return [
            CardHeadUpdatedEvent(
                card_address=log["args"]["card_address"],
                prev_log_cid=_cid_bytes_to_string(log["args"]["prev_log_cid"]),
                new_log_cid=_cid_bytes_to_string(log["args"]["new_log_cid"]),
                press_address=log["args"]["press_address"],
                timestamp=log["args"]["timestamp"],
                block_number=log["blockNumber"],
            )
            for log in logs
        ]
