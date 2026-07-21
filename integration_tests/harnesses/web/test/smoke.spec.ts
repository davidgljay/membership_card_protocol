import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { test, expect } from '@playwright/test';
import { prepare } from '../src/prepare.js';
import type { HarnessConfig } from '../src/prepare.js';
import type { ScenarioResult } from '../src/scenario.js';

const PRESS_BASE_URL = process.env.HARNESS_PRESS_URL ?? 'http://localhost:3001';
const WALLET_SERVICE_BASE_URL = process.env.HARNESS_WALLET_SERVICE_URL ?? 'http://localhost:3002';
const RELAY_BASE_URL = process.env.HARNESS_RELAY_URL ?? 'http://localhost:3000';
const KUBO_API_URL = process.env.HARNESS_KUBO_API_URL ?? 'http://localhost:5001';
const HARNESS_ORIGIN = 'http://localhost:8901';

/**
 * The stack runs against a local nitro-devnode by default (see
 * docker-compose.yml's top-of-file comment), which resets all chain state
 * and redeploys fresh contracts on every restart — so, unlike a stable
 * Sepolia address, the storage contract address can't be a fixed default.
 * Read it from the same deployments/local.json file press/wallet-service's
 * own entrypoint.sh reads (bind-mounted from the same host path, not a
 * named Docker volume — see docker-compose.yml's deploy-contracts service).
 * HARNESS_ARBITRUM_RPC_URL/HARNESS_STORAGE_CONTRACT_ADDRESS still override
 * this for pointing the harness at Sepolia or another chain instead.
 */
function readLocalStorageAddress(): string {
  const deploymentPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/deployments/local.json');
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf-8')) as { contracts: { storage_contract: string } };
  return deployment.contracts.storage_contract;
}

const ARBITRUM_RPC_URL = process.env.HARNESS_ARBITRUM_RPC_URL ?? 'http://localhost:8547';
const STORAGE_CONTRACT_ADDRESS = process.env.HARNESS_STORAGE_CONTRACT_ADDRESS ?? readLocalStorageAddress();

/**
 * press/wallet-service/relay/the chain RPC have no CORS headers, so
 * browser-side fetches to them (unlike prepare.ts's Node-side ones) must
 * go through serve.mjs's same-origin proxy instead of hitting the real
 * ports directly.
 */
function toBrowserConfig(config: HarnessConfig): HarnessConfig {
  return {
    ...config,
    pressBaseUrl: `${HARNESS_ORIGIN}/proxy/press`,
    walletServiceBaseUrl: `${HARNESS_ORIGIN}/proxy/wallet-service`,
    relayBaseUrl: `${HARNESS_ORIGIN}/proxy/relay`,
    arbitrumRpcUrl: `${HARNESS_ORIGIN}/proxy/rpc`,
  };
}

test('create wallet, accept an offer, validate the card', async ({ page, context }) => {
  // Chrome's CDP WebAuthn domain supports a virtual authenticator with the
  // PRF extension (hasPrf) — confirmed empirically (deterministic,
  // reproducible output between register()/assert() for the same
  // credential+salt), which is what unblocked sdk-providers-web's
  // WebAuthnPasskeyProvider fix in the first place. Without this, every
  // navigator.credentials call in the page would hang waiting for a real
  // authenticator that doesn't exist in a headless/CI browser.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
    },
  });

  const config = await prepare({
    pressBaseUrl: PRESS_BASE_URL,
    walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
    relayBaseUrl: RELAY_BASE_URL,
    arbitrumRpcUrl: ARBITRUM_RPC_URL,
    storageContractAddress: STORAGE_CONTRACT_ADDRESS,
    kuboApiUrl: KUBO_API_URL,
  });

  page.on('console', (msg) => console.log(`[page console:${msg.type()}]`, msg.text()));
  page.on('pageerror', (err) => console.log('[page error]', err.message, err.stack));
  page.on('request', (req) => console.log(`[req]`, req.method(), req.url()));
  page.on('requestfailed', (req) => console.log(`[req failed]`, req.method(), req.url(), req.failure()?.errorText));
  page.on('response', (res) => console.log(`[res]`, res.status(), res.url()));

  await page.goto('/index.html');
  const result = await page.evaluate(async (cfg) => {
    return window.runScenario(cfg);
  }, toBrowserConfig(config) as never) as ScenarioResult;

  if (!result.success) {
    console.error('Scenario failed. Full result:', JSON.stringify(result, null, 2));
  }
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.chainReachesTrustedRoot).toBe(true);
  expect(result.isCurrentlyValid).toBe(true);
  expect(result.subCardRegistered).toBe(true);
  expect(typeof result.mintedCardCid).toBe('string');
});
