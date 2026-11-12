import { defineConfig, devices } from '@playwright/test';

// login_router.md §10: every acceptance test runs in Chromium, Firefox, and WebKit.
export default defineConfig({
  testDir: './test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:8911' },
  webServer: {
    command: 'node scripts/serve.mjs',
    port: 8911,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
