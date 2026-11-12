import { getCtx, isHostReady } from '../../plugins/startup.js';
import { decapsulate } from '../../../src/ohttp-gateway.js';
import { dispatch } from '../../../src/ohttp-router.js';

/** POST /ohttp/gateway — decapsulates, dispatches in-process to the oblivious routes, encapsulates the response. */
export default defineEventHandler(async (event) => {
  if (!isHostReady()) { setResponseStatus(event, 503); return { error: 'NH_ENCLAVE_UNAVAILABLE', message: 'Host is initializing' }; }
  const body = await readBody<{ enc?: string; ciphertext?: string }>(event);
  if (!body?.enc || !body?.ciphertext) { setResponseStatus(event, 400); return { error: 'MISSING_FIELD', message: 'enc and ciphertext are required.' }; }
  const ctx = getCtx();
  const { envelope, encapsulateResponse } = await decapsulate(ctx.config.NOTARY_OHTTP_PRIVATE_KEY, { enc: body.enc, ciphertext: body.ciphertext });
  return encapsulateResponse(await dispatch(envelope, ctx));
});
