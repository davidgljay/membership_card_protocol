# G3 Spec — real `getCardEventLog` implementation

Implements `plans/todo-implementation-plan.md` Phase 3 (G3), resolving
`plans/completed/membership_card_verifier_todo.md` item 3.

**Clarification checkpoint carried forward from the plan:** no live Arbitrum
RPC endpoint or deployed registry contract is available in this sandbox.
Everything below is implemented and validated against mocked
providers/contracts only. Do not describe this as "verified against a live
chain" anywhere.

## 0. Scope correction from the original plan text

The plan assumed only the TS `verifier-rpc-provider` package needed a real
implementation. **That's incomplete.** Repo-wide grep confirms there is no
Python equivalent of `verifier-rpc-provider` at all — the only concrete
Python `RpcProvider` implementation in this codebase is
`wallet-service/matrix-policy-module/src/matrix_policy_module/rpc_provider.py`'s
`Web3RpcProvider`, and it **does not implement `get_card_event_log` at
all** (confirmed: no such method exists on the class today). If
`Web3RpcProvider` is ever handed to a `CardVerifier` and Stage 4's
`HISTORY_MISMATCH` cross-check runs, `rpc.get_card_event_log(...)` raises
`AttributeError` — this is the same gap as the TS side, just further along
(missing entirely, not a stub). Both sides are in scope for 3.2/3.3:

- **3.2 (TS):** a new chunked-query companion helper in
  `verifier-rpc-provider`, composable into a `RegistryContract.getCardEventLog`
  implementation (per that interface's own doc comment — see §1 for why not a
  full contract-wide implementation).
- **3.3 (Python):** a new `get_card_event_log` method added directly to
  `Web3RpcProvider`, since that's the only concrete Python provider that
  exists to add it to.

## 1. Event shapes (from `registry_contract.md §7`)

```
CardRegistered(card_address bytes32, policy_address bytes32, press_address bytes32,
                initial_log_cid bytes, timestamp uint64)
CardHeadUpdated(card_address bytes32, prev_log_cid bytes, new_log_cid bytes,
                 press_address bytes32, timestamp uint64)
```

