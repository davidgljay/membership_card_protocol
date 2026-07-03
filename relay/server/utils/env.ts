// Environment/config accessors — relay_data_model.md §9.
//
// Under `node-server`, these read `process.env` directly. Under
// `cloudflare`/`cloudflare-module`, Nitro's H3 event carries Cloudflare's
// per-request `env` (bindings + vars) rather than a process-wide
// `process.env` — so every accessor here takes the H3 event and falls back
// to `process.env` only when running under node-server (mirroring
// transport.ts's runtime-detection approach). This keeps call sites
// preset-agnostic: `getEnv(event, 'REDIS_PRIMARY_URL')` works the same way
// regardless of which preset is currently running.

import type { H3Event } from 'h3';

function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

/** Cloudflare's per-request env, when running under a Cloudflare preset. */
function cloudflareEnv(event: H3Event): Record<string, unknown> | undefined {
  // Nitro's cloudflare-module preset attaches the Workers `env` object to
  // event.context.cloudflare.env — see Nitro's cloudflare preset runtime.
  const ctx = event.context as unknown as {
    cloudflare?: { env?: Record<string, unknown> };
  };
  return ctx.cloudflare?.env;
}

export function getEnv(event: H3Event, key: string): string | undefined {
  if (isNodeRuntime()) {
    // Under node-server (including local dev/test), env vars are the
    // portable source of truth — no Cloudflare bindings exist.
    const fromProcess = process.env[key];
    if (fromProcess !== undefined) return fromProcess;
  }
  const cfEnv = cloudflareEnv(event);
  const value = cfEnv?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function requireEnv(event: H3Event, key: string): string {
  const value = getEnv(event, key);
  if (!value) {
    throw new Error(`Missing required environment variable/binding: ${key}`);
  }
  return value;
}

export function getEnvInt(event: H3Event, key: string, defaultValue: number): number {
  const value = getEnv(event, key);
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
