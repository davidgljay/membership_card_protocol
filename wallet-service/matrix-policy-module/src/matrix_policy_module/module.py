"""Synapse module entrypoint (Step 12).

Registers user_may_join_room and check_event_for_spam against Synapse's Spam
Checker callback category (not the "very experimental" check_event_allowed —
matrix_synapse_module.md's Callback Selection section already confirmed this
against Synapse's own docs).

**Join-attestation wire transport — resolved 2026-07-12 (was an open item in
matrix_join_attestation_and_revocation.md §1):** `user_may_join_room`'s real
signature is `(user, room, is_invited)`, with no room for extra request
content — a signed attestation object cannot reach that callback at all,
structurally, regardless of what the client sends. The resolution: the
client embeds the attestation as a custom, namespaced key
(`io.cardprotocol.join_attestation`) in the `m.room.member` join event's own
content. Matrix event content is extensible by design (arbitrary additional
keys are permitted and ignored by clients that don't understand them) — this
is the same mechanism MSC3083 (restricted rooms) already uses to carry a
signed join authorization inside the join event itself, not a bespoke
mechanism invented here. Per matrix_synapse_module.md's own note, state
events (including `m.room.member`) already pass through
`check_event_for_spam`, which *does* receive the full event object —
`user_may_join_room` is therefore a permissive no-op below; the real join
gating happens in `check_event_for_spam` when it sees an `m.room.member`
event with `content.membership == "join"` in a card-gated room.

**One open item remains, flagged rather than guessed past:** Synapse's exact
ModuleApi call for reading a room's current `m.card.policy` state event
content hasn't been confirmed against current Synapse docs (unlike
check_event_for_spam vs. check_event_allowed, which matrix_synapse_module.md
already did confirm). `_room_policy_resolver` is injected so the
authorization logic itself stays fully testable independent of that
unresolved API-surface question.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional, Protocol

from matrix_policy_module.attestation import verify_join_attestation
from matrix_policy_module.cache import ChainWalkCache
from matrix_policy_module.chain_context import build_verifier
from matrix_policy_module.config import PolicyModuleConfig
from matrix_policy_module.ipfs_provider import HttpxIpfsProvider
from matrix_policy_module.membership_registry import MembershipRegistry
from matrix_policy_module.predicates import evaluate_room_predicate

logger = logging.getLogger(__name__)

_REVOKED_STATUSES = {"revoked", "loud_revocation"}
_CONTENT_BEARING_EVENT_TYPES = {"m.room.message"}
_JOIN_ATTESTATION_CONTENT_KEY = "io.cardprotocol.join_attestation"


class RoomPolicyResolver(Protocol):
    async def get_policy_id(self, room_id: str) -> Optional[str]: ...


class PolicyModule:
    def __init__(
        self,
        config: dict,
        api: Any,
        *,
        room_policy_resolver: Optional[RoomPolicyResolver] = None,
        trusted_roots: Optional[list[str]] = None,
    ) -> None:
        self.config = PolicyModuleConfig.parse(config)
        self.api = api
        self._room_policy_resolver = room_policy_resolver
        self._verifier = build_verifier(self.config, trusted_roots or [])
        self._ipfs = HttpxIpfsProvider(self.config.ipfs_gateway_url)
        self._registry = MembershipRegistry.from_key_path(
            self.config.membership_registry_path, self.config.membership_registry_key_path
        )
        self._cache = ChainWalkCache(refresh_revocation=self._refresh_revocation)
        api.register_spam_checker_callbacks(
            user_may_join_room=self.user_may_join_room,
            check_event_for_spam=self.check_event_for_spam,
        )

    async def _refresh_revocation(self, card_address: str):
        from matrix_policy_module.chain_context import verify_card_revocation

        result = await verify_card_revocation(self._verifier, card_address)
        return result.revocation, result.is_currently_valid

    # ---- join ----

    async def user_may_join_room(self, user: str, room: str, is_invited: bool) -> Any:
        # Structurally can't see the join attestation (no request content on
        # this callback) — always defers. The actual gate is
        # check_event_for_spam's handling of the m.room.member/join event
        # below, which does carry the attestation in its content.
        return self.api.NOT_SPAM

    async def _authorize_join_event(self, event: Any) -> Any:
        room_id = event.room_id
        matrix_user_id = event.sender

        envelope = getattr(event, "content", {}).get(_JOIN_ATTESTATION_CONTENT_KEY)
        if envelope is None:
            logger.info("join denied for %s in %s: no attestation presented", matrix_user_id, room_id)
            return self.api.errors.Codes.FORBIDDEN

        attestation = await verify_join_attestation(
            envelope,
            joining_matrix_user_id=matrix_user_id,
            server_name=self.config.matrix_server_name,
            freshness_seconds=self.config.join_attestation_freshness_seconds,
            verifier=self._verifier,
        )
        if not attestation.valid:
            logger.info("join denied for %s in %s: %s", matrix_user_id, room_id, attestation.deny_reason)
            return self.api.errors.Codes.FORBIDDEN

        policy_id = await self._resolve_policy_id(room_id)
        if policy_id is None:
            logger.warning("join denied for %s in %s: room has no m.card.policy state", matrix_user_id, room_id)
            return self.api.errors.Codes.FORBIDDEN

        predicate_document = await self._fetch_predicate_document(policy_id)
        if predicate_document is None:
            logger.warning("join denied for %s in %s: predicate document unreachable", matrix_user_id, room_id)
            return self.api.errors.Codes.FORBIDDEN

        satisfies_policy = self._safe_evaluate_predicate(predicate_document, attestation.chain, room_id, matrix_user_id)
        if satisfies_policy is not True:
            reason = "evaluation_error" if satisfies_policy is None else "policy_violation"
            logger.info("join denied for %s in %s: %s", matrix_user_id, room_id, reason)
            return self.api.errors.Codes.FORBIDDEN

        watched_addresses = [link.card_address for link in attestation.chain] or [attestation.card_hash]
        self._registry.register(room_id, matrix_user_id, attestation.card_hash, watched_addresses, joined_at=_now_iso())
        if attestation.revocation is not None:
            self._cache.seed_from_join(
                attestation.card_hash, attestation.chain, attestation.revocation, attestation.is_currently_valid
            )

        return self.api.NOT_SPAM

    # ---- post ----

    async def check_event_for_spam(self, event: Any) -> Any:
        room_id = event.room_id
        policy_id = await self._resolve_policy_id(room_id)
        if policy_id is None:
            return self.api.NOT_SPAM  # not a card-gated room — defer to normal event-auth

        event_type = getattr(event, "type", None)
        if event_type == "m.room.member" and getattr(event, "content", {}).get("membership") == "join":
            return await self._authorize_join_event(event)

        if event_type not in _CONTENT_BEARING_EVENT_TYPES:
            return self.api.NOT_SPAM  # other state events pass through; power levels handle those

        matrix_user_id = event.sender
        card_hash = self._registry.resolve_card_hash(room_id, matrix_user_id)
        if card_hash is None:
            logger.info("post denied for %s in %s: membership_not_registered", matrix_user_id, room_id)
            return self.api.errors.Codes.FORBIDDEN

        cached = await self._cache.get(card_hash)
        if cached.revocation.status in _REVOKED_STATUSES:
            logger.info("post denied for %s in %s: card revoked", matrix_user_id, room_id)
            return self.api.errors.Codes.FORBIDDEN

        predicate_document = await self._fetch_predicate_document(policy_id)
        if predicate_document is None:
            logger.warning("post denied for %s in %s: predicate document unreachable", matrix_user_id, room_id)
            return self.api.errors.Codes.FORBIDDEN

        satisfies_policy = self._safe_evaluate_predicate(predicate_document, cached.chain, room_id, matrix_user_id)
        if satisfies_policy is not True:
            reason = "evaluation_error" if satisfies_policy is None else "policy_violation"
            logger.info("post denied for %s in %s: %s", matrix_user_id, room_id, reason)
            return self.api.errors.Codes.FORBIDDEN

        return self.api.NOT_SPAM

    # ---- shared helpers ----

    def _safe_evaluate_predicate(
        self, predicate_document: dict[str, Any], chain: list, room_id: str, matrix_user_id: str
    ) -> Optional[bool]:
        """Wraps predicates.evaluate_room_predicate so a bug or unexpected
        shape in the evaluator denies (per matrix_room_membership.md §4's
        "Predicate evaluation itself throws" row) rather than propagating an
        uncaught exception out of a Synapse callback with undefined
        allow/deny consequences. Returns None (denied, logged as
        evaluation_error) on any exception, True/False otherwise."""
        try:
            return evaluate_room_predicate(predicate_document, chain)
        except Exception:
            logger.exception("predicate evaluation raised for %s in %s", matrix_user_id, room_id)
            return None

    async def _resolve_policy_id(self, room_id: str) -> Optional[str]:
        # NOTE: a real implementation must distinguish "room genuinely has no
        # m.card.policy state" (pass through, per matrix_synapse_module.md)
        # from "state read failed" (should deny, per matrix_room_membership.md
        # §4's deny-by-default failure table — a read failure is not the same
        # as absence). Both currently collapse to None here, since
        # RoomPolicyResolver's real Synapse-API-backed implementation is
        # itself the still-open item flagged in this module's docstring.
        # Revisit this once that resolver is actually wired to a confirmed
        # Synapse ModuleApi call.
        if self._room_policy_resolver is None:
            return None
        return await self._room_policy_resolver.get_policy_id(room_id)

    async def _fetch_predicate_document(self, policy_id: str) -> Optional[dict[str, Any]]:
        try:
            raw = await self._ipfs.fetch(policy_id)
            return json.loads(raw)
        except Exception:
            return None


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
