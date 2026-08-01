import { defineNitroConfig } from 'nitropack';

// Cloudflare Workers' nodejs_compat layer can't run ioredis: its wire-
// protocol parser instantiates node:string_decoder's StringDecoder
// unconditionally at module-load time, and unenv only ships a
// non-functional mock of it (throws on real use) — the Worker crashes
// before serving a single request. Confirmed against the actual bundled
// output, not just docs; not fixable via compatibility_date/flags. So the
// `redis` driver (EXTERNAL_KV_URL, ioredis-backed) only works on the
// node-server/aws-lambda presets; the default cloudflare-module preset
// uses a native KV binding instead — the same fix wallet-service's
// nitro.config.ts already applies for the identical reason.
const preset = process.env['NITRO_PRESET'] ?? 'cloudflare-module';

export default defineNitroConfig({
  // Default deployment target is Cloudflare Workers. Operators may build
  // against an alternate preset via NITRO_PRESET (see package.json scripts
  // build:lambda / build:node) without changing application code.
  preset: 'cloudflare-module',
  // Without this, Nitro falls back to compatibilityDate 2024-04-03, which
  // is before the modern cloudflare-module preset's required 2024-09-19 —
  // silently selecting the legacy Workers Sites preset instead (breaks
  // with "No such module __STATIC_CONTENT_MANIFEST" since wrangler.toml
  // has no [site] bucket). Matches wallet-service/nitro.config.ts's fix
  // for the same issue.
  compatibilityDate: '2026-06-29',
  srcDir: 'server',
  routeRules: {},
  scheduledTasks: {
    '0 */6 * * *': ['reconcile-cids'],
  },
  storage: {
    press:
      preset === 'cloudflare-module'
        ? { driver: 'cloudflare-kv-binding', binding: 'PRESS_KV' }
        : { driver: 'redis', url: process.env['EXTERNAL_KV_URL'] ?? '' },
  },
});
