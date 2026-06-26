/**
 * IPFS pinning client backed by Piñata (SDK v2).
 *
 * pinToIPFS  — upload bytes, validate returned CID, return CID string.
 * fetchFromIPFS — fetch raw bytes for a CID via the dedicated Piñata gateway.
 *
 * CID validation: after every upload the press re-fetches the content from the
 * gateway and compares byte-for-byte against what it uploaded. A mismatch is
 * a hard error (P-10) and the CID is never used in any signed object.
 */

import { PinataSDK } from 'pinata';
import type { PressConfig } from '../config.js';

export interface IpfsClient {
  pinToIPFS(content: Uint8Array): Promise<string>;
  fetchFromIPFS(cid: string): Promise<Uint8Array>;
}

export function createIpfsClient(config: PressConfig): IpfsClient {
  const pinata = new PinataSDK({
    pinataJwt: config.PINATA_JWT,
    pinataGateway: config.PINATA_GATEWAY_URL,
  });

  return {
    async pinToIPFS(content: Uint8Array): Promise<string> {
      // Upload to Piñata as a public file.
      const file = new File([content], 'content.bin', { type: 'application/octet-stream' });
      let cid: string;
      try {
        const result = await pinata.upload.public.file(file);
        cid = result.cid;
      } catch (err) {
        throw Object.assign(new Error(`Piñata upload failed: ${String(err)}`), {
          pressCode: 'P-24',
        });
      }

      // Re-fetch from gateway and compare bytes (P-10 guard).
      let fetched: Uint8Array;
      try {
        fetched = await fetchByCid(config.PINATA_GATEWAY_URL, cid);
      } catch (err) {
        throw Object.assign(
          new Error(`CID validation fetch failed after upload: ${String(err)}`),
          { pressCode: 'P-10' }
        );
      }

      if (!bytesEqual(content, fetched)) {
        throw Object.assign(
          new Error(
            `P-10: CID content mismatch — fetched bytes differ from uploaded bytes for CID ${cid}`
          ),
          { pressCode: 'P-10' }
        );
      }

      return cid;
    },

    async fetchFromIPFS(cid: string): Promise<Uint8Array> {
      return fetchByCid(config.PINATA_GATEWAY_URL, cid);
    },
  };
}

async function fetchByCid(gatewayUrl: string, cid: string): Promise<Uint8Array> {
  const url = `${gatewayUrl}/ipfs/${cid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`IPFS gateway fetch failed: ${cid} → HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check that the Piñata JWT is valid and the API is reachable.
 * Called during startup before the press opens its HTTP listener.
 */
export async function checkPinataHealth(config: PressConfig): Promise<void> {
  const res = await fetch('https://api.pinata.cloud/data/testAuthentication', {
    headers: { Authorization: `Bearer ${config.PINATA_JWT}` },
  });
  if (!res.ok) {
    throw new Error(`Piñata authentication failed (HTTP ${res.status})`);
  }
}
