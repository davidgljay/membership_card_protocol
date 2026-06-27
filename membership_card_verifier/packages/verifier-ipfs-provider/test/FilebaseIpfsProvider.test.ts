import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FilebaseIpfsProvider } from "../src/index.js";

const FAKE_CID = "QmTestCid";

function mockFetch(status: number, body: Uint8Array | string): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "Error",
    arrayBuffer: async () =>
      typeof body === "string" ? new TextEncoder().encode(body).buffer : body.buffer,
  } as unknown as Response);
}

describe("FilebaseIpfsProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns bytes for a known CID", async () => {
    const content = new TextEncoder().encode("hello filebase");
    globalThis.fetch = mockFetch(200, content);

    const provider = new FilebaseIpfsProvider();
    const result = await provider.fetch(FAKE_CID);

    expect(new TextDecoder().decode(result)).toBe("hello filebase");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://ipfs.filebase.io/ipfs/${FAKE_CID}`,
      expect.anything()
    );
  });

  it("throws when CID is not found (404)", async () => {
    globalThis.fetch = mockFetch(404, "not found");

    const provider = new FilebaseIpfsProvider();
    await expect(provider.fetch(FAKE_CID)).rejects.toThrow("CID not found");
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = mockFetch(500, "error");

    const provider = new FilebaseIpfsProvider();
    await expect(provider.fetch(FAKE_CID)).rejects.toThrow("Filebase IPFS fetch failed (500)");
  });

  it("throws on timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
            return;
          }
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        })
    );

    const provider = new FilebaseIpfsProvider({ timeoutMs: 50 });
    await expect(provider.fetch(FAKE_CID)).rejects.toThrow("timed out");
  }, 2000);

  it("uses a custom gateway URL when provided", async () => {
    const content = new TextEncoder().encode("data");
    globalThis.fetch = mockFetch(200, content);

    const provider = new FilebaseIpfsProvider({
      gatewayUrl: "https://mybucket.myfilebase.com/ipfs",
    });
    await provider.fetch(FAKE_CID);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://mybucket.myfilebase.com/ipfs/${FAKE_CID}`,
      expect.anything()
    );
  });
});
