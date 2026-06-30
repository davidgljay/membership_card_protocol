/**
 * Keyring blob replication messages (implementation-plan.md §Step 4.1a,
 * ARCHITECTURE.md ADR-009-AMEND, wallet_backup_and_recovery.md §Keyring
 * Storage and Replication). Rides the same peer-broadcast and signature
 * pattern as CardBindingAnnouncement (Step 4.1) — signed by the sending
 * peer's 'wallet_service' role key, verified the same way.
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { canonicalize } from '../canonicalize.js';
import { verifyPeerWalletSignature } from '../auth/peer-wallet-signature.js';

export interface KeyringSyncPayload {
  keyring_id: string;
  card_hash: string;
  encrypted_blob: string;
}

export interface KeyringDeletePayload {
  keyring_id: string;
}

export interface SignedKeyringMessage {
  payload: KeyringSyncPayload;
  wallet_service_id: string;
  public_key: string; // base64url
  signature: string; // base64url, over canonicalize(payload)
}

export interface SignedKeyringDeleteMessage {
  payload: KeyringDeletePayload;
  wallet_service_id: string;
  public_key: string;
  signature: string;
}

function sign(payload: object, walletServicePrivateKey: Uint8Array): Uint8Array {
  return ml_dsa44.sign(canonicalize(payload), walletServicePrivateKey);
}

export function buildSignedKeyringMessage(
  payload: KeyringSyncPayload,
  walletServiceId: string,
  walletServicePrivateKey: Uint8Array
): SignedKeyringMessage {
  const publicKey = ml_dsa44.getPublicKey(walletServicePrivateKey);
  return {
    payload,
    wallet_service_id: walletServiceId,
    public_key: Buffer.from(publicKey).toString('base64url'),
    signature: Buffer.from(sign(payload, walletServicePrivateKey)).toString('base64url'),
  };
}

export function buildSignedKeyringDeleteMessage(
  payload: KeyringDeletePayload,
  walletServiceId: string,
  walletServicePrivateKey: Uint8Array
): SignedKeyringDeleteMessage {
  const publicKey = ml_dsa44.getPublicKey(walletServicePrivateKey);
  return {
    payload,
    wallet_service_id: walletServiceId,
    public_key: Buffer.from(publicKey).toString('base64url'),
    signature: Buffer.from(sign(payload, walletServicePrivateKey)).toString('base64url'),
  };
}

export function verifySignedKeyringMessage(message: SignedKeyringMessage | SignedKeyringDeleteMessage): boolean {
  return verifyPeerWalletSignature(
    canonicalize(message.payload),
    message.signature,
    message.public_key,
    message.wallet_service_id
  );
}
