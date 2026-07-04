/**
 * GET /ohttp/key-config — client-sdk implementation plan Step 1.4d.
 * Unauthenticated: returns the press's current HPKE public key and suite
 * identifiers, which client-sdk's ObliviousProtocolTransport (Step 1.4a)
 * fetches and caches per press base URL.
 */

import { getCtx, isPressReady } from '../../plugins/startup.js';
import { getKeyConfig } from '../../../src/ohttp-gateway.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  const ctx = getCtx();
  return getKeyConfig(ctx.config, ctx.pressAddress);
});
