// Vitest config for the Durable-Object-backed connection layer's tests
// (server/do/*.do-test.ts), run under the real Cloudflare Workers
// (workerd) runtime via @cloudflare/vitest-pool-workers + Miniflare —
// NOT under Node.js.
//
// WHY THIS IS A SEPARATE CONFIG FILE FROM vitest.config.ts:
// The rest of this project's tests (server/utils/redis/*.test.ts,
// server/utils/push/*.test.ts, etc.) are plain Node-runtime Vitest tests
// (vitest.config.ts, `environment: 'node'`) and must keep passing
// unmodified under `npx vitest run` / `npm test`. `@cloudflare/
// vitest-pool-workers` tests run inside workerd, a genuinely different JS
// runtime from Node (no unrestricted `node:*` module access, different
// globals, real WebSocket Hibernation semantics, etc.) — Vitest does not
// support mixing a `workerd`-pool project and a `node`-environment project
// inside a single `defineConfig`/`defineWorkersConfig` call in a way that
// keeps both fully independent and low-risk to the existing suite. Rather
// than restructure the whole project into a multi-project Vitest
// workspace (higher blast radius, and not required by the task at hand),
// this stays as its own top-level config file, invoked by its own npm
// script (`test:do`, see package.json) — `npm test` / `vitest run` (no
// `-c`/`--config` flag) picks up vitest.config.ts by Vitest's normal
// default-config-discovery rules and never loads this file at all, so the
// existing suite is unaffected by this file's mere existence.
//
// Scope: this config's `include` is deliberately narrowed to
// `server/do/**/*.do-test.ts` (a distinct suffix from the plain `*.test.ts`
// used everywhere else) so that running `vitest` with this config can
// never accidentally pick up and try to run the plain-Node tests inside
// workerd (where Node-only test harnesses like
// server/utils/redis/test-harness.ts would not work).
//
// wrangler config: points at wrangler.do-test.toml, a minimal test-scoped
// config (NOT the real relay-next/wrangler.toml) — see that file's header
// comment for why (real config depends on Nitro build output, a live KV
// namespace id, and a cron trigger, none of which make sense for a DO
// unit-test environment).
//
// isolatedStorage: false — REQUIRED, not a preference. This is a
// documented @cloudflare/vitest-pool-workers limitation, not a choice made
// for convenience: "Using WebSockets with Durable Objects is not supported
// with per-file storage isolation. To work around this, run your tests
// with shared storage using `--max-workers=1 --no-isolate`" (Cloudflare
// Workers docs, "Workers Vitest integration" > "Known issues" >
// "WebSockets", https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#websockets).
// Confirmed empirically here too: with isolated storage on (the default),
// every test in this suite that opens a real WebSocket into a DO crashes
// the whole worker isolate at end-of-test with "Failed to pop isolated
// storage stack frame ... unable to pop Durable Objects storage" —
// regardless of how carefully the test awaits the close handshake before
// finishing. Setting `isolatedStorage: false` (the `poolOptions.workers`
// equivalent of the CLI's `--no-isolate`) fixes this. `singleWorker: true`
// pairs with it (CLI's `--max-workers=1`), per the same doc note, so all
// test files in this project share one worker instance/storage rather
// than each getting an isolated snapshot — acceptable here because these
// tests use per-test-unique UUIDs/device_credentials (see each *.do-test.ts
// file's fixture values) specifically so cross-test storage leakage within
// a shared worker cannot cause false passes/failures.

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['server/do/**/*.do-test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.do-test.toml' },
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});
