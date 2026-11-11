import { defineConfig } from 'vitest/config';

// Unit tests only; test/e2e/ is Playwright (npm run test:e2e).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/e2e/**', 'node_modules/**'] },
});
