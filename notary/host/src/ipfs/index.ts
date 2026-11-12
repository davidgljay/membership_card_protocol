/**
 * Pinning exact bytes (notary_host.md §9). Public notary objects are pinned as the **raw canonical bytes** (CIDv1,
 * `raw` codec, sha2-256), so the CID's digest equals SHA-256 of the bytes. `pinExact` refuses a provider that
 * answers with any other CID: a notarization pinned under the wrong CID would not verify.
 */
import { cidOfBytes } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { IpfsService } from "../services.js";

export async function pinExact(ipfs: IpfsService, bytes: Uint8Array): Promise<string> {
  const cid = await ipfs.pin(bytes);
  if (cid !== cidOfBytes(bytes)) throw new Error(`IPFS provider returned ${cid}, not the raw-codec CID of the bytes`);
  return cid;
}

/** In-memory IPFS for tests and `IPFS_PROVIDER=mock`: real raw-codec CIDs. */
export function createMockIpfs(): IpfsService & { pinned: Map<string, Uint8Array> } {
  const pinned = new Map<string, Uint8Array>();
  return {
    pinned,
    async pin(bytes) { const cid = cidOfBytes(bytes); pinned.set(cid, bytes.slice()); return cid; },
    async fetch(cid) { return pinned.get(cid) ?? null; },
  };
}


