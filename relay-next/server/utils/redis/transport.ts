// Minimal duplex-byte-stream transport abstraction so the RESP client
// (resp-client.ts) can run unmodified under both Nitro presets targeted by
// this migration (strategic-plan.md Goal 3):
//
//   - `cloudflare` / `cloudflare-module` preset: backed by the Workers
//     `connect()` TCP Sockets API (`cloudflare:sockets`), which exposes a
//     `ReadableStream`/`WritableStream` duplex, NOT Node's `net.Socket`.
//   - `node-server` preset: backed by Node's `net.connect` / `tls.connect`,
//     wrapped to present the same duplex-stream shape.
//
// Why not just use `unstorage`'s Redis driver or `ioredis` directly (as
// originally suggested by the implementation plan's step 2.1 "whichever
// proves more reliable")? Both are `ioredis`-based, and `ioredis` requires
// Node's `net` module, which does not exist in the Workers runtime — it is
// not merely "less reliable" under `cloudflare-module`, it does not run at
// all. That rules out "one driver for both presets" via `unstorage`/`ioredis`
// and leaves two real options: (a) two separate storage-layer
// implementations, one per preset (violates Goal 3 — the whole point of
// Nitro here is one codebase), or (b) one small transport abstraction with
// two backends and a single protocol-level (RESP) client on top, which is
// what this file + resp-client.ts implement. (b) is the smaller, more
// auditable surface — a RESP client is ~200 lines and needs no dependency
// tree, consistent with this project's stated thin-dependency preference
// (see decision #4 in the implementation plan, made for the same reason
// about the APNs client).
//
// TLS is mandatory (relay_data_model.md §9 `REDIS_PRIMARY_URL` is a
// `rediss://` connection string; PROVISIONING.md requires TLS enforced on
// the Redis Cloud database). Both backends below negotiate TLS.

export interface DuplexTransport {
  /** Write raw bytes to the socket. */
  write(data: Uint8Array): Promise<void>;
  /** Read the next available chunk of bytes (0 length = stream ended). */
  read(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface TransportConnectOptions {
  hostname: string;
  port: number;
  /** Reject the connection if TLS cannot be negotiated. Always true for this relay — see module doc. */
  tls: true;
}

export type TransportFactory = (
  opts: TransportConnectOptions
) => Promise<DuplexTransport>;

/**
 * Cloudflare Workers backend, using the `connect()` TCP Sockets API.
 * Only import/call this under the `cloudflare` preset — `cloudflare:sockets`
 * does not resolve under `node-server`. Callers select the backend via
 * `createRedisTransport` below, which branches on `process.env` presence
 * (Node) vs. absence (Workers) rather than importing both unconditionally,
 * so a `node-server` build never tries to resolve `cloudflare:sockets`.
 */
async function connectCloudflareSocket(
  opts: TransportConnectOptions
): Promise<DuplexTransport> {
  // Dynamic import so this module can be loaded (but not executed down this
  // path) under node-server without a bundler trying to resolve
  // `cloudflare:sockets` at build time.
  const { connect } = (await import('cloudflare:sockets')) as unknown as {
    connect: (
      address: string | { hostname: string; port: number },
      options?: { secureTransport?: 'on' | 'off' | 'starttls'; allowHalfOpen?: boolean }
    ) => {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      closed: Promise<void>;
      close: () => Promise<void>;
    };
  };

  const socket = connect(
    { hostname: opts.hostname, port: opts.port },
    { secureTransport: 'on', allowHalfOpen: false }
  );

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  return {
    async write(data) {
      await writer.write(data);
    },
    async read() {
      const { value, done } = await reader.read();
      if (done) return null;
      return value ?? null;
    },
    async close() {
      try {
        await writer.close();
      } catch {
        // socket may already be closing
      }
      await socket.close();
    },
  };
}

/**
 * Node backend (`node-server` preset and local/dev/test usage), using
 * `node:tls` directly (TLS is mandatory — see module doc), wrapped to
 * present the same read/write/close duplex shape as the Cloudflare backend.
 */
async function connectNodeSocket(
  opts: TransportConnectOptions
): Promise<DuplexTransport> {
  const tls = await import('node:tls');

  return await new Promise<DuplexTransport>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: opts.hostname,
        port: opts.port,
        // Redis Cloud presents a standard publicly-trusted certificate;
        // no custom CA handling needed. Left explicit (default) rather
        // than setting rejectUnauthorized: false, which would silently
        // defeat the point of requiring TLS at all.
      },
      () => resolve(makeNodeDuplex(socket))
    );
    socket.once('error', reject);
  });
}

function makeNodeDuplex(socket: import('node:tls').TLSSocket): DuplexTransport {
  const chunks: Uint8Array[] = [];
  const waiters: Array<(v: Uint8Array | null) => void> = [];
  let ended = false;

  socket.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(bytes);
    } else {
      chunks.push(bytes);
    }
  });
  socket.on('end', () => {
    ended = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.(null);
    }
  });
  socket.on('close', () => {
    ended = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.(null);
    }
  });

  return {
    async write(data) {
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
      });
    },
    async read() {
      if (chunks.length > 0) {
        return chunks.shift() ?? null;
      }
      if (ended) return null;
      return await new Promise<Uint8Array | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    async close() {
      socket.end();
      socket.destroy();
    },
  };
}

/**
 * Selects the correct transport backend for the current runtime.
 *
 * Detection: Cloudflare Workers has no `process.versions.node`; Node.js
 * (both the `node-server` preset and this project's own test runner,
 * vitest under Node) does. This mirrors how Nitro itself detects runtime
 * targets and avoids needing a build-time flag threaded through every
 * caller.
 */
export const createRedisTransport: TransportFactory = async (opts) => {
  const isNode =
    typeof process !== 'undefined' && !!process.versions?.node;
  return isNode ? connectNodeSocket(opts) : connectCloudflareSocket(opts);
};
