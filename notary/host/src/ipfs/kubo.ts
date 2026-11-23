/**
 * The production IPFS client: a Kubo node's HTTP API (`IPFS_PROVIDER=kubo`, notary_host.md §9).
 *
 * Pins **exact** bytes with the `raw` codec: `add?cid-version=1&raw-leaves=true&hash=sha2-256&pin=true`. For an object
 * that fits one chunk Kubo answers with the raw-codec CID, whose digest is SHA-256 of the bytes. An object larger than
 * one chunk would be a DAG and get a different CID, so the chunker is set to the size Kubo allows (1 MiB) and `pinExact`
 * (`./index.ts`) refuses any CID that is not the raw-codec CID of the bytes. Fetch is `cat`, and is checked the same way:
 * the digest of what comes back must be the CID's, whatever node answered.
 */
import { cidOfBytes } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { IpfsService } from "../services.js";

export function kuboIpfs(apiUrl: string, fetchImpl: typeof fetch = fetch): IpfsService {
  const base = apiUrl.replace(/\/$/, "");
  return {
    async pin(bytes) {
      const form = new FormData();
      form.append("file", new Blob([bytes as unknown as BlobPart]));
      const r = await fetchImpl(`${base}/api/v0/add?cid-version=1&raw-leaves=true&hash=sha2-256&chunker=size-1048576&pin=true`, { method: "POST", body: form });
      if (!r.ok) throw new Error(`kubo add: HTTP ${r.status}`);
      const hash = ((await r.json()) as { Hash?: string }).Hash;
      if (!hash) throw new Error("kubo add: no Hash in the response");
      return hash;
    },
    async fetch(cid) {
      const r = await fetchImpl(`${base}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST" });
      if (r.status === 404 || r.status === 500) return null; // Kubo answers 500 for "not found" (a block it cannot get)
      if (!r.ok) throw new Error(`kubo cat: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      // content addressing is checked here, not trusted to the node
      if (cidOfBytes(bytes) !== cid) throw new Error(`kubo returned bytes that are not ${cid}`);
      return bytes;
    },
  };
}
