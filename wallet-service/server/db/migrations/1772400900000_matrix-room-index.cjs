/**
 * Room index table (specs/process_specs/room_discovery.md §1) — backs
 * POST /matrix/rooms's (matrix-implementation-plan.md Phase 4 Step 16)
 * append-on-create write, and the upcoming GET /matrix/room-index (Step
 * 16a) read.
 *
 * A plain Postgres table via the existing getPool() pattern, not a flat
 * file/KV entry (room_discovery.md §1 permits either) — chosen because
 * `wallet-service` already has exactly this shape elsewhere
 * (routing_table, 1772400300000_phase4-routing.cjs, read back by
 * server/routes/bindings/index.get.ts as a public unauthenticated list):
 * an authenticated POST appends a row, an unauthenticated GET lists them
 * all. Reusing that convention avoids introducing a second, novel
 * storage mechanism for a shape this codebase already has an established
 * answer for. No encryption/envelope columns here (contrast
 * matrix_credentials, 1772400800000_matrix-credentials.cjs) — room_id and
 * policy_id are explicitly non-sensitive by room_discovery.md's own
 * Overview (the whole point of the index is that it's public and
 * unauthenticated to read).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('matrix_room_index', {
    room_id: { type: 'text', notNull: true },
    policy_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('matrix_room_index', 'matrix_room_index_pkey', {
    primaryKey: ['room_id'],
  });
  pgm.createIndex('matrix_room_index', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('matrix_room_index');
};
