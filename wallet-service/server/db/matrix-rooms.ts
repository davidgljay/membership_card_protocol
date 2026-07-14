/**
 * matrix_room_index repository (specs/process_specs/room_discovery.md §1;
 * matrix-implementation-plan.md Phase 4 Step 16). One row per card-gated
 * room created via POST /matrix/rooms — `{ room_id, policy_id, created_at }`,
 * exactly the shape `room_discovery.md §1` documents for both the write
 * side (this file) and the read side (GET /matrix/room-index, Step 16a,
 * not yet built — it reads via listRoomIndex below).
 *
 * Deliberately no encryption/envelope columns (contrast
 * server/db/accounts.ts's service_secret_enc pattern): room_id and
 * policy_id are non-sensitive by room_discovery.md's own design (see the
 * migration file's header comment for the full rationale).
 */

import type { Pool } from 'pg';

export interface RoomIndexEntry {
  room_id: string;
  policy_id: string;
  created_at: Date;
}

/**
 * Idempotent on room_id — a retried room-creation call (e.g. after a
 * client timeout on an otherwise-successful request) does not produce a
 * duplicate index entry.
 */
export async function insertRoomIndexEntry(pool: Pool, entry: RoomIndexEntry): Promise<void> {
  await pool.query(
    `INSERT INTO matrix_room_index (room_id, policy_id, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (room_id) DO NOTHING`,
    [entry.room_id, entry.policy_id, entry.created_at]
  );
}

/** Full list, oldest first — the shape GET /matrix/room-index (Step 16a) returns as its `rooms` array. */
export async function listRoomIndex(pool: Pool): Promise<RoomIndexEntry[]> {
  const { rows } = await pool.query<RoomIndexEntry>(
    'SELECT room_id, policy_id, created_at FROM matrix_room_index ORDER BY created_at ASC'
  );
  return rows;
}

export interface RoomIndexResponse {
  rooms: Array<{ room_id: string; policy_id: string; created_at: string }>;
  updated_at: string;
}

/**
 * Shapes the room index into exactly the wire format
 * room_discovery.md §1 documents for GET /matrix/room-index (Step 16a):
 * `{ rooms: [{ room_id, policy_id, created_at }], updated_at }`, with
 * timestamps as ISO-8601 strings rather than `Date` objects.
 *
 * Pulled out of the route handler (server/routes/matrix/room-index.get.ts)
 * so it's callable directly against a real Postgres instance in tests —
 * H3 route files in this codebase rely on Nitro's auto-imported globals
 * and aren't unit-testable outside a running Nitro instance (see the note
 * in test/matrix-room-creation.test.ts), so the handler stays a thin
 * wrapper around this function, same thin-route/pure-logic split used
 * elsewhere in server/routes/matrix/*.
 *
 * `updated_at` is "now" (the time of this read), not derived from the max
 * `created_at` in the table — an empty room index still needs a valid
 * `updated_at`, and room_discovery.md §1 doesn't require it to track the
 * last write specifically, just to timestamp the response.
 */
export async function getRoomIndexResponse(pool: Pool): Promise<RoomIndexResponse> {
  const rows = await listRoomIndex(pool);
  return {
    rooms: rows.map((row) => ({
      room_id: row.room_id,
      policy_id: row.policy_id,
      created_at: row.created_at.toISOString(),
    })),
    updated_at: new Date().toISOString(),
  };
}
