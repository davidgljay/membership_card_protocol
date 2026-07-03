/**
 * Signed-envelope verification for DELETE
 * /cards/{card_hash}/subcards/{subcard_hash}
 * (notification_relay.md v0.9 §Multi-Device Support "Deregistration").
 *
 * Sibling of ../auth/subcard-uuid-signature.ts's
 * verifyUuidRegistrationEnvelope, reusing that module's resolveSubcardPubkey
 * for the identical on-chain-registry -> IPFS -> recipient_pubkey
 * resolution chain (specs/subcards.md §Step 5). The only structural
 * difference from the registration envelope is the payload shape: no
 * `uuids` field, since deregistration doesn't carry a UUID list — it just
 * proves the caller controls the sub-card's private key and wants this
 * wallet-service instance to drop its local UUID-pool bookkeeping for it.
 *
 * Like resolveSubcardPubkey, this does NOT check SubCardEntry.active and
 * never will by design — wallet-service-local deregistration is
 * independent of on-chain revocation state in both directions. See
 * resolveSubcardPubkey's doc comment in subcard-uuid-signature.ts for the
 * full rationale; the same reasoning applies here without modification.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { canonicalize } from '../canonicalize.js';
import { keccak256OfBase64Url } from '../crypto.js';
import type { WalletServiceConfig } from '../config.js';
import { resolveSubcardPubkey } from './subcard-uuid-signature.js';
import type { SubcardRegistryClient } from '../chain/subcard-registry.js';

export interface SubcardDeregistrationPayload {
  card_hash: string;
  subcard_hash: string;
  timestamp: string; // ISO 8601
  nonce: string; // base64url
}

export interface SubcardDeregistrationEnvelope {
  payload: SubcardDeregistrationPayload;
  signature: string; // base64url ML-DSA-44 signature over canonicalize(payload)
}

export type VerifySubcardDeregistrationEnvelopeResult = { ok: true } | { ok: false; reason: string };

/**
 * Full verification per notification_relay.md v0.9 §Multi-Device Support
 * "Deregistration": resolves the sub-card's public key, confirms
 * keccak256(subcard_pubkey) == subcard_hash, and verifies the ML-DSA-44
 * signature over canonicalize(payload).
 *
 * Does NOT check timestamp/nonce replay or path/payload param matching —
 * those are the route handler's job (server/routes/.../index.delete.ts via
 * ../routes/subcard-deregistration.ts), same division of responsibility
 * as verifyUuidRegistrationEnvelope.
 */
export async function verifySubcardDeregistrationEnvelope(
  config: WalletServiceConfig,
  envelope: SubcardDeregistrationEnvelope,
  registryClient?: SubcardRegistryClient
): Promise<VerifySubcardDeregistrationEnvelopeResult> {
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
