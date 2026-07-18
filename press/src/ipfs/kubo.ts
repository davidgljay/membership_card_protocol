/**
 * IPFS pinning provider backed by a local Kubo node's HTTP API.
 *
 * Used for local/integration testing (IPFS_PROVIDER=kubo) — talks to a real
 * IPFS node directly rather than faking Filebase's S3-with-CID-metadata
 * behavior on top of a generic object store. Kubo natively returns real
 * CIDs from `add`, so no shim is needed.
 *
 * API reference: https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-add
 */

import type { PressConfig } from '../config.js';
import type { IpfsPinningProvider } from './provider.js';

export function createKuboProvider(config: PressConfig): IpfsPinningProvider {
  const apiUrl = config.KUBO_API_URL.replace(/\/$/, '');
  const gatewayUrl = config.KUBO_GATEWAY_URL.replace(/\/$/, '');

  return {
    async pinToIPFS(content: Uint8Array): Promise<string> {
      const form = new FormData();
      form.append('file', new Blob([content as unknown as BlobPart]));

      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/v0/add?cid-version=1&pin=true`, {
          method: 'POST',
          body: form,
        });
      } catch (err) {
        throw Object.assign(new Error(`Kubo add failed: ${String(err)}`), { pressCode: 'P-24' });
      }
      if (!res.ok) {
        throw Object.assign(
          new Error(`Kubo add failed: HTTP ${res.status}`),
          { pressCode: 'P-24' }
        );
      }
      const body = (await res.json()) as { Hash?: string };
      const cid = body.Hash;
      if (!cid) {
        throw Object.assign(
          new Error('Kubo add response did not include a Hash (CID)'),
          { pressCode: 'P-24' }
        );
      }

      // Same P-10 fetch-and-byte-compare validation as the Filebase provider,
      // so callers see identical guarantees regardless of active provider.
      let fetched: Uint8Array;
      try {
        fetched = await fetchByCid(gatewayUrl, cid);
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
      return fetchByCid(gatewayUrl, cid);
    },

    async checkHealth(): Promise<void> {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/v0/id`, { method: 'POST' });
      } catch (err) {
        throw new Error(`Kubo health check failed: ${String(err)}`);
      }
      if (!res.ok) {
        throw new Error(`Kubo health check failed: HTTP ${res.status}`);
      }
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
