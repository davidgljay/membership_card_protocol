/**
 * Nitro plugin: initializes all press clients at startup and marks the server ready.
 *
 * Startup sequence (per spec §3 Goal 4):
 *   1. Validate all required env vars and key material — loadConfig()
 *   2. Check Filebase bucket is reachable — checkFilebaseHealth()
 *   3. Check Arbitrum One RPC is responsive — eth_chainId
 *   4. Verify press is active under at least one configured policy (warning only)
 *   5. Mark ready — HTTP listener begins accepting traffic
 *
 * GET /health returns 503 until step 5 completes.
 */

import { loadConfig, type PressConfig } from '../../src/config.js';
import { checkFilebaseHealth, createIpfsClient } from '../../src/ipfs/client.js';
import { createRegistryClient } from '../../src/chain/registry.js';
import { createGasManager } from '../../src/chain/gas.js';
import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import {
  buildCardVerifier,
  setPressContext,
  type PressContext,
} from '../../src/context.js';
import { mlDsa44PublicKeyFromPrivate, keccak256 } from '../../src/functions/crypto.js';
import { createNitroKvStore } from '../utils/kv.js';

let pressReady = false;
let pressStartupError: string | null = null;
let pressContext: PressContext | null = null;

export function isPressReady(): boolean {
  return pressReady;
}

export function getPressStartupError(): string | null {
  return pressStartupError;
}

export function getCtx(): PressContext {
  if (!pressContext) throw new Error('PressContext not initialized — startup plugin has not run');
  return pressContext;
}

export default defineNitroPlugin(async () => {
  // ── Step 1: config ──────────────────────────────────────────────────────────
  let config: PressConfig;
  try {
    config = loadConfig();
  } catch {
    pressStartupError = 'Config validation failed — see process logs.';
    return;
  }

  // ── Step 2: Filebase reachability ───────────────────────────────────────────
  const ipfs = createIpfsClient(config);
  try {
    await checkFilebaseHealth(config);
  } catch (err) {
    pressStartupError = `Filebase: ${String(err)}`;
    return;
  }

  // ── Step 3: Arbitrum One RPC ────────────────────────────────────────────────
  const rpcClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.ARBITRUM_RPC_URL),
  });
  try {
    const chainId = await rpcClient.getChainId();
    if (chainId !== arbitrum.id) {
      pressStartupError =
        `ARBITRUM_RPC_URL: connected to chain ${chainId}, expected ${arbitrum.id} (Arbitrum One)`;
      return;
    }
  } catch (err) {
    pressStartupError = `ARBITRUM_RPC_URL: RPC not responding — ${String(err)}`;
    return;
  }

  // ── Step 4: initialize clients ──────────────────────────────────────────────
  const registry = createRegistryClient(config);
  const kv = createNitroKvStore();
  const verifier = buildCardVerifier(config, registry, ipfs);
  const gas = createGasManager(config, registry, kv);

  const pressPublicKey = mlDsa44PublicKeyFromPrivate(config.PRESS_MLDSA44_PRIVATE_KEY);
  const pressAddress = '0x' + Buffer.from(keccak256(pressPublicKey)).toString('hex');

  // ── Step 4b: press authorization advisory check ─────────────────────────────
  // Non-fatal: emit a warning if the press isn't authorized under any policy yet.
  // The contract will reject unauthorized writes at submission time.
  let authorizedCount = 0;
  for (const policyCid of config.PRESS_POLICY_CIDS) {
    try {
      const policyAddress = ('0x' + Buffer.from(
        keccak256(new TextEncoder().encode(policyCid))
      ).toString('hex')) as `0x${string}`;
      const auth = await registry.getPressAuthorization(policyAddress, pressAddress as `0x${string}`);
      if (auth.active) authorizedCount++;
    } catch {
      // Registry may not have the policy yet; not fatal at startup.
    }
  }
  if (authorizedCount === 0) {
    console.warn(
      '[press] Warning: press is not currently authorized under any configured policy. ' +
        'On-chain writes will be rejected until AuthorizePress is called by the governance body.'
    );
  }

  // ── Step 5: ready ───────────────────────────────────────────────────────────
  pressContext = {
    config, kv, verifier, registry, ipfs, gas, pressPublicKey, pressAddress,
  };
  setPressContext(pressContext);
  pressReady = true;
  console.info(
    `[press] Ready. Address: ${pressAddress} | ` +
      `Policies: ${config.PRESS_POLICY_CIDS.length} | ` +
      `Authorized: ${authorizedCount}`
  );
});
