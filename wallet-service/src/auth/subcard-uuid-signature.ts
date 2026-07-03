/**
 * Signed-envelope verification for the two sub-card lifecycle endpoints
 * that require proof of sub-card key control:
 *   - POST   /cards/{card_hash}/subcards/{subcard_hash}/uuids   (registration)
 *   - DELETE /cards/{card_hash}/subcards/{subcard_hash}         (deregistration)
 * (notification_relay.md v0.9 §Process 1 steps 6-8, §Multi-Device Support
 * "Deregistration"; specs/subcards.md §Step 5 for the on-chain/IPFS
 * resolution chain).
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
 *
 * resolveSubcardPubkey is shared by both registration and deregistration
 * verification (verifyUuidRegistrationEnvelope below and
 * verifySubcardDeregistrationEnvelope in
 * ../auth/subcard-deregistration-signature.ts) — the pubkey-resolution
 * and binding-check logic is identical for both; only the payload shape
 * and what happens after verification succeeds differ.
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
 * keccak256(pubkey) == subcard_hash — that's the caller's job (see
 * verifyUuidRegistrationEnvelope below and
 * verifySubcardDeregistrationEnvelope in
 * ../auth/subcard-deregistration-signature.ts), kept separate so
 * resolution failures and binding-mismatch failures are distinguishable
 * if a caller wants to (both current callers fold both into the same
 * rejection, per notification_relay.md v0.9).
 *
 * Deliberately does NOT check SubCardEntry.active. An earlier version of
 * this function rejected resolution when active === false, on the theory
 * that a "deregistered" sub-card shouldn't be able to register UUIDs.
 * That conflated two unrelated things:
 *
 *   - SubCardEntry.active (this field): an on-chain, cryptographic
 *     revocation state, set only via the 8xx/9xx sub-card revocation flow
 *     defined in specs/process_specs/subcard_creation_policy.md. It
 *     answers "is this sub-card still a trusted, unrevoked identity in
 *     the protocol?" — a governance/trust question.
 *   - Wallet-service-local "deregistration" (DELETE
 *     /cards/{card_hash}/subcards/{subcard_hash}): purely this
 *     wallet-service instance's own UUID-pool bookkeeping (app uninstall,
 *     device cleanup, or an authenticated request from the sub-card's own
 *     holder). It never touches the chain and never sets `active` —
 *     see ../routes/subcard-deregistration.ts.
 *
 * A sub-card can be wallet-service-deregistered (its UUID pool here is
 * empty/consumed) while remaining fully `active` on-chain — that's the
 * expected, common case, and message deliverability must be recoverable
 * from it: the device re-registers UUIDs the next time it needs delivery,
 * exactly as if it had never registered before (notification_relay.md
 * v0.9 §Multi-Device Support "Deregistration"). Gating UUID registration
 * on `active` would have made that recovery impossible to distinguish
 * from genuine on-chain revocation, silently bricking any subcard whose
 * device merely uninstalled and reinstalled the app. UUID-registration
 * (and deregistration) eligibility is therefore keyed only on "does a
 * valid signature resolve to the sub-card's on-chain public key" — never
 * on `active`/revocation state. Nothing downstream of resolution
 * currently inspects `active`, by design; a caller wanting to treat
 * genuinely on-chain-revoked sub-cards differently would need its own
 * explicit check against the resolved `SubCardEntry`, not a change here.
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
 * Full verification per notification_relay.md v0.9 §Process 1 step 7:
 * resolves the sub-card's public key, confirms
 * keccak256(subcard_pubkey) == subcard_hash, and verifies the ML-DSA-44
 * signature over canonicalize(payload).
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
