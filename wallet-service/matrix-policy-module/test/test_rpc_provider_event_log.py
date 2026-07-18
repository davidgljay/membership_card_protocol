import asyncio
from types import SimpleNamespace

import pytest

from matrix_policy_module.rpc_provider import Web3RpcProvider

_ZERO_BYTES32 = "0x" + "00" * 32


class _FakeEventType:
    """Mimics web3.py contract.events.EventName() which has a get_logs method."""

    def __init__(self, logs_to_return: list[dict]) -> None:
        self._logs = logs_to_return

    async def get_logs(self, from_block: int, to_block: int, argument_filters: dict = None) -> list[dict]:
        return self._logs


class _FakeEvents:
    """Mimics web3.py contract.events with CardRegistered and CardHeadUpdated."""

    def __init__(self, registered_logs: list[dict], updated_logs: list[dict]) -> None:
        self._registered_logs = registered_logs
        self._updated_logs = updated_logs

    def CardRegistered(self) -> _FakeEventType:
        return _FakeEventType(self._registered_logs)

    def CardHeadUpdated(self) -> _FakeEventType:
        return _FakeEventType(self._updated_logs)


class _FakeContract:
    """Mimics web3.py contract object with events and functions."""

    def __init__(self, registered_logs: list[dict] = None, updated_logs: list[dict] = None, functions: dict = None) -> None:
        self.events = _FakeEvents(registered_logs or [], updated_logs or [])
        self.functions = functions or {}


class _FakeFunctions:
    """Mimics web3.py contract.functions."""

    def __init__(self, results: dict) -> None:
        self._results = results

    def GetCardEntry(self, address: str) -> "_FakeCallable":
        return _FakeCallable(self._results.get("GetCardEntry"))

    def GetPressAuthorization(self, policy_address: str, press_address: str) -> "_FakeCallable":
        return _FakeCallable(self._results.get("GetPressAuthorization"))

    def GetSubCardEntry(self, sub_card_address: str) -> "_FakeCallable":
        return _FakeCallable(self._results.get("GetSubCardEntry"))


class _FakeCallable:
    """Mimics web3.py function call object."""

    def __init__(self, result: object) -> None:
        self._result = result

    async def call(self) -> object:
        return self._result


class _BlockNumberProperty:
    """Provides an awaitable block_number property."""

    def __init__(self, value: int) -> None:
        self._value = value

    def __await__(self):
        async def _get_block_number():
            return self._value

        return _get_block_number().__await__()


class _FakeEth:
    """Mimics web3.py eth interface."""

    def __init__(self, block_number: int) -> None:
        self._block_number = block_number

    @property
    def block_number(self) -> _BlockNumberProperty:
        return _BlockNumberProperty(self._block_number)

    def contract(self, address: str, abi: list) -> _FakeContract:
        # Return a contract that will be configured by the test
        return _FakeContract()


class _FakeAsyncWeb3:
    """Mimics web3.py AsyncWeb3."""

    def __init__(self, block_number: int = 250) -> None:
        self.eth = _FakeEth(block_number)


def _make_event_log(block_number: int, log_index: int, event_type: str, args: dict) -> dict:
    """Helper to construct log dict shaped like web3.py get_logs output."""
    return {
        "blockNumber": block_number,
        "logIndex": log_index,
        "args": args,
        "event": event_type,
    }


def _make_provider(registered_logs: list[dict] = None, updated_logs: list[dict] = None, block_number: int = 250) -> Web3RpcProvider:
    """Create a Web3RpcProvider with mocked AsyncWeb3."""
    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )

    fake_web3 = _FakeAsyncWeb3(block_number)
    provider._w3 = fake_web3  # type: ignore[attr-defined]

    # Override eth.contract to return a properly mocked contract
    original_contract = fake_web3.eth.contract

    def mock_contract(address: str, abi: list) -> _FakeContract:
        # Return a contract with the appropriate event logs already set up
        contract = _FakeContract(registered_logs or [], updated_logs or [])
        return contract

    fake_web3.eth.contract = mock_contract  # type: ignore[method-assign]

    return provider


