import { defineNitroConfig } from 'nitropack/config';

// Runtime preset detection for the storage() mount below. NITRO_PRESET is
// the same env var package.json's build:cloudflare / build:node scripts set
// (see comment below); default matches this file's own `preset` field.
const isCloudflarePreset = (process.env.NITRO_PRESET ?? 'cloudflare-module').startsWith(
  'cloudflare'
);

export default defineNitroConfig({
  // Default deployment target is Cloudflare Workers using the *module*
  // worker format (`cloudflare-module`, Nitro's stdName `cloudflare_workers`),
  // not the legacy `cloudflare` / `cloudflare-worker` service-worker preset —
  // Durable Objects (`cloudflare-durable`, used by the Phase 1.2 DO+WS spike)
  // extend the module-worker preset, not the legacy one. Build against the
  // node-server preset via NITRO_PRESET=node-server (see package.json scripts
  // build:cloudflare / build:node) without changing application code — this
  // is the whole point of using Nitro (see
  // plans/relay-serverless-migration-strategic-plan.md Goal 3). The
  // DO-backed WebSocket/SSE connection layer itself is Cloudflare-specific
  // and is NOT part of this portability claim.
  preset: 'cloudflare-module',
  srcDir: 'server',
  compatibilityDate: '2026-07-02',
  routeRules: {},

  // Device registry storage mount (relay_data_model.md §5, Phase 2 step
  // 2.2). Under `cloudflare`/`cloudflare-module`: unstorage's
  // cloudflare-kv-binding driver, reading the `mcard_relay` binding
  // (PROVISIONING.md — binding name/namespace id already provisioned).
  // Under `node-server`: an unstorage `fs-lite` driver rooted at
  // `.data/device-registry` for local dev persistence across restarts, with
  // no Redis Cloud or Cloudflare credentials required for this store at all
  // (§5's stated portability benefit). Tests construct their own in-memory
  // `memory` driver directly rather than going through this mount — see
  // server/utils/kv/device-registry.test.ts.
  storage: isCloudflarePreset
    ? {
        device_registry: {
          driver: 'cloudflare-kv-binding',
          binding: 'mcard_relay',
        },
      }
    : {
        device_registry: {
          driver: 'fs-lite',
          base: './.data/device-registry',
        },
      },
});
