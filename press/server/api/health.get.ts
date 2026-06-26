import { isPressReady, getPressStartupError } from '../plugins/startup.js';

export default defineEventHandler((event) => {
  if (isPressReady()) {
    return { status: 'ok' };
  }
  setResponseStatus(event, 503);
  return {
    status: 'starting',
    error: getPressStartupError() ?? 'Press is initializing',
  };
});