@pytest.mark.asyncio
async def test_get_card_event_log_scans_from_block_zero() -> None:
    """Test that scanning starts from block 0 when no fromBlock is specified."""
    # This is scenario 3 from the spec

    call_log = []

    class TrackingEventType:
        def __init__(self, logs: list[dict]) -> None:
            self._logs = logs

        async def get_logs(self, from_block: int, to_block: int, argument_filters: dict = None) -> list[dict]:
            call_log.append({"from_block": from_block, "to_block": to_block})
            return self._logs

    class TrackingEvents:
        def __init__(self, registered_logs: list[dict] = None, updated_logs: list[dict] = None) -> None:
            self._registered_logs = registered_logs or []
            self._updated_logs = updated_logs or []

        def CardRegistered(self) -> TrackingEventType:
            return TrackingEventType(self._registered_logs)

        def CardHeadUpdated(self) -> TrackingEventType:
            return TrackingEventType(self._updated_logs)

    class TrackingContract:
        def __init__(self) -> None:
            self.events = TrackingEvents([], [])

    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )

    fake_web3 = _FakeAsyncWeb3(50)
    provider._w3 = fake_web3  # type: ignore[attr-defined]

    fake_web3.eth.contract = lambda address, abi: TrackingContract()  # type: ignore[method-assign]

    result = await provider.get_card_event_log("0xcard")

    # Verify first call started from block 0
    assert len(call_log) > 0
    assert call_log[0]["from_block"] == 0


@pytest.mark.asyncio
async def test_get_card_event_log_returns_empty_when_no_events() -> None:
    """Test that empty list is returned when no events found."""
    provider = _make_provider([], [], 100)

    result = await provider.get_card_event_log("0xcard")

    assert result == []


@pytest.mark.asyncio
async def test_scenario_1_range_spanning_multiple_chunks() -> None:
    """Test scenario 1: Range spanning multiple chunks with blocks 0-250."""
    # Setup: blocks 0-250, should scan in chunks
    # Verify events from different blocks are correctly merged and sorted

    class MultiChunkEventType:
        def __init__(self, all_logs: list[dict]) -> None:
            self._all_logs = all_logs

        async def get_logs(self, from_block: int, to_block: int, argument_filters: dict = None) -> list[dict]:
            # Return logs that fall within the requested range
            return [log for log in self._all_logs if from_block <= log["blockNumber"] <= to_block]

    class MultiChunkEvents:
        def __init__(self, registered_logs: list[dict], updated_logs: list[dict]) -> None:
            self._registered = registered_logs
            self._updated = updated_logs

        def CardRegistered(self) -> MultiChunkEventType:
            return MultiChunkEventType(self._registered)

        def CardHeadUpdated(self) -> MultiChunkEventType:
            return MultiChunkEventType(self._updated)

    class MultiChunkContract:
        def __init__(self) -> None:
            registered_logs = [
                _make_event_log(10, 0, "CardRegistered", {
                    "initial_log_cid": b"QmGenesis",
                    "timestamp": 1000,
                })
            ]
            updated_logs = [
                _make_event_log(50, 1, "CardHeadUpdated", {
                    "new_log_cid": b"QmUpdate1",
                    "timestamp": 2000,
                }),
                _make_event_log(150, 0, "CardHeadUpdated", {
                    "new_log_cid": b"QmUpdate2",
                    "timestamp": 3000,
                }),
                _make_event_log(220, 0, "CardHeadUpdated", {
                    "new_log_cid": b"QmUpdate3",
                    "timestamp": 4000,
                }),
            ]
            self.events = MultiChunkEvents(registered_logs, updated_logs)

    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )

    fake_web3 = _FakeAsyncWeb3(250)
    provider._w3 = fake_web3  # type: ignore[attr-defined]

    fake_web3.eth.contract = lambda address, abi: MultiChunkContract()  # type: ignore[method-assign]

    result = await provider.get_card_event_log("0xcard")

    # Verify results are in correct order: genesis first, then updates sorted by block
    assert len(result) == 4  # 1 genesis + 3 updates
    assert result[0].cid == "QmGenesis"
    assert result[1].cid == "QmUpdate1"
    assert result[2].cid == "QmUpdate2"
    assert result[3].cid == "QmUpdate3"


