// Minimal RESP2 (Redis Serialization Protocol) client, sufficient for the
// commands the relay's storage layer needs (HSET/HGET/HGETALL/EXPIRE/TTL/
// DEL, RPUSH, ZADD/ZRANGEBYSCORE/ZREMRANGEBYSCORE, EVAL, PING). Built on the
// DuplexTransport abstraction (transport.ts) so it runs unmodified under
// both the `cloudflare` and `node-server` Nitro presets — see that file's
// module doc for why `ioredis`/`unstorage`'s Redis driver could not be used
// directly (relay_data_model.md §1's portability requirement, strategic-plan
// Goal 3).
//
// Deliberately NOT a general-purpose Redis client: no pipelining beyond a
// single in-flight command, no cluster support, no RESP3. The relay's access
// pattern (per-request, short-lived logical operations) does not need those,
// and every added feature is more surface to audit given this store holds
// privacy-critical UUID/credential associations (relay_data_model.md §10.4).

import {
  createRedisTransport,
  type DuplexTransport,
  type TransportFactory,
} from './transport';

export type RespValue =
  | string // simple string or bulk string
  | number // integer
  | null // nil bulk string / nil array
  | RespValue[] // array
  | RespError;

export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespError';
  }
}

export interface RedisClientOptions {
  /** `rediss://user:password@host:port` or `redis://...` (non-TLS rejected — see below). */
  url: string;
  transportFactory?: TransportFactory;
}

function parseRedisUrl(url: string): {
  hostname: string;
  port: number;
  password?: string;
  username?: string;
  tls: boolean;
} {
  const parsed = new URL(url);
  if (parsed.protocol !== 'rediss:' && parsed.protocol !== 'redis:') {
    throw new Error(`Unsupported Redis URL scheme: ${parsed.protocol}`);
  }
  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    tls: parsed.protocol === 'rediss:',
  };
}

/** Encodes a command as a RESP2 array of bulk strings. */
function encodeCommand(args: Array<string | number>): Uint8Array {
  const parts: string[] = [`*${args.length}\r\n`];
  for (const arg of args) {
    const str = String(arg);
    const byteLen = new TextEncoder().encode(str).length;
    parts.push(`$${byteLen}\r\n${str}\r\n`);
  }
  return new TextEncoder().encode(parts.join(''));
}

class ByteReader {
  private buf = new Uint8Array(0);
  constructor(private transport: DuplexTransport) {}

  private async fill(): Promise<boolean> {
    const chunk = await this.transport.read();
    if (chunk === null) return false;
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    return true;
  }

  /** Reads one CRLF-terminated line, consuming it (without the CRLF). */
  async readLine(): Promise<string> {
    for (;;) {
      const idx = indexOfCrlf(this.buf);
      if (idx >= 0) {
        const line = new TextDecoder().decode(this.buf.subarray(0, idx));
        this.buf = this.buf.subarray(idx + 2);
        return line;
      }
      const more = await this.fill();
      if (!more) throw new Error('Redis connection closed while reading line');
    }
  }

  /** Reads exactly n bytes plus the trailing CRLF, returning the n bytes. */
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n + 2) {
      const more = await this.fill();
      if (!more) throw new Error('Redis connection closed while reading bytes');
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n + 2);
    return out;
  }
}

