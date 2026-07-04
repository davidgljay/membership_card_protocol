/**
 * POST /ohttp/gateway — client-sdk implementation plan Step 1.4d. The
 * single generic entry point the relay's oblivious-forwarding endpoint
 * (Step 1.4b) POSTs to. Decapsulates the request body, dispatches
 * in-process (src/ohttp-router.ts) to the matching existing handler
 * function, and encapsulates the result back through the same HPKE
 * context.
 */

import { getCtx, isPressReady } from '../../plugins/startup.js';
import { decapsulate } from '../../../src/ohttp-gateway.js';
import { dispatch } from '../../../src/ohttp-router.js';

interface GatewayRequestBody {
  enc?: string;
  ciphertext?: string;
}

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }

  const body = await readBody<GatewayRequestBody>(event);
  if (!body?.enc || !body?.ciphertext) {
    setResponseStatus(event, 400);
    return { error: 'MISSING_FIELD', message: 'enc and ciphertext are required.' };
  }

  const ctx = getCtx();
  const { envelope, encapsulateResponse } = await decapsulate(ctx.config, {
    enc: body.enc,
    ciphertext: body.ciphertext,
  });

  const responseEnvelope = await dispatch(envelope, ctx);
  return encapsulateResponse(responseEnvelope);
});
