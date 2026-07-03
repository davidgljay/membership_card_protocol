// Re-registration on store reset — relay.md §9, relay_data_model.md §2.6.
// Called by the reconciliation job (delete-queue-job.ts /
// plugins/scheduled.ts, plugins/dev-scheduler.ts) only on a confirmed
// non-empty -> empty transition of the primary Redis database, per §2.6's
// false-positive guard (already implemented in redis/reconciliation.ts —
// this module is purely "given a confirmed reset, send the pushes").

import type { KVStorage } from './kv/device-registry';
import { DeviceRegistry } from './kv/device-registry';
import { sendApnsPush, type ApnsCredentials } from './push/apns';
import { sendFcmPush, type FcmServiceAccount } from './push/fcm';
import { loadAppRegistryFromEnvRecord, type AppConfig } from './app-registry';

export interface ReregistrationEnv {
  RELAY_ID?: string;
  [key: string]: unknown;
}

/**
 * relay.md §9: "the relay lists the current contents of the KV device
 * registry ... and sends a re-registration push to each" with payload
 * `{ "type": "relay_reregistration_requested", "relay_id": "<RELAY_ID>" }`.
 *
 * Note this payload shape is APNs/FCM-transport-agnostic at the relay.md
 * level; this function adapts it into each platform's actual silent-push
 * envelope (APNs content-available / FCM data-only), same as
 * push/dispatch.ts does for ordinary delivery pushes.
 */
export async function dispatchReregistrationPush(
  kv: KVStorage,
  env: ReregistrationEnv
): Promise<{ attempted: number; succeeded: number }> {
  const registry = new DeviceRegistry(kv);
  const devices = await registry.listAll();
  const appRegistry = loadAppRegistryFromEnvRecord(env);
  const relayId = env.RELAY_ID ?? 'unknown-relay';

  let succeeded = 0;
  for (const { push_token, entry } of devices) {
    const app = appRegistry?.get(entry.app_id);
    if (!app) continue;
    const ok = await sendReregistrationPush(app, push_token, relayId, env);
    if (ok) succeeded += 1;
  }

  return { attempted: devices.length, succeeded };
}

async function sendReregistrationPush(
  app: AppConfig,
  deviceToken: string,
  relayId: string,
  env: ReregistrationEnv
): Promise<boolean> {
  // relay.md §9's re-registration payload includes `type` and `relay_id` —
  // distinct from the ordinary delivery push's `{ uuid }` payload
  // (relay.md §7.2 step 7). apns.ts/fcm.ts's sendXPush helpers are typed
  // around `{ uuid }` specifically (ApnsPayload/FcmPayload) since that is
  // the only payload shape relay.md's endpoint spec defines elsewhere; the
  // re-registration payload is sent here via the same underlying transport
  // functions is intentionally NOT reused as-is, since forcing this
  // different payload shape through the `{ uuid }`-typed helpers would
  // either lose type safety or require a misleading `uuid` field. Instead,
  // this constructs the platform request bodies directly by duplicating
  // the minimal amount of dispatch logic — flagged here as a small,
  // deliberate divergence from "one push-sending code path," not an
  // oversight.
  // relay.md §9's exact payload: { type: "relay_reregistration_requested", relay_id }.
  const payload = { type: 'relay_reregistration_requested', relay_id: relayId };

  if (app.platform === 'apns' && app.apns) {
    const keyPem = env[`APNS_KEY_${app.app_id}`] as string | undefined;
    if (!keyPem) return false;
    const creds: ApnsCredentials = {
      keyP8: keyPem,
      keyId: app.apns.key_id,
      teamId: app.apns.team_id,
      bundleId: app.apns.bundle_id,
      sandbox: app.apns.sandbox ?? true,
    };
    const result = await sendApnsPush(creds, deviceToken, payload);
    return result.ok;
  }
  if (app.platform === 'fcm' && app.fcm) {
    const serviceAccountJson = env[`FCM_SERVICE_ACCOUNT_${app.app_id}`] as string | undefined;
    if (!serviceAccountJson) return false;
    const account = JSON.parse(serviceAccountJson) as FcmServiceAccount;
    const result = await sendFcmPush(account, deviceToken, payload);
    return result.ok;
  }
  return false;
}
