import { defineNitroConfig } from 'nitropack/config';

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
});
