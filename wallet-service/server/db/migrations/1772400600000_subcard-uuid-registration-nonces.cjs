/**
 * Replay protection for POST /cards/{card_hash}/subcards/{subcard_hash}/uuids
 * (notification_relay.md v0.8 §Process 1 steps 6-8, security-audit finding
 * (a), implementation-plan.md §Step 2.7).
 *
 * Deliberately a separate table from routing_nonces (server/db/routing.ts)
 * rather than reusing it: routing_nonces is a global namespace for
 * federation/binding-announcement replay detection (one wallet-service
 * identity's announcements), where any nonce reuse by anyone is
 * suspicious. Here the concern is narrower and per-subcard — a nonce is
 * only meaningful (and only needs to be unique) within one subcard_hash's
 * own signed-envelope stream, since two different sub-cards independently
 * generating the same random 32-byte nonce is not a replay of anything.
 * Scoping the uniqueness constraint to (subcard_hash, nonce) rather than a
 * bare global nonce column keeps the replay check precise to what's
 * actually being replayed, and keeps this concern's prune job independent
 * of routing_nonces' 24-hour retention window (see
 * prune-subcard-uuid-registration-nonces.ts for why this table uses a
 * shorter window tied to the endpoint's own timestamp tolerance instead).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('subcard_uuid_registration_nonces', {
    subcard_hash: { type: 'text', notNull: true },
    nonce: { type: 'text', notNull: true },
    seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('subcard_uuid_registration_nonces', 'subcard_uuid_registration_nonces_pkey', {
    primaryKey: ['subcard_hash', 'nonce'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('subcard_uuid_registration_nonces');
};
