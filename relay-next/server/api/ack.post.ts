// POST /ack — relay.md §7.6.

import { readBody, type H3Event } from 'h3';
import { relayError, extractBearerCredential } from '../utils/http-errors';
import { createRedisClientForRequest } from '../utils/redis/client-factory';
import { CredentialStore } from '../utils/redis/credential-store';
import { UuidStore } from '../utils/redis/uuid-store';
import { DeleteQueue } from '../utils/redis/delete-queue';
import { getEnvInt } from '../utils/env';

interface AckBody {
  uuids?: string[];
}

export default defineEventHandler(async (event: H3Event) => {
  const credential = extractBearerCredential(event);
  if (!credential) {
    throw relayError('MISSING_CREDENTIAL', 'Authorization header required');
  }

  const redis = createRedisClientForRequest(event);
  try {
    const credentialStore = new CredentialStore(redis);
    const credentialRecord = await credentialStore.get(credential);
    if (!credentialRecord) {
      throw relayError('INVALID_CREDENTIAL', 'Device credential unknown or expired');
    }

    const body = await readBody<AckBody>(event);
    if (!body?.uuids || body.uuids.length === 0) {
      throw relayError('MISSING_FIELD', 'uuids is required and must be non-empty');
    }

    const uuidStore = new UuidStore(redis);
    const maxDelaySeconds = getEnvInt(event, 'MAX_DELETE_DELAY_SECONDS', 21_600);
    const deleteQueue = new DeleteQueue(redis, maxDelaySeconds);
    const now = Math.floor(Date.now() / 1000);

    for (const uuid of body.uuids) {
      // relay.md §7.6: "UUIDs not found in Redis (expired or unknown) are
      // silently skipped — they were already consumed and cleared."
      const record = await uuidStore.get(uuid);
      if (!record) continue;
      await deleteQueue.enqueue(record.wallet_base_url, uuid, now);
    }

    return {};
  } finally {
    await redis.close();
  }
});
