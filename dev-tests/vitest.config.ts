import { defineConfig } from 'vitest/config';

// Same reasoning as integration_tests/suites/vitest.config.ts: every
// live-minting suite shares a single press gas wallet with its own nonce
// tracking, so concurrent writes from different files race into "nonce too
// low" tx failures. Disabling file parallelism keeps that assumption true
// here too -- doubly important against a real dev Sepolia deployment, where
// there's no way to reset state between runs the way a local devnode volume
// reset would.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
