/**
 * Phase 2 auth schema addendum (implementation-plan.md §Step 2.1 schema
 * addendum, resolving CP-1). Adds:
 *
 *  - WebAuthn credential columns on holder_accounts, used by the
 *    existing-wallet passkey login path (Step 2.1) to verify assertions
 *    before releasing service_secret.
 *  - auth_challenges: a single-use, expiring challenge store shared by the
 *    three challenge/response auth flows in this plan — new-account
 *    creation (Step 2.2), passkey login (Step 2.1), and post-recovery
 *    keyring rotation (Step 2.4).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Added as nullable columns (existing rows predate this migration in any
  // already-deployed environment) but every account created via Step 2.2
  // from this point forward always supplies all three at creation time —
  // the passkey is registered in the same call as the account.
  pgm.addColumns('holder_accounts', {
    webauthn_credential_id: { type: 'text' },
    webauthn_public_key: { type: 'text' }, // COSE public key, base64url
    webauthn_sign_count: { type: 'bigint', notNull: true, default: 0 }, // replay protection per WebAuthn spec
  });
  pgm.sql(
    'CREATE UNIQUE INDEX holder_accounts_webauthn_credential_id_idx ON holder_accounts(webauthn_credential_id) WHERE webauthn_credential_id IS NOT NULL;'
  );

  pgm.createTable('auth_challenges', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    purpose: {
      type: 'text',
      notNull: true,
      check: "purpose IN ('account_creation', 'passkey_login', 'keyring_rotation')",
    },
    card_hash: { type: 'text' }, // null for account_creation issued before the account exists
    challenge: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    consumed: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('auth_challenges', ['card_hash', 'purpose']);
};

exports.down = (pgm) => {
  pgm.dropTable('auth_challenges');
  pgm.sql('DROP INDEX IF EXISTS holder_accounts_webauthn_credential_id_idx;');
  pgm.dropColumns('holder_accounts', [
    'webauthn_credential_id',
    'webauthn_public_key',
    'webauthn_sign_count',
  ]);
};
