// Regression test for the @noble/hashes double-resolution bug: Nitro's
// node-server build previously flattened two coexisting copies of
// @noble/hashes (pulled in at 2.0.1 by @noble/post-quantum and at 1.8.0 by
// viem's dependency chain) into a single `.output/server/node_modules`
// copy that satisfied only one consumer's import style, causing every
// route that touched both dependency chains in the same bundled chunk
// (e.g. POST /accounts/challenge, which uses viem/ox's keccak256 and
// touches @noble/post-quantum's ml_dsa44 via shared auth code) to crash at
// import time with ERR_PACKAGE_PATH_NOT_EXPORTED.
//
// `vitest run` never catches this because vitest resolves each package
// from its own isolated node_modules copy (source resolution), never
// through Nitro's rollup bundler. This test is the only thing in the
// suite that actually runs `.output/server/index.mjs` — the real
// bundled artifact — over real HTTP, so it would have caught this bug.
//
// Requires `npm run build:node` to have been run first, and a reachable
// Postgres at DATABASE_URL (same as the rest of the suite) plus the other
// env vars documented in .env.example. Skips itself with a clear message
// if the build output is missing, rather than failing confusingly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNodeServerHarness, type NodeServerHarness } from './node-server-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputEntry = path.resolve(__dirname, '../../.output/server/index.mjs');
const hasBuildOutput = existsSync(outputEntry);

describe.runIf(hasBuildOutput)('bundled node-server smoke test', () => {
  let harness: NodeServerHarness;

  beforeAll(async () => {
    harness = await startNodeServerHarness();
  }, 20_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  it('POST /accounts/challenge does not crash with ERR_PACKAGE_PATH_NOT_EXPORTED', async () => {
    const res = await fetch(`${harness.baseUrl}/accounts/challenge`, { method: 'POST' });
    const body = await res.text();

    expect(body).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(res.status).toBeLessThan(500);

    const parsed = JSON.parse(body);
    expect(typeof parsed.challenge).toBe('string');
    expect(typeof parsed.expires_at).toBe('string');
  });

  it('GET /health does not crash with ERR_PACKAGE_PATH_NOT_EXPORTED', async () => {
    const res = await fetch(`${harness.baseUrl}/health`);
    const body = await res.text();

    expect(body).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(res.status).toBeLessThan(500);
  });
});

if (!hasBuildOutput) {
  describe('bundled node-server smoke test', () => {
    it.skip(`skipped: run "npm run build:node" first (missing ${outputEntry})`, () => {});
  });
}
