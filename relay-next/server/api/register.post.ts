// POST /register — relay.md §7.1.

import { readBody, type H3Event } from 'h3';
import { relayError, extractBearerCredential } from '../utils/http-errors';
import { createRedisClientForRequest } from '../utils/redis/client-factory';
import { UuidStore } from '../utils/redis/uuid-store';
import { CredentialStore } from '../utils/redis/credential-store';
import { clearEmptyFlag } from '../utils/redis/reconciliation';
import { DeviceRegistry } from '../utils/kv/device-registry';
import { getDeviceRegistryStorage } from '../utils/kv/storage-factory';
import { loadAppRegistry } from '../utils/app-registry';
import { generateUuid, generateDeviceCredential, nowIso } from '../utils/ids';
import { getEnvInt } from '../utils/env';

interface RegisterBody {
  app_id?: string;
  push_token?: string;
  count?: number;
}

export default defineEventHandler(async (event: H3Event) => {
  const body = await readBody<RegisterBody>(event);

  if (!body?.app_id || !body?.push_token) {
    throw relayError('MISSING_FIELD', 'app_id and push_token are required');
  }

  const count = body.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw relayError('INVALID_COUNT', 'count must be an integer between 1 and 100');
  }

  const appRegistry = await loadAppRegistry(event);
  const app = appRegistry.get(body.app_id);
  if (!app) {
    throw relayError('UNKNOWN_APP', `Unknown app_id: ${body.app_id}`);
  }

  const redis = createRedisClientForRequest(event);
  const ttlSeconds = getEnvInt(event, 'UUID_TTL_SECONDS', 2_592_000);
  const uuidStore = new UuidStore(redis, ttlSeconds);
  const credentialStore = new CredentialStore(redis, ttlSeconds);
  const deviceRegistry = new DeviceRegistry(getDeviceRegistryStorage(event));

  try {
    const presentedCredential = extractBearerCredential(event);
    let deviceCredential: string;
    let isBootstrap: boolean;

    if (presentedCredential) {
      // Replenishment path (relay.md §7.1).
      const existing = await credentialStore.get(presentedCredential);
      if (!existing) {
        throw relayError('INVALID_CREDENTIAL', 'Device credential unknown or expired');
      }
      await credentialStore.refresh(presentedCredential, body.push_token);
      deviceCredential = presentedCredential;
      isBootstrap = false;
    } else {
      // Bootstrap path.
      deviceCredential = generateDeviceCredential();
      await credentialStore.create(deviceCredential, {
        push_token: body.push_token,
        app_id: body.app_id,
        created_at: nowIso(),
      });
      isBootstrap = true;
    }

    const uuids: string[] = [];
    for (let i = 0; i < count; i++) {
      const uuid = generateUuid();
      await uuidStore.create(uuid, {
        app_id: body.app_id,
        push_token: body.push_token,
        wallet_base_url: app.wallet_base_url,
        device_credential: deviceCredential,
        created_at: nowIso(),
      });
      uuids.push(uuid);
    }

    // A UUID write just succeeded — clear the empty-store flag
    // (relay_data_model.md §2.6's false-positive guard: "resetting it to
    // false as soon as any UUID write succeeds again").
    await clearEmptyFlag(getDeviceRegistryStorage(event));

    await deviceRegistry.upsert(body.push_token, body.app_id, nowIso());

    return isBootstrap
      ? { uuids, device_credential: deviceCredential }
      : { uuids };
  } finally {
    await redis.close();
  }
});
