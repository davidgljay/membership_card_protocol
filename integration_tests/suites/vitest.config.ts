import { defineConfig } from 'vitest/config';

/**
 * Vitest defaults to running test *files* in parallel worker threads. That's
 * fine for pure-unit suites, but every live-stack suite here ends up calling
 * press's on-chain `registerCard`/offer-issuance endpoints, all sharing a
 * single press gas wallet with its own nonce tracking — concurrent calls
 * from different files race into "nonce too low" tx failures, confirmed
 * empirically running the full suite together (each individual file passes
 * in isolation; `npm test` running all of them did not). Disabling file
 * parallelism makes `npm test` match what every suite already assumes
 * within a single file (sequential live-stack writes — see each spec's own
 * `beforeAll` doc comments).
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
