import type { IpfsProvider } from "@membership-card-protocol/verifier";

const FILEBASE_IPFS_GATEWAY = "https://ipfs.filebase.io/ipfs";

export interface FilebaseIpfsProviderOptions {
  /** Override the default Filebase IPFS gateway URL (without trailing slash). */
  gatewayUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

/**
 * Filebase IPFS gateway provider.
 *
 * Fetches content by CID from Filebase's public IPFS gateway. No API key required.
 */
export class FilebaseIpfsProvider implements IpfsProvider {
  readonly #gatewayUrl: string;
  readonly #timeoutMs: number;

  constructor(options?: FilebaseIpfsProviderOptions) {
    this.#gatewayUrl = options?.gatewayUrl ?? FILEBASE_IPFS_GATEWAY;
    this.#timeoutMs = options?.timeoutMs ?? 30_000;
  }

  async fetch(cid: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await globalThis.fetch(`${this.#gatewayUrl}/${cid}`, {
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new Error(`CID not found: ${cid}`);
      }
      if (!response.ok) {
        throw new Error(`Filebase IPFS fetch failed (${response.status}): ${cid}`);
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`IPFS fetch timed out for CID: ${cid}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Legacy web3.storage provider ────────────────────────────────────────────

/** Minimal interface for a web3.storage-compatible client. */
export interface Web3StorageClient {
  get(cid: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/**
 * web3.storage-compatible IpfsProvider implementation.
 *
 * Pass any client that implements `get(cid)` returning an object with `arrayBuffer()`.
 * Compatible with @web3-storage/w3up-client and similar gateway clients.
 */
export class Web3StorageIpfsProvider implements IpfsProvider {
  readonly #client: Web3StorageClient;
  readonly #timeoutMs: number;

  constructor(client: Web3StorageClient, timeoutMs = 30_000) {
    this.#client = client;
    this.#timeoutMs = timeoutMs;
  }

  async fetch(cid: string): Promise<Uint8Array> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`IPFS fetch timed out for CID: ${cid}`)), this.#timeoutMs)
    );

    const response = await Promise.race([
      this.#client.get(cid),
      timeout,
    ]);

    if (!response) {
      throw new Error(`CID not found: ${cid}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
