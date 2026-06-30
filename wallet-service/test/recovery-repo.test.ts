import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createAccount } from '../server/db/accounts.js';
import { createBackupRegistration } from '../server/db/backups.js';
import {
  createRecoveryWindow,
  findActiveRecoveryWindow,
  findRecoveryWindowById,
  cancelRecoveryWindow,
  releaseRecoveryWindow,
} from '../server/db/recovery.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

async function makeBackup(pool: Pool) {
  const suffix = crypto.randomUUID();
  const account = await createAccount(pool, {
    cardHash: `0xtest-card-${suffix}`,
    masterPubkey: `pubkey-${suffix}`,
    keyringId: `0xtest-keyring-${suffix}`,
    serviceSecretEnc: `enc-${suffix}`,
    serviceSecretDekEnc: `dek-${suffix}`,
    webauthnCredentialId: `cred-${suffix}`,
    webauthnPublicKey: `cose-pubkey-${suffix}`,
  });
  return createBackupRegistration(pool, {
    holderId: account.id,
    type: 'synced_passkey',
    wrappedBlob: 'opaque-wrapped-blob',
    keyringId: account.keyring_id,
    notificationChannels: { email: 'holder@example.com' },
    cancellationPubkey: 'cancellation-pubkey',
  });
}

async function expireNow(pool: Pool, recoveryId: string) {
  await pool.query(`UPDATE recovery_windows SET expires_at = now() - interval '1 second' WHERE id = $1`, [
    recoveryId,
  ]);
}

describe('recovery_windows repository', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates a window with expires_at ~72 hours out and status pending', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    expect(window.status).toBe('pending');
    const hoursOut = (window.expires_at.getTime() - window.initiated_at.getTime()) / (1000 * 60 * 60);
    expect(hoursOut).toBeGreaterThan(71.9);
    expect(hoursOut).toBeLessThan(72.1);
  });

  it('finds the active window for a backup registration', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    const active = await findActiveRecoveryWindow(pool, backup.id);
    expect(active?.id).toBe(window.id);
  });

  it('does not find an active window once cancelled', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    await cancelRecoveryWindow(pool, window.id);
    const active = await findActiveRecoveryWindow(pool, backup.id);
    expect(active).toBeNull();
  });

  it('cancels a pending, unexpired window exactly once (second cancel is a no-op at the DB layer)', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);

    const first = await cancelRecoveryWindow(pool, window.id);
    expect(first?.status).toBe('cancelled');

    const second = await cancelRecoveryWindow(pool, window.id);
    expect(second).toBeNull(); // already cancelled — caller layer treats this as idempotent 200
  });

  it('refuses to cancel an expired window', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    await expireNow(pool, window.id);

    const result = await cancelRecoveryWindow(pool, window.id);
    expect(result).toBeNull();

    const current = await findRecoveryWindowById(pool, window.id);
    expect(current?.status).toBe('pending'); // never transitioned — still 410-worthy at the route layer
  });

  it('refuses to release before expiry', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    const result = await releaseRecoveryWindow(pool, window.id);
    expect(result).toBeNull();
  });

  it('releases an expired, pending window and is idempotent on a second call returning null (caller re-reads)', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    await expireNow(pool, window.id);

    const released = await releaseRecoveryWindow(pool, window.id);
    expect(released?.status).toBe('released');

    const second = await releaseRecoveryWindow(pool, window.id);
    expect(second).toBeNull();
    const current = await findRecoveryWindowById(pool, window.id);
    expect(current?.status).toBe('released');
  });

  it('refuses to release a cancelled window', async () => {
    const backup = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    await cancelRecoveryWindow(pool, window.id);
    await expireNow(pool, window.id);

    const result = await releaseRecoveryWindow(pool, window.id);
    expect(result).toBeNull();
  });
});
