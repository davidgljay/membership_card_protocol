/**
 * GET /matrix/room-index — specs/process_specs/room_discovery.md §1;
 * matrix-implementation-plan.md Phase 4 Step 16a.
 *
 * Unauthenticated, publicly cacheable list of every card-gated Matrix
 * room `POST /matrix/rooms` (Step 16) has created — `{ room_id,
 * policy_id, created_at }` per room, plus a response-level `updated_at`.
 * §1 is explicit that this is a read over already-public data (a room's
 * `policy_id` is visible in cleartext room state to anyone who can see
 * the room, and the predicate document it names is public IPFS content),
 * so this endpoint deliberately requires no session token — the whole
 * point (per §1) is that a card holder shouldn't have to identify
 * themselves just to learn what rooms exist. `POST /matrix/rooms` still
 * gates *writing* an entry via its own session-token auth, unchanged.
 *
 * Thin H3 adapter — same split as server/routes/matrix/rooms/index.post.ts:
 * all the actual logic (querying + shaping the response) lives in
 * server/db/matrix-rooms.ts's getRoomIndexResponse, reusing listRoomIndex
 * from Step 16 rather than re-querying matrix_room_index directly. Every
 * call reads Postgres live — nothing here caches server-side, so a room
 * inserted via POST /matrix/rooms shows up on the very next request.
 *
 * Mirrors server/routes/bindings/index.get.ts's conventions for this same
 * "authenticated write, unauthenticated read, full list" shape
 * (routing_table / matrix_room_index): getPool() for the pool, a plain
 * object return with no auth check at all.
 *
 * Caching: this response is identical for every requester (no per-user
 * variation) and safe for a CDN to cache, per §1 ("Publicly cacheable;
 * a CDN in front of this is appropriate"). No caching-header convention
 * exists elsewhere in this codebase to follow (bindings/index.get.ts sets
 * none), so this picks a short, explicit `public, max-age=30`: long enough
 * to absorb a burst of client-side discovery reads (room_discovery.md §2
 * step 2) without hammering Postgres, short enough that a newly created
 * room becomes visible to a polling/CDN-fronted client within half a
 * minute rather than being pinned stale for longer.
 */

import { getPool } from '../../db/client.js';
import { getRoomIndexResponse } from '../../db/matrix-rooms.js';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30');

  const pool = getPool();
  return await getRoomIndexResponse(pool);
});