function indexOfCrlf(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

async function readReply(reader: ByteReader): Promise<RespValue> {
  const line = await reader.readLine();
  const type = line[0];
  const rest = line.slice(1);

  switch (type) {
    case '+': // simple string
      return rest;
    case '-': // error
      return new RespError(rest);
    case ':': // integer
      return Number(rest);
    case '$': {
      // bulk string
      const len = Number(rest);
      if (len === -1) return null;
      const bytes = await reader.readBytes(len);
      return new TextDecoder().decode(bytes);
    }
    case '*': {
      // array
      const len = Number(rest);
      if (len === -1) return null;
      const out: RespValue[] = [];
      for (let i = 0; i < len; i++) {
        out.push(await readReply(reader));
      }
      return out;
    }
    default:
      throw new Error(`Unexpected RESP reply type: ${JSON.stringify(line)}`);
  }
}

export class RedisClient {
  private transport: DuplexTransport | null = null;
  private reader: ByteReader | null = null;
  private connecting: Promise<void> | null = null;
  private readonly hostname: string;
  private readonly port: number;
  private readonly password?: string;
  private readonly username?: string;
  private readonly transportFactory: TransportFactory;

  constructor(opts: RedisClientOptions) {
    const parsed = parseRedisUrl(opts.url);
    if (!parsed.tls) {
      throw new Error(
        'RedisClient requires a rediss:// (TLS) URL — plaintext redis:// connections are rejected. ' +
          'See relay_data_model.md §9 (REDIS_PRIMARY_URL) and PROVISIONING.md §2 (TLS enforced).'
      );
    }
    this.hostname = parsed.hostname;
    this.port = parsed.port;
    if (parsed.password !== undefined) this.password = parsed.password;
    if (parsed.username !== undefined) this.username = parsed.username;
    this.transportFactory = opts.transportFactory ?? createRedisTransport;
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = await this.transportFactory({
        hostname: this.hostname,
        port: this.port,
        tls: true,
      });
      this.transport = transport;
      this.reader = new ByteReader(transport);
      if (this.password) {
        if (this.username) {
          await this.sendCommand(['AUTH', this.username, this.password]);
        } else {
          await this.sendCommand(['AUTH', this.password]);
        }
      }
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async sendCommand(args: Array<string | number>): Promise<RespValue> {
    if (!this.transport || !this.reader) {
      throw new Error('RedisClient not connected');
    }
    await this.transport.write(encodeCommand(args));
    const reply = await readReply(this.reader);
    if (reply instanceof RespError) {
      throw reply;
    }
    return reply;
  }

  async command(args: Array<string | number>): Promise<RespValue> {
    await this.ensureConnected();
    return this.sendCommand(args);
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.reader = null;
    }
  }

  // --- convenience wrappers used by the storage layer ---

  async ping(): Promise<boolean> {
    const res = await this.command(['PING']);
    return res === 'PONG';
  }

  async hset(key: string, fields: Record<string, string | number>): Promise<void> {
    const args: Array<string | number> = ['HSET', key];
    for (const [f, v] of Object.entries(fields)) {
      args.push(f, v);
    }
    await this.command(args);
  }

  async hget(key: string, field: string): Promise<string | null> {
    const res = await this.command(['HGET', key, field]);
    return res as string | null;
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const res = (await this.command(['HGETALL', key])) as RespValue[];
    if (!res || res.length === 0) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < res.length; i += 2) {
      out[res[i] as string] = res[i + 1] as string;
    }
    return out;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.command(['EXPIRE', key, seconds]);
  }

  async ttl(key: string): Promise<number> {
    const res = await this.command(['TTL', key]);
    return res as number;
  }

  async del(...keys: string[]): Promise<number> {
    const res = await this.command(['DEL', ...keys]);
    return res as number;
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.command(['EXISTS', key]);
    return (res as number) > 0;
  }

  async rpush(key: string, value: string): Promise<void> {
    await this.command(['RPUSH', key, value]);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.command(['ZADD', key, score, member]);
  }

  async scan(
    cursor: string,
    matchPattern: string,
    count: number
  ): Promise<{ cursor: string; keys: string[] }> {
    const res = (await this.command([
      'SCAN',
      cursor,
      'MATCH',
      matchPattern,
      'COUNT',
      count,
    ])) as RespValue[];
    const [newCursor, keys] = res;
    return {
      cursor: newCursor as string,
      keys: (keys as RespValue[]).map((k) => k as string),
    };
  }

  /** Runs a Lua script via EVAL. `keys` and `args` are stringified positionally. */
  async eval(
    script: string,
    keys: string[],
    args: Array<string | number>
  ): Promise<RespValue> {
    return this.command(['EVAL', script, keys.length, ...keys, ...args]);
  }
}