@pytest.mark.asyncio
async def test_scenario_2_range_limit_error_mid_scan() -> None:
    """Test scenario 2: Provider throws range-limit error, retries with halved window."""

    # Track attempts globally by range
    attempts = {}

    class ThrowingEventType:
        def __init__(self, event_name: str, logs: list[dict]) -> None:
            self._event_name = event_name
            self._logs = logs

        async def get_logs(self, from_block: int, to_block: int, argument_filters: dict = None) -> list[dict]:
            # Create a key for this query
            key = (self._event_name, from_block, to_block)
            if key not in attempts:
                attempts[key] = 0
            attempts[key] += 1

            # First attempt at the original range throws range-limit error
            # Subsequent attempts (after halving window) succeed
            if attempts[key] == 1 and from_block == 0 and to_block == 1999:  # Original query
                raise Exception("query returned more than 10000 results")

            # Return logs that are in range
            return [log for log in self._logs if from_block <= log["blockNumber"] <= to_block]

    class ThrowingEvents:
        def __init__(self) -> None:
            self._registered_logs = [
                _make_event_log(10, 0, "CardRegistered", {
                    "initial_log_cid": b"QmGenesis",
                    "timestamp": 1000,
                })
            ]
            self._updated_logs = []

        def CardRegistered(self) -> ThrowingEventType:
            return ThrowingEventType("CardRegistered", self._registered_logs)

        def CardHeadUpdated(self) -> ThrowingEventType:
            return ThrowingEventType("CardHeadUpdated", self._updated_logs)

    class ThrowingContract:
        def __init__(self) -> None:
            self.events = ThrowingEvents()

    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )

    fake_web3 = _FakeAsyncWeb3(250)
    provider._w3 = fake_web3  # type: ignore[attr-defined]

    fake_web3.eth.contract = lambda address, abi: ThrowingContract()  # type: ignore[method-assign]

    # Should succeed despite the initial range-limit errors
    result = await provider.get_card_event_log("0xcard")

    # Should have retried and gotten the genesis event
    assert len(result) >= 1
    assert result[0].cid == "QmGenesis"


@pytest.mark.asyncio
async def test_scenario_3_no_starting_block_cache() -> None:
    """Test scenario 3: Call without fromBlock caches, scans from block 0."""

    first_from_blocks = {"registered": None, "updated": None}

    class TrackingEventType:
        def __init__(self, event_name: str, logs: list[dict]) -> None:
            self._event_name = event_name
            self._logs = logs

        async def get_logs(self, from_block: int, to_block: int, argument_filters: dict = None) -> list[dict]:
            if self._event_name == "CardRegistered":
                if first_from_blocks["registered"] is None:
                    first_from_blocks["registered"] = from_block
            elif self._event_name == "CardHeadUpdated":
                if first_from_blocks["updated"] is None:
                    first_from_blocks["updated"] = from_block
            return self._logs

    class TrackingEvents:
        def CardRegistered(self) -> TrackingEventType:
            return TrackingEventType("CardRegistered", [])

        def CardHeadUpdated(self) -> TrackingEventType:
            return TrackingEventType("CardHeadUpdated", [])

    class TrackingContract:
        def __init__(self) -> None:
            self.events = TrackingEvents()

    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )

    fake_web3 = _FakeAsyncWeb3(100)
    provider._w3 = fake_web3  # type: ignore[attr-defined]

    fake_web3.eth.contract = lambda address, abi: TrackingContract()  # type: ignore[method-assign]

    # Call without fromBlock in options
    await provider.get_card_event_log("0xcard")

    # Verify scanning started from block 0 for both CardRegistered and CardHeadUpdated
    assert first_from_blocks["registered"] == 0
    assert first_from_blocks["updated"] == 0


