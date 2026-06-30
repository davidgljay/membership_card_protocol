import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createAccount } from '../server/db/accounts.js';
import { createBackupRegistration, findBackupRegistrationById } from '../server/db/backups.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

async function makeAccount(pool: Pool) {
  const suffix = crypto.randomUUID();
  return createAccount(pool, {
    cardHash: `0xtest-card-${suffix}`,
    masterPubkey: `pubkey-${suffix}`,
    keyringId: `0xtest-keyring-${suffix}`,
    serviceSecretEnc: `enc-${suffix}`,
    serviceSecretDekEnc: `dek-${suffix}`,
    webauthnCredentialId: `cred-${suffix}`,
    webauthnPublicKey: `cose-pubkey-${suffix}`,
  });
}

describe('backup_registrations repository', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a backup registration and finds it by id', async () => {
    const account = await makeAccount(pool);
    const created = await createBackupRegistration(pool, {
      holderId: account.id,
      type: 'synced_passkey',
      wrappedBlob: 'opaque-wrapped-blob',
      keyringId: account.keyring_id,
      notificationChannels: { email: 'holder@example.com' },
      cancellationPubkey: 'cancellation-pubkey',
    });

    const found = await findBackupRegistrationById(pool, created.id);
    expect(found?.holder_id).toBe(account.id);
    expect(found?.wrapped_blob).toBe('opaque-wrapped-blob');
    expect(found?.notification_channels).toEqual({ email: 'holder@example.com' });
  });

  it('supports a secondary_contact channel', async () => {
    const account = await makeAccount(pool);
    const created = await createBackupRegistration(pool, {
      holderId: account.id,
      type: 'yubikey',
      wrappedBlob: 'opaque-wrapped-blob-2',
      keyringId: account.keyring_id,
      notificationChannels: {
        sms: '+15551234567',
        secondary_contact: { name: 'Alex', email: 'alex@example.com' },
      },
      cancellationPubkey: 'cancellation-pubkey-2',
    });

    const found = await findBackupRegistrationById(pool, created.id);
    expect(found?.notification_channels.secondary_contact?.name).toBe('Alex');
  });

  it('returns null for an unknown id', async () => {
    const found = await findBackupRegistrationById(pool, crypto.randomUUID());
    expect(found).toBeNull();
  });
});
