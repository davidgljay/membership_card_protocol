import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToBase64Url } from '../util/base64url.js';
import type { ObliviousProtocolTransport } from '../providers/ObliviousProtocolTransport.js';

const GCM_NONCE_LENGTH = 12;

export type BackupType = 'synced_passkey' | 'yubikey';

export interface NotificationChannels {
  email?: string;
  sms?: string;
  webhook?: string;
  secondary_contact?: { name: string; email?: string; sms?: string };
}

/**
 * `wrapped_decryption_key = AES-GCM.Encrypt(wrapping_key, decryption_key)`
 * (`wallet_backup_and_recovery.md §Process 1` Steps 12 and 14 — the
 * synced-passkey and YubiKey formulas are structurally identical, differing
 * only in which wrapping key is used, so one function covers both). Nonce
 * is generated fresh and prepended to the ciphertext (`nonce ||
 * ciphertext`), matching this SDK's other self-contained-blob AES-GCM uses
 * (`wallet/keyring.ts`, `crypto/hpke.ts`).
 */
export function wrapDecryptionKey(decryptionKey: Uint8Array, wrappingKey: Uint8Array): Uint8Array {
  const nonce = randomBytes(GCM_NONCE_LENGTH);
  const ciphertext = gcm(wrappingKey, nonce).encrypt(decryptionKey);
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return blob;
}

/**
 * Inverse of {@link wrapDecryptionKey}. Only ever run client-side (by a
 * recovering client that holds the wrapping key) — the wallet/backup
 * service stores `wrapped_blob` opaquely and never calls this.
 */
export function unwrapDecryptionKey(blob: Uint8Array, wrappingKey: Uint8Array): Uint8Array {
  const nonce = blob.slice(0, GCM_NONCE_LENGTH);
  const ciphertext = blob.slice(GCM_NONCE_LENGTH);
  return gcm(wrappingKey, nonce).decrypt(ciphertext);
}

export interface RegisterBackupOptions {
  transport: ObliviousProtocolTransport;
  /** Bearer session token from `setupWallet`'s `POST /accounts` call. */
  sessionToken: string;
  cardHash: string;
  type: BackupType;
  decryptionKey: Uint8Array;
  wrappingKey: Uint8Array;
  keyringId: string;
  notificationChannels: NotificationChannels;
  /** ML-DSA-44 master public key — `wallet-service/src/routes/recovery/[recovery_id]/cancel.post.ts`'s doc confirms the cancellation credential is the master card key (OQ-WS-6), not a separately generated keypair. */
  cancellationPubkey: Uint8Array;
}

export interface BackupRegistrationResult {
  backupId: string;
}

interface BackupRegistrationResponseBody {
  backup_id: string;
}

/**
 * `POST /accounts/{card_hash}/backups` (`plans/wallet-service/
 * implementation-plan.md §Step 3.1`; `wallet_backup_and_recovery.md
 * §Process 1` Steps 13 / 14's "sends the encrypted blob to the backup
 * service"). Session-token authenticated — same wallet service as every
 * other call in this module (`{ kind: 'wallet_service' }`); "the backup
 * service" is not a separate destination.
 *
 * The wallet/backup service never sees `decryptionKey` or `wrappingKey` —
 * only `wrapDecryptionKey`'s output, opaque AES-GCM ciphertext.
 */
export async function registerBackup(options: RegisterBackupOptions): Promise<BackupRegistrationResult> {
  const wrappedBlob = wrapDecryptionKey(options.decryptionKey, options.wrappingKey);

  const response = await options.transport.request(
    { kind: 'wallet_service' },
    {
      method: 'POST',
      path: `/accounts/${options.cardHash}/backups`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.sessionToken}`,
      },
      body: new TextEncoder().encode(
        JSON.stringify({
          type: options.type,
          wrapped_blob: bytesToBase64Url(wrappedBlob),
          keyring_id: options.keyringId,
          notification_channels: options.notificationChannels,
          cancellation_pubkey: bytesToBase64Url(options.cancellationPubkey),
        })
      ),
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `registerBackup: POST /accounts/${options.cardHash}/backups returned status ${response.status}`
    );
  }

  const body = JSON.parse(new TextDecoder().decode(response.body)) as BackupRegistrationResponseBody;
  return { backupId: body.backup_id };
}
