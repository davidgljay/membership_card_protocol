import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { insertRoomIndexEntry, listRoomIndex, getRoomIndexResponse } from '../server/db/matrix-rooms.js';

// Same real-Postgres integration convention as test/routing-repo.test.ts
// (matrix-implementation-plan.md Phase 4 Step 16) — matrix_room_index is a
// plain table (1772400900000_matrix-room-index.cjs), not something worth
// mocking `pg` for.
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

describe('matrix_room_index repository (Step 16)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('appends an entry and it shows up in the room index list', async () => {
    const roomId = `!test-${crypto.randomUUID()}:matrix.internal`;
    const policyId = 'bafyreih6qivnk...roompredicate';
    const createdAt = new Date();

    await insertRoomIndexEntry(pool, { room_id: roomId, policy_id: policyId, created_at: createdAt });

    const rows = await listRoomIndex(pool);
    const entry = rows.find((r) => r.room_id === roomId);
    expect(entry).toBeDefined();
    expect(entry?.policy_id).toBe(policyId);
  });

  it('is idempotent on room_id — inserting the same room_id twice does not duplicate or error', async () => {
    const roomId = `!test-${crypto.randomUUID()}:matrix.internal`;
    const createdAt = new Date();

    await insertRoomIndexEntry(pool, { room_id: roomId, policy_id: 'policy-a', created_at: createdAt });
    await insertRoomIndexEntry(pool, { room_id: roomId, policy_id: 'policy-a', created_at: createdAt });

    const rows = await listRoomIndex(pool);
    const matches = rows.filter((r) => r.room_id === roomId);
    expect(matches).toHaveLength(1);
  });
});

// GET /matrix/room-index (Step 16a) — server/routes/matrix/room-index.get.ts
// is a thin, unauthenticated H3 wrapper around getRoomIndexResponse below.
// H3 route files in this codebase rely on Nitro's auto-imported globals
// (defineEventHandler/setResponseHeader) and aren't unit-testable outside a
// running Nitro instance (see the note at the bottom of
// test/matrix-room-creation.test.ts) — no existing route file has a
// matching *.test.ts, and this one follows that same convention. Its
// actual logic (query + response shaping) is covered here directly
// against real Postgres instead, same convention as the repository tests
// above. The route itself adds nothing beyond a Cache-Control header and
// calling this function, so there is nothing further to unit-test at the
// route layer — no session/auth check is even present to verify by
// exercising the handler; it's verifiable by inspection of the route file
// (no requireSessionToken call, unlike every authenticated route in this
// service).
describe('getRoomIndexResponse (Step 16a)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns the { rooms, updated_at } shape room_discovery.md §1 documents', async () => {
    const roomId = `!test-${crypto.randomUUID()}:matrix.internal`;
    const policyId = 'bafyreih6qivnk...roompredicate';
    await insertRoomIndexEntry(pool, { room_id: roomId, policy_id: policyId, created_at: new Date() });

    const response = await getRoomIndexResponse(pool);

    expect(typeof response.updated_at).toBe('string');
    expect(new Date(response.updated_at).toISOString()).toBe(response.updated_at);

    const entry = response.rooms.find((r) => r.room_id === roomId);
    expect(entry).toBeDefined();
    expect(entry?.policy_id).toBe(policyId);
    // created_at is serialized as an ISO string, not a Date instance, so
    // this is JSON-response-ready without any further transformation.
    expect(typeof entry?.created_at).toBe('string');
    expect(new Date(entry!.created_at).toISOString()).toBe(entry!.created_at);
  });

  it('reflects a room inserted after the fact — reads live from Postgres, not a stale/cached snapshot', async () => {
    const before = await getRoomIndexResponse(pool);
    const roomId = `!test-${crypto.randomUUID()}:matrix.internal`;
    expect(before.rooms.find((r) => r.room_id === roomId)).toBeUndefined();

    await insertRoomIndexEntry(pool, {
      room_id: roomId,
      policy_id: 'bafyreih6qivnk...roompredicate',
      created_at: new Date(),
    });

    // No server restart, no cache warm-up between the two calls — if this
    // were reading anything but the live table, the second call would
    // still miss the just-inserted row.
    const after = await getRoomIndexResponse(pool);
    expect(after.rooms.find((r) => r.room_id === roomId)).toBeDefined();
  });
});
