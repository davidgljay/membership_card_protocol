import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  // The scenario chains multiple real on-chain transactions against the
  // public Arbitrum Sepolia RPC (root card registerCard, device sub-card
  // registerSubCard, new-card registerCard on offer acceptance), each of
  // which can take up to press's own 300s waitForTransactionReceipt
  // timeout (see press/src/chain/registry.ts) if the RPC lags on receipt
  // propagation. Budget for that worst case rather than a fixed guess.
  timeout: 900_000,
  // One worker: smoke.spec and login.spec both make the press submit
  // transactions from its single signing account. Run in parallel, they
  // race on that account's nonce ("nonce too low" → HTTP 500). Same reason
  // suites/ sets fileParallelism: false.
  workers: 1,
  webServer: {
    // Serves static/ and proxies /proxy/<press|wallet-service|relay>/... to
    // the real services, same-origin — sidesteps those services' missing
    // CORS headers without touching their source (see serve.mjs's doc
    // comment for why).
    command: 'node serve.mjs',
    port: 8901,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:8901',
  },
});
