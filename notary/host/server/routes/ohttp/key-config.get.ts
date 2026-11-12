import { getCtx, isHostReady } from '../../plugins/startup.js';
import { getKeyConfig } from '../../../src/ohttp-gateway.js';

/** GET /ohttp/key-config — the gateway's HPKE key configuration (direct). */
export default defineEventHandler((event) => {
  if (!isHostReady()) { setResponseStatus(event, 503); return { error: 'NH_ENCLAVE_UNAVAILABLE', message: 'Host is initializing' }; }
  const ctx = getCtx();
  return getKeyConfig(ctx.config.NOTARY_OHTTP_PRIVATE_KEY, ctx.config.NOTARY_RELAY_TARGET_ID);
});
