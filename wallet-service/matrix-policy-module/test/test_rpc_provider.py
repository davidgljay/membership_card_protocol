import httpx
import pytest

from matrix_policy_module.rpc_provider import Web3RpcProvider

_ZERO_BYTES32 = "0x" + "00" * 32
_RealAsyncClient = httpx.AsyncClient


class _FakeCallable:
    def __init__(self, result: object) -> None:
        self._result = result

    async def call(self) -> object:
        return self._result


class _FakeFunctions:
    def __init__(self, results: dict[str, object]) -> None:
        self._results = results

    def GetCardEntry(self, address: str) -> _FakeCallable:
        return _FakeCallable(self._results["GetCardEntry"])

    def GetPressAuthorization(self, policy_address: str, press_address: str) -> _FakeCallable:
        return _FakeCallable(self._results["GetPressAuthorization"])

    def GetSubCardEntry(self, sub_card_address: str) -> _FakeCallable:
        return _FakeCallable(self._results["GetSubCardEntry"])


class _FakeContract:
    def __init__(self, results: dict[str, object]) -> None:
        self.functions = _FakeFunctions(results)


def _make_provider(results: dict[str, object]) -> Web3RpcProvider:
    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )
    provider._contract = _FakeContract(results)  # type: ignore[attr-defined]
    return provider


@pytest.mark.asyncio
async def test_get_card_entry_returns_none_when_not_exists() -> None:
    provider = _make_provider({"GetCardEntry": (b"", _ZERO_BYTES32, _ZERO_BYTES32, _ZERO_BYTES32, False)})
    result = await provider.get_card_entry("0xabc")
    assert result is None


@pytest.mark.asyncio
async def test_get_card_entry_returns_entry_when_exists() -> None:
    provider = _make_provider(
        {
            "GetCardEntry": (
                b"QmHeadCid",
                "0xPolicy",
                "0xPress",
                _ZERO_BYTES32,
                True,
            )
        }
    )
    result = await provider.get_card_entry("0xabc")
    assert result is not None
    assert result.log_head_cid == "QmHeadCid"
    assert result.policy_address == "0xPolicy"
    assert result.forward_to is None
    assert result.exists is True


@pytest.mark.asyncio
async def test_get_card_entry_forward_to_populated_when_nonzero() -> None:
    provider = _make_provider(
        {"GetCardEntry": (b"QmHeadCid", "0xPolicy", "0xPress", "0xSuccessor", True)}
    )
    result = await provider.get_card_entry("0xabc")
    assert result is not None
    assert result.forward_to == "0xSuccessor"


@pytest.mark.asyncio
async def test_is_policy_authorizer_always_false() -> None:
    provider = _make_provider({})
    assert await provider.is_policy_authorizer("0xanything") is False


@pytest.mark.asyncio
async def test_get_press_authorization_returns_none_when_inactive() -> None:
    provider = _make_provider(
        {"GetPressAuthorization": (b"pubkey", "0xhash", 0, False, 0, 0, 0)}
    )
    result = await provider.get_press_authorization("0xpolicy", "0xpress")
    assert result is None


@pytest.mark.asyncio
async def test_get_press_authorization_returns_entry_when_active() -> None:
    provider = _make_provider(
        {"GetPressAuthorization": (b"pubkey", "0xhash", 0, True, 5, 1000, 0)}
    )
    result = await provider.get_press_authorization("0xpolicy", "0xpress")
    assert result is not None
    assert result.active is True
    assert result.revoked_at is None
    assert result.authorized_at == "1000"


@pytest.mark.asyncio
async def test_get_sub_card_entry_deregistered_at_none_when_zero() -> None:
    provider = _make_provider(
        {"GetSubCardEntry": ("0xmaster", b"QmRegHead", b"QmDocCid", True, 500, 0)}
    )
    result = await provider.get_sub_card_entry("0xsub")
    assert result is not None
    assert result.deregistered_at is None
    assert result.sub_card_doc_cid == "QmDocCid"


@pytest.mark.asyncio
async def test_get_eas_annotations_always_empty() -> None:
    provider = _make_provider({})
    result = await provider.get_eas_annotations("0xcard", ["0xannotator"])
    assert result == []


@pytest.mark.asyncio
async def test_get_log_entries_walks_ipfs_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    import json as _json

    docs = {
        "QmHead": {"code": 200, "effective_date": "2026-07-10", "prev_log_root": "QmMid"},
        "QmMid": {"code": 100, "effective_date": "2026-06-01", "prev_log_root": "QmGenesis"},
        "QmGenesis": {"code": 100, "effective_date": "2026-01-01", "prev_log_root": ""},
    }

    class _WalkTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            cid = str(request.url).rsplit("/", 1)[-1]
            return httpx.Response(200, content=_json.dumps(docs[cid]).encode())

    def _client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return _RealAsyncClient(transport=_WalkTransport())

    monkeypatch.setattr(httpx, "AsyncClient", _client_factory)

    provider = _make_provider(
        {"GetCardEntry": (b"QmHead", "0xPolicy", "0xPress", _ZERO_BYTES32, True)}
    )
    entries = await provider.get_log_entries("0xabc")
    assert [e.cid for e in entries] == ["QmHead", "QmMid", "QmGenesis"]
    assert entries[0].update_code == 200


@pytest.mark.asyncio
async def test_get_log_entries_stops_on_fetch_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FailingTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

    def _client_factory(*args: object, **kwargs: object) -> httpx.AsyncClient:
        return _RealAsyncClient(transport=_FailingTransport())

    monkeypatch.setattr(httpx, "AsyncClient", _client_factory)

    provider = _make_provider(
        {"GetCardEntry": (b"QmHead", "0xPolicy", "0xPress", _ZERO_BYTES32, True)}
    )
    entries = await provider.get_log_entries("0xabc")
    assert entries == []


@pytest.mark.asyncio
async def test_get_log_entries_empty_when_card_missing() -> None:
    provider = _make_provider(
        {"GetCardEntry": (b"", _ZERO_BYTES32, _ZERO_BYTES32, _ZERO_BYTES32, False)}
    )
    entries = await provider.get_log_entries("0xabc")
    assert entries == []
