import { getCtx, isPressReady } from '../../plugins/startup.js';
import { kvKeys } from '../../../src/kv.js';
import type { AppGasRecord } from '../../../src/kv.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  const address = getRouterParam(event, 'address');
  if (!address) {
    setResponseStatus(event, 400);
    return { error: 'MISSING_ADDRESS', message: 'Address parameter is required' };
  }

  const { kv } = getCtx();
  const record = await kv.getItem<AppGasRecord>(kvKeys.appGas(address));
  return {
    app_card_address: address,
    balance_wei: record?.balance_wei ?? '0',
    last_funded_at: record?.last_funded_at ?? null,
    last_debited_at: record?.last_debited_at ?? null,
  };
});
