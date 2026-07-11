// Wires the Cloudflare Cron Trigger to the portable delete-queue +
// reconciliation job (server/utils/delete-queue-job.ts) via Nitro's own
// `cloudflare:scheduled` hook (nitropack's cloudflare-module preset's
// generated Worker entry calls this hook from its `scheduled()` export —
// see node_modules/nitropack/dist/presets/cloudflare/runtime/
// _module-handler.mjs). This is the in-framework Nitro extension point for
// this trigger, so no hand-rolled Worker-entry code is needed for the
// scheduled path specifically (contrast with the DO-backed /ws/{uuid}
// routing, which genuinely does need a hand-rolled entry — see
// server/cloudflare-entry.ts — because Nitro's generated entry has no
// per-request Durable Object instance resolution, the same limitation the
// Phase 1 spike found).
//
// Under node-server, this hook never fires (there is no Cloudflare Cron
// Trigger under Node) — server/plugins/dev-scheduler.ts covers local dev
// via a plain interval instead. Both call the same portable
// runScheduledInvocation from delete-queue-job.ts, satisfying decision #3
// ("business logic stays portable, the trigger is platform-native").

import { defineNitroPlugin } from 'nitropack/runtime';
import { RedisClient } from '../utils/redis/resp-client';
import { runScheduledInvocation } from '../utils/delete-queue-job';
import type { KVStorage } from '../utils/kv/device-registry';
import { dispatchReregistrationPush } from '../utils/reregistration';

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async ({ env }) => {
    const cfEnv = env as Record<string, string> & {
      mcard_relay?: KVStorage;
    };
    const redisUrl = cfEnv.REDIS_PRIMARY_URL;
    if (!redisUrl) {
      console.error('[scheduled] REDIS_PRIMARY_URL not configured; skipping run');
      return;
    }
    const redis = new RedisClient({ url: redisUrl });
    try {
      // useStorage('device_registry') is unavailable outside a request
      // event in this hook context, so this constructs a KV accessor
      // directly from the raw binding — same binding name as
      // nitro.config.ts's storage() mount, kept consistent deliberately.
      const kvBinding = cfEnv.mcard_relay as unknown as {
        get(key: string): Promise<string | null>;
        put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
        list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }>;
        delete(key: string): Promise<void>;
      };
      const kv: KVStorage = {
        async getItem(key) {
          const raw = await kvBinding.get(key);
          return raw ? JSON.parse(raw) : null;
        },
        async setItem(key, value, opts) {
          await kvBinding.put(
            key,
            JSON.stringify(value),
            opts?.ttl !== undefined ? { expirationTtl: opts.ttl } : {}
          );
        },
        async getKeys(base) {
          const result = await kvBinding.list(base !== undefined ? { prefix: base } : {});
          return result.keys.map((k) => k.name);
        },
        async removeItem(key) {
          await kvBinding.delete(key);
        },
      };

      await runScheduledInvocation(redis, kv, async () => {
        await dispatchReregistrationPush(kv, cfEnv);
      });
    } finally {
      await redis.close();
    }
  });
});
