/**
 * POST /ohttp/gateway — client-sdk implementation plan Step 1.4c. The
 * single generic entry point the relay's oblivious-forwarding endpoint
 * (Step 1.4b) POSTs to. Decapsulates the request body, dispatches
 * in-process (src/ohttp-router.ts) to the corresponding route's own logic
 * — a direct function call, not a second HTTP round-trip — and
 * encapsulates the result back through the same HPKE context.
 */

import { getPool } from '../../db/client.js';
import { decapsulate } from '../../../src/ohttp-gateway.js';
import { dispatch } from '../../../src/ohttp-router.js';

interface GatewayRequestBody {
  enc?: string;
  ciphertext?: string;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<GatewayRequestBody>(event);
  if (!body?.enc || !body?.ciphertext) {
    throw createError({ statusCode: 400, statusMessage: 'enc and ciphertext are required.' });
  }

  const { envelope, encapsulateResponse } = await decapsulate({
    enc: body.enc,
    ciphertext: body.ciphertext,
  });

  // The gateway's own event only ever sees whatever forwarded this request
  // (in production, the relay) — so IP-based rate limiting here is scoped
  // to the aggregate of traffic through that relay, not the originating
  // device. This is an accepted consequence of oblivious routing (Goal 7),
  // not something this step attempts to solve.
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';

  const responseEnvelope = await dispatch(envelope, { pool: getPool(), ip });
  return encapsulateResponse(responseEnvelope);
});
