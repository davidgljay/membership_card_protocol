/**
 * holder_accounts repository (implementation-plan.md §Step 1.2, §Step 2.1
 * schema addendum). One row per holder; the WebAuthn columns are populated
 * once, at account creation (Step 2.2), and never re-registered.
 */

import type { Pool } from 'pg';

export interface HolderAccountRow {
  id: string;
  card_hash: string;
  master_pubkey: string;
  keyring_id: string;
  service_secret_enc: string;
  service_secret_dek_enc: string;
  webauthn_credential_id: string | null;
  webauthn_public_key: string | null;
  webauthn_sign_count: string; // bigint -> string over the wire
  created_at: Date;
}

export interface CreateAccountInput {
  cardHash: string;
  masterPubkey: string;
  keyringId: string;
  serviceSecretEnc: string;
  serviceSecretDekEnc: string;
  webauthnCredentialId: string;
  webauthnPublicKey: string;
}

export async function findAccountByCardHash(
  pool: Pool,
  cardHash: string
): Promise<HolderAccountRow | null> {
  const { rows } = await pool.query<HolderAccountRow>(
    'SELECT * FROM holder_accounts WHERE card_hash = $1',
    [cardHash]
  );
  return rows[0] ?? null;
}

export async function createAccount(
  pool: Pool,
  input: CreateAccountInput
): Promise<HolderAccountRow> {
  const { rows } = await pool.query<HolderAccountRow>(
    `INSERT INTO holder_accounts (
       card_hash, master_pubkey, keyring_id,
       service_secret_enc, service_secret_dek_enc,
       webauthn_credential_id, webauthn_public_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.cardHash,
      input.masterPubkey,
      input.keyringId,
      input.serviceSecretEnc,
      input.serviceSecretDekEnc,
      input.webauthnCredentialId,
      input.webauthnPublicKey,
    ]
  );
  const row = rows[0];
  if (!row) {
    throw new Error('createAccount: insert returned no row.');
  }
  return row;
}

/** Updates the stored WebAuthn signature counter after a verified login (Step 2.1). */
export async function updateWebAuthnSignCount(
  pool: Pool,
  cardHash: string,
  newCounter: number
): Promise<void> {
  await pool.query('UPDATE holder_accounts SET webauthn_sign_count = $1 WHERE card_hash = $2', [
    newCounter,
    cardHash,
  ]);
}

/** Replaces service_secret and keyring_id after recovery re-registration (Step 2.4). */
export async function updateServiceSecretAndKeyring(
  pool: Pool,
  cardHash: string,
  fields: { keyringId: string; serviceSecretEnc: string; serviceSecretDekEnc: string }
): Promise<void> {
  await pool.query(
    `UPDATE holder_accounts
     SET keyring_id = $1, service_secret_enc = $2, service_secret_dek_enc = $3
     WHERE card_hash = $4`,
    [fields.keyringId, fields.serviceSecretEnc, fields.serviceSecretDekEnc, cardHash]
  );
}

/**
 * Replaces `keyring_id` only, leaving `service_secret_enc`/`_dek_enc`
 * untouched (client-sdk implementation plan Step 2.4 fix: `rotate_service_
 * secret: false` on `PUT /accounts/{card_hash}/keyring`). See that route's
 * doc comment for why unconditionally rotating on every call made the
 * account's stored blob permanently undecryptable via any secret the
 * server would later hand back.
 */
export async function updateKeyringOnly(pool: Pool, cardHash: string, keyringId: string): Promise<void> {
  await pool.query('UPDATE holder_accounts SET keyring_id = $1 WHERE card_hash = $2', [keyringId, cardHash]);
}
