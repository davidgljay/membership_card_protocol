/**
 * Initial wallet service schema (implementation-plan.md §Step 1.2).
 *
 * Table comments below restate the trust/storage decisions from
 * strategic-plan.md so the schema is self-documenting: service_secret is
 * envelope-encrypted (OQ unrelated, Goal 1); reencryption_keys are
 * deliberately plaintext (OQ-WS-4 resolved); keyring_blobs is traditional
 * replicated storage, not IPFS (OQ-WS-3 resolved, ARCHITECTURE.md
 * ADR-009-AMEND).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  // Holder accounts
  pgm.createTable('holder_accounts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    card_hash: { type: 'text', notNull: true, unique: true }, // keccak256(card_pubkey)
    master_pubkey: { type: 'text', notNull: true }, // ML-DSA-44 pubkey, base64url
    keyring_id: { type: 'text', notNull: true }, // keccak256(encrypted_blob); lookup key into keyring_blobs
    service_secret_enc: { type: 'text', notNull: true }, // AES-256-GCM ciphertext of service_secret
    service_secret_dek_enc: { type: 'text', notNull: true }, // envelope-encrypted DEK (SecretsService)
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Keyring blobs — replicated across the wallet service federation.
  // Not IPFS (ADR-009-AMEND): traditional, deletable storage. A row here
  // may belong to a holder served by THIS wallet service, or to a holder of
  // any peer in the federation (full replication, OQ-WS-3).
  pgm.createTable('keyring_blobs', {
    keyring_id: { type: 'text', primaryKey: true }, // keccak256(encrypted_blob)
    card_hash: { type: 'text', notNull: true },
    encrypted_blob: { type: 'text', notNull: true }, // AES-GCM ciphertext, base64url; opaque to this service
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('keyring_blobs', 'card_hash');

  // Backup registrations (wrapped decryption key blobs)
  pgm.createTable('backup_registrations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    holder_id: {
      type: 'uuid',
      notNull: true,
      references: 'holder_accounts(id)',
      onDelete: 'CASCADE',
    },
    type: { type: 'text', notNull: true, check: "type IN ('synced_passkey', 'yubikey')" },
    wrapped_blob: { type: 'text', notNull: true }, // opaque ciphertext; wallet cannot decrypt
    notification_channels: { type: 'jsonb', notNull: true }, // { email, sms, webhook, secondary_contact }
    cancellation_pubkey: { type: 'text', notNull: true }, // ML-DSA-44 pubkey for cancellation signing
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Active recovery windows
  pgm.createTable('recovery_windows', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    backup_reg_id: { type: 'uuid', notNull: true, references: 'backup_registrations(id)' },
    initiated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true }, // initiated_at + 72 hours
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'cancelled', 'released')",
    },
    cancelled_at: { type: 'timestamptz' },
    released_at: { type: 'timestamptz' },
  });

  // Per-card message queue
  pgm.createTable('message_queue', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    card_hash: { type: 'text', notNull: true },
    payload: { type: 'text', notNull: true }, // E2E encrypted routing envelope payload, base64url
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    cleared: { type: 'boolean', notNull: true, default: false },
    cleared_at: { type: 'timestamptz' },
  });
  pgm.createIndex('message_queue', ['card_hash', 'cleared']);

  // UUID pools (subcard delivery routing)
  pgm.createTable('uuid_pools', {
    uuid: { type: 'uuid', primaryKey: true },
    card_hash: { type: 'text', notNull: true },
    subcard_hash: { type: 'text', notNull: true }, // keccak256(subcard_pubkey), opaque
    consumed: { type: 'boolean', notNull: true, default: false },
    registered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true }, // registered_at + 30 days
  });
  pgm.createIndex('uuid_pools', ['card_hash', 'subcard_hash', 'consumed']);

  // Re-encryption keys (UMBRAL; one per card per sub-card).
  // Stored in plaintext per OQ-WS-4: a stolen key alone cannot decrypt
  // anything without the sub-card's private key, and the only exposure
  // (sub-card count) is already visible on the storage contract.
  pgm.createTable('reencryption_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    card_hash: { type: 'text', notNull: true },
    subcard_hash: { type: 'text', notNull: true }, // keccak256(subcard_pubkey)
    rekey: { type: 'text', notNull: true }, // UMBRAL re-encryption key, plaintext, base64url
    active: { type: 'boolean', notNull: true, default: true },
    registered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(
    'CREATE UNIQUE INDEX reencryption_keys_card_subcard_active_idx ON reencryption_keys(card_hash, subcard_hash) WHERE active = TRUE;'
  );

  // Routing table (off-chain; card_hash -> wallet service endpoint)
  pgm.createTable('routing_table', {
    card_hash: { type: 'text', primaryKey: true },
    wallet_service_id: { type: 'text', notNull: true },
    endpoint: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true, check: "type IN ('card_registration', 'card_migration')" },
    announced_at: { type: 'timestamptz', notNull: true },
    nonce: { type: 'text', notNull: true, unique: true }, // replay prevention
  });

  // Nonce cache (routing announcement replay prevention)
  pgm.createTable('routing_nonces', {
    nonce: { type: 'text', primaryKey: true },
    seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // KV fallback for node-server/aws-lambda presets (no cloudflare-kv-binding
  // available there). Session revocation + rate-limit counters only.
  pgm.createTable('kv_store', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    expires_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('routing_nonces');
  pgm.dropTable('routing_table');
  pgm.dropTable('reencryption_keys');
  pgm.dropTable('uuid_pools');
  pgm.dropTable('message_queue');
  pgm.dropTable('recovery_windows');
  pgm.dropTable('backup_registrations');
  pgm.dropTable('keyring_blobs');
  pgm.dropTable('holder_accounts');
};
