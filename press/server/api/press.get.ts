import { isPressReady, getPressConfig } from '../plugins/startup.js';

export default defineEventHandler((event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  const config = getPressConfig();
  return {
    press_card_cid: config.PRESS_CARD_CID,
    policy_cids: config.PRESS_POLICY_CIDS,
  };
});
