/**
 * IPFS reader for DNS governance scripts.
 *
 * Governance scripts read IPFS content (card documents, sub-card documents)
 * via a public HTTP gateway. They do NOT pin content to IPFS directly —
 * that is the press's responsibility. All card creation and log entry
 * uploads go through the authorized press HTTP API.
 *
 * To swap the gateway, change IPFS_GATEWAY_URL in .env.
 */

export interface IpfsReader {
  /** Fetch raw bytes for a CID from the public IPFS gateway. */
  fetchFromIPFS(cid: string): Promise<Uint8Array>;
}

export function createIpfsReader(gatewayUrl: string): IpfsReader {
  return {
    async fetchFromIPFS(cid: string): Promise<Uint8Array> {
      const url = `${gatewayUrl}/ipfs/${cid}`;
      const res = await globalThis.fetch(url);
      if (!res.ok) throw new Error(`IPFS gateway fetch failed: ${cid} → HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
