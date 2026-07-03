/**
 * Read-only IPFS fetch for `SubCardDocument`s (specs/subcards.md §Step 1,
 * §Step 5; notification_relay.md v0.8 §POST
 * /cards/{card_hash}/subcards/{subcard_hash}/uuids). Wallet service only
 * ever reads these — it never pins/uploads — so this mirrors only the
 * `fetchByCid` half of press/src/ipfs/client.ts's `fetchFromIPFS`, via a
 * plain gateway `fetch`, not press's Filebase S3 client (which is for
 * uploads with CID-capture and isn't needed for reads).
 */

import type { WalletServiceConfig } from '../config.js';

/**
 * Fields this service needs from a SubCardDocument (protocol-objects.md
 * §16). Other fields (holder_primary_card, app_card, capabilities, etc.)
 * are validated at issuance time by the wallet/press per specs/subcards.md
 * §Step 2/§Step 5 — this service only needs recipient_pubkey to verify the
 * sub-card's own signature on a UUID-registration envelope.
 */
export interface SubCardDocument {
  recipient_pubkey: string; // base64url, ML-DSA-44 public key, 1312 bytes raw
  [key: string]: unknown;
}

/** CID as produced by SubCardEntry.sub_card_doc_cid (raw bytes) is UTF-8-decoded to the string form gateways expect. */
export function cidBytesToString(cidBytes: Uint8Array): string {
  return new TextDecoder().decode(cidBytes);
}

export async function fetchSubCardDocument(config: WalletServiceConfig, cid: string): Promise<SubCardDocument> {
  const url = `${config.IPFS_GATEWAY_URL}/ipfs/${cid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`IPFS gateway fetch failed: ${cid} -> HTTP ${res.status}`);
  }
  const parsed: unknown = await res.json();
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['recipient_pubkey'] !== 'string'
  ) {
    throw new Error(`SubCardDocument at CID ${cid} is missing a string recipient_pubkey field.`);
  }
  return parsed as SubCardDocument;
}
