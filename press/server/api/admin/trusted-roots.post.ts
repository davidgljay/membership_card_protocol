/**
 * POST /api/admin/trusted-roots — operator-only. Registers an address as
 * a policy-authorizer/trusted chain-walk root that context.ts's
 * `createRpcProvider`'s `isPolicyAuthorizer` will recognize, alongside the
 * real on-chain `PolicyAuthorizerKeys` check. See kv.ts's `trustedRoot`
 * key doc for why this exists: a card address that's legitimately a
 * trusted anchor but was never itself registered as an on-chain policy
 * (e.g. a test fixture's synthetic per-run root) has no other way to be
 * recognized, since `PRESS_POLICY_CIDS`'s static config can't track an
 * address generated fresh on every run.
 */

import { requireAdminAuth } from '../../utils/admin-auth.js';
import { getCtx, isPressReady } from '../../plugins/startup.js';
import { kvKeys } from '../../../src/kv.js';

interface RegisterTrustedRootBody {
  address?: string;
}

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  requireAdminAuth(event);

  const body = await readBody<RegisterTrustedRootBody>(event);
  const address = body?.address;
  if (!address) {
    setResponseStatus(event, 400);
    return { error: 'MISSING_FIELD', message: 'address is required.' };
  }

  const ctx = getCtx();
  await ctx.kv.setItem(kvKeys.trustedRoot(address.toLowerCase()), true);

  return { ok: true };
});
