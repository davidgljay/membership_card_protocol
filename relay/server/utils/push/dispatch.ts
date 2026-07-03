// Push dispatch — relay.md §7.2 step 7's push fallback. Resolves an
// AppConfig (app-registry.ts) to the right client (apns.ts / fcm.ts) and
// sends the `{ uuid }` payload.
//
// Credential SOURCING GAP (same one flagged in app-registry.ts's module
// doc): relay_data_model.md §6 explicitly defers how `apns.key_file` /
// `fcm.service_account_file` are sourced under the cloudflare preset to
// Phase 2. This module resolves them via environment variables holding the
// raw PEM/JSON content directly (APNS_KEY_<APP_ID>, FCM_SERVICE_ACCOUNT_
// <APP_ID>), not by reading `key_file`/`service_account_file` as
// filesystem paths under Cloudflare (there is no filesystem). Under
// node-server, the same env vars are used for parity/testability rather
// than branching to a filesystem read of key_file — this keeps dispatch.ts
// itself preset-agnostic even though app-registry.ts's *registry loading*
// still branches. This is a provisional Phase 2 implementation choice, not
// a spec-confirmed one — flagged in the Phase 2 report alongside the
// app-registry.ts gap, both stemming from the same unresolved §6 question.

import type { H3Event } from 'h3';
import type { AppConfig } from '../app-registry';
import { getEnv } from '../env';
import { sendApnsPush, type ApnsCredentials } from './apns';
import { sendFcmPush, type FcmServiceAccount } from './fcm';

// Index-signature-compatible with apns.ts/fcm.ts's Record<string, string>
// payload types (see those files' ApnsPayload/FcmPayload docs).
export interface PushPayload {
  uuid: string;
  [key: string]: string;
}

export async function dispatchPush(
  event: H3Event,
  app: AppConfig,
  deviceToken: string,
  payload: PushPayload
): Promise<{ ok: boolean; reason?: string }> {
  if (app.platform === 'apns') {
    if (!app.apns) {
      return { ok: false, reason: 'apns config missing on app registry entry' };
    }
    const keyPem = getEnv(event, `APNS_KEY_${app.app_id}`);
    if (!keyPem) {
      return { ok: false, reason: `Missing APNS_KEY_${app.app_id} env var` };
    }
    const creds: ApnsCredentials = {
      keyP8: keyPem,
      keyId: app.apns.key_id,
      teamId: app.apns.team_id,
      bundleId: app.apns.bundle_id,
      sandbox: app.apns.sandbox ?? true,
    };
    const result = await sendApnsPush(creds, deviceToken, payload);
    return { ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) };
  }

  if (app.platform === 'fcm') {
    if (!app.fcm) {
      return { ok: false, reason: 'fcm config missing on app registry entry' };
    }
    const serviceAccountJson = getEnv(event, `FCM_SERVICE_ACCOUNT_${app.app_id}`);
    if (!serviceAccountJson) {
      return { ok: false, reason: `Missing FCM_SERVICE_ACCOUNT_${app.app_id} env var` };
    }
    const account = JSON.parse(serviceAccountJson) as FcmServiceAccount;
    const result = await sendFcmPush(account, deviceToken, payload);
    return { ok: result.ok, ...(result.error ? { reason: result.error } : {}) };
  }

  return { ok: false, reason: `Unknown platform: ${String(app.platform)}` };
}
