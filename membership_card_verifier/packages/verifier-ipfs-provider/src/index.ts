import type { IpfsProvider } from "@membership-card-protocol/verifier";

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
