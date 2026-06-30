/**
 * GET /bindings — implementation-plan.md §Step 4.1. Returns the full
 * routing table as a list of signed CardBindingAnnouncement envelopes, for
 * startup sync by a peer joining or recovering.
 */

import { getPool } from '../../db/client.js';
import { listRoutingTable } from '../../db/routing.js';
import type { AnnouncementEnvelope } from '../../../src/federation/binding.js';

export default defineEventHandler(async () => {
  const pool = getPool();
  const rows = await listRoutingTable(pool);

  const envelopes: AnnouncementEnvelope[] = rows.map((row) => ({
    payload: {
      type: row.type,
      card_hash: row.card_hash,
      wallet_service_id: row.wallet_service_id,
      endpoint: row.endpoint,
      timestamp: row.announced_at.toISOString(),
      nonce: row.nonce,
    },
    signatures: row.signatures,
  }));

  return { bindings: envelopes };
});
