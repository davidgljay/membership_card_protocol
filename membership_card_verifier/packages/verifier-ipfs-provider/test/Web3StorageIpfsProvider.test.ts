import { describe, it, expect, vi } from "vitest";
import { Web3StorageIpfsProvider, type Web3StorageClient } from "../src/index.js";

function mockClient(responses: Record<string, Uint8Array | null> = {}): Web3StorageClient {
  return {
    get: vi.fn().mockImplementation(async (cid: string) => {
      const data = responses[cid];
      if (data === undefined) return null;
      if (data === null) return null;
      return { arrayBuffer: async () => data.buffer };
    }),
  };
}

describe("Web3StorageIpfsProvider", () => {
  it("returns bytes for a known CID", async () => {
    const content = new TextEncoder().encode("hello ipfs");
    const client = mockClient({ QmTest: content });
    const provider = new Web3StorageIpfsProvider(client);
    const result = await provider.fetch("QmTest");
    expect(new TextDecoder().decode(result)).toBe("hello ipfs");
  });

  it("throws when CID is not found", async () => {
    const client = mockClient({ QmOther: null });
    const provider = new Web3StorageIpfsProvider(client);
    await expect(provider.fetch("QmMissing")).rejects.toThrow("CID not found");
  });

  it("throws on timeout", async () => {
    const slowClient: Web3StorageClient = {
      get: () => new Promise((res) => setTimeout(() => res(null), 5000)),
    };
    const provider = new Web3StorageIpfsProvider(slowClient, 50); // 50ms timeout
    await expect(provider.fetch("QmSlow")).rejects.toThrow("timed out");
  });
});
