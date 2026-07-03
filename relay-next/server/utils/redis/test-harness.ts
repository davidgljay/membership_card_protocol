// Test-only helper: constructs a real RedisClient (resp-client.ts) wired
// to talk to test-resp-server.ts over real TLS, with certificate
// validation relaxed for the self-signed test cert (production code in
// transport.ts's connectNodeSocket does NOT relax this — see that file).
// This is the one place in the test suite that intentionally bypasses
// cert validation, and it does so via a custom transportFactory injected
// into RedisClient's constructor (resp-client.ts's RedisClientOptions),
// not by modifying production code.

import * as tls from 'node:tls';
import { RedisClient } from './resp-client';
import type { DuplexTransport, TransportConnectOptions } from './transport';
import { startTestRespServer, type TestRespServerHandle } from './test-resp-server';

function makeNodeDuplexRelaxed(socket: tls.TLSSocket): DuplexTransport {
  const chunks: Uint8Array[] = [];
  const waiters: Array<(v: Uint8Array | null) => void> = [];
  let ended = false;

  socket.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else chunks.push(bytes);
  });
  socket.on('end', () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()?.(null);
  });
  socket.on('close', () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()?.(null);
  });

  return {
    async write(data) {
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
      });
    },
    async read() {
      if (chunks.length > 0) return chunks.shift() ?? null;
      if (ended) return null;
      return await new Promise<Uint8Array | null>((resolve) => waiters.push(resolve));
    },
    async close() {
      socket.end();
      socket.destroy();
    },
  };
}

export interface TestRedisHarness {
  client: RedisClient;
  server: TestRespServerHandle;
  teardown(): Promise<void>;
}

export async function createTestRedisHarness(): Promise<TestRedisHarness> {
  const server = await startTestRespServer();

  const client = new RedisClient({
    url: `rediss://127.0.0.1:${server.port}`,
    transportFactory: async (opts: TransportConnectOptions) => {
      return await new Promise<DuplexTransport>((resolve, reject) => {
        const socket = tls.connect(
          {
            host: opts.hostname,
            port: opts.port,
            rejectUnauthorized: false, // self-signed test cert only — see module doc
          },
          () => resolve(makeNodeDuplexRelaxed(socket))
        );
        socket.once('error', reject);
      });
    },
  });

  return {
    client,
    server,
    async teardown() {
      await client.close();
      await server.close();
    },
  };
}
