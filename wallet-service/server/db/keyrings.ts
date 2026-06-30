/**
 * keyring_blobs repository (implementation-plan.md §Step 1.2, §OQ-WS-3,
 * §Step 4.1a). Traditional, deletable storage — not IPFS, per
 * ARCHITECTURE.md ADR-009-AMEND. A row here may belong to a holder served
 * by this instance, or to a holder of any peer in the federation (full
 * replication, OQ-WS-3) — `findKeyringBlob` makes no distinction.
 */

import type { Pool } from 'pg';

export interface KeyringBlobRow {
  keyring_id: string;
  card_hash: string;
  encrypted_blob: string;
  received_at: Date;
}

export async function insertKeyringBlob(
  pool: Pool,
  keyringId: string,
  cardHash: string,
  encryptedBlob: string
): Promise<void> {
  await pool.query(
    `INSERT INTO keyring_blobs (keyring_id, card_hash, encrypted_blob)
     VALUES ($1, $2, $3)
     ON CONFLICT (keyring_id) DO NOTHING`,
    [keyringId, cardHash, encryptedBlob]
  );
}

export async function findKeyringBlob(pool: Pool, keyringId: string): Promise<KeyringBlobRow | null> {
  const { rows } = await pool.query<KeyringBlobRow>('SELECT * FROM keyring_blobs WHERE keyring_id = $1', [
    keyringId,
  ]);
  return rows[0] ?? null;
}

/** Idempotent — deleting an already-absent keyring_id is a no-op (implementation-plan.md §Step 4.1a). */
export async function deleteKeyringBlob(pool: Pool, keyringId: string): Promise<void> {
  await pool.query('DELETE FROM keyring_blobs WHERE keyring_id = $1', [keyringId]);
}
