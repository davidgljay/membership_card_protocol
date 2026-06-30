/**
 * Nightly prune of expired, already-consumed uuid_pools rows
 * (implementation-plan.md §Step 5.3). Only consumed + expired rows are
 * deleted — an unconsumed-but-expired UUID is left alone (it simply stops
 * being claimable once expired, per claimNextUuid's `expires_at > now()`
 * check; deleting it here isn't necessary for correctness, only for
 * cleanup, and consumed rows are the ones actually accumulating as dead
 * weight).
 *
 * Logs an aggregate count only — no card-level or subcard-level breakdown,
 * per the privacy constraint (implementation-plan.md §Step 6.2 and this
 * step's "no subcard-level logging — aggregate only").
 */

import { getPool } from '../db/client.js';
import { pruneExpiredConsumedUuids } from '../db/uuid-pools.js';

export default defineTask({
  meta: {
    name: 'prune-expired-uuids',
    description: 'Deletes expired, consumed uuid_pools rows.',
  },
  async run() {
    const pool = getPool();
    const pruned = await pruneExpiredConsumedUuids(pool);
    console.info(`[wallet-service] pruned expired uuids count=${pruned}`);
    return { result: 'done', pruned };
  },
});
