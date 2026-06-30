/**
 * POST /messages — implementation-plan.md §Step 4.2. Accepts a routed
 * message envelope from a peer wallet service, already addressed to one
 * specific sub-card and already encrypted to that sub-card's key by the
 * sender (message_routing.md v0.4 §Sender-Side Fan-out). The payload is
 * opaque — never decrypted, never logged. Only `to` and `subcard_hash` are
 * visible to the routing layer (message_routing.md §What Wallet Services
 * Observe).
 */

import { loadConfig } from '../../../src/config.js';
import { getPool } from '../../db/client.js';
import { findRoutingEntry } from '../../db/routing.js';
import { enqueueMessage } from '../../db/messages.js';
import { deliverMessage } from '../../utils/message-delivery.js';

interface RoutingEnvelopeBody {
  to?: string;
  subcard_hash?: string;
  payload?: string;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<RoutingEnvelopeBody>(event);
  const { to, subcard_hash: subcardHash, payload } = body ?? {};
  if (!to || !subcardHash || !payload) {
    throw createError({ statusCode: 400, statusMessage: 'to, subcard_hash, and payload are required.' });
  }

  const pool = getPool();
  const routing = await findRoutingEntry(pool, to);
  if (!routing) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown card_hash.' });
  }

  const config = loadConfig();
  if (routing.wallet_service_id !== config.WALLET_SERVICE_ID) {
    setResponseStatus(event, 410);
    return {
      error: 'card_migrated',
      wallet_service_id: routing.wallet_service_id,
      endpoint: routing.endpoint,
    };
  }

  const message = await enqueueMessage(pool, to, subcardHash, payload);

  // No sender information is stored or logged — only the recipient card
  // hash, target subcard_hash, and an opaque message id (message_routing.md
  // §What Wallet Services Observe).
  console.info(`[wallet-service] message received card_hash=${to} message_id=${message.id}`);

  setResponseStatus(event, 202);
  await deliverMessage(pool, message);

  return null;
});
