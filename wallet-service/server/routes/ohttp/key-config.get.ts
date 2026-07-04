/**
 * GET /ohttp/key-config — client-sdk implementation plan Step 1.4c.
 * Unauthenticated: returns the wallet service's current HPKE public key
 * and suite identifiers, which client-sdk's ObliviousProtocolTransport
 * (Step 1.4a) fetches and caches on a TTL. `target_id` is this wallet
 * service's fixed relay-registry target (OQ-SDK-7: single preferred
 * wallet-service instance per SDK configuration).
 */

import { loadConfig } from '../../../src/config.js';
import { getKeyConfig } from '../../../src/ohttp-gateway.js';

export default defineEventHandler(async () => {
  const config = loadConfig();
  return getKeyConfig(config.WALLET_SERVICE_ID);
});
