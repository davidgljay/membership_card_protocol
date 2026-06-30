import { defineNitroConfig } from 'nitropack';

export default defineNitroConfig({
  // Default deployment target is Cloudflare Workers. Operators may build
  // against an alternate preset via NITRO_PRESET (see package.json scripts
  // build:lambda / build:node) without changing application code.
  preset: 'cloudflare-module',
  compatibilityDate: '2026-06-29',
  srcDir: 'server',
  cloudflare: {
    // pg (node-postgres) and node:crypto need real Node builtins, not
    // unenv polyfills. Requires compatibility_flags = ["nodejs_compat"] in
    // wrangler.toml (set there) plus Hyperdrive or a TCP-capable Postgres
    // endpoint at deploy time.
    nodeCompat: true,
  },
  alias: {
    // pg's native bindings are an optional dependency we never install;
    // pg/lib/native/index.js requires() it behind a runtime check that
    // never fires in this deployment, but the bundler's static analysis
    // still needs something resolvable here.
    'pg-native': 'unenv/mock/empty',
  },
  routeRules: {},
  // Scheduled sweep tasks (72-hour recovery window expiry, UUID pool and
  // routing-nonce pruning — strategic-plan.md §Architectural Decision) are
  // registered here once their server/tasks/*.ts handlers land in Phase 3+.
  // No precise in-process timer is needed for the 72h window — expires_at
  // is a persisted DB column, swept periodically.
  scheduledTasks: {},
  storage: {
    // Session tokens, rate-limit counters. Defaults to KV on the Cloudflare
    // preset; falls back to a Postgres-backed driver on node-server/aws-lambda
    // (see server/utils/kv.ts). No standalone Redis dependency.
    wallet: {
      driver: 'cloudflare-kv-binding',
      binding: 'WALLET_KV',
    },
  },
});