`getCardEventLog(cardAddress)` must return the oldest-first CID sequence:
genesis entry (`initial_log_cid` from that card's one `CardRegistered` event)
followed by every subsequent `new_log_cid` from `CardHeadUpdated` events for
that card, each in `{cid, timestamp}` form (`CardChainEvent` /
`CardChainEvent` dataclass — `timestamp` is ISO 8601, matching the existing
type definition in both languages; on-chain `timestamp` is `uint64` unix
seconds and must be converted). Order matters: Stage 4's `HISTORY_MISMATCH`
check (`stage4.ts`/`stage4.py`) compares this sequence positionally against
a card's self-reported `history` array, so entries must be sorted by
on-chain order (block number, then log index within a block) — not by
insertion order from parallel per-chunk queries, which is not guaranteed
sorted if chunks are queried concurrently.

## 2. Why not a full `RegistryContract` implementation (TS)

`verifier-rpc-provider`'s `RegistryContract` interface (`src/index.ts`)
bundles five unrelated methods (`getCardEntry`, `isPolicyAuthorizer`,
`getPressAuthorization`, `getSubCardEntry`, `getCardEventLog`,
`getEasAnnotations`) and is explicitly documented as caller-supplied — "The
registry contract ABI is caller-supplied via the `contract` parameter...
allows integrators to use any version of the ABI without coupling the
package to one." Writing a full concrete implementation of all six methods
is a much larger, unrelated undertaking (needs the complete registry ABI,
not just the two events this item is about) and is out of scope for this
item. What's actually missing — per the todo doc's own recommendation
("implement a real `RegistryContract.getCardEventLog` (in
`verifier-rpc-provider` or a new companion helper)") — is a reusable
building block an integrator's `RegistryContract.getCardEventLog`
implementation can call into, not a whole contract client.

## 3. Chunking / retry / starting-block decisions (locked in)

- **Chunk window size:** default **2000 blocks**, configurable via an
  options parameter. 2000 is a conservative default under the common
  "a few thousand blocks" free-tier RPC caps the todo doc itself cites.
- **Starting block:** **caller-supplied, optional, defaults to `0`.**
  Confirmed via repo-wide grep that no "registry deploy block" constant
  exists anywhere in this codebase (not in `networkConfig.ts`, not in any
  spec doc) — inventing one now would mean hardcoding a value that can't be
  verified without a live deployed contract, which contradicts this phase's
  own "no live chain available" constraint. Caching a per-card last-seen
  block to avoid rescanning from 0 on every call is explicitly a **caller
  concern** (see §7 — this confirms, not overrides, `strategic-plan.md`
  open question #3's working assumption; no reason found in this research
  to escalate to David).
- **Retry-on-range-limit-error:** on a provider error while querying a
  chunk, if the error looks like a block-range-limit rejection (heuristic
  substring match on the error message — see §4/§5 for the exact check in
  each language, since there is no standard error code across RPC
  providers), halve the chunk window size and retry the **same** `from`
  block with the smaller window. Stop halving at a configurable minimum
  (default 1 block) — if a single-block query still fails with a
  range-limit-shaped error, something else is wrong (this shouldn't be
  possible for a real range-limit), so re-throw instead of looping forever.
  Non-range-limit errors (network failure, malformed response, etc.)
  propagate immediately, uncaught — no blanket retry-on-any-error, only the
  specific range-limit case, since silently swallowing other error classes
  would hide real provider outages behind an empty/partial event log.

## 4. TS implementation — `verifier-rpc-provider`

New file `packages/verifier-rpc-provider/src/chunkedEventLog.ts`:

```ts
import { Contract } from "ethers";
import type { CardChainEvent } from "@membership-card-protocol/verifier";

export interface ChunkedEventLogOptions {
  fromBlock?: number; // default 0
  toBlock?: number | "latest"; // default "latest"
  chunkSize?: number; // default 2000
  minChunkSize?: number; // default 1
}

const RANGE_LIMIT_ERROR_PATTERNS = [
  "block range",
  "range limit",
  "query returned more than",
  "exceeds range",
  "exceed maximum",
  "too many results",
  "limited to a",
  "-32005", // common JSON-RPC "limit exceeded" error code, sometimes surfaced in the message
];

function isRangeLimitError(e: unknown): boolean {
  const message = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e).toLowerCase();
  return RANGE_LIMIT_ERROR_PATTERNS.some((p) => message.includes(p));
}

/**
 * Chunked, retrying `CardRegistered`/`CardHeadUpdated` replay for one card
 * address, oldest-first. `contract` must be an ethers.js v6 `Contract`
 * whose ABI includes both events (the registry contract's full ABI already
 * does — no separate ABI needed here). Composable into a
 * `RegistryContract.getCardEventLog` implementation:
 *
 *   const registryContract: RegistryContract = {
 *     ...,
 *     getCardEventLog: (addr) => getCardEventLogChunked(myEthersContract, addr),
 *   };
 *
 * Per-card starting-block caching (to avoid rescanning from `fromBlock` on
 * every call) is a caller concern — pass a cached `fromBlock` in `options`
 * if the caller tracks one; this function has no persistence of its own.
 */
export async function getCardEventLogChunked(
  contract: Contract,
  cardAddress: string,
  options?: ChunkedEventLogOptions
): Promise<CardChainEvent[]> {
  const minWindow = options?.minChunkSize ?? 1;
  let windowSize = options?.chunkSize ?? 2000;
  let from = options?.fromBlock ?? 0;

  const provider = contract.runner?.provider;
  if (!provider) throw new Error("getCardEventLogChunked: contract has no connected provider");
  const latestBlock =
    options?.toBlock === undefined || options.toBlock === "latest"
      ? await provider.getBlockNumber()
      : options.toBlock;

  const registeredLogs: Array<{ blockNumber: number; index: number; args: unknown }> = [];
  const headUpdatedLogs: Array<{ blockNumber: number; index: number; args: unknown }> = [];

  while (from <= latestBlock) {
    const to = Math.min(from + windowSize - 1, latestBlock);
    try {
      const [registered, updated] = await Promise.all([
        contract.queryFilter(contract.filters["CardRegistered"]!(cardAddress), from, to),
        contract.queryFilter(contract.filters["CardHeadUpdated"]!(cardAddress), from, to),
      ]);
      for (const log of registered) {
        if ("args" in log) registeredLogs.push({ blockNumber: log.blockNumber, index: log.index, args: log.args });
      }
      for (const log of updated) {
        if ("args" in log) headUpdatedLogs.push({ blockNumber: log.blockNumber, index: log.index, args: log.args });
      }
      from = to + 1;
    } catch (e) {
      if (isRangeLimitError(e) && windowSize > minWindow) {
        windowSize = Math.max(minWindow, Math.floor(windowSize / 2));
        continue; // retry same `from` with the smaller window
      }
      throw e;
    }
  }

  const sortKey = (l: { blockNumber: number; index: number }) => l.blockNumber * 1_000_000 + l.index;

  registeredLogs.sort((a, b) => sortKey(a) - sortKey(b));
  headUpdatedLogs.sort((a, b) => sortKey(a) - sortKey(b));

  const toEvent = (args: any, cidField: string): CardChainEvent => ({
    cid: args[cidField] as string, // ethers v6 decodes `bytes` ABI-typed args to a UTF-8-decodable
    // hex string only if declared `string` in the ABI; registry_contract.md declares these as
    // raw `bytes` (matching rpc_provider.py's own _cid_bytes_to_string treatment of the same
    // field) — decode explicitly: see note below.
    timestamp: new Date(Number(args["timestamp"]) * 1000).toISOString(),
  });

  // NOTE: the exact decode call (`ethers.toUtf8String(args[cidField])`) depends on whether
  // ethers.js v6 auto-decodes a `bytes`-typed ABI field to a hex string or leaves it as
  // Uint8Array — confirm against the actual ethers v6 Result type during implementation and
  // adjust `toEvent` accordingly (wrap with `ethers.toUtf8String(...)` if the raw value is a
  // hex string /Uint8Array, matching press/src/context.ts's own `cidBytesToString` helper's
  // documented behavior, mirrored in rpc_provider.py's `_cid_bytes_to_string`). This is an
  // implementation-time detail, not a design decision — do not skip verifying it, since a CID
  // decode bug here silently corrupts every downstream `HISTORY_MISMATCH` comparison.

  const genesis = registeredLogs.length > 0 ? [toEvent(registeredLogs[0]!.args, "initial_log_cid")] : [];
  const updates = headUpdatedLogs.map((l) => toEvent(l.args, "new_log_cid"));

  return [...genesis, ...updates];
}
```

Export from `packages/verifier-rpc-provider/src/index.ts`:
`export { getCardEventLogChunked } from "./chunkedEventLog.js"; export type { ChunkedEventLogOptions } from "./chunkedEventLog.js";`

`EthersRpcProvider.getCardEventLog` itself is **not** changed — it stays a
thin pass-through to the caller-supplied `RegistryContract.getCardEventLog`
per its existing design (§2). This new export is a helper an integrator's
`RegistryContract` implementation opts into, not a replacement for the
pass-through.

## 5. Python implementation — `Web3RpcProvider`

Add to `wallet-service/matrix-policy-module/src/matrix_policy_module/rpc_provider.py`:

1. New ABI constant (mirrors `_CARD_HEAD_UPDATED_ABI`'s existing shape):

```python
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
```

2. Range-limit heuristic (module-level, near the top with other helpers):

```python
_RANGE_LIMIT_ERROR_PATTERNS = (
    "block range",
    "range limit",
    "query returned more than",
    "exceeds range",
    "exceed maximum",
    "too many results",
    "limited to a",
    "-32005",
)


def _is_range_limit_error(e: Exception) -> bool:
    message = str(e).lower()
    return any(p in message for p in _RANGE_LIMIT_ERROR_PATTERNS)
```

3. New method on `Web3RpcProvider` (add near `get_log_entries`, ~line 193),
   using the same `self._w3.eth.contract(...)` pattern already established
   for `CardHeadUpdated` event queries elsewhere in this file:

```python
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
        [CardChainEvent(cid=_cid_bytes_to_string(registered_logs[0]["args"]["initial_log_cid"]), timestamp=_timestamp_iso(registered_logs[0]["args"]["timestamp"]))]
        if registered_logs
        else []
    )
    updates = [
        CardChainEvent(cid=_cid_bytes_to_string(log["args"]["new_log_cid"]), timestamp=_timestamp_iso(log["args"]["timestamp"]))
        for log in updated_logs
    ]
    return genesis + updates
```

Requires `import asyncio` (confirm not already imported — check current
import block) and `from datetime import datetime, timezone` at the top of
the file; both are standard-library, no new dependency. `_cid_bytes_to_string`
already exists in this file (used elsewhere) — reuse it directly, do not
duplicate. `CardChainEvent` needs to be added to the existing
`from membership_card_verifier import (...)` line.

**web3.py `argument_filters` note:** confirm during implementation that
`argument_filters={"card_address": card_address}` is the correct web3.py v6
syntax for filtering an indexed event argument via `get_logs` (it is, per
web3.py's `contract.events.EventName().get_logs(argument_filters=...)` API
— this filters server-side via the log topic, not client-side after
fetching, which matters for the chunking to actually reduce data volume).
If `card_address` needs to be pre-formatted (e.g. checksummed or
0x-prefixed 32-byte hex) to match how it's indexed on-chain, match whatever
format `get_card_entry`'s existing `GetCardEntry(address)` call already
expects for the same `address` parameter (check that method's signature
just above in the same file) — indexed `bytes32` topics require exact
byte-for-byte matching, unlike view-function calldata.

## 6. Fixed-window vs. adaptive-window note (avoid an efficiency footgun)

Once `windowSize` is reduced by a retry, it **stays reduced** for the rest
of that call (does not grow back after a successful chunk) — this is a
deliberate simplification, not an oversight: growing it back would need a
separate "success streak" heuristic to decide when it's safe to re-widen,
which adds complexity for a code path (a `getCardEventLog` call spanning
enough blocks to hit an RPC's range cap) that isn't performance-critical
enough in this phase to justify it. Note this explicitly in a code comment
at the point `windowSize` is first reduced in both languages, so a future
reader doesn't mistake the lack of re-widening for a bug.

## 7. Caching-ownership confirmation (open question #3)

Per `strategic-plan.md` open question #3 and this spec's own clarification
checkpoint: nothing in this research changed the working assumption.
Neither implementation above persists a starting block across calls — every
`getCardEventLog`/`get_card_event_log` call scans from `fromBlock`
(TS, caller-suppliable) / `0` (Python, no caching layer exists in
`Web3RpcProvider` to hang one off) through `latest` every time. This is the
package's existing "thin package, caller supplies transport/caching"
posture, confirmed rather than contradicted — **no escalation to David
needed for this item.**

## 8. Test cases (step 3.4 — mocked provider, both languages)

**TS** — new test file
`packages/verifier-rpc-provider/test/chunkedEventLog.test.ts`, mocking an
ethers.js `Contract`-shaped object (`queryFilter`, `filters.CardRegistered`,
`filters.CardHeadUpdated`, `runner.provider.getBlockNumber`) — follow
`EthersRpcProvider.test.ts`'s existing mocking style for how this package
already fakes ethers.js objects:

1. **Range spanning multiple chunks:** `chunkSize: 100`, blocks 0-250 total,
   confirm `queryFilter` is called 3 times (chunks `[0,99]`, `[100,199]`,
   `[200,250]`) with events from each chunk correctly concatenated and
   sorted.
2. **Provider-imposed range-limit error mid-scan:** first `queryFilter` call
   for a chunk throws an error whose message matches one of
   `RANGE_LIMIT_ERROR_PATTERNS` (e.g. `"query returned more than 10000
   results"`); confirm the function retries the same `from` block with a
   halved `chunkSize` and succeeds on the retry, producing the correct
   merged/sorted result — not raising, not skipping the range.
3. **No-starting-block-cache case:** call without `fromBlock` in options;
   confirm the scan starts from block `0` (assert the first `queryFilter`
   call's `fromBlock` argument is `0`) — this is the "defaults to
   block 0, no deploy-block constant" case from §3, worded per the plan's
   original "no-starting-block-cached case defaulting to the registry
   deploy block" language, adjusted to this spec's actual decision (block 0,
   not a deploy-block constant, since none exists — see §3).

**Python** — new test file
`wallet-service/matrix-policy-module/test/test_rpc_provider_event_log.py`
(or extend the existing `test_rpc_provider.py` if it already has a
`Web3RpcProvider`-mocking pattern for `get_logs`-style calls — check first
and follow whichever is established), mocking
`AsyncWeb3`/`contract.events.EventName().get_logs`:

Same three scenarios as TS, adapted to web3.py's mocking idioms — reuse
`test_rpc_provider.py`'s existing mock-`AsyncWeb3` setup pattern if one
exists for `Web3RpcProvider.get_card_entry`, rather than inventing a new
mocking approach.

## 9. Stage 4 integration check (step 3.6 — inline, not delegated)

Using the mocked-provider fixtures from §8 (or a small superset), construct
a `CardVerifier`/`verify_stage4` call where the mocked `getCardEventLog`
returns a realistic non-empty `[{cid, timestamp}, ...]` sequence and confirm:

1. A chain member whose `card_content.history` + own CID **matches** the
   mocked event log in count/order → `HISTORY_MISMATCH` does **not** fire.
2. A chain member whose `card_content.history` **diverges** from the mocked
   event log (e.g. one entry's `cid` differs) → `HISTORY_MISMATCH` **does**
   fire with the expected error code.

This exercises real (non-empty, chunking-derived) event data through
Stage 4's existing comparison logic (`stage4.ts`/`stage4.py`, already
unchanged by this spec — only the event-log *source* changed, not Stage 4's
consumption of it), confirming the new `getCardEventLogChunked`/
`get_card_event_log` output is actually shaped the way Stage 4 expects
(oldest-first, matching `history`'s own ordering convention) rather than
just type-checking.

## 10. `press.md` OQ-B3 update (step 3.5)

Locate Open Question OQ-B3 in `press.md` (repo-wide grep for "OQ-B3" or
"getLogEntries" in that file). It currently describes the pre-redesign
`getLogEntries()` name/framing. Update its text to reference the current
`getCardEventLog(cardAddress) -> Array<{cid, timestamp}>` interface shape
(per `types.ts`/`types.py`'s current definition, unchanged by this spec) and
this spec's chunking behavior, without altering any other content in
`press.md`.

## 11. Done-when checklist for 3.2/3.3/3.4/3.5/3.6

- 3.2 (TS): `getCardEventLogChunked` implemented in
  `verifier-rpc-provider/src/chunkedEventLog.ts` per §4, exported from
  `index.ts`; existing `verifier-rpc-provider` test suite still passes
  unmodified (this is a new file/export, not a change to
  `EthersRpcProvider` itself).
- 3.3 (Python): `Web3RpcProvider.get_card_event_log` implemented per §5;
  existing `matrix-policy-module` test suite still passes unmodified.
- 3.4: all three scenarios from §8 covered and passing in both languages.
- 3.5: `press.md` OQ-B3 corrected per §10; nothing else in `press.md`
  altered.
- 3.6: both integration cases from §9 pass, demonstrating
  `HISTORY_MISMATCH` firing/not-firing correctly against real (non-empty)
  chunked event data.
- All steps: explicitly note in commit/status language that this is
  mocked-provider-validated only, not live-chain-validated, per this
  spec's clarification checkpoint and the plan's own Phase 3 milestone
  review requirement.
