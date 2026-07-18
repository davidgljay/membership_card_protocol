import { describe, it, expect, vi } from "vitest";
import type { Contract, EventLog } from "ethers";
import { getCardEventLogChunked } from "../src/chunkedEventLog.js";

/**
 * Mock Contract builder: creates an ethers.js v6-shaped Contract object
 * with queryFilter, filters, and runner.provider mocked.
 */
function createMockContract(overrides: {
  queryFilter?: (filter: unknown, from: number, to: number) => Promise<EventLog[]>;
  filters?: Record<string, (addr: string) => unknown>;
  getBlockNumber?: () => Promise<number>;
} = {}): Contract {
  const filters = overrides.filters || {
    CardRegistered: vi.fn((addr: string) => ({ type: "CardRegistered", cardAddress: addr })),
    CardHeadUpdated: vi.fn((addr: string) => ({ type: "CardHeadUpdated", cardAddress: addr })),
  };

  const getBlockNumber = overrides.getBlockNumber || vi.fn(async () => 250);
  const queryFilter =
    overrides.queryFilter ||
    vi.fn(async () => []);

  return {
    filters,
    queryFilter,
    runner: {
      provider: {
        getBlockNumber,
      },
    },
  } as unknown as Contract;
}

describe("getCardEventLogChunked", () => {
  it("should require a connected provider", async () => {
    const contract = {
      runner: { provider: null },
    } as unknown as Contract;

    await expect(getCardEventLogChunked(contract, "0xcard")).rejects.toThrow(
      "getCardEventLogChunked: contract has no connected provider"
    );
  });

  it("should scan from block 0 by default", async () => {
    const queryFilterMock = vi.fn(async () => []);
    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 50,
    });

    await getCardEventLogChunked(contract, "0xcard");

    // Should call queryFilter with fromBlock=0
    const firstCall = queryFilterMock.mock.calls[0];
    expect(firstCall?.[1]).toBe(0); // second arg is fromBlock
  });

  it("Scenario 1: Range spanning multiple chunks", async () => {
    // Setup: chunkSize=100, blocks 0-250
    // Expected chunks: [0-99], [100-199], [200-250]
    const cardAddress = "0xcard";
    const chunkSize = 100;
    const totalBlocks = 250;

    let callCount = 0;

    const queryFilterMock = vi.fn(async (filter: unknown, from: number, to: number) => {
      callCount++;
      const logs: EventLog[] = [];

      // Filter object should have type field to distinguish CardRegistered vs CardHeadUpdated
      const filterType = (filter as any)?.type;

      if (from === 0 && to === 99) {
        if (filterType === "CardRegistered") {
          logs.push({
            blockNumber: 10,
            index: 0,
            args: {
              initial_log_cid: new TextEncoder().encode("QmGenesis"),
              timestamp: 1000,
            },
          } as unknown as EventLog);
        } else if (filterType === "CardHeadUpdated") {
          logs.push({
            blockNumber: 50,
            index: 1,
            args: {
              new_log_cid: new TextEncoder().encode("QmUpdate1"),
              timestamp: 2000,
            },
          } as unknown as EventLog);
        }
      } else if (from === 100 && to === 199) {
        if (filterType === "CardHeadUpdated") {
          logs.push({
            blockNumber: 150,
            index: 0,
            args: {
              new_log_cid: new TextEncoder().encode("QmUpdate2"),
              timestamp: 3000,
            },
          } as unknown as EventLog);
        }
      } else if (from === 200 && to === 250) {
        if (filterType === "CardHeadUpdated") {
          logs.push({
            blockNumber: 220,
            index: 0,
            args: {
              new_log_cid: new TextEncoder().encode("QmUpdate3"),
              timestamp: 4000,
            },
          } as unknown as EventLog);
        }
      }

      return logs;
    });

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => totalBlocks,
    });

    const result = await getCardEventLogChunked(contract, cardAddress, {
      chunkSize,
      toBlock: totalBlocks,
    });

    // Verify queryFilter was called 3 times with correct ranges
    expect(queryFilterMock).toHaveBeenCalledTimes(6); // 2 calls per chunk (CardRegistered + CardHeadUpdated)

    // Verify results are concatenated and sorted by blockNumber, then index
    expect(result).toHaveLength(4); // 1 genesis + 3 updates
    expect(result[0]?.cid).toBe("QmGenesis");
    expect(result[0]?.timestamp).toMatch(/1970-01-01T00:16:40/); // 1000 seconds
    expect(result[1]?.cid).toBe("QmUpdate1");
    expect(result[2]?.cid).toBe("QmUpdate2");
    expect(result[3]?.cid).toBe("QmUpdate3");
  });

  it("Scenario 2: Provider-imposed range-limit error mid-scan", async () => {
    const cardAddress = "0xcard";
    let cardRegisteredAttempts = 0;
    let cardHeadUpdatedAttempts = 0;

    const queryFilterMock = vi.fn(async (filter: unknown, from: number, to: number) => {
      const filterType = (filter as any)?.type;

      if (filterType === "CardRegistered") {
        cardRegisteredAttempts++;
        if (cardRegisteredAttempts === 1) {
          throw new Error("query returned more than 10000 results");
        }
        // Second attempt succeeds
        return [
          {
            blockNumber: 10,
            index: 0,
            args: {
              initial_log_cid: new TextEncoder().encode("QmGenesis"),
              timestamp: 1000,
            },
          } as unknown as EventLog,
        ];
      } else if (filterType === "CardHeadUpdated") {
        cardHeadUpdatedAttempts++;
        if (cardHeadUpdatedAttempts === 1) {
          throw new Error("query returned more than 10000 results");
        }
        // Second attempt succeeds
        return [];
      }

      return [];
    });

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 250,
    });

    const result = await getCardEventLogChunked(contract, cardAddress, {
      chunkSize: 100,
      toBlock: 250,
    });

    // Should succeed and return events despite range-limit error
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.cid).toBe("QmGenesis");
  });

  it("Scenario 3: No-starting-block-cache case (defaults to 0)", async () => {
    const cardAddress = "0xcard";
    const queryFilterMock = vi.fn(async () => []);

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 100,
    });

    // Call without fromBlock in options
    await getCardEventLogChunked(contract, cardAddress, {
      chunkSize: 50,
      toBlock: 100,
    });

    // Verify first queryFilter call started from block 0
    const firstCall = queryFilterMock.mock.calls[0];
    expect(firstCall?.[1]).toBe(0); // fromBlock should be 0
  });

  it("should return empty array when no events found", async () => {
    const queryFilterMock = vi.fn(async () => []);
    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 100,
    });

    const result = await getCardEventLogChunked(contract, "0xcard");

    expect(result).toEqual([]);
  });

  it("should convert timestamps correctly", async () => {
    const queryFilterMock = vi.fn(async (filter: unknown, from: number, to: number) => {
      const filterType = (filter as any)?.type;

      if (filterType === "CardRegistered") {
        return [
          {
            blockNumber: 10,
            index: 0,
            args: {
              initial_log_cid: new TextEncoder().encode("QmGenesis"),
              timestamp: 1609459200, // 2021-01-01T00:00:00Z
            },
          } as unknown as EventLog,
        ];
      }
      return [];
    });

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 100,
    });

    const result = await getCardEventLogChunked(contract, "0xcard");

    expect(result).toHaveLength(1);
    expect(result[0]?.timestamp).toMatch(/2021-01-01T/);
  });

  it("should filter out logs without args", async () => {
    const queryFilterMock = vi.fn(async (filter: unknown, from: number, to: number) => {
      const filterType = (filter as any)?.type;

      if (filterType === "CardRegistered") {
        return [
          {
            blockNumber: 10,
            index: 0,
            // Missing 'args' — should be filtered out
          } as unknown as EventLog,
          {
            blockNumber: 20,
            index: 0,
            args: {
              initial_log_cid: new TextEncoder().encode("QmGenesis"),
              timestamp: 1000,
            },
          } as unknown as EventLog,
        ];
      }
      return [];
    });

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 100,
    });

    const result = await getCardEventLogChunked(contract, "0xcard");

    expect(result).toHaveLength(1);
    expect(result[0]?.cid).toBe("QmGenesis");
  });

  it("should handle empty CID bytes", async () => {
    const queryFilterMock = vi.fn(async (filter: unknown, from: number, to: number) => {
      const filterType = (filter as any)?.type;

      if (filterType === "CardRegistered") {
        return [
          {
            blockNumber: 10,
            index: 0,
            args: {
              initial_log_cid: new TextEncoder().encode(""), // Empty CID
              timestamp: 1000,
            },
          } as unknown as EventLog,
        ];
      }
      return [];
    });

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 100,
    });

    const result = await getCardEventLogChunked(contract, "0xcard");

    expect(result).toHaveLength(1);
    expect(result[0]?.cid).toBe("");
  });

  it("should re-throw non-range-limit errors", async () => {
    const queryFilterMock = vi.fn(async () => {
      throw new Error("network failure");
    });

    const contract = createMockContract({
      queryFilter: queryFilterMock,
      getBlockNumber: async () => 100,
    });

    await expect(getCardEventLogChunked(contract, "0xcard")).rejects.toThrow("network failure");
  });
});
