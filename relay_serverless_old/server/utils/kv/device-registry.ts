// Device registry — relay_data_model.md §5. Cloudflare KV via Nitro's
// storage() abstraction under the `cloudflare` preset (binding `mcard_relay`,
// see PROVISIONING.md and nitro.config.ts), a filesystem/memory unstorage
// driver under `node-server` for local dev (no Redis/Cloudflare credentials
// needed for this store, per §5's portability note).
//
// Ported from `relay/src/utils/storage/sqlite.ts`'s schema/queries
// (reference codebase not present in this checkout — built directly
// against the spec). `pruneOldDevices` is explicitly NOT ported — KV's
// native per-key TTL replaces it entirely (relay_data_model.md §5.3: "No
// separate prune operation").
//
// PRIVACY INVARIANT (relay_data_model.md §10.4, §5.2): this store may ONLY
// ever contain `push_token` (as the key, prefixed), `app_id`,
// `last_registered_at`. Never a UUID, never a device_credential, never any
// value derived from either. Every write path in this file is typed to
// only accept DeviceRegistryEntry, which has no such fields — this is a
// structural guard, not just a documentation comment.

export interface DeviceRegistryEntry {
  app_id: string;
  last_registered_at: string;
}

// Minimal surface of Nitro's storage() this module needs — kept as an
// explicit interface (rather than importing unstorage's full Storage type)
// so this module's dependency on Nitro's runtime `useStorage()` global stays
// narrow and easy to fake in tests.
export interface KVStorage {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  getKeys(base?: string): Promise<string[]>;
  removeItem(key: string): Promise<void>;
}

export const DEFAULT_DEVICE_REGISTRY_RETENTION_DAYS = 90; // relay_data_model.md §9

function registryKey(pushToken: string): string {
  return `registry:${pushToken}`;
}

export class DeviceRegistry {
  constructor(
    private storage: KVStorage,
    private retentionDays: number = DEFAULT_DEVICE_REGISTRY_RETENTION_DAYS
  ) {}

  /** Upsert on registration (relay_data_model.md §5.3, relay.md §7.1 steps 5/5). */
  async upsert(pushToken: string, appId: string, nowIso: string): Promise<void> {
    const entry: DeviceRegistryEntry = {
      app_id: appId,
      last_registered_at: nowIso,
    };
    await this.storage.setItem(registryKey(pushToken), entry, {
      ttl: this.retentionDays * 86_400,
    });
  }

  /**
   * Query for re-registration (relay_data_model.md §5.3): returns every
   * currently-live entry. Anything expired per its TTL is already gone —
   * no cutoff-timestamp filtering needed. Pages through the full key set
   * via unstorage's getKeys(), consistent with the spec's note that
   * `storage()` callers should not assume a single call is exhaustive once
   * the registry grows past Cloudflare's 1000-keys-per-call limit —
   * unstorage's cloudflare-kv-binding driver handles that pagination
   * internally when getKeys() is awaited to completion, which this method
   * relies on rather than re-implementing cursor handling itself.
   */
  async listAll(): Promise<Array<{ push_token: string; entry: DeviceRegistryEntry }>> {
    const keys = await this.storage.getKeys('registry:');
    const results: Array<{ push_token: string; entry: DeviceRegistryEntry }> = [];
    for (const key of keys) {
      const value = (await this.storage.getItem(key)) as DeviceRegistryEntry | null;
      if (value) {
        results.push({ push_token: key.slice('registry:'.length), entry: value });
      }
    }
    return results;
  }

  async get(pushToken: string): Promise<DeviceRegistryEntry | null> {
    const value = (await this.storage.getItem(registryKey(pushToken))) as
      | DeviceRegistryEntry
      | null;
    return value ?? null;
  }

  // Deliberately no `pruneOldDevices` / `pruneExpired` method — KV's native
  // TTL (set via `upsert`'s `ttl` option above) is enforced by the platform
  // per-entry; there is nothing left for application code to do
  // (relay_data_model.md §5.3, §5.4). If you are looking for where the old
  // weekly pruning job went, this comment is that job's epitaph.
}