@pytest.mark.asyncio
async def test_get_card_event_log_converts_timestamps() -> None:
    """Test that unix timestamps are correctly converted to ISO 8601."""

    registered_logs = [
        _make_event_log(10, 0, "CardRegistered", {
            "initial_log_cid": b"QmGenesis",
            "timestamp": 1609459200,  # 2021-01-01T00:00:00Z
        })
    ]

    updated_logs = [
        _make_event_log(50, 0, "CardHeadUpdated", {
            "new_log_cid": b"QmUpdate1",
            "timestamp": 1609545600,  # 2021-01-02T00:00:00Z
        })
    ]

    provider = _make_provider(registered_logs, updated_logs)

    result = await provider.get_card_event_log("0xcard")

    assert len(result) == 2
    assert result[0].timestamp.startswith("2021-01-01")
    assert result[1].timestamp.startswith("2021-01-02")


@pytest.mark.asyncio
async def test_get_card_event_log_handles_empty_cid_bytes() -> None:
    """Test that empty CID bytes are handled correctly."""

    registered_logs = [
        _make_event_log(10, 0, "CardRegistered", {
            "initial_log_cid": b"",  # Empty CID
            "timestamp": 1000,
        })
    ]

    provider = _make_provider(registered_logs, [])

    result = await provider.get_card_event_log("0xcard")

    assert len(result) == 1
    assert result[0].cid == ""


@pytest.mark.asyncio
async def test_get_card_event_log_sorts_by_block_then_log_index() -> None:
    """Test that events are sorted by blockNumber then logIndex, genesis always first."""

    registered_logs = [
        _make_event_log(50, 0, "CardRegistered", {
            "initial_log_cid": b"QmGenesis",
            "timestamp": 1000,
        })
    ]

    updated_logs = [
        _make_event_log(100, 1, "CardHeadUpdated", {
            "new_log_cid": b"QmUpdate1",
            "timestamp": 2000,
        }),
        _make_event_log(100, 0, "CardHeadUpdated", {
            "new_log_cid": b"QmUpdate2",
            "timestamp": 2001,
        }),
        _make_event_log(75, 0, "CardHeadUpdated", {
            "new_log_cid": b"QmUpdate3",
            "timestamp": 2500,
        }),
    ]

    provider = _make_provider(registered_logs, updated_logs)

    result = await provider.get_card_event_log("0xcard")

    # Genesis is always first, then updates sorted by block, then logIndex
    assert result[0].cid == "QmGenesis"  # genesis always first
    assert result[1].cid == "QmUpdate3"  # block 75, index 0
    assert result[2].cid == "QmUpdate2"  # block 100, index 0
    assert result[3].cid == "QmUpdate1"  # block 100, index 1


@pytest.mark.asyncio
async def test_get_card_event_log_re_throws_non_range_limit_errors() -> None:
    """Test that non-range-limit errors are re-thrown."""

    class FailingEventType:
        def __init__(self, event_name: str) -> None:
            self._event_name = event_name

        async def get_logs(self, from_block: int, to_block: int, argument_filters: dict = None) -> list[dict]:
            raise Exception("network connection failed")

    class FailingEvents:
        def CardRegistered(self) -> FailingEventType:
            return FailingEventType("CardRegistered")

        def CardHeadUpdated(self) -> FailingEventType:
            return FailingEventType("CardHeadUpdated")

    class FailingContract:
        def __init__(self) -> None:
            self.events = FailingEvents()

    provider = Web3RpcProvider(
        rpc_url="http://localhost:8545",
        registry_contract_address="0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
        ipfs_gateway_url="https://ipfs.example.com/ipfs",
    )

    fake_web3 = _FakeAsyncWeb3(250)
    provider._w3 = fake_web3  # type: ignore[attr-defined]

    fake_web3.eth.contract = lambda address, abi: FailingContract()  # type: ignore[method-assign]

    with pytest.raises(Exception, match="network connection failed"):
        await provider.get_card_event_log("0xcard")


