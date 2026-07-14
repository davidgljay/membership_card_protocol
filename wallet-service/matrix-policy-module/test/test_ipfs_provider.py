import httpx
import pytest

from matrix_policy_module.ipfs_provider import HttpxIpfsProvider

_RealAsyncClient = httpx.AsyncClient


class _MockTransport(httpx.AsyncBaseTransport):
    def __init__(self, responses: dict[str, httpx.Response]) -> None:
        self._responses = responses

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        for path, response in self._responses.items():
            if url.endswith(path):
                return response
        return httpx.Response(404, request=request)


@pytest.mark.asyncio
async def test_fetch_returns_bytes_for_resolvable_cid(monkeypatch: pytest.MonkeyPatch) -> None:
    transport = _MockTransport({"/bafyTestCid": httpx.Response(200, content=b"hello world")})

    def _client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return _RealAsyncClient(transport=transport)

    monkeypatch.setattr(httpx, "AsyncClient", _client_factory)

    provider = HttpxIpfsProvider("https://ipfs.example.com/ipfs")
    result = await provider.fetch("bafyTestCid")
    assert result == b"hello world"


@pytest.mark.asyncio
async def test_fetch_raises_for_unresolvable_cid(monkeypatch: pytest.MonkeyPatch) -> None:
    transport = _MockTransport({})

    def _client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return _RealAsyncClient(transport=transport)

    monkeypatch.setattr(httpx, "AsyncClient", _client_factory)

    provider = HttpxIpfsProvider("https://ipfs.example.com/ipfs")
    with pytest.raises(httpx.HTTPStatusError):
        await provider.fetch("bafyMissingCid")


@pytest.mark.asyncio
async def test_gateway_url_trailing_slash_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    seen_urls: list[str] = []

    class _RecordingTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            seen_urls.append(str(request.url))
            return httpx.Response(200, content=b"x")

    def _client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return _RealAsyncClient(transport=_RecordingTransport())

    monkeypatch.setattr(httpx, "AsyncClient", _client_factory)

    provider = HttpxIpfsProvider("https://ipfs.example.com/ipfs/")
    await provider.fetch("cid123")
    assert seen_urls == ["https://ipfs.example.com/ipfs/cid123"]
