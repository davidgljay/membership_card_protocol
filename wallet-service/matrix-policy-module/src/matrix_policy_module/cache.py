"""Event-invalidated chain-walk cache (Step 11).

Keyed by card_address. Unlike the original TTL design, there is no expiry —
`invalidate_and_refresh` is called by watcher.py (Step 11a) on a detected
CardHeadUpdated event or the backstop re-walk, never a timer.

**A real, worth-stating-explicitly limitation, not papered over:**
`CardVerifier.verify_card()` (chain_context.verify_card_revocation) — the
only call available for a bare address with no known public key — can never
populate `chain: list[ChainLink]` (see chain_context.py's own docstring: it
can't decrypt a CardDocument without the pubkey). So a cache entry's `chain`
field is only ever populated once, at join time, from the join attestation's
own `walk_join_attestation_chain` result (which *does* have the pubkey, via
the attestation's signature). `invalidate_and_refresh` — driven by watcher.py
off a bare `card_address` from a CardHeadUpdated event — can only refresh the
entry's *revocation* status, not re-derive chain content. This means a
`get()` on an address the module has never seen a join attestation for
(e.g. only ever appears as an ancestor in someone else's chain, never itself
the joining leaf) can have current revocation data but an empty `chain` —
callers evaluating a room predicate against such an entry should treat an
empty `chain` on a non-leaf address as "not independently re-checkable
against the predicate," not as "this address holds no policy" — the
predicate-relevant content was already captured in the *leaf's* chain at
join time and doesn't need re-deriving per ancestor.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Awaitable, Callable, Optional

from membership_card_verifier import ChainLink, RevocationStatus


@dataclass
class CachedChainResult:
    chain: list[ChainLink]
    revocation: RevocationStatus
    is_currently_valid: bool | str


class ChainWalkCache:
    def __init__(
        self,
        refresh_revocation: Callable[[str], Awaitable[tuple[RevocationStatus, bool | str]]],
    ) -> None:
        """`refresh_revocation(card_address)` is expected to be
        `chain_context.verify_card_revocation`-backed — returns
        (revocation, is_currently_valid) for the given bare address."""
        self._refresh_revocation = refresh_revocation
        self._entries: dict[str, CachedChainResult] = {}

    def seed_from_join(
        self, card_address: str, chain: list[ChainLink], revocation: RevocationStatus, is_currently_valid: bool | str
    ) -> None:
        """Populates a full entry (chain + revocation) at join time, from
        walk_join_attestation_chain's result — the only call shape that has
        real chain content."""
        self._entries[card_address] = CachedChainResult(
            chain=chain, revocation=revocation, is_currently_valid=is_currently_valid
        )

    async def get(self, card_address: str) -> CachedChainResult:
        """Returns the cached entry, walking (revocation-only, see module
        docstring) on a miss."""
        if card_address in self._entries:
            return self._entries[card_address]
        return await self.invalidate_and_refresh(card_address)

    async def invalidate_and_refresh(self, card_address: str) -> CachedChainResult:
        revocation, is_currently_valid = await self._refresh_revocation(card_address)
        existing = self._entries.get(card_address)
        chain = existing.chain if existing is not None else []
        updated = CachedChainResult(chain=chain, revocation=revocation, is_currently_valid=is_currently_valid)
        self._entries[card_address] = updated
        return updated

    def drop(self, card_address: str) -> None:
        """Called when the last membership depending on this address ends
        (room leave or force-part) — watcher.py's watch-set ref-counting
        (Step 11a) removes the address from its subscription filter at the
        same time, keeping the two in sync."""
        self._entries.pop(card_address, None)
