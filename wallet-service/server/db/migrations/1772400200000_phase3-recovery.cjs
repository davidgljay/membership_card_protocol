/**
 * Phase 3 recovery infrastructure schema addendum (implementation-plan.md
 * §Step 3.1, §Step 3.3). Adds:
 *
 *  - keyring_id on backup_registrations: the wire format in Step 3.1 binds
 *    each backup registration to the keyring_id it can unwrap to, released
 *    alongside wrapped_blob at key release time (Step 3.5) — independent
 *    of whatever the holder's *current* keyring_id is, since recovery may
 *    be initiated against an older registration.
 *  - notification_jobs: the job queue for the 72-hour window's
 *    notification fan-out (Step 3.3). PostgreSQL-backed (not Redis) so
 *    jobs survive restarts, matching the recovery_windows durability
 *    requirement.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('backup_registrations', {
    keyring_id: { type: 'text', notNull: true }, // keccak256 hex; not a hard FK — see migration header
  });

  pgm.createTable('notification_jobs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    recovery_id: { type: 'uuid', notNull: true, references: 'recovery_windows(id)', onDelete: 'CASCADE' },
    channel: {
      type: 'text',
      notNull: true,
      check: "channel IN ('email', 'sms', 'webhook', 'secondary_contact_email', 'secondary_contact_sms')",
    },
    payload: { type: 'jsonb', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'sent', 'failed')",
    },
    attempts: { type: 'int', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('notification_jobs', ['status', 'next_attempt_at']);
  pgm.createIndex('notification_jobs', 'recovery_id');
};

exports.down = (pgm) => {
  pgm.dropTable('notification_jobs');
  pgm.dropColumns('backup_registrations', ['keyring_id']);
};
