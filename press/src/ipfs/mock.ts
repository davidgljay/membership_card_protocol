/**
 * In-memory IPFS pinning provider (IPFS_PROVIDER=mock). No network calls —
 * intended for fast unit tests that need a real IpfsPinningProvider without
 * mocking fetch/S3 at a lower level.
 *
 * CIDs are deterministic content hashes, not real IPFS CIDs — good enough
 * for round-tripping within a single test process, not for interop with
 * anything expecting valid multihash-encoded CIDs.
 */

import type { IpfsPinningProvider } from './provider.js';

export function createMockProvider(): IpfsPinningProvider {
  const store = new Map<string, Uint8Array>();

  return {
    async pinToIPFS(content: Uint8Array): Promise<string> {
      const hash = await crypto.subtle.digest('SHA-256', content as unknown as BufferSource);
      const cid = `mockcid${Buffer.from(hash).toString('hex').slice(0, 32)}`;
      store.set(cid, content);
      return cid;
    },

    async fetchFromIPFS(cid: string): Promise<Uint8Array> {
      const bytes = store.get(cid);
      if (!bytes) {
        throw new Error(`mock IPFS: no content pinned for CID ${cid}`);
      }
      return bytes;
    },

    async checkHealth(): Promise<void> {
      // Always healthy — nothing to check.
    },
  };
}
