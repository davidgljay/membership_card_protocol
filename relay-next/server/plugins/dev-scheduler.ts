// node-server local-dev trigger for the delete-queue + reconciliation job
// (server/utils/delete-queue-job.ts) — the Node-preset counterpart to
// server/plugins/scheduled.ts's Cloudflare Cron Trigger wiring (decision
// #3: same portable business logic, platform-native trigger). Runs on a
// plain `setInterval`, gated so it never activates under the cloudflare
// preset (where server/plugins/scheduled.ts's hook is the real trigger —
// running both would double-process the queue).
//
// Interval defaults to RECONCILIATION_CRON_SCHEDULE's *5-minute-equivalent*
// for parity with the Cron Trigger default (relay_data_model.md §9) via
// DEV_SCHEDULER_INTERVAL_MS, not by parsing the cron expression itself —
// this dev-only trigger does not need general cron-syntax support, just a
// fixed interval a developer can override for faster local iteration.

import { defineNitroPlugin } from 'nitropack/runtime';
import { RedisClient } from '../utils/redis/resp-client';
import { runScheduledInvocation } from '../utils/delete-queue-job';
import { dispatchReregistrationPush } from '../utils/reregistration';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KVStorage } from '../utils/kv/device-registry';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Minimal fs-backed KVStorage matching nitro.config.ts's fs-lite device_registry mount shape closely enough for this dev-only trigger's needs. */
function createFsKvStorage(baseDir: string): KVStorage {
  function keyToPath(key: string): string {
    return path.join(baseDir, key.replace(/[:/]/g, '_') + '.json');
  }
  return {
    async getItem(key) {
      try {
        const raw = await fs.readFile(keyToPath(key), 'utf-8');
        const parsed = JSON.parse(raw) as { value: unknown; expiresAt?: number };
        if (parsed.expiresAt && Date.now() > parsed.expiresAt) return null;
        return parsed.value;
      } catch {
        return null;
      }
    },
    async setItem(key, value, opts) {
      await fs.mkdir(baseDir, { recursive: true });
      const expiresAt = opts?.ttl ? Date.now() + opts.ttl * 1000 : undefined;
      await fs.writeFile(keyToPath(key), JSON.stringify({ value, expiresAt }), 'utf-8');
    },
    async getKeys(base) {
      try {
        const files = await fs.readdir(baseDir);
        return files
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, '').replace(/_/g, ':'))
          .filter((k) => !base || k.startsWith(base));
      } catch {
        return [];
      }
    },
    async removeItem(key) {
      await fs.rm(keyToPath(key), { force: true });
    },
  };
}

export default defineNitroPlugin((nitroApp) => {
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (!isNode) return;
  if (process.env.DISABLE_DEV_SCHEDULER === 'true') return;
  const redisUrl = process.env.REDIS_PRIMARY_URL;
  if (!redisUrl) {
    // Nothing to schedule against in local dev without a Redis URL
    // configured — silently skip rather than crash the dev server on boot.
    return;
  }

  const intervalMs = Number.parseInt(
    process.env.DEV_SCHEDULER_INTERVAL_MS ?? '',
    10
  ) || DEFAULT_INTERVAL_MS;

  const kv = createFsKvStorage(
    process.env.DEV_SCHEDULER_KV_DIR ?? './.data/device-registry'
  );

  const timer = setInterval(async () => {
    const redis = new RedisClient({ url: redisUrl });
    try {
      await runScheduledInvocation(redis, kv, async () => {
        await dispatchReregistrationPush(kv, process.env as Record<string, unknown>);
      });
    } catch (err) {
      console.error('[dev-scheduler] run failed', err);
    } finally {
      await redis.close();
    }
  }, intervalMs);
  timer.unref?.();

  nitroApp.hooks.hook('close', () => {
    clearInterval(timer);
  });
});
