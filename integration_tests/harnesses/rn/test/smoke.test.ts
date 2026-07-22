import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepare } from '../src/prepare.js';
import { runScenario } from '../src/scenario.js';

const PRESS_BASE_URL = process.env.HARNESS_PRESS_URL ?? 'http://localhost:3001';
const WALLET_SERVICE_BASE_URL = process.env.HARNESS_WALLET_SERVICE_URL ?? 'http://localhost:3002';
const RELAY_BASE_URL = process.env.HARNESS_RELAY_URL ?? 'http://localhost:3000';
const KUBO_API_URL = process.env.HARNESS_KUBO_API_URL ?? 'http://localhost:5001';

/**
 * The stack runs against a local nitro-devnode by default (see
 * docker-compose.yml's top-of-file comment) — the storage contract address
 * isn't a fixed default. Read it from the same deployments/local.json file
 * press/wallet-service's own entrypoint.sh reads. Mirrors the web harness's
 * smoke.spec.ts's identical helper.
 * HARNESS_ARBITRUM_RPC_URL/HARNESS_STORAGE_CONTRACT_ADDRESS still override
 * this for pointing the harness at Sepolia or another chain instead.
 */
function readLocalStorageAddress(): string {
  const deploymentPath = join(__dirname, '../../../../contracts/deployments/local.json');
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf-8')) as { contracts: { storage_contract: string } };
  return deployment.contracts.storage_contract;
}

const ARBITRUM_RPC_URL = process.env.HARNESS_ARBITRUM_RPC_URL ?? 'http://localhost:8547';
const STORAGE_CONTRACT_ADDRESS = process.env.HARNESS_STORAGE_CONTRACT_ADDRESS ?? readLocalStorageAddress();

// Generous timeout: this test drives real on-chain transactions (multiple
// registerCard/registerSubCard calls) against a live devnode, same as the
// web harness's equivalent (Playwright's own default timeout covers that
// one; jest's default 5s does not).
jest.setTimeout(60_000);

test('create wallet, accept an offer, validate the card', async () => {
  // No browser, no CDP virtual authenticator — jest runs this directly
  // under Node, and press/wallet-service/relay/the chain RPC are hit with
  // plain fetch() directly (no CORS proxy needed outside a browser).
  const config = await prepare({
    pressBaseUrl: PRESS_BASE_URL,
    walletServiceBaseUrl: WALLET_SERVICE_BASE_URL,
    relayBaseUrl: RELAY_BASE_URL,
    arbitrumRpcUrl: ARBITRUM_RPC_URL,
    storageContractAddress: STORAGE_CONTRACT_ADDRESS,
    kuboApiUrl: KUBO_API_URL,
  });

  const result = await runScenario(config);

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
