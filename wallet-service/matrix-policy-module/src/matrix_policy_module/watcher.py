"""Watcher daemon (Step 11a).

A long-running process, not a Synapse callback — callbacks are
request-scoped and can't hold a persistent subscription
(matrix_join_attestation_and_revocation.md §3.1). Runs alongside the Synapse
module (same container/process group).

Responsibilities:
1. Holds a push subscription to the registry logic contract's
   CardHeadUpdated event, filtered (application-side — see rpc_provider.py's
   CardHeadEventSubscription docstring) to the membership registry's current
   watch-set.
2. On a matching event for a watched address: invalidate_and_refresh that
   one address in the cache, and if the refreshed result shows a revocation
   (8xx "revoked" or 9xx "loud_revocation" — no distinction, confirmed
   2026-07-12), force-part every membership that depends on it.
3. Force-part with retry-with-backoff — a failed call must not be treated
   as "handled" (§3.3); the post hook's per-message deny-on-revoked-cache
   remains the floor until it succeeds.
4. Runs a coarse backstop re-walk of the full watch-set on
   watcher_backstop_interval_seconds (default 3600, confirmed 2026-07-12) —
   a correctness floor, not the primary detection path.
5. On reconnect after a subscription drop, performs a catch-up eth_getLogs
   query over the outage window before resuming the live subscription;
   requests evaluated during an uncaught-up gap are treated as stale (deny) —
   exposed here as `is_catching_up`, which module.py's hooks should check.

**Force-part mechanism, resolved 2026-07-12 (was an open item — the
originally-guessed HTTP admin-API endpoint below has been confirmed NOT to
exist):** researched against current Synapse docs/source/issue tracker.
There is no Synapse Admin API HTTP endpoint to force-remove a user from a
room — the Room Membership admin API only forces a *join*
(element-hq/synapse#17885, filed for exactly this gap, closed "not
planned"). Since the watcher runs in-process alongside the Synapse module
(same container/process group, §3.1), it has direct access to `ModuleApi`,
which exposes `update_room_membership(sender, target, room_id,
new_membership, content=None) -> EventBase`
(`synapse/module_api/__init__.py`, confirmed against current `develop`) — a
privileged in-process call, not an HTTP request, so **no admin token is
needed at all** (Step 7b, "generate the watcher's Synapse admin-API token",
is unnecessary and should not be built).

**One real requirement this surfaces:** `update_room_membership` still runs
through Synapse's normal membership handler, which enforces ordinary
Matrix power-level auth — `sender` needs kick permission in that specific
room, the same as any other Matrix kick. This means a dedicated enforcement
account (not any of the card-holder shadow accounts) must be granted
sufficient power level (>= the room's kick level) in every card-gated
room's initial `m.room.power_levels` state at creation time — a new
requirement for Step 16 (room creation, Phase 4, not yet built), not
something this module can retrofit after the fact.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional, Protocol

from matrix_policy_module.cache import ChainWalkCache
from matrix_policy_module.membership_registry import MembershipRegistry
from matrix_policy_module.rpc_provider import CardHeadEventSubscription

logger = logging.getLogger(__name__)

_REVOKED_STATUSES = {"revoked", "loud_revocation"}


class SynapseAdminClient(Protocol):
    async def force_part(self, room_id: str, matrix_user_id: str) -> None: ...


class ModuleApiForcePartClient:
    """Wraps `ModuleApi.update_room_membership` — an in-process, privileged
    call, not an HTTP admin request. `enforcement_sender` must be a local
    user with kick permission in every card-gated room (granted at room
    creation, Step 16) — this is not the module's own identity, since a
    Synapse module has no Matrix user ID of its own to act as."""

    def __init__(self, module_api: Any, enforcement_sender: str) -> None:
        self._module_api = module_api
        self._enforcement_sender = enforcement_sender

    async def force_part(self, room_id: str, matrix_user_id: str) -> None:
        await self._module_api.update_room_membership(
            sender=self._enforcement_sender,
            target=matrix_user_id,
            room_id=room_id,
            new_membership="leave",
        )


class Watcher:
    def __init__(
        self,
        registry: MembershipRegistry,
        cache: ChainWalkCache,
        admin_client: SynapseAdminClient,
        subscription: CardHeadEventSubscription,
        backstop_interval_seconds: int = 3600,
        force_part_max_retries: int = 5,
        force_part_retry_base_delay_seconds: float = 1.0,
    ) -> None:
        self._registry = registry
        self._cache = cache
        self._admin_client = admin_client
        self._subscription = subscription
        self._backstop_interval_seconds = backstop_interval_seconds
        self._force_part_max_retries = force_part_max_retries
        self._force_part_retry_base_delay_seconds = force_part_retry_base_delay_seconds
        self._last_processed_block: Optional[int] = None
        self.is_catching_up = False

    async def handle_card_head_updated(self, card_address: str) -> None:
        """Core logic for a single detected event or backstop entry —
        exposed directly (not just via the subscription loop) so tests and
        the backstop loop can drive it without a real event source."""
        if card_address not in self._registry.watched_addresses():
            return  # not relevant to any currently active membership

        result = await self._cache.invalidate_and_refresh(card_address)
        if result.revocation.status not in _REVOKED_STATUSES:
            return

        for room_id, matrix_user_id in self._registry.memberships_for_address(card_address):
            await self._force_part_with_retry(room_id, matrix_user_id, card_address)

    async def _force_part_with_retry(self, room_id: str, matrix_user_id: str, card_address: str) -> None:
        delay = self._force_part_retry_base_delay_seconds
        for attempt in range(self._force_part_max_retries):
            try:
                await self._admin_client.force_part(room_id, matrix_user_id)
                self._registry.remove_membership(room_id, matrix_user_id)
                if card_address not in self._registry.watched_addresses():
                    self._cache.drop(card_address)
                return
            except Exception:
                logger.warning(
                    "force-part failed for %s in %s (attempt %d/%d); retrying",
                    matrix_user_id, room_id, attempt + 1, self._force_part_max_retries,
                )
                await asyncio.sleep(delay)
                delay *= 2
        logger.error(
            "force-part permanently failed for %s in %s after %d attempts — "
            "post-time denial (module.py) remains the only enforcement floor until this succeeds",
            matrix_user_id, room_id, self._force_part_max_retries,
        )

    async def run_backstop_loop(self, stop_event: Optional[asyncio.Event] = None) -> None:
        stop_event = stop_event or asyncio.Event()
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self._backstop_interval_seconds)
            except asyncio.TimeoutError:
                pass
            if stop_event.is_set():
                return
            for address in list(self._registry.watched_addresses()):
                await self.handle_card_head_updated(address)

    async def run_subscription_loop(self) -> None:
        await self._subscription.connect()
        try:
            async for event in self._subscription.subscribe_card_head_updated():
                self._last_processed_block = event.block_number
                await self.handle_card_head_updated(event.card_address)
        finally:
            await self._subscription.close()

    async def catch_up(self, from_block: int, to_block: int | str = "latest") -> None:
        """Reconnect catch-up (matrix_join_attestation_and_revocation.md §3.3):
        replays missed events over the outage window before the caller
        resumes the live subscription. `is_catching_up` should be checked by
        module.py's join/post hooks and treated as deny-worthy staleness
        while True."""
        self.is_catching_up = True
        try:
            events = await self._subscription.get_logs_since(from_block, to_block)
            for event in events:
                await self.handle_card_head_updated(event.card_address)
                self._last_processed_block = event.block_number
        finally:
            self.is_catching_up = False
