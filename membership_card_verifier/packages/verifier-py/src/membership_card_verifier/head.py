"""Reads a card's current head (protocol-objects.md §1, §3). Mirrors head.ts."""

import json
from typing import Any

from .crypto import aes256gcm_decrypt
from .types import IpfsProvider

_ENTRY_META = ("entry_type", "code", "revocation", "history", "version", "prev_log_root")


async def decrypt_card_head(cid: str, content_key: bytes, ipfs: IpfsProvider) -> dict[str, Any]:
    """Decrypts a card's head. When the head is a LogEntry, returns the card's
    current field state: the genesis CardDocument (history[0]) overlaid with the
    entry's card_state, plus the entry's own metadata (entry_type, code,
    revocation, history, version, prev_log_root) so Stage 4 still sees
    revocations and update codes."""
    head = json.loads(aes256gcm_decrypt(content_key, await ipfs.fetch(cid)).decode("utf-8"))
    if head.get("entry_type") not in ("field_update", "revocation"):
        return head
    history = head.get("history")
    genesis: dict[str, Any] = {}
    if isinstance(history, list) and history:
        genesis = json.loads(aes256gcm_decrypt(content_key, await ipfs.fetch(history[0])).decode("utf-8"))
    state = head.get("card_state") or {}
    meta = {k: head[k] for k in _ENTRY_META if k in head}
    return {**genesis, **state, **meta}
