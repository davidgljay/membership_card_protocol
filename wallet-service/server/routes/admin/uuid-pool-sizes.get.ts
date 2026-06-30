/**
 * GET /admin/uuid-pool-sizes — strategic-plan.md §Goal 5: UUID pool sizes
 * per device. The wallet's only granularity is subcard_hash (never a
 * device identity — see docs/audit-log-schema.md). Operator auth only
 * (ADMIN_API_KEY).
 */

import { requireAdminAuth } from '../../utils/admin-auth.js';
import { getPool } from '../../db/client.js';
import { listUuidPoolSizes } from '../../db/uuid-pools.js';

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);

  const pool = getPool();
  const sizes = await listUuidPoolSizes(pool);

  return { uuid_pool_sizes: sizes };
});
