import { isPressReady, getCtx } from '../plugins/startup.js';
import { kvKeys } from '../../src/kv.js';
import type { LogHeadRecord } from '../../src/kv.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  const { config, kv, pressAddress } = getCtx();

  // Collect current log heads for each policy.
  const log_heads: Record<string, string | null> = {};
  for (const policyCid of config.PRESS_POLICY_CIDS) {
    const record = await kv.getItem<LogHeadRecord>(kvKeys.logHead(policyCid));
    log_heads[policyCid] = record?.log_head_cid ?? null;
  }

  return {
    press_card_cid: config.PRESS_CARD_CID,
    policy_cids: config.PRESS_POLICY_CIDS,
    address: pressAddress,
    log_heads,
  };
});
