// Integration test harness: boots the REAL built node-server output
// (`.output/server/index.mjs`, produced by `npm run build:node`) as a
// child process and drives it over real HTTP — proving the portability
// claim from strategic-plan.md Goal 3 ("register/deliver/pending/ack/
// health handlers ... run unmodified under both presets") by actually
// running the node-server preset's build output, not by unit-testing
// handler functions in isolation with a fake H3Event.
//
// Requires `.output/server/index.mjs` to exist — run `npm run build:node`
// first (the Phase 2 report documents this as part of the test sequence).
// If it's missing, tests using this harness fail with a clear message
// rather than a confusing spawn error.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRespServer, type TestRespServerHandle } from '../utils/redis/test-resp-server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputEntry = path.resolve(__dirname, '../../.output/server/index.mjs');

export interface HttpServerHarness {
  baseUrl: string;
  redisServer: TestRespServerHandle;
  teardown(): Promise<void>;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      // Any response (even 503, since Redis/KV might not be ready on the
      // very first tick) means the HTTP server itself is up.
      if (res.status) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not become reachable within ${timeoutMs}ms: ${String(lastErr)}`);
}

export async function startHttpServerHarness(opts: {
  appRegistryFile: { apps: unknown[] };
}): Promise<HttpServerHarness> {
  if (!existsSync(outputEntry)) {
    throw new Error(
      `Missing ${outputEntry} — run "npm run build:node" before running integration tests that use startHttpServerHarness.`
    );
  }

  const redisServer = await startTestRespServer();
  const port = 20000 + Math.floor(Math.random() * 10000);
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'relay-integration-'));
  const kvDir = path.join(tmpRoot, 'device-registry');
  const appRegistryPath = path.join(tmpRoot, 'app-registry.json');
  // node-server reads APP_REGISTRY_PATH as a filesystem path
  // (app-registry.ts's loadAppRegistry) — unlike the cloudflare preset's
  // APP_REGISTRY_JSON inline-string path, since node-server genuinely has
  // a filesystem, matching v0.4's original semantics for this preset.
  writeFileSync(appRegistryPath, JSON.stringify(opts.appRegistryFile), 'utf-8');

  // The spawned child process runs the REAL production RedisClient
  // (resp-client.ts / transport.ts's connectNodeSocket), which enforces
  // standard TLS certificate validation (rejectUnauthorized defaults to
  // true) and correctly rejects test-resp-server.ts's self-signed cert
  // out of the box — confirmed by direct reproduction (self-signed
  // certificate / DEPTH_ZERO_SELF_SIGNED_CERT). Rather than weakening
  // transport.ts's production TLS handling (which must stay strict for a
  // real Redis Cloud deployment), extend the child's trust store via
  // Node's standard NODE_EXTRA_CA_CERTS mechanism — the same thing you'd
  // do to trust an internal/private CA in a real deployment, not a
  // validation bypass.
  const caCertPath = path.join(tmpRoot, 'test-redis-ca.pem');
  writeFileSync(caCertPath, redisServer.certPem, 'utf-8');

  const child: ChildProcess = spawn(
    process.execPath,
    [outputEntry],
    {
      // nitro.config.ts's node-server storage() mount for device_registry
      // is a relative fs-lite path (./.data/device-registry) — cwd-scoping
      // the child process is what actually isolates each test run's KV
      // data, since the mount path itself isn't independently
      // env-configurable without changing nitro.config.ts.
      cwd: tmpRoot,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        REDIS_PRIMARY_URL: `rediss://127.0.0.1:${redisServer.port}`,
        NODE_EXTRA_CA_CERTS: caCertPath,
        APP_REGISTRY_PATH: appRegistryPath,
        DEV_SCHEDULER_KV_DIR: kvDir,
        DISABLE_DEV_SCHEDULER: 'true', // integration tests trigger reconciliation explicitly, not on a timer
        RELAY_ID: 'test-relay',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, 10_000);
  } catch (err) {
    child.kill();
    throw new Error(`${String(err)}\nstderr:\n${stderrChunks.join('')}`);
  }

  return {
    baseUrl,
    redisServer,
    async teardown() {
      child.kill();
      await new Promise((r) => setTimeout(r, 50));
      await redisServer.close();
    },
  };
}
