// Minimal Worker entry used ONLY by wrangler.do-test.toml /
// vitest.workers.config.ts (@cloudflare/vitest-pool-workers). Not part of
// the real deployment (see server/cloudflare-entry.ts, which is the actual
// `main` under the real wrangler.toml).
//
// This file exists because @cloudflare/vitest-pool-workers requires a
// `main` module that names the Durable Object classes as exports (same
// Workers-platform requirement server/cloudflare-entry.ts's module doc
// describes) in order to construct the DO bindings declared in
// wrangler.do-test.toml. Re-exporting straight from server/do/*.ts means
// tests exercise the exact same DO class source that the real deployment
// uses — nothing about UuidConnection or DeviceChannel's behavior is
// duplicated or reimplemented here.
//
// The `fetch` export is a trivial passthrough (never expected to be hit
// directly by these tests, which talk to the DO stubs via
// `env.UUID_CONNECTION.get(...)` / `env.DEVICE_CHANNEL.get(...)` from
// `cloudflare:test`) — it exists only because Cloudflare's modules format
// requires *some* default export with a `fetch` handler alongside the
// named DO class exports.

export { UuidConnection } from './uuid-connection';
export { DeviceChannel } from './device-channel';

export default {
  async fetch(): Promise<Response> {
    return new Response('not found', { status: 404 });
  },
};
