/**
 * Nitro plugin: initializes all press clients at startup and marks the server ready.
 *
 * Startup sequence (per spec §3 Goal 4):
 *   1. Validate all required env vars and key material — loadConfig()
 *   2. Check the configured IPFS provider is reachable — ipfs.checkHealth()
 *   3. Check Arbitrum One RPC is responsive — eth_chainId
 *   4. Verify press is active under at least one configured policy (warning only)
 *   5. Mark ready — HTTP listener begins accepting traffic
 *
 * GET /health (and every other endpoint) returns 503 until step 5 completes.
 *
 * Under the cloudflare-module preset, this sequence's async I/O (IPFS/RPC
 * checks) can't run directly in defineNitroPlugin's own callback — Workers
 * runs plugin registration at module-evaluation time, outside any request's
 * handler context, and workerd hard-rejects fetch()/connect() there
 * ("Disallowed operation called within global scope"). Confirmed against
 * the actual `wrangler dev` error, not just docs. So the plugin only
 * registers a `request` hook (which *does* fire inside request handling);
 * the hook kicks off runStartup() on the first real request it sees,
 * memoized via startupPromise so later requests don't restart it. Every
 * handler already checks isPressReady() before touching context (see
 * server/api/*), so requests during the startup window still get a clean
 * 503 exactly as before — this only changes when the I/O begins, not the
 * observable ready/not-ready contract.
 */

import { loadConfig, type PressConfig } from '../../src/config.js';
import { createIpfsClient } from '../../src/ipfs/index.js';
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

let startupPromise: Promise<void> | null = null;

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', async () => {
    // Awaited (not fire-and-forget): workerd only permits async I/O for the
    // duration of the request that's actually executing. A detached
    // background promise starting mid-request but outliving its own
    // handler's return gets its I/O silently stuck (confirmed empirically —
    // fetch() inside it never resolves or rejects). Awaiting here keeps
    // runStartup()'s I/O within a request's live execution the whole time.
    // Memoized via startupPromise, so only the request that triggers it
    // pays the cost — every request after that (including concurrent ones)
    // awaits the same settled/settling promise.
    if (!startupPromise) {
      startupPromise = runStartup();
    }
    await startupPromise;
  });
});

async function runStartup(): Promise<void> {
  // ── Step 1: config ──────────────────────────────────────────────────────────
  let config: PressConfig;
  try {
    config = loadConfig();
  } catch {
    pressStartupError = 'Config validation failed — see process logs.';
    return;
  }

  // ── Step 2: IPFS provider reachability ──────────────────────────────────────
  const ipfs = createIpfsClient(config);
  try {
    await ipfs.checkHealth();
  } catch (err) {
    pressStartupError = `IPFS provider (${config.IPFS_PROVIDER}): ${String(err)}`;
    return;
  }

  // ── Step 3: Arbitrum RPC (chain ID checked against config.EXPECTED_CHAIN_ID) ─
  const rpcClient = createPublicClient({
    chain: arbitrum,
    transport: http(config.ARBITRUM_RPC_URL),
  });
  try {
    const chainId = await rpcClient.getChainId();
    if (chainId !== config.EXPECTED_CHAIN_ID) {
      pressStartupError =
        `ARBITRUM_RPC_URL: connected to chain ${chainId}, expected ${config.EXPECTED_CHAIN_ID}`;
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
}
