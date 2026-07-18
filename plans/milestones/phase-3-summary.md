# Phase 3 (G3) Milestone Summary — real `getCardEventLog` implementation

Part of `plans/todo-implementation-plan.md`, resolving
`plans/completed/membership_card_verifier_todo.md` item 3. Full design spec:
`plans/g3-event-log-spec.md`.

## What shipped

- **Scope correction found during 3.1 research:** the original plan text
  assumed only the TS `verifier-rpc-provider` package needed a real
  implementation. Repo-wide grep confirmed the Python side had **no
  `get_card_event_log` implementation at all** — not even a stub — on the
  only concrete Python `RpcProvider`, `Web3RpcProvider`
  (`wallet-service/matrix-policy-module/src/matrix_policy_module/rpc_provider.py`).
  Both languages were implemented as part of this phase, not just TS.
- **TS:** new `getCardEventLogChunked(contract, cardAddress, options?)`
  helper in `verifier-rpc-provider/src/chunkedEventLog.ts`, exported from the
  package. Composable into a `RegistryContract.getCardEventLog`
  implementation; `EthersRpcProvider` itself is unchanged (stays a thin
  pass-through by design).
- **Python:** `Web3RpcProvider.get_card_event_log` implemented directly.
- Both implementations: chunked `queryFilter`/`get_logs` calls (default
  2000-block window), retry-with-halved-window on a provider range-limit
  error (heuristic message matching, since there's no standard error code
  across RPC providers), starting block defaults to `0` (no registry
  deploy-block constant exists anywhere in this codebase — confirmed by
  grep — so none was invented), oldest-first merged/sorted output
  (`CardRegistered` genesis entry + `CardHeadUpdated` entries, sorted by
  block number then log index).
- Caching ownership (`strategic-plan.md` open question #3): confirmed, not
  overridden — neither implementation persists a starting block across
  calls; that remains a caller concern. No escalation to David was needed.
- `press.md`'s OQ-B3 corrected to reference the current
  `getCardEventLog(cardAddress) -> CardChainEvent[]` interface instead of
  the pre-redesign `getLogEntries()` name. (A separate, out-of-scope stale
  reference to `getLogEntries` at `press.md` line ~268, inside a code
  sample, was left untouched per the plan's explicit "no other content
  altered" scope and flagged as a follow-up task instead.)
- Stage 4's `HISTORY_MISMATCH` cross-check confirmed to fire/not-fire
  correctly against the **real** chunked `Web3RpcProvider.get_card_event_log`
  output (not just a hand-mocked event list, which was already covered by
  pre-existing tests) — two new integration tests in
  `wallet-service/matrix-policy-module/test/test_rpc_provider_event_log.py`.

## Test results (all mocked-provider / unit-level)

- `verifier-rpc-provider`: 18/18 passing (8 pre-existing + 10 new chunking/
  retry tests), typecheck clean.
- `verifier` (TS): 111/111 passing, typecheck clean (unaffected by this
  phase — no changes to the core verifier package itself).
- `verifier-py`: 140/140 passing (unaffected by this phase).
- `matrix-policy-module`: 97/97 passing (86 pre-existing + 9 new chunking/
  retry tests + 2 new Stage 4 integration tests), including the real
  `get_card_event_log` implementation exercised end-to-end against
  `verify_stage4`.

## What was NOT validated — explicitly flagged, blocked on David

**No live Arbitrum RPC endpoint or deployed registry contract is available
in this sandbox environment**, per this phase's clarification checkpoint
(carried forward from `strategic-plan.md`'s open questions). Everything
above is validated against mocked `ethers.js`/`web3.py` contract objects
only:

- The chunking/retry logic has never executed against a real RPC provider's
  actual block-range-limit error shape — the range-limit detection is a
  heuristic substring match against known error message patterns from
  common providers (Infura, Alchemy, public RPC defaults), not verified
  against any single real provider's actual error format.
- No real `CardRegistered`/`CardHeadUpdated` events have ever been queried
  from an actual deployed registry contract.
- The `argument_filters={"card_address": ...}` indexed-topic filtering
  (Python) and `contract.filters.CardRegistered(cardAddress)` (TS) have not
  been confirmed against a real contract's actual event topic encoding.

**Follow-up, blocked on David:** provision an Arbitrum RPC endpoint (testnet
is sufficient) and a deployed registry contract address, then re-run this
phase's chunking/retry logic against real `eth_getLogs` calls to confirm the
range-limit heuristic actually catches that provider's real error shape and
that indexed-topic filtering works as expected. Until then, do not describe
`getCardEventLog`/`get_card_event_log` as "verified against a live chain"
anywhere.
