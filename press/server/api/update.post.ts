import { getCtx, isPressReady } from '../plugins/startup.js';
import { handleUpdate } from '../../src/handlers/update.js';
import type { UpdateRequest } from '../../src/types.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  try {
    const body = await readBody<UpdateRequest>(event);
    return await handleUpdate(getCtx(), body);
  } catch (err: unknown) {
    const code = (err as { pressCode?: string }).pressCode;
    if (code) {
      setResponseStatus(event, 400);
      return { error: code, message: (err as Error).message };
    }
    throw err;
  }
});
