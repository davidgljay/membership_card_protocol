/**
 * Nitro plugin: initializes all press clients at startup and marks the server ready.
 * GET /health returns 503 until all checks pass.
 */

import { loadConfig, type PressConfig } from '../../src/config.js';
import { checkFilebaseHealth } from '../../src/ipfs/client.js';
import { createIpfsClient } from '../../src/ipfs/client.js';
import { createRegistryClient } from '../../src/chain/registry.js';
import { createGasManager } from '../../src/chain/gas.js';
import { createInMemoryKv } from '../../src/kv.js';
import {
  buildCardVerifier,
  setPressContext,
  type PressContext,
} from '../../src/context.js';
import { mlDsa44PublicKeyFromPrivate } from '../../src/functions/crypto.js';
import { keccak256, toBase64url } from '../../src/functions/crypto.js';

let pressReady = false;
let pressStartupError: string | null = null;
let pressContext: PressContext | null = null;

export function getPressConfig(): PressConfig {
  if (!pressContext) throw new Error('Press config not loaded');
  return pressContext.config;
}

export function isPressReady(): boolean {
  return pressReady;
}

export function getPressStartupError(): string | null {
  return pressStartupError;
}

export function getCtx(): PressContext {
  if (!pressContext) throw new Error('PressContext not initialized');
  return pressContext;
}

export default defineNitroPlugin(async () => {
  // 1. Load and validate config.
  let config: PressConfig;
  try {
    config = loadConfig();
  } catch {
    pressStartupError = 'Config validation failed — see process logs.';
    return;
  }

  // 2. Initialize clients.
  const ipfs = createIpfsClient(config);
  const registry = createRegistryClient(config);

  // 3. Check Filebase reachability.
  try {
    await checkFilebaseHealth(config);
  } catch (err) {
    pressStartupError = String(err);
    return;
  }

  // 4. Build KV store.
  // In production, use Nitro's useStorage('press') adapter.
  // For Phase 3, use in-memory KV (replaced in Phase 4 with the Nitro driver).
  const kv = createInMemoryKv();

  // 5. Build CardVerifier.
  const verifier = buildCardVerifier(config, registry, ipfs);

  // 6. Build gas manager.
  const gas = createGasManager(config, registry, kv);

  // 7. Derive press public key and address.
  const pressPublicKey = mlDsa44PublicKeyFromPrivate(config.PRESS_MLDSA44_PRIVATE_KEY);
  const pressAddress = '0x' + Buffer.from(keccak256(pressPublicKey)).toString('hex');

  // 8. Assemble context.
  const ctx: PressContext = {
    config,
    kv,
    verifier,
    registry,
    ipfs,
    gas,
    pressPublicKey,
    pressAddress,
  };
  setPressContext(ctx);
  pressContext = ctx;

  pressReady = true;
  console.info(`[press] Ready. Press address: ${pressAddress}`);
});
