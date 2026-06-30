/**
 * POST /cards/{card_hash}/subcards/{subcard_hash}/uuids —
 * implementation-plan.md §Step 5.1. Device registers a batch of UUIDs for
 * this subcard. No authentication beyond a syntactically valid card_hash —
 * the device does not authenticate its identity here, by design
 * (unlinkability: the wallet service must not be able to tell which
 * device is registering, only that some device is registering UUIDs for
 * this subcard).
 *
 * On receiving new UUIDs, immediately redelivers any uncleared messages
 * for this subcard — no re-encryption needed, the payload was already
 * encrypted to this exact subcard by the sender (message_routing.md v0.4
 * §Sender-Side Fan-out). This is the retransmission path after a relay
 * restart (message_routing.md §UUID Re-registration and Retransmission).
 */

import { getPool } from '../../../../../db/client.js';
import { registerUuids } from '../../../../../db/uuid-pools.js';
import { findUnclearedMessagesForSubcard } from '../../../../../db/messages.js';
import { deliverMessage } from '../../../../../utils/message-delivery.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RegisterUuidsBody {
  uuids?: string[];
}

export default defineEventHandler(async (event) => {
  const cardHash = getRouterParam(event, 'card_hash');
  const subcardHash = getRouterParam(event, 'subcard_hash');
  if (!cardHash || !subcardHash) {
    throw createError({ statusCode: 400, statusMessage: 'card_hash and subcard_hash are required.' });
  }

  const body = await readBody<RegisterUuidsBody>(event);
  const uuids = body?.uuids;
  if (!Array.isArray(uuids) || uuids.length === 0 || uuids.length > 100) {
    throw createError({ statusCode: 400, statusMessage: 'uuids must be a non-empty array of at most 100 UUIDs.' });
  }
  if (!uuids.every((u) => typeof u === 'string' && UUID_V4_RE.test(u))) {
    throw createError({ statusCode: 400, statusMessage: 'uuids must all be valid UUID v4 strings.' });
  }

  // No rate limit on total UUIDs registered per subcard per day (Step 6.1's
  // original "100 per 24h" cap is removed — see implementation-plan.md
  // §Step 6.1 note. Each delivered message consumes one UUID, so capping
  // registration directly caps message throughput; 100/day is an
  // unreasonably low ceiling for an active chat-like subcard. The
  // per-call cap of 100 UUIDs (validated above) remains, as a payload-size
  // guard, not a throughput limit.

  const pool = getPool();
  await registerUuids(pool, cardHash, subcardHash, uuids);

  // Retransmission: redeliver anything still queued for this subcard to
  // the newly-registered UUIDs. No log line below names subcard_hash —
  // only card_hash and a count (Step 5.1 unlinkability constraint).
  const uncleared = await findUnclearedMessagesForSubcard(pool, cardHash, subcardHash);
  for (const message of uncleared) {
    await deliverMessage(pool, message);
  }

  console.info(`[wallet-service] uuids registered card_hash=${cardHash} count=${uuids.length} retransmitted=${uncleared.length}`);

  setResponseStatus(event, 204);
  return null;
});
