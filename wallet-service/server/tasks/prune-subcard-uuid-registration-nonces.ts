/**
 * Hourly prune of subcard_uuid_registration_nonces older than their
 * 1-hour retention window (notification_relay.md v0.8 §Process 1 steps
 * 6-8; server/db/subcard-uuid-nonces.ts). Mirrors prune-routing-nonces.ts's
 * shape, on a shorter cadence matching this table's much shorter retention.
 */

import { getPool } from '../db/client.js';
import { pruneOldSubcardUuidNonces } from '../db/subcard-uuid-nonces.js';

export default defineTask({
  meta: {
    name: 'prune-subcard-uuid-registration-nonces',
    description: 'Deletes subcard_uuid_registration_nonces entries older than the 1-hour replay-prevention window.',
  },
  async run() {
    const pool = getPool();
    const pruned = await pruneOldSubcardUuidNonces(pool);
    return { result: 'done', pruned };
  },
});
