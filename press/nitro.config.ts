import { defineNitroConfig } from 'nitropack';

export default defineNitroConfig({
  // Default deployment target is Cloudflare Workers. Operators may build
  // against an alternate preset via NITRO_PRESET (see package.json scripts
  // build:lambda / build:node) without changing application code.
  preset: 'cloudflare-module',
  srcDir: 'server',
  routeRules: {},
  scheduledTasks: {
    '0 */6 * * *': ['reconcile-cids'],
  },
  storage: {
    press: {
      driver: 'redis',
      url: process.env['EXTERNAL_KV_URL'] ?? '',
    },
  },
});
