/**
 * keyring_blobs repository (implementation-plan.md §Step 1.2, §OQ-WS-3).
 * Traditional, deletable storage — not IPFS, per ARCHITECTURE.md
 * ADR-009-AMEND. Federation replication (broadcast/delete to peers) lands
 * in Phase 4 Step 4.1a; this module only handles the local row.
 */

import type { Pool } from 'pg';

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
