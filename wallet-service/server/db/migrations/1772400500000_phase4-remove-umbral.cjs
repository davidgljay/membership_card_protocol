/**
 * Removes the UMBRAL re-encryption subsystem, replaced mid-Phase-4 by
 * sender-side per-sub-card encryption (process_specs/message_routing.md
 * v0.4 — see implementation-plan.md §Phase 4 "Revised mid-phase").
 *
 *  - reencryption_keys: dropped entirely. The wallet service never holds
 *    re-encryption key material now.
 *  - message_deliveries: dropped. With each message_queue row already
 *    scoped to one subcard (next change), an explicit join table for
 *    "which uuid delivered which message" collapses to a single nullable
 *    column on message_queue itself.
 *  - message_queue: gains `subcard_hash` (which device this copy is for —
 *    every routing envelope now names one) and `delivery_uuid` (the most
 *    recent relay UUID this message was handed to, used by
 *    DELETE /messages/{uuid} to find the right row).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropTable('message_deliveries');
  pgm.dropTable('reencryption_keys');

  pgm.addColumns('message_queue', {
    subcard_hash: { type: 'text' }, // nullable for pre-existing rows; new rows always set it
    delivery_uuid: { type: 'uuid' },
  });
  pgm.createIndex('message_queue', ['card_hash', 'subcard_hash', 'cleared']);
  pgm.createIndex('message_queue', 'delivery_uuid');
};

exports.down = (pgm) => {
  pgm.dropColumns('message_queue', ['subcard_hash', 'delivery_uuid']);

  pgm.createTable('reencryption_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    card_hash: { type: 'text', notNull: true },
    subcard_hash: { type: 'text', notNull: true },
    rekey: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    registered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(
    'CREATE UNIQUE INDEX reencryption_keys_card_subcard_active_idx ON reencryption_keys(card_hash, subcard_hash) WHERE active = TRUE;'
  );

  pgm.createTable('message_deliveries', {
    uuid: { type: 'uuid', primaryKey: true },
    message_id: { type: 'uuid', notNull: true, references: 'message_queue(id)', onDelete: 'CASCADE' },
    subcard_hash: { type: 'text', notNull: true },
    delivered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('message_deliveries', 'message_id');
};
