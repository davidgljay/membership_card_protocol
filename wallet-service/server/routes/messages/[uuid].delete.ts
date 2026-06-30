/**
 * DELETE /messages/{uuid} — implementation-plan.md §Step 4.5. Called by
 * the relay, staggered 0-6 hours after confirmed device pickup. Finds the
 * message a delivery UUID was for (via message_queue.delivery_uuid, Step
 * 4.4) and marks it cleared. Wallet services must not clear messages based solely
 * on relay delivery (the 200 from POST /deliver/{uuid}) — only this
 * explicit call does (message_routing.md §Wallet Message Retention).
 */

import { getPool } from '../../db/client.js';
import { clearMessageByDeliveryUuid } from '../../db/messages.js';

export default defineEventHandler(async (event) => {
  const uuid = getRouterParam(event, 'uuid');
  if (!uuid) {
    throw createError({ statusCode: 400, statusMessage: 'uuid is required.' });
  }

  const pool = getPool();
  const cleared = await clearMessageByDeliveryUuid(pool, uuid);
  if (!cleared) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown UUID, or message already cleared.' });
  }

  setResponseStatus(event, 200);
  return { cleared: true };
});
