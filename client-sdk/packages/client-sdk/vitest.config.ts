import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        // Don't bundle @noble packages — use the actual ESM files from node_modules.
        // Bundling breaks @noble/post-quantum's internal use of globalThis.crypto.
        external: [/^@noble\//],
      },
    },
  },
});
