/**
 * PUT /accounts/{card_hash}/keyring — implementation-plan.md §Step 2.4.
 * Replaces the holder's keyring blob after recovery re-registration.
 * Authenticated with masterCardSignatureAuth: holder signs the challenge
 * from POST /accounts/{card_hash}/keyring/challenge with the recovered
 * master card key. Issues a new service_secret (old one is invalidated by
 * being overwritten) and invalidates all previously issued session tokens
 * for this card_hash.
 */

import { getPool } from '../../../db/client.js';
import { findAccountByCardHash, updateServiceSecretAndKeyring } from '../../../db/accounts.js';
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
}

const SERVICE_SECRET_BYTES = 32;

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  if (!cardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash is required.' });
  }

  const body = await readBody<KeyringUpdateBody>(event);
  const { challenge, signature, new_encrypted_keyring_blob: newEncryptedKeyringBlob } = body ?? {};
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
  // Replicate the new blob and instruct peers to delete the superseded
  // version (Step 4.1a). Best-effort; does not block or fail rotation.
  await Promise.all([
    replicateKeyringBlob(newKeyringId, cardHash, newEncryptedKeyringBlob),
    replicateKeyringDelete(previousKeyringId),
  ]);

  const kv = createKvStore();
  await invalidateSessionsForCard(cardHash, kv);

  auditLog('info', 'keyring_rotated', { card_hash: cardHash });
  auditLog('info', 'service_secret_created', { card_hash: cardHash });

  return {
    service_secret: Buffer.from(serviceSecretPlain).toString('base64url'),
    keyring_id: newKeyringId,
  };
});