# --- Step 3.6: Stage 4 HISTORY_MISMATCH integration check ---
#
# Confirms the new chunked get_card_event_log (not a hand-mocked RpcProvider,
# but the real Web3RpcProvider method against a mocked web3 contract) feeds
# correctly into verify_stage4's existing HISTORY_MISMATCH comparison logic —
# i.e. the new event-log source is shaped the way Stage 4 already expects
# (oldest-first cid sequence), not just that Stage 4's own comparison works
# against an arbitrary hand-authored list (already covered by
# tests/stages/test_stage4.py in the verifier-py package).


def _make_provider_with_card_entry(
    registered_logs: list[dict],
    updated_logs: list[dict],
    head_cid: str,
    block_number: int = 250,
) -> Web3RpcProvider:
    """Like _make_provider, but also wires up get_card_entry (needed by
    verify_stage4 to read the on-chain head CID) against the same mocked
    contract shape."""
    provider = _make_provider(registered_logs, updated_logs, block_number)

    async def _fake_get_card_entry(address: str):
        from membership_card_verifier import CardEntry

        return CardEntry(
            log_head_cid=head_cid,
            policy_address="0x",
            last_press_address="0x",
            forward_to=None,
            exists=True,
        )

    provider.get_card_entry = _fake_get_card_entry  # type: ignore[method-assign]
    return provider


@pytest.mark.asyncio
async def test_stage4_history_mismatch_fires_against_real_chunked_event_log() -> None:
    from membership_card_verifier.stages.stage4 import verify_stage4
    from membership_card_verifier.types import ChainLink

    # On-chain ground truth (via the real chunked get_card_event_log): genesis + one update.
    provider = _make_provider_with_card_entry(
        registered_logs=[
            _make_event_log(10, 0, "CardRegistered", {"initial_log_cid": b"QmGenesis", "timestamp": 1000}),
        ],
        updated_logs=[
            _make_event_log(20, 0, "CardHeadUpdated", {"new_log_cid": b"QmMiddle", "timestamp": 2000}),
            _make_event_log(30, 0, "CardHeadUpdated", {"new_log_cid": b"QmUpdate", "timestamp": 3000}),
        ],
        head_cid="QmUpdate",
    )

    # Card's self-reported history omits QmMiddle — a genuine mismatch.
    chain = [
        ChainLink(
            card_address="0xcard1",
            public_key="pk",
            card_content={"entry_type": "field_update", "code": 100, "history": ["QmGenesis"]},
        )
    ]
    result = await verify_stage4(chain, "2026-06-01T00:00:00Z", provider, SimpleNamespace(revocation_freshness_window_seconds=300, reject_stale_revocation=True))
    assert any(e.code == "HISTORY_MISMATCH" and e.stage == 4 for e in result.errors)


@pytest.mark.asyncio
async def test_stage4_no_history_mismatch_against_real_chunked_event_log() -> None:
    from membership_card_verifier.stages.stage4 import verify_stage4
    from membership_card_verifier.types import ChainLink

    provider = _make_provider_with_card_entry(
        registered_logs=[
            _make_event_log(10, 0, "CardRegistered", {"initial_log_cid": b"QmGenesis", "timestamp": 1000}),
        ],
        updated_logs=[
            _make_event_log(20, 0, "CardHeadUpdated", {"new_log_cid": b"QmMiddle", "timestamp": 2000}),
        ],
        head_cid="QmMiddle",
    )

    # Card's self-reported history matches the real chunked event log exactly.
    chain = [
        ChainLink(
            card_address="0xcard1",
            public_key="pk",
            card_content={"entry_type": "field_update", "code": 100, "history": ["QmGenesis"]},
        )
    ]
    result = await verify_stage4(chain, "2026-06-01T00:00:00Z", provider, SimpleNamespace(revocation_freshness_window_seconds=300, reject_stale_revocation=True))
    assert not any(e.code == "HISTORY_MISMATCH" for e in result.errors)
