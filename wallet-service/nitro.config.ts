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
  // Nitro's scheduledTasks feature requires this to actually register
  // server/tasks/*.ts handlers — without it, tasks defined in the
  // scheduledTasks map below silently never run.
  experimental: {
    tasks: true,
  },
  // Scheduled sweep tasks (strategic-plan.md §Architectural Decision). The
  // 72-hour recovery window itself needs no sweep — expires_at is a
  // persisted DB column, checked lazily on GET /recovery/{id}/release
  // (Step 3.5) — only notification retries need a periodic sweep (Step
  // 3.3).
  scheduledTasks: {
    '*/5 * * * *': ['sweep-notification-retries'],
    '0 3 * * 0': ['prune-routing-nonces'], // weekly, Sunday 03:00 (Step 4.1)
    '0 4 * * *': ['prune-expired-uuids'], // nightly, 04:00 (Step 5.3)
    '0 * * * *': ['prune-subcard-uuid-registration-nonces'], // hourly (v0.9 subcard registration/deregistration replay window is 5 minutes)
  },
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
