/**
 * GET /admin/message-counts — strategic-plan.md §Goal 5: held message
 * counts per card. card_hash only — no subcard_hash, no payload content.
 * Operator auth only (ADMIN_API_KEY).
 */

import { requireAdminAuth } from '../../utils/admin-auth.js';
import { getPool } from '../../db/client.js';
import { countHeldMessagesPerCard } from '../../db/messages.js';

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);

  const pool = getPool();
  const counts = await countHeldMessagesPerCard(pool);

  return { message_counts: counts };
});
