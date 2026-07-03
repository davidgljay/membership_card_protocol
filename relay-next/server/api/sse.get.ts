// GET /sse — relay.md §7.4.
//
// Same node-server-vs-cloudflare split as server/api/ws/[uuid].get.ts: the
// real DO-backed accept only happens under cloudflare-module via
// server/cloudflare-entry.ts. This handler validates the credential
// (portable, real) and then reports the expected "no DO runtime here"
// condition under node-server.

import type { H3Event } from 'h3';
import { relayError, extractBearerCredential } from '../utils/http-errors';
import { createRedisClientForRequest } from '../utils/redis/client-factory';
import { validateSseCredential } from '../utils/sse-upgrade';

export default defineEventHandler(async (event: H3Event) => {
  const credential = extractBearerCredential(event);
  const redis = createRedisClientForRequest(event);
  try {
    const result = await validateSseCredential(redis, credential);
    if (!result.ok) {
      throw relayError(result.errorCode, result.message);
    }
    throw relayError(
      'INTERNAL_ERROR',
      'GET /sse requires the Cloudflare Durable Object runtime; not available under node-server. Credential validation succeeded — this handler is a portability/testing stub for that logic only.'
    );
  } finally {
    await redis.close();
  }
});
