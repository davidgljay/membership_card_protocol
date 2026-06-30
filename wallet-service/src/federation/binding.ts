/**
 * CardBindingAnnouncement construction, verification, and conflict
 * resolution (implementation-plan.md §Step 4.1, message_routing.md
 * §Wallet Service Registry).
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { canonicalize } from '../canonicalize.js';
import { keccak256OfBase64Url } from '../crypto.js';
import { verifyPeerWalletSignature } from '../auth/peer-wallet-signature.js';
import { verifyMasterCardSignature } from '../auth/master-card-signature.js';
import type { BindingType, RoutingTableRow } from '../../server/db/routing.js';

export interface CardBindingAnnouncementPayload {
  type: BindingType;
  card_hash: string;
  wallet_service_id: string;
  endpoint: string;
  timestamp: string; // ISO 8601
  nonce: string; // base64url, 32 random bytes
}

export interface SignatureEntry {
  public_key: string; // base64url
  role: 'wallet_service' | 'cardholder';
  signature: string; // base64url
}

export interface AnnouncementEnvelope {
  payload: CardBindingAnnouncementPayload;
  signatures: SignatureEntry[];
}

const NONCE_BYTES = 32;

/** Builds and self-signs a 'card_registration' announcement for a card this instance now holds. */
export function buildRegistrationAnnouncement(
  cardHash: string,
  walletServiceId: string,
  endpoint: string,
  walletServicePrivateKey: Uint8Array
): AnnouncementEnvelope {
  const payload: CardBindingAnnouncementPayload = {
    type: 'card_registration',
    card_hash: cardHash,
    wallet_service_id: walletServiceId,
    endpoint,
    timestamp: new Date().toISOString(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))).toString('base64url'),
  };
  const signature = ml_dsa44.sign(canonicalize(payload), walletServicePrivateKey);
  const publicKey = ml_dsa44.getPublicKey(walletServicePrivateKey);
  return {
    payload,
    signatures: [
      {
        public_key: Buffer.from(publicKey).toString('base64url'),
        role: 'wallet_service',
        signature: Buffer.from(signature).toString('base64url'),
      },
    ],
  };
}

export type VerifyEnvelopeResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies all signatures on an announcement envelope per
 * message_routing.md §Binding Announcements: a 'card_registration' needs
 * only a valid 'wallet_service' signature; a 'card_migration' needs both
 * 'wallet_service' and 'cardholder' signatures.
 */
export function verifyAnnouncementEnvelope(envelope: AnnouncementEnvelope): VerifyEnvelopeResult {
  const { payload, signatures } = envelope;

  const walletServiceSig = signatures.find((s) => s.role === 'wallet_service');
  if (!walletServiceSig) {
    return { ok: false, reason: 'missing wallet_service signature' };
  }
  const message = canonicalize(payload);
  const walletServiceValid = verifyPeerWalletSignature(
    message,
    walletServiceSig.signature,
    walletServiceSig.public_key,
    payload.wallet_service_id
  );
  if (!walletServiceValid) {
    return { ok: false, reason: 'invalid wallet_service signature' };
  }

  if (payload.type === 'card_migration') {
    const cardholderSig = signatures.find((s) => s.role === 'cardholder');
    if (!cardholderSig) {
      return { ok: false, reason: 'card_migration requires a cardholder signature' };
    }
    // cardholder signer is verified by keccak256(public_key) === card_hash
    if (keccak256OfBase64Url(cardholderSig.public_key).toLowerCase() !== payload.card_hash.toLowerCase()) {
      return { ok: false, reason: 'cardholder public key does not match card_hash' };
    }
    const cardholderValid = verifyMasterCardSignature(message, cardholderSig.signature, cardholderSig.public_key);
    if (!cardholderValid) {
      return { ok: false, reason: 'invalid cardholder signature' };
    }
  }

  return { ok: true };
}

/**
 * implementation-plan.md §Step 4.1, message_routing.md §Binding Conflict
 * Resolution: returns true if `incoming` should replace `existing` in the
 * routing table.
 */
export function shouldAcceptAnnouncement(
  existing: RoutingTableRow | null,
  incoming: CardBindingAnnouncementPayload
): boolean {
  if (!existing) return true;
  if (existing.type === 'card_migration' && incoming.type === 'card_registration') {
    return false; // migration always supersedes registration, regardless of timestamp
  }
  if (existing.type === 'card_registration' && incoming.type === 'card_migration') {
    return true; // migration always supersedes registration, regardless of timestamp
  }
  // same type on both sides — prefer the later timestamp
  return new Date(incoming.timestamp).getTime() > existing.announced_at.getTime();
}
