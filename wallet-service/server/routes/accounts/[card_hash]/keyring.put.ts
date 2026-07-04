/**
 * PUT /accounts/{card_hash}/keyring — implementation-plan.md §Step 2.4.
 * Replaces the holder's keyring blob after recovery re-registration.
 * Authenticated with masterCardSignatureAuth: holder signs the challenge
 * from POST /accounts/{card_hash}/keyring/challenge with the recovered
 * master card key. By default issues a new service_secret (old one is
 * invalidated by being overwritten) and invalidates all previously issued
 * session tokens for this card_hash.
 *
 * `rotate_service_secret` (client-sdk implementation plan Step 2.4 fix,
 * default `true` — preserves this endpoint's original recovery-only
 * behavior for any caller that doesn't pass it): a client that already
 * encrypted `new_encrypted_keyring_blob` under `KDF(device_passkey_output,
 * <the account's CURRENT service_secret>)` needs to install that blob
 * *without* this call minting a different secret out from under it — since
 * this endpoint previously rotated unconditionally on every call, no
 * finite sequence of calls to it could ever leave the stored blob's true
 * encryption secret matching what `GET /accounts/{card_hash}/service-
 * secret` (the "daily-use decryption key derivation" endpoint) would
 * return. Passing `rotate_service_secret: false` replaces the keyring blob
 * and keyring_id as usual but leaves `service_secret_enc`/`_dek_enc`
 * untouched, and echoes back the *unchanged* current secret rather than
 * minting one.
 *
 * Both `client-sdk`'s `setupWallet` (finalizing the real, dual-factor-
 * encrypted blob right after `POST /accounts`) and `recoverWallet`
 * (finalizing after its own provisional rotation) use this: the call that
 * mints a genuinely new secret (`POST /accounts`, or recovery's first,
 * provisional `PUT`) is always followed by exactly one
 * `rotate_service_secret: false` call installing the blob actually
 * encrypted under that secret.
 */

import { getPool } from '../../../db/client.js';
import { findAccountByCardHash, updateServiceSecretAndKeyring, updateKeyringOnly } from '../../../db/accounts.js';
import { insertKeyringBlob } from '../../../db/keyrings.js';
import { consumeChallenge } from '../../../db/challenges.js';
import { verifyMasterCardSignature } from '../../../../src/auth/master-card-signature.js';
import { invalidateSessionsForCard } from '../../../../src/auth/session-token.js';
import { keccak256OfBase64Url } from '../../../../src/crypto.js';
import { getSecretsService } from '../../../utils/secrets.js';
import { createKvStore } from '../../../utils/kv-store.js';
import { replicateKeyringBlob, replicateKeyringDelete } from '../../../utils/federation-self.js';
import { auditLog } from '../../../utils/audit-log.js';

interface KeyringUpdateBody {
  challenge?: string;
  signature?: string;
  new_encrypted_keyring_blob?: string;
  rotate_service_secret?: boolean;
}

const SERVICE_SECRET_BYTES = 32;

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
  }

  const body = await readBody<KeyringUpdateBody>(event);
  const {
    challenge,
    signature,
    new_encrypted_keyring_blob: newEncryptedKeyringBlob,
    rotate_service_secret: rotateServiceSecret = true,
  } = body ?? {};
  if (!challenge || !signature || !newEncryptedKeyringBlob) {
    throw createError({
      statusCode: 400,
      statusMessage: 'challenge, signature, and new_encrypted_keyring_blob are all required.',
    });
  }

  const pool = getPool();
  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    throw createError({ statusCode: 404, statusMessage: 'No account found for this card_hash.' });
  }

  const consumed = await consumeChallenge(pool, 'keyring_rotation', cardHash, challenge);
  if (!consumed) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid or expired challenge.' });
  }

  const challengeBytes = new Uint8Array(Buffer.from(challenge, 'base64url'));
  const validSignature = verifyMasterCardSignature(challengeBytes, signature, account.master_pubkey);
  if (!validSignature) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid master card key signature.' });
  }

  const newKeyringId = keccak256OfBase64Url(newEncryptedKeyringBlob);
  const previousKeyringId = account.keyring_id;
  const secretsService = getSecretsService();

  let responseServiceSecretPlain: Uint8Array;

  if (rotateServiceSecret) {
    const serviceSecretPlain = crypto.getRandomValues(new Uint8Array(SERVICE_SECRET_BYTES));
    let ciphertext: string, dekEnc: string;
    try {
      ({ ciphertext, dekEnc } = await secretsService.encryptSecret(Buffer.from(serviceSecretPlain)));
    } catch (err) {
      auditLog('error', 'secrets_backend_failure', { operation: 'encryptSecret', card_hash: cardHash, error: String(err) });
      throw err;
    }

    await insertKeyringBlob(pool, newKeyringId, cardHash, newEncryptedKeyringBlob);
    await updateServiceSecretAndKeyring(pool, cardHash, {
      keyringId: newKeyringId,
      serviceSecretEnc: ciphertext,
      serviceSecretDekEnc: dekEnc,
    });
    auditLog('info', 'service_secret_created', { card_hash: cardHash });
    responseServiceSecretPlain = serviceSecretPlain;
  } else {
    await insertKeyringBlob(pool, newKeyringId, cardHash, newEncryptedKeyringBlob);
    await updateKeyringOnly(pool, cardHash, newKeyringId);
    let plaintext: Buffer;
    try {
      plaintext = await secretsService.decryptSecret(account.service_secret_enc, account.service_secret_dek_enc);
    } catch (err) {
      auditLog('error', 'secrets_backend_failure', { operation: 'decryptSecret', card_hash: cardHash, error: String(err) });
      throw err;
    }
    responseServiceSecretPlain = new Uint8Array(plaintext);
  }

  // Replicate the new blob and instruct peers to delete the superseded
  // version (Step 4.1a). Best-effort; does not block or fail rotation.
  await Promise.all([
    replicateKeyringBlob(newKeyringId, cardHash, newEncryptedKeyringBlob),
    replicateKeyringDelete(previousKeyringId),
  ]);

  // Only invalidate outstanding sessions on a genuine secret rotation
  // (recovery re-registration) — not on a `rotate_service_secret: false`
  // finalize call, which by construction happens moments after the very
  // call (`POST /accounts`, or recovery's provisional `PUT`) that issued
  // the session/secret this call is finalizing; invalidating it here would
  // make `setupWallet`'s returned `sessionToken` useless immediately.
  if (rotateServiceSecret) {
    const kv = createKvStore();
    await invalidateSessionsForCard(cardHash, kv);
  }

  auditLog('info', 'keyring_rotated', { card_hash: cardHash });

  return {
    service_secret: Buffer.from(responseServiceSecretPlain).toString('base64url'),
    keyring_id: newKeyringId,
  };
});
