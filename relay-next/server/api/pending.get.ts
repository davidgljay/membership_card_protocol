// GET /pending — relay.md §7.5.

import type { H3Event } from 'h3';
import { relayError, extractBearerCredential } from '../utils/http-errors';
import { createRedisClientForRequest } from '../utils/redis/client-factory';
import { CredentialStore } from '../utils/redis/credential-store';
import { MessageStore } from '../utils/redis/message-store';

export default defineEventHandler(async (event: H3Event) => {
  const credential = extractBearerCredential(event);
  if (!credential) {
    throw relayError('MISSING_CREDENTIAL', 'Authorization header required');
  }

  const redis = createRedisClientForRequest(event);
  try {
    const credentialStore = new CredentialStore(redis);
    const record = await credentialStore.get(credential);
    if (!record) {
      throw relayError('INVALID_CREDENTIAL', 'Device credential unknown or expired');
    }

    const messageStore = new MessageStore(redis);
    const entries = await messageStore.readAndClear(credential);

    return {
      messages: entries.map((e) => ({ uuid: e.uuid, blob: e.blob })),
    };
  } finally {
    await redis.close();
  }
});
