import { defineNitroConfig } from 'nitropack';

export default defineNitroConfig({
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
