import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { keccak256 } from '../crypto/hashes.js';

/**
 * The append-only encrypted keyring blob (`wallet_backup_and_recovery.md
 * §Process 1` Step 5, `ARCHITECTURE.md` ADR-009): "the blob contains the
 * master card private key, keyed by card address" and "is encrypted with
 * `decryption_key` (AES-GCM)".
 *
 * Step 2.1 only ever initializes a keyring containing the single master
 * card private key entry; later steps (device sub-card issuance, additional
 * cards accepted via offers) append further entries — this module only
 * covers the shape needed for initial setup.
 */
export interface KeyringEntry {
  /** keccak256 address the entry's private key corresponds to, hex (no 0x prefix, matching `crypto/hashes.ts#keccak256`'s output shape). */
  cardAddress: string;
  /** Raw ML-DSA-44 private key bytes for this entry. */
  privateKey: Uint8Array;
}

interface SerializedKeyring {
  entries: Array<{ cardAddress: string; privateKey: string }>;
}

const GCM_NONCE_LENGTH = 12;

/**
 * Serialize a keyring's entries to canonical JSON and AES-GCM-encrypt it
 * under `decryptionKey`. The nonce is generated fresh and prepended to the
 * ciphertext (`nonce || ciphertext`) so a single opaque blob can be stored
 * and later decrypted without a side channel for the nonce — the same
 * self-contained-blob shape `crypto/hpke.ts`'s response envelope uses.
 */
export function encryptKeyring(entries: KeyringEntry[], decryptionKey: Uint8Array): Uint8Array {
  const serialized: SerializedKeyring = {
    entries: entries.map((entry) => ({
      cardAddress: entry.cardAddress,
      privateKey: bytesToBase64(entry.privateKey),
    })),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(serialized));
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  const ciphertext = gcm(decryptionKey, nonce).encrypt(plaintext);

  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return blob;
}

/**
 * Decrypt a blob produced by {@link encryptKeyring}.
 */
export function decryptKeyring(encryptedBlob: Uint8Array, decryptionKey: Uint8Array): KeyringEntry[] {
  const nonce = encryptedBlob.slice(0, GCM_NONCE_LENGTH);
  const ciphertext = encryptedBlob.slice(GCM_NONCE_LENGTH);
  const plaintext = gcm(decryptionKey, nonce).decrypt(ciphertext);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as SerializedKeyring;
  return parsed.entries.map((entry) => ({
    cardAddress: entry.cardAddress,
    privateKey: base64ToBytes(entry.privateKey),
  }));
}

/**
 * `keyring_id = keccak256(encrypted_blob)` (`wallet_backup_and_recovery.md
 * §Process 1` Step 5, `§Keyring Storage and Replication`).
 */
export function computeKeyringId(encryptedBlob: Uint8Array): string {
  return keccak256(encryptedBlob);
}

// Plain base64 (not base64url) is fine here — this is an internal
// serialization detail of the keyring's own plaintext JSON, never
// transmitted or parsed by any other party or spec-defined wire format.
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
