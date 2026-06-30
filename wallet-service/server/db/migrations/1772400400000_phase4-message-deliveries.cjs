/**
 * Phase 4 message delivery tracking (implementation-plan.md §Step 4.4,
 * §Step 4.5). A single message_queue row can be delivered to multiple
 * subcards (multi-device fan-out), each via its own relay UUID. This table
 * maps each delivery UUID back to the message_queue row it carried, so
 * `DELETE /messages/{uuid}` (Step 4.5) can find "the correct message"
 * rather than guessing via card_hash + oldest-uncleared.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('message_deliveries', {
    uuid: { type: 'uuid', primaryKey: true },
    message_id: { type: 'uuid', notNull: true, references: 'message_queue(id)', onDelete: 'CASCADE' },
    subcard_hash: { type: 'text', notNull: true },
    delivered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('message_deliveries', 'message_id');
};

exports.down = (pgm) => {
  pgm.dropTable('message_deliveries');
};
