/**
 * GET /admin/recovery-windows — strategic-plan.md §Goal 5 (operational
 * transparency): pending recovery windows with time remaining. Operator
 * auth only (ADMIN_API_KEY). No plaintext key material — recovery_windows
 * has none to begin with (wrapped_blob lives on backup_registrations and
 * is never joined in here).
 */

import { requireAdminAuth } from '../../utils/admin-auth.js';
import { getPool } from '../../db/client.js';
import { listPendingRecoveryWindows } from '../../db/recovery.js';

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);

  const pool = getPool();
  const windows = await listPendingRecoveryWindows(pool);

  return {
    recovery_windows: windows.map((w) => ({
      recovery_id: w.id,
      initiated_at: w.initiated_at.toISOString(),
      expires_at: w.expires_at.toISOString(),
      seconds_remaining: Math.max(0, Math.floor((w.expires_at.getTime() - Date.now()) / 1000)),
    })),
  };
});
