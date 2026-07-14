"""Implements membership_card_verifier.IpfsProvider: a single async
fetch(cid) -> bytes against the configured gateway. Per the verifier
package's README §Providers, this must raise on an unresolvable CID rather
than return empty bytes — the verifier pipeline treats a raised exception as
a hard fetch failure, not "empty document"."""

from __future__ import annotations

import httpx


class HttpxIpfsProvider:
    def __init__(self, gateway_url: str) -> None:
        self._gateway_url = gateway_url.rstrip("/")

    async def fetch(self, cid: str) -> bytes:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{self._gateway_url}/{cid}")
            response.raise_for_status()
            return response.content
