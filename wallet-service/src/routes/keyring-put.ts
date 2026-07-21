/**
 * Request-orchestration logic for PUT /accounts/{card_hash}/keyring
 * (implementation-plan.md §Step 2.4). See that route file
 * (server/routes/accounts/[card_hash]/keyring.put.ts) for the full
 * `rotate_service_secret` design rationale — this module is a factored-out
 * copy of the same logic, callable identically from the plaintext route and
 * the OHTTP gateway (server/routes/ohttp/gateway.post.ts), same convention
 * as accounts-challenge.ts / accounts-create.ts. Reachable through the
 * gateway for the same reason keyring-challenge.ts is: it's the call
 * `setupWallet`/`recoverWallet` make immediately after account creation,
 * over the same oblivious transport.
 */

import type { Pool } from 'pg';
import { findAccountByCardHash, updateServiceSecretAndKeyring, updateKeyringOnly } from '../../server/db/accounts.js';
import { insertKeyringBlob } from '../../server/db/keyrings.js';
import { consumeChallenge } from '../../server/db/challenges.js';
import { verifyMasterCardSignature } from '../auth/master-card-signature.js';
import { invalidateSessionsForCard } from '../auth/session-token.js';
import { keccak256OfBase64Url } from '../crypto.js';
import { getSecretsService } from '../../server/utils/secrets.js';
import { createKvStore } from '../../server/utils/kv-store.js';
import { replicateKeyringBlob, replicateKeyringDelete } from '../../server/utils/federation-self.js';
import { auditLog } from '../../server/utils/audit-log.js';

export interface KeyringUpdateBody {
  challenge?: string;
  signature?: string;
  new_encrypted_keyring_blob?: string;
  rotate_service_secret?: boolean;
}

const SERVICE_SECRET_BYTES = 32;

export type KeyringUpdateOutcome =
  | { ok: true; service_secret: string; keyring_id: string }
  | { ok: false; statusCode: 400 | 401 | 404; statusMessage: string };

export async function handleKeyringUpdate(params: {
  pool: Pool;
  cardHash: string | undefined;
  body: KeyringUpdateBody | undefined;
}): Promise<KeyringUpdateOutcome> {
  const { pool, cardHash, body } = params;
  if (!cardHash) {
    return { ok: false, statusCode: 400, statusMessage: 'card_hash is required.' };
  }

  const {
    challenge,
    signature,
    new_encrypted_keyring_blob: newEncryptedKeyringBlob,
    rotate_service_secret: rotateServiceSecret = true,
  } = body ?? {};
  if (!challenge || !signature || !newEncryptedKeyringBlob) {
    return {
      ok: false,
      statusCode: 400,
      statusMessage: 'challenge, signature, and new_encrypted_keyring_blob are all required.',
    };
  }

  const account = await findAccountByCardHash(pool, cardHash);
  if (!account) {
    return { ok: false, statusCode: 404, statusMessage: 'No account found for this card_hash.' };
  }

  const consumed = await consumeChallenge(pool, 'keyring_rotation', cardHash, challenge);
  if (!consumed) {
    return { ok: false, statusCode: 401, statusMessage: 'Invalid or expired challenge.' };
  }

  const challengeBytes = new Uint8Array(Buffer.from(challenge, 'base64url'));
  const validSignature = verifyMasterCardSignature(challengeBytes, signature, account.master_pubkey);
  if (!validSignature) {
    return { ok: false, statusCode: 401, statusMessage: 'Invalid master card key signature.' };
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
    ok: true,
    service_secret: Buffer.from(responseServiceSecretPlain).toString('base64url'),
    keyring_id: newKeyringId,
  };
}
