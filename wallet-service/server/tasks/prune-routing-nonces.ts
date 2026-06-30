/**
 * Weekly prune of routing_nonces older than the 24-hour replay window
 * (implementation-plan.md §Step 4.1). Nonces are only useful for replay
 * detection within that window; anything older is dead weight.
 */

import { getPool } from '../db/client.js';
import { pruneOldNonces } from '../db/routing.js';

export default defineTask({
  meta: {
    name: 'prune-routing-nonces',
    description: 'Deletes routing_nonces entries older than the 24-hour replay-prevention window.',
  },
  async run() {
    const pool = getPool();
    const pruned = await pruneOldNonces(pool);
    return { result: 'done', pruned };
  },
});
