import { defineNitroConfig } from 'nitropack';

// The host runs on the operator's enclave-capable EC2 parent instance, so the node-server preset is the default
// (Docker Compose, notary/deploy). Durable host state lives in Redis through the `redis` storage driver
// (EXTERNAL_KV_URL), as in the press (press/nitro.config.ts).
export default defineNitroConfig({
  preset: 'node-server',
  compatibilityDate: '2026-06-29',
  srcDir: 'server',
  // The dependency tree needs two major versions of @noble/hashes (the verifier uses 1.x, @noble/post-quantum 0.5 uses 2.x).
  // Tracing externals flattens them to one version and breaks the other at runtime; bundling resolves each import per importer.
  noExternals: true,
  routeRules: {},
  // Storage `notary` is mounted at startup (server/plugins/startup.ts) from EXTERNAL_KV_URL, read at run time:
  // a `storage` entry here would bake the build machine's URL into the image.
});
