// Internal endpoint called by UuidConnection DO's webSocketClose/
// webSocketError handlers (server/do/uuid-connection.ts) — relay_data_model.md
// §10.3 "Closing a connection" step 2: "The DO calls back into the
// stateless layer ... to request the Redis active -> consumed transition.
// The DO does not perform this Redis write itself."
//
// Not part of the public API surface in relay.md — this is
// infrastructure-internal, guarded by a shared secret header so it cannot
// be triggered by an arbitrary external caller to force UUIDs into
// `consumed` early. (Cloudflare Workers has no built-in service-to-service
// auth for same-Worker fetch() calls the way, e.g., Cloudflare Access
// service tokens would provide for cross-Worker calls — this is a Worker
// calling itself via its own origin, so a shared secret is the minimal
// viable guard. Real secret provisioning is a Phase 3 deployment detail;
// tests use a fixed value.)

import { getHeader, type H3Event } from 'h3';
import { relayError } from '../../../utils/http-errors';
import { createRedisClientForRequest } from '../../../utils/redis/client-factory';
import { UuidStore } from '../../../utils/redis/uuid-store';
import { isValidUuidV4 } from '../../../utils/ids';
import { getEnv } from '../../../utils/env';

export default defineEventHandler(async (event: H3Event) => {
  const configuredSecret = getEnv(event, 'INTERNAL_API_SECRET');
  if (configuredSecret) {
    const presented = getHeader(event, 'x-internal-secret');
    if (presented !== configuredSecret) {
      throw relayError('INVALID_CREDENTIAL', 'Invalid internal call');
    }
  }

  const uuid = event.context.params?.uuid;
  if (!uuid || !isValidUuidV4(uuid)) {
    throw relayError('INVALID_UUID', 'Path parameter is not a valid UUID v4');
  }

  const redis = createRedisClientForRequest(event);
  try {
    const uuidStore = new UuidStore(redis);
    // active -> consumed. Uses simpleTransition (not the CAS Lua script) —
    // consistent with relay_data_model.md §7.3's simplification note: this
    // call site is reached only via the DO's own single-threaded teardown
    // path, not a potentially-concurrent stateless HTTP handler racing with
    // another writer of the same transition.
    await uuidStore.simpleTransition(uuid, 'active', 'consumed');
    return { ok: true };
  } finally {
    await redis.close();
  }
});
