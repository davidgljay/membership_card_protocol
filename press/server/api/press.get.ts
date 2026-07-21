import { isPressReady, getCtx } from '../plugins/startup.js';
import { kvKeys } from '../../src/kv.js';
import type { LogHeadRecord } from '../../src/kv.js';

export default defineEventHandler(async (event) => {
  if (!isPressReady()) {
    setResponseStatus(event, 503);
    return { error: 'PRESS_NOT_READY', message: 'Press is initializing' };
  }
  const { config, kv, pressAddress, registry } = getCtx();

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
    // On-chain `PressAuthorizations` lookup key (secp256r1 gas-account
    // address, bytes32-padded) — a distinct identity from `address` above
    // (keccak256 of the ML-DSA-44 content-signing key). Callers that need
    // to authoritatively check this press's authorization for a policy
    // (e.g. wallet-sdk's `reviewTargetedOffer`) need this value, not `address`.
    gas_address: registry.pressGasAddress,
    log_heads,
  };
});
