/**
 * Phase 4 routing schema addendum (implementation-plan.md §Step 4.1).
 * `GET /bindings` must return startup-sync peers a list of *signed*
 * announcement objects, independently verifiable by the receiving peer —
 * not just the resolved fields routing_table already stored. Adding the
 * original `signatures` array lets routing_table double as both the
 * resolved view (used for routing lookups) and the source for re-serving
 * verifiable envelopes, without a separate announcements table.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('routing_table', {
    signatures: { type: 'jsonb', notNull: true }, // the announcement envelope's original signatures array
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('routing_table', ['signatures']);
};
