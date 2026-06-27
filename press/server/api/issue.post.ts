import { getCtx, isPressReady } from '../plugins/startup.js';
import { handleIssue } from '../../src/handlers/issue.js';
import type { IssuanceRequest } from '../../src/types.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  try {
    const body = await readBody<IssuanceRequest>(event);
    return await handleIssue(getCtx(), body);
  } catch (err: unknown) {
    const code = (err as { pressCode?: string }).pressCode;
    if (code) {
      setResponseStatus(event, 400);
      return { error: code, message: (err as Error).message };
    }
    throw err;
  }
});
