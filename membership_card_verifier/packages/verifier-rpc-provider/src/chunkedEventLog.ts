import type { Contract, EventLog } from "ethers";
import type { CardChainEvent } from "@membership-card-protocol/verifier";

export interface ChunkedEventLogOptions {
  /** Block to start scanning from. Defaults to 0 — there is no known registry
   * deploy-block constant in this codebase, and per-card starting-block
   * caching (to avoid rescanning from 0 on every call) is a caller concern,
   * not something this function persists. */
  fromBlock?: number;
  /** Block to stop scanning at (inclusive). Defaults to the chain's latest block. */
  toBlock?: number | "latest";
  /** Block-range window size per `queryFilter` call. Defaults to 2000. */
  chunkSize?: number;
  /** Floor for the window size after halving on a range-limit error. Defaults to 1. */
  minChunkSize?: number;
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
  const message = String(
    (e as { shortMessage?: string; message?: string })?.shortMessage ??
      (e as Error)?.message ??
      e
  ).toLowerCase();
  return RANGE_LIMIT_ERROR_PATTERNS.some((p) => message.includes(p));
}

/** Mirrors press/src/context.ts's cidBytesToString: CIDs are stored as UTF-8
 * string bytes on-chain, so decode directly; empty bytes means "no CID". */
function cidBytesToString(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

interface OrderedLog {
  blockNumber: number;
  index: number;
  args: Record<string, unknown>;
}

function toOrderedLog(log: EventLog): OrderedLog | null {
  if (!("args" in log)) return null; // skip undecoded raw Log entries (shouldn't occur when queryFilter is given an event name/filter)
  return { blockNumber: log.blockNumber, index: log.index, args: log.args as unknown as Record<string, unknown> };
}

/**
 * Chunked, retrying `CardRegistered`/`CardHeadUpdated` replay for one card
 * address, oldest-first. `contract` must be an ethers.js v6 `Contract` whose
 * ABI includes both events (the registry contract's full ABI already does —
 * no separate ABI needed here). Composable into a
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
 *
 * Once a range-limit error forces the window smaller, the smaller window is
 * kept for the rest of this call (not grown back after a later successful
 * chunk) — a deliberate simplification; re-widening would need a separate
 * "success streak" heuristic that isn't worth the complexity for a code path
 * that isn't performance-critical.
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

  const registeredLogs: OrderedLog[] = [];
  const headUpdatedLogs: OrderedLog[] = [];

  while (from <= latestBlock) {
    const to = Math.min(from + windowSize - 1, latestBlock);
    try {
      const [registered, updated] = await Promise.all([
        contract.queryFilter(contract.filters["CardRegistered"]!(cardAddress), from, to),
        contract.queryFilter(contract.filters["CardHeadUpdated"]!(cardAddress), from, to),
      ]);
      for (const log of registered) {
        const ordered = toOrderedLog(log as EventLog);
        if (ordered) registeredLogs.push(ordered);
      }
      for (const log of updated) {
        const ordered = toOrderedLog(log as EventLog);
        if (ordered) headUpdatedLogs.push(ordered);
      }
      from = to + 1;
    } catch (e) {
      if (isRangeLimitError(e) && windowSize > minWindow) {
        // Window forced smaller by a range-limit rejection — retry the same
        // `from` with the smaller window; see this function's doc comment
        // for why the window is not grown back afterward.
        windowSize = Math.max(minWindow, Math.floor(windowSize / 2));
        continue;
      }
      throw e;
    }
  }

  const sortKey = (l: OrderedLog) => l.blockNumber * 1_000_000 + l.index;
  registeredLogs.sort((a, b) => sortKey(a) - sortKey(b));
  headUpdatedLogs.sort((a, b) => sortKey(a) - sortKey(b));

  const toEvent = (args: Record<string, unknown>, cidField: string): CardChainEvent => ({
    cid: cidBytesToString(args[cidField] as Uint8Array),
    timestamp: new Date(Number(args["timestamp"]) * 1000).toISOString(),
  });

  const genesis = registeredLogs.length > 0 ? [toEvent(registeredLogs[0]!.args, "initial_log_cid")] : [];
  const updates = headUpdatedLogs.map((l) => toEvent(l.args, "new_log_cid"));

  return [...genesis, ...updates];
}
