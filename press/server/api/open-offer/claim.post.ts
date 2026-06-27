import { getCtx, isPressReady } from '../../plugins/startup.js';
import { handleOpenOfferClaim } from '../../../src/handlers/open-offer.js';
import type { OpenOfferClaimSubmission } from '../../../src/types.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  try {
    const body = await readBody<OpenOfferClaimSubmission>(event);
    return await handleOpenOfferClaim(getCtx(), body);
  } catch (err: unknown) {
    const code = (err as { pressCode?: string }).pressCode;
    if (code) {
      setResponseStatus(event, 400);
      return { error: code, message: (err as Error).message };
    }
    throw err;
  }
});
