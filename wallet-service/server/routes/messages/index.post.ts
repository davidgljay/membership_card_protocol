/**
 * POST /messages — implementation-plan.md §Step 4.2. Accepts a routed
 * message envelope from a peer wallet service, already addressed to one
 * specific sub-card and already encrypted to that sub-card's key by the
 * sender (message_routing.md v0.4 §Sender-Side Fan-out). The payload is
 * opaque — never decrypted, never logged. Only `to` and `subcard_hash` are
 * visible to the routing layer (message_routing.md §What Wallet Services
 * Observe).
 *
 * Thin H3 adapter — all logic lives in
 * ../../../src/routes/messages-create.ts (client-sdk implementation plan
 * Step 1.4c), callable identically from here and from the OHTTP gateway
 * (server/routes/ohttp/gateway.post.ts).
 */

import { getPool } from '../../db/client.js';
import {
  handleMessagesCreate,
  type RawRoutingEnvelopeBody,
} from '../../../src/routes/messages-create.js';

export default defineEventHandler(async (event) => {
  const rawBody = await readBody<RawRoutingEnvelopeBody>(event);
  const outcome = await handleMessagesCreate({ pool: getPool(), rawBody });

  if (!outcome.ok) {
    throw createError({ statusCode: outcome.statusCode, statusMessage: outcome.statusMessage });
  }

  setResponseStatus(event, outcome.status);
  return outcome.body;
});
