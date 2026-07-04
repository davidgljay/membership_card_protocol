/**
 * Request-orchestration logic for GET /keyrings/{keyring_id}
 * (implementation-plan.md §Step 4.1a).
 *
 * Factored out of server/routes/keyrings/[keyring_id].get.ts (client-sdk
 * implementation plan Step 1.4c) — see accounts-challenge.ts's doc for the
 * convention this follows.
 */

import type { Pool } from 'pg';
import { findKeyringBlob } from '../../server/db/keyrings.js';

export type KeyringsGetOutcome =
  | { ok: true; encrypted_blob: string }
  | { ok: false; statusCode: 400 | 404; statusMessage: string };

export async function handleKeyringsGet(params: {
  pool: Pool;
  keyringId: string | null | undefined;
}): Promise<KeyringsGetOutcome> {
  const { pool, keyringId } = params;

  if (!keyringId) {
    return { ok: false, statusCode: 400, statusMessage: 'keyring_id is required.' };
  }

  const blob = await findKeyringBlob(pool, keyringId);
  if (!blob) {
    return { ok: false, statusCode: 404, statusMessage: 'No replica of this keyring_id held locally.' };
  }

  return { ok: true, encrypted_blob: blob.encrypted_blob };
}
