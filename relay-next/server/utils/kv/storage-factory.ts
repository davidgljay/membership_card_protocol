// Resolves the device-registry KV storage() mount (nitro.config.ts's
// `device_registry` mount point — cloudflare-kv-binding under `cloudflare`,
// fs-lite under `node-server`) into the narrow KVStorage interface
// device-registry.ts depends on.

import type { H3Event } from 'h3';
import { useStorage } from '#imports';
import type { StorageValue } from 'unstorage';
import type { KVStorage } from './device-registry';

export function getDeviceRegistryStorage(_event: H3Event): KVStorage {
  // useStorage() is Nitro's runtime global (auto-imported via #imports),
  // resolving the `device_registry:` mount configured in nitro.config.ts.
  // It works identically across both presets — Nitro resolves the
  // Cloudflare KV binding transparently via the per-request env for the
  // cloudflare-module preset.
  const storage = useStorage('device_registry');
  return {
    getItem: (key) => storage.getItem(key),
    // unstorage's setItem is typed against its own StorageValue union, not
    // `unknown` — KVStorage's interface (device-registry.ts) intentionally
    // stays narrow/unstorage-agnostic, so the cast happens at this one
    // adapter boundary rather than loosening KVStorage's own contract.
    setItem: (key, value, opts) => storage.setItem(key, value as StorageValue, opts),
    getKeys: (base) => storage.getKeys(base),
    removeItem: (key) => storage.removeItem(key),
  };
}
