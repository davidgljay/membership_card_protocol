// App registry — relay_data_model.md §6, relay.md §5.
//
// SPEC GAP FLAGGED (not silently resolved — see Phase 2 report): §6's own
// text says "how it is loaded is a Phase 2 question this document does not
// resolve yet" and defers the Cloudflare-side sourcing mechanism (Workers
// Secrets vs KV vs build-time bundling) to this step. This is a genuine
// case of "Phase 2 requires a decision the updated spec doesn't already
// answer" per the task brief's explicit instruction to flag rather than
// silently decide. The implementation below makes a concrete choice —
// build-time bundled JSON asset, read via Nitro's server asset storage
// under `cloudflare`, plain filesystem read under `node-server` — because
// Phase 2 needs *something* working end-to-end to build and test the HTTP
// handlers against, but this choice has NOT been run past the user and
// should be treated as provisional pending spec amendment, not as
// silently-final.
//
// Why this specific choice: it needs no additional Cloudflare resource
// provisioning (no new KV namespace, no Workers Secrets setup) to get
// Phase 2's handlers working end-to-end, and "changes require a restart /
// redeploy" (§6.1's existing behavior under node-server) maps naturally
// onto "changes require a rebuild" for a bundled asset under Cloudflare —
// arguably the closest match to the current semantics of the three
// candidates. But it was not the only reasonable choice (KV would allow
// updating the registry without a redeploy, at the cost of another
// provisioned resource and the question of whether app registry entries —
// which are not UUIDs or credentials — are fine to store there; Workers
// Secrets would suit the APNs/FCM credential material specifically better
// than the whole-registry JSON blob). Flagged for explicit user sign-off.
//
// apns.key_file / fcm.service_account_file: same gap. This implementation
// resolves them as bundled asset paths (node-server) / server asset keys
// (cloudflare) alongside the registry JSON itself, not as arbitrary
// filesystem paths — real Apple/Google credential material for a live
// deployment would need to be wired through Workers Secrets in production,
// which is explicitly NOT implemented here (see server/utils/push/*.test.ts,
// which use synthetic test credentials, never live ones).

import type { H3Event } from 'h3';
import { getEnv } from './env';

export interface AppConfig {
  app_id: string;
  platform: 'apns' | 'fcm';
  wallet_base_url: string;
  apns?: {
    key_file: string;
    key_id: string;
    team_id: string;
    bundle_id: string;
    sandbox?: boolean;
  };
  fcm?: {
    service_account_file: string;
  };
}

export interface AppRegistryFile {
  apps: AppConfig[];
}

export class AppRegistryValidationError extends Error {}

export function validateAppRegistry(file: AppRegistryFile): void {
  const seenIds = new Set<string>();
  for (const app of file.apps) {
    if (seenIds.has(app.app_id)) {
      throw new AppRegistryValidationError(`Duplicate app_id: ${app.app_id}`);
    }
    seenIds.add(app.app_id);

    if (app.platform !== 'apns' && app.platform !== 'fcm') {
      throw new AppRegistryValidationError(
        `Invalid platform for ${app.app_id}: ${String(app.platform)}`
      );
    }
    if (!/^https:\/\//.test(app.wallet_base_url)) {
      throw new AppRegistryValidationError(
        `wallet_base_url must be https:// for ${app.app_id}`
      );
    }
    if (app.platform === 'apns') {
      if (app.fcm) {
        throw new AppRegistryValidationError(
          `${app.app_id}: platform is apns but fcm config present`
        );
      }
      if (!app.apns || !app.apns.key_id || !app.apns.team_id || !app.apns.bundle_id) {
        throw new AppRegistryValidationError(
          `${app.app_id}: missing required apns fields`
        );
      }
    }
    if (app.platform === 'fcm') {
      if (app.apns) {
        throw new AppRegistryValidationError(
          `${app.app_id}: platform is fcm but apns config present`
        );
      }
      if (!app.fcm || !app.fcm.service_account_file) {
        throw new AppRegistryValidationError(
          `${app.app_id}: missing required fcm fields`
        );
      }
    }
  }
}

export class AppRegistry {
  private appsById: Map<string, AppConfig>;

  constructor(file: AppRegistryFile) {
    validateAppRegistry(file);
    this.appsById = new Map(file.apps.map((a) => [a.app_id, a]));
  }

  get(appId: string): AppConfig | undefined {
    return this.appsById.get(appId);
  }

  has(appId: string): boolean {
    return this.appsById.has(appId);
  }
}

let cachedRegistry: AppRegistry | null = null;

/**
 * Loads the app registry. Under node-server, reads APP_REGISTRY_PATH from
 * the filesystem (unchanged from v0.4 semantics). Under cloudflare, expects
 * the registry to have been bundled at build time and injected via the
 * APP_REGISTRY_JSON environment variable/binding (a string containing the
 * full JSON) — see the module doc above for why this is a provisional
 * choice, not a spec-confirmed one.
 */
export async function loadAppRegistry(event: H3Event): Promise<AppRegistry> {
  if (cachedRegistry) return cachedRegistry;

  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  let raw: string;

  if (isNode) {
    const path = getEnv(event, 'APP_REGISTRY_PATH');
    if (!path) {
      throw new Error('APP_REGISTRY_PATH is required under node-server');
    }
    const fs = await import('node:fs/promises');
    raw = await fs.readFile(path, 'utf-8');
  } else {
    const inlined = getEnv(event, 'APP_REGISTRY_JSON');
    if (!inlined) {
      throw new Error(
        'APP_REGISTRY_JSON is required under the cloudflare preset (see server/utils/app-registry.ts module doc — this is a provisional Phase 2 choice pending spec amendment)'
      );
    }
    raw = inlined;
  }

  const parsed = JSON.parse(raw) as AppRegistryFile;
  cachedRegistry = new AppRegistry(parsed);
  return cachedRegistry;
}

/** Test-only: reset the module-level cache between test cases. */
export function _resetAppRegistryCacheForTests(): void {
  cachedRegistry = null;
}

/**
 * Loads the app registry synchronously from a raw env record's
 * APP_REGISTRY_JSON string, rather than an H3Event — used by the
 * scheduled-invocation path (server/plugins/scheduled.ts and
 * dev-scheduler.ts), which runs outside any single HTTP request and
 * therefore has no H3Event to read headers/bindings from, only the
 * trigger's raw `env` object. This intentionally does NOT support the
 * node-server APP_REGISTRY_PATH filesystem-read path (that would require
 * this to be async) — dev-scheduler.ts (node-server local dev) is expected
 * to also set APP_REGISTRY_JSON for parity with the Cloudflare path rather
 * than exercising a third loading mode. Same flagged spec gap as
 * loadAppRegistry — see this module's top-of-file doc.
 */
export function loadAppRegistryFromEnvRecord(
  env: Record<string, unknown>
): AppRegistry | null {
  const raw = env.APP_REGISTRY_JSON as string | undefined;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AppRegistryFile;
    return new AppRegistry(parsed);
  } catch {
    return null;
  }
}
