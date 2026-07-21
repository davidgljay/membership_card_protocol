/**
 * POST /api/admin/app-gas-credit — operator-only. Credits an app's gas
 * account directly, bypassing the real flow (an app sends ETH to the
 * press's address with its app_card_address in calldata, detected by
 * chain/gas.ts's pollEthTransfers polling task — see that file's doc).
 * Test/dev escape hatch for exercising sub-card registration (which
 * checkAppGasBalance gates, handlers/sub-card.ts step 8) without wiring
 * up a real funded wallet and waiting on block-polling in an integration
 * harness — mirrors POST /api/admin/trusted-roots's rationale exactly.
 */

import { requireAdminAuth } from '../../utils/admin-auth.js';
import { getCtx, isPressReady } from '../../plugins/startup.js';

interface CreditAppGasBody {
  app_card_address?: string;
  wei_amount?: string;
}

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  requireAdminAuth(event);

  const body = await readBody<CreditAppGasBody>(event);
  const appCardAddress = body?.app_card_address;
  const weiAmount = body?.wei_amount;
  if (!appCardAddress || !weiAmount) {
    setResponseStatus(event, 400);
    return { error: 'MISSING_FIELD', message: 'app_card_address and wei_amount are required.' };
  }

  const ctx = getCtx();
  await ctx.gas.creditAppGasAccount(appCardAddress, BigInt(weiAmount));

  return { ok: true };
});
