import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceRegistry, type DeviceRegistryEntry, type KVStorage } from './device-registry';

// In-memory KVStorage fake with real TTL semantics (setTimeout-free —
// checks wall-clock at read time), mirroring unstorage's `memory` driver
// closely enough for this module's own logic to be exercised faithfully.
// Nitro's actual storage() wiring (nitro.config.ts's device_registry
// mount) is exercised separately by the HTTP handler integration tests,
// not here — this test targets DeviceRegistry's own logic in isolation.
function createFakeKvStorage(): KVStorage & { _dump(): Record<string, unknown> } {
  const store = new Map<string, { value: unknown; expiresAt?: number }>();
  return {
    async getItem(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async setItem(key, value, opts) {
      store.set(key, {
        value,
        ...(opts?.ttl ? { expiresAt: Date.now() + opts.ttl * 1000 } : {}),
      });
    },
    async getKeys(base) {
      return [...store.keys()].filter((k) => !base || k.startsWith(base));
    },
    async removeItem(key) {
      store.delete(key);
    },
    _dump() {
      return Object.fromEntries(store);
    },
  };
}

describe('DeviceRegistry (relay_data_model.md §5)', () => {
  let kv: ReturnType<typeof createFakeKvStorage>;
  let registry: DeviceRegistry;

  beforeEach(() => {
    kv = createFakeKvStorage();
    registry = new DeviceRegistry(kv, 90);
  });

  it('upsert stores only push_token(as key)/app_id/last_registered_at — privacy invariant (relay_data_model.md §10.4, §5.2)', async () => {
    await registry.upsert('push-tok-1', 'app-1', '2026-07-02T00:00:00Z');
    const dump = kv._dump();
    const keys = Object.keys(dump);
    expect(keys).toEqual(['registry:push-tok-1']);
    const stored = dump['registry:push-tok-1'] as { value: DeviceRegistryEntry };
    expect(stored.value).toEqual({ app_id: 'app-1', last_registered_at: '2026-07-02T00:00:00Z' });
    // Explicitly assert no uuid/credential-shaped fields ever appear.
    expect(Object.keys(stored.value)).not.toContain('uuid');
    expect(Object.keys(stored.value)).not.toContain('device_credential');
  });

  it('sets a TTL of retentionDays * 86400 seconds', async () => {
    await registry.upsert('push-tok-2', 'app-1', '2026-07-02T00:00:00Z');
    const dump = kv._dump();
    const entry = dump['registry:push-tok-2'] as { expiresAt?: number };
    expect(entry.expiresAt).toBeDefined();
    const remainingSeconds = (entry.expiresAt! - Date.now()) / 1000;
    expect(remainingSeconds).toBeGreaterThan(90 * 86400 - 5);
    expect(remainingSeconds).toBeLessThanOrEqual(90 * 86400);
  });

  it('listAll returns every currently-live entry (re-registration query, relay_data_model.md §5.3)', async () => {
    await registry.upsert('tok-a', 'app-1', '2026-07-02T00:00:00Z');
    await registry.upsert('tok-b', 'app-2', '2026-07-02T00:01:00Z');

    const all = await registry.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.push_token).sort()).toEqual(['tok-a', 'tok-b']);
  });

  it('expired entries are excluded from listAll (TTL replaces pruneOldDevices — relay_data_model.md §5.3)', async () => {
    // ttl in seconds; use a very short one and simulate expiry directly.
    await kv.setItem('registry:expired-tok', { app_id: 'a', last_registered_at: 'x' }, { ttl: 0.001 });
    await new Promise((r) => setTimeout(r, 20));
    const all = await registry.listAll();
    expect(all.map((d) => d.push_token)).not.toContain('expired-tok');
  });

  it('get() returns null for an unregistered push token', async () => {
    expect(await registry.get('never-registered')).toBeNull();
  });

  it('re-upsert refreshes TTL from the new write (never expires while re-registering periodically)', async () => {
    await registry.upsert('tok-c', 'app-1', '2026-07-02T00:00:00Z');
    const firstExpiry = (kv._dump()['registry:tok-c'] as { expiresAt: number }).expiresAt;
    await new Promise((r) => setTimeout(r, 5));
    await registry.upsert('tok-c', 'app-1', '2026-07-02T00:00:05Z');
    const secondExpiry = (kv._dump()['registry:tok-c'] as { expiresAt: number }).expiresAt;
    expect(secondExpiry).toBeGreaterThan(firstExpiry);
  });
});
