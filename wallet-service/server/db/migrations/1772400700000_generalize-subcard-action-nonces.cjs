/**
 * Generalizes subcard_uuid_registration_nonces -> subcard_action_nonces,
 * adding an `action` column (notification_relay.md v0.9 §Process 1 steps
 * 6-8, §Multi-Device Support "Deregistration"; wallet-service correction
 * to ea7ce3b1).
 *
 * Why generalize the existing table instead of adding a second dedicated
 * one: DELETE /cards/{card_hash}/subcards/{subcard_hash} (deregistration)
 * now needs the exact same signed-envelope replay protection as POST
 * .../uuids (registration) — same (subcard_hash, nonce) uniqueness
 * concern, same 5-minute timestamp window, same 1-hour retention/prune
 * cadence (server/db/subcard-uuid-nonces.ts). A second table would
 * duplicate that schema and its prune task wholesale for no isolation
 * benefit: nothing about registration and deregistration nonces needs to
 * be queried, retained, or pruned differently, and a nonce is already
 * scoped to one subcard_hash's own signed-envelope stream (see the
 * original migration's rationale comment) — adding `action` to the
 * uniqueness constraint keeps a register-nonce and a deregister-nonce
 * from colliding with each other for the same subcard without needing a
 * second table to do it.
 *
 * The (subcard_hash, nonce) primary key becomes (subcard_hash, action,
 * nonce) accordingly.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.renameTable('subcard_uuid_registration_nonces', 'subcard_action_nonces');

  pgm.addColumn('subcard_action_nonces', {
    action: { type: 'text', notNull: true, default: 'register' },
  });
  pgm.alterColumn('subcard_action_nonces', 'action', { default: null });

  pgm.addConstraint('subcard_action_nonces', 'subcard_action_nonces_action_check', {
    check: "action IN ('register', 'deregister')",
  });

  pgm.dropConstraint('subcard_action_nonces', 'subcard_uuid_registration_nonces_pkey');
  pgm.addConstraint('subcard_action_nonces', 'subcard_action_nonces_pkey', {
    primaryKey: ['subcard_hash', 'action', 'nonce'],
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('subcard_action_nonces', 'subcard_action_nonces_pkey');
  pgm.dropConstraint('subcard_action_nonces', 'subcard_action_nonces_action_check');
  pgm.dropColumn('subcard_action_nonces', 'action');
  pgm.addConstraint('subcard_action_nonces', 'subcard_uuid_registration_nonces_pkey', {
    primaryKey: ['subcard_hash', 'nonce'],
  });
  pgm.renameTable('subcard_action_nonces', 'subcard_uuid_registration_nonces');
};
