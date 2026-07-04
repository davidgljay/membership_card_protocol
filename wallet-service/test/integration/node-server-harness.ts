// Integration test harness: boots the REAL built node-server output
// (`.output/server/index.mjs`, produced by `npm run build:node`) as a
// child process and drives it over real HTTP.
//
// This exists specifically to catch the class of bug where Nitro's
// rollup-based bundler flattens two coexisting copies of a transitive
// dependency (here, @noble/hashes, pulled in at different versions by
// @noble/post-quantum and by viem's dependency chain) into a single
// `.output/server/node_modules/<pkg>` copy that only satisfies one of the
// two consumers' import styles — producing a runtime
// ERR_PACKAGE_PATH_NOT_EXPORTED that `vitest run` never sees, because
// vitest resolves modules from source (each dependency's own isolated
// node_modules copy) rather than through Nitro's bundler.
//
// Unit tests and vitest's module resolution cannot catch this class of
// bug by construction; only actually running the bundled output does.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputEntry = path.resolve(__dirname, '../../.output/server/index.mjs');

export interface NodeServerHarness {
  baseUrl: string;
  teardown(): Promise<void>;
}

async function waitForServerUp(
  baseUrl: string,
  timeoutMs: number,
  getStderr: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      // Any response at all (even a 503/404) means the HTTP server itself
      // came up and Node didn't crash during module resolution/import —
      // which is exactly the failure mode this harness targets.
      const res = await fetch(`${baseUrl}/health`);
      if (res.status) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Server did not become reachable within ${timeoutMs}ms: ${String(lastErr)}\nstderr:\n${getStderr()}`
  );
}

/**
 * Spawns the real built node-server output as a child process using the
 * *current* process's env (so it picks up DATABASE_URL, ARBITRUM_RPC_URL,
 * etc. the same way the documented manual repro does), overriding only
 * PORT so parallel test runs don't collide, plus any additional env the
 * caller wants to inject/override.
 */
export async function startNodeServerHarness(opts?: {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<NodeServerHarness> {
  if (!existsSync(outputEntry)) {
    throw new Error(
      `Missing ${outputEntry} — run "npm run build:node" before running integration tests that use startNodeServerHarness.`
    );
  }

  const port = 20000 + Math.floor(Math.random() * 10000);

  const child: ChildProcess = spawn(
    process.execPath,
    [outputEntry],
    {
      env: {
        ...process.env,
        ...opts?.env,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString()));
  child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServerUp(baseUrl, opts?.timeoutMs ?? 10_000, () =>
      stderrChunks.join('') + stdoutChunks.join('')
    );
  } catch (err) {
    child.kill();
    throw err;
  }

  return {
    baseUrl,
    async teardown() {
      child.kill();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
