/**
 * Hourly prune of subcard_action_nonces entries older than their 1-hour
 * retention window (notification_relay.md v0.9 §Process 1 steps 6-8,
 * §Multi-Device Support "Deregistration"; server/db/subcard-action-nonces.ts).
 * Mirrors prune-routing-nonces.ts's shape, on a shorter cadence matching
 * this table's much shorter retention.
 *
 * Task filename/registered name is unchanged from ea7ce3b1 even though
 * the table now covers both registration and deregistration nonces —
 * renaming the task would just be churn for Nitro's task registry with no
 * behavioral benefit; the table rename is what matters for query clarity.
 */

import { getPool } from '../db/client.js';
import { pruneOldSubcardActionNonces } from '../db/subcard-action-nonces.js';

export default defineTask({
  meta: {
    name: 'prune-subcard-uuid-registration-nonces',
    description: 'Deletes subcard_action_nonces entries older than the 1-hour replay-prevention window.',
  },
  async run() {
    const pool = getPool();
    const pruned = await pruneOldSubcardActionNonces(pool);
    return { result: 'done', pruned };
  },
});
