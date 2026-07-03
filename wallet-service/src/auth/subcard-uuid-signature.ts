/**
 * Signed-envelope verification for POST
 * /cards/{card_hash}/subcards/{subcard_hash}/uuids
 * (notification_relay.md v0.8 §Process 1 steps 6-8; specs/subcards.md
 * §Step 5 for the on-chain/IPFS resolution chain).
 *
 * Structurally the same shape as verifyPeerWalletSignature
 * (../auth/peer-wallet-signature.ts) and binding.ts's cardholder check:
 * derive an identity hash from a resolved public key, compare it to the
 * claimed id (here, subcard_hash), then verify the ML-DSA-44 signature.
 * The difference is that the public key isn't handed to us in the
 * request (as it is for peer/cardholder signatures) — it has to be
 * resolved on-chain first:
 *
 *   subcard_hash --GetSubCardEntry--> sub_card_doc_cid
 *                 --IPFS fetch-->      SubCardDocument
 *                 --field-->           recipient_pubkey
 *
 * That resolution is untrusted input from chain/IPFS, so the
 * keccak256(pubkey) == subcard_hash check below is still load-bearing:
 * it's what actually ties the resolved key back to the hash the caller
 * claimed authority over, the same way the on-request pubkey is checked
 * in the peer/cardholder flows.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import type { Hex } from 'viem';
import { canonicalize } from '../canonicalize.js';
import { keccak256OfBase64Url } from '../crypto.js';
import type { WalletServiceConfig } from '../config.js';
import { getSubcardRegistryClient, type SubcardRegistryClient } from '../chain/subcard-registry.js';
import { cidBytesToString, fetchSubCardDocument } from '../ipfs/fetch-subcard-document.js';

export interface UuidRegistrationPayload {
  card_hash: string;
  subcard_hash: string;
  uuids: string[];
  timestamp: string; // ISO 8601
  nonce: string; // base64url
}

export interface UuidRegistrationEnvelope {
  payload: UuidRegistrationPayload;
  signature: string; // base64url ML-DSA-44 signature over canonicalize(payload)
}

export type ResolveSubcardPubkeyResult =
  | { ok: true; pubkeyB64: string }
  | { ok: false; reason: string };

/**
 * Resolves subcard_hash's registered public key via the Arbitrum registry
 * and IPFS (specs/subcards.md §Step 5). Does NOT check
 * keccak256(pubkey) == subcard_hash — that's verifyUuidRegistrationEnvelope's
 * job, kept separate so resolution failures and binding-mismatch failures
 * are distinguishable if a caller wants to (the route handler currently
 * folds both into the same rejection, per notification_relay.md v0.8).
 *
 * Rejects entries with active === false (deregistered sub-cards). The v0.8
 * spec text doesn't explicitly enumerate this as a rejection condition for
 * this endpoint, but registering UUIDs for a sub-card the chain says has
 * been deregistered is never correct — see the report for this as a
 * documented judgment call.
 */
export async function resolveSubcardPubkey(
  config: WalletServiceConfig,
  subcardHash: string,
  registryClient: SubcardRegistryClient = getSubcardRegistryClient(config)
): Promise<ResolveSubcardPubkeyResult> {
  let entry;
  try {
    entry = await registryClient.getSubCardEntry(subcardHash as Hex);
  } catch (err) {
    return { ok: false, reason: `on-chain lookup failed: ${String(err)}` };
  }

  if (!entry.active) {
    return { ok: false, reason: 'sub-card is deregistered (SubCardEntry.active is false)' };
  }

  const cid = cidBytesToString(entry.sub_card_doc_cid);
  if (!cid) {
    return { ok: false, reason: 'SubCardEntry has no sub_card_doc_cid (sub-card not found on-chain)' };
  }

  let doc;
  try {
    doc = await fetchSubCardDocument(config, cid);
  } catch (err) {
    return { ok: false, reason: `IPFS fetch failed: ${String(err)}` };
  }

  return { ok: true, pubkeyB64: doc.recipient_pubkey };
}

export type VerifyUuidEnvelopeResult = { ok: true } | { ok: false; reason: string };

/**
 * Full verification per notification_relay.md v0.8 step 7: resolves the
 * sub-card's public key, confirms keccak256(subcard_pubkey) == subcard_hash,
 * and verifies the ML-DSA-44 signature over canonicalize(payload).
 *
 * Does NOT check timestamp/nonce replay or path/payload param matching —
 * those are the route handler's job (server/routes/.../uuids.post.ts),
 * same division of responsibility as verifyAnnouncementEnvelope vs. its
 * callers.
 */
export async function verifyUuidRegistrationEnvelope(
  config: WalletServiceConfig,
  envelope: UuidRegistrationEnvelope,
  registryClient?: SubcardRegistryClient
): Promise<VerifyUuidEnvelopeResult> {
  const { payload, signature } = envelope;

  const resolved = await resolveSubcardPubkey(config, payload.subcard_hash, registryClient);
  if (!resolved.ok) {
    return { ok: false, reason: `could not resolve sub-card public key: ${resolved.reason}` };
  }

  let derivedHash: string;
  try {
    derivedHash = keccak256OfBase64Url(resolved.pubkeyB64);
  } catch {
    return { ok: false, reason: 'resolved recipient_pubkey is not valid base64url' };
  }
  if (derivedHash.toLowerCase() !== payload.subcard_hash.toLowerCase()) {
    return { ok: false, reason: 'keccak256(subcard_pubkey) does not match subcard_hash' };
  }

  let publicKey: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    publicKey = new Uint8Array(Buffer.from(resolved.pubkeyB64, 'base64url'));
    signatureBytes = new Uint8Array(Buffer.from(signature, 'base64url'));
  } catch {
    return { ok: false, reason: 'malformed public key or signature encoding' };
  }

  const message = canonicalize(payload);
  let valid: boolean;
  try {
    valid = ml_dsa44.verify(signatureBytes, message, publicKey);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'invalid signature' };
  }

  return { ok: true };
}
