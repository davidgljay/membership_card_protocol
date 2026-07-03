// GET /ws/{uuid} — relay.md §7.3, relay_data_model.md §10.3 "Opening a
// connection."
//
// Steps 1-4 (Redis validation + unused -> active transition) happen HERE,
// in the stateless Nitro handler layer, per §10.3's explicit ordering.
// Step 5 (forwarding the upgrade to the UUID's Durable Object) only
// happens if steps 1-4 succeed — this handler never invokes the DO on a
// rejection path.
//
// IMPORTANT — this route only runs under node-server (where it correctly
// returns 501, since there is no Durable Object runtime to forward to) or
// as a pre-DO-forward validation step under a hypothetical Nitro-native
// Cloudflare WebSocket path. Under the actual cloudflare-module deployment,
// this exact validation logic also runs — duplicated intentionally, not
// accidentally — inside server/cloudflare-entry.ts's hand-rolled
// `/ws/:uuid` route, because Nitro's generated Cloudflare Worker entry
// cannot resolve a per-UUID Durable Object instance (the same limitation
// the Phase 1 spike found — see spike-do-ws/README.md) and therefore
// cannot reach this Nitro route handler for WebSocket upgrade requests at
// all under that preset. See server/cloudflare-entry.ts's module doc for
// the full explanation and why the validation logic is factored into
// server/utils/ws-upgrade.ts so both entry points call the identical code
// rather than maintaining two copies.

import type { H3Event } from 'h3';
import { relayError } from '../../utils/http-errors';
import { createRedisClientForRequest } from '../../utils/redis/client-factory';
import { validateAndActivateUuid } from '../../utils/ws-upgrade';

export default defineEventHandler(async (event: H3Event) => {
  const uuid = event.context.params?.uuid;
  const redis = createRedisClientForRequest(event);
  try {
    const result = await validateAndActivateUuid(redis, uuid);
    if (!result.ok) {
      throw relayError(result.errorCode, result.message);
    }
    // node-server has no Durable Object runtime — this preset cannot
    // actually accept the WebSocket upgrade into a DO-backed connection
    // (strategic-plan.md Goal 3: the DO-backed connection layer is
    // explicitly NOT part of the cross-platform portability claim). The
    // Redis-side validation above is still real and portable; only the
    // actual socket acceptance is Cloudflare-only.
    throw relayError(
      'INTERNAL_ERROR',
      'GET /ws/{uuid} requires the Cloudflare Durable Object runtime; not available under node-server. Redis-side validation succeeded — this handler is a portability/testing stub for the transition logic only.'
    );
  } finally {
    await redis.close();
  }
});
