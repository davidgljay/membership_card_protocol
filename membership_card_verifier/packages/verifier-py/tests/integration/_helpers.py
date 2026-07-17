import base64
from unittest.mock import AsyncMock

from tests.fixtures import sign


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def make_envelope(public_key: bytes, secret_key, message: str = "test") -> dict:
    payload = {
        "message": message,
        "protocol_version": "0.1",
        "timestamp": "2026-06-20T00:00:00Z",
    }
    signature = sign(secret_key, payload)
    return {
        "payload": payload,
        "signatures": [{"public_key": b64url(public_key), "signature": signature}],
    }


def mock_rpc(**overrides) -> AsyncMock:
    rpc = AsyncMock()
    rpc.get_card_entry.return_value = None
    rpc.is_policy_authorizer.return_value = False
    rpc.get_press_authorization.return_value = None
    rpc.get_sub_card_entry.return_value = None
    rpc.get_card_event_log.return_value = []
    rpc.get_eas_annotations.return_value = []
    for name, value in overrides.items():
        setattr(rpc, name, value)
    return rpc


def mock_ipfs(responses: dict[str, bytes] | None = None) -> AsyncMock:
    responses = responses or {}
    ipfs = AsyncMock()

    async def _fetch(cid: str) -> bytes:
        if cid in responses:
            return responses[cid]
        raise Exception(f"CID not found: {cid}")

    ipfs.fetch.side_effect = _fetch
    return ipfs
