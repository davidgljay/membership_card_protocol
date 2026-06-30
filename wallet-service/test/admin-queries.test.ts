import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createAccount } from '../server/db/accounts.js';
import { createBackupRegistration } from '../server/db/backups.js';
import { createRecoveryWindow, listPendingRecoveryWindows, cancelRecoveryWindow } from '../server/db/recovery.js';
import { enqueueMessage, countHeldMessagesPerCard, clearMessageByDeliveryUuid, setDeliveryUuid } from '../server/db/messages.js';
import { registerUuids, listUuidPoolSizes, consumeAllForSubcard } from '../server/db/uuid-pools.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

async function makeBackup(pool: Pool) {
  const suffix = crypto.randomUUID();
  const account = await createAccount(pool, {
    cardHash: `0xtest-${suffix}`,
    masterPubkey: `pubkey-${suffix}`,
    keyringId: `0xtest-keyring-${suffix}`,
    serviceSecretEnc: `enc-${suffix}`,
    serviceSecretDekEnc: `dek-${suffix}`,
    webauthnCredentialId: `cred-${suffix}`,
    webauthnPublicKey: `cose-pubkey-${suffix}`,
  });
  const backup = await createBackupRegistration(pool, {
    holderId: account.id,
    type: 'synced_passkey',
    wrappedBlob: 'opaque-wrapped-blob',
    keyringId: account.keyring_id,
    notificationChannels: { email: 'holder@example.com' },
    cancellationPubkey: 'cancellation-pubkey',
  });
  return { account, backup };
}

describe('admin query functions (strategic-plan.md §Goal 5)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('listPendingRecoveryWindows includes a freshly created window with correct timing', async () => {
    const { backup } = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);

    const pending = await listPendingRecoveryWindows(pool);
    const found = pending.find((w) => w.id === window.id);
    expect(found).toBeDefined();
    expect(found!.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('listPendingRecoveryWindows excludes cancelled windows', async () => {
    const { backup } = await makeBackup(pool);
    const window = await createRecoveryWindow(pool, backup.id);
    await cancelRecoveryWindow(pool, window.id);

    const pending = await listPendingRecoveryWindows(pool);
    expect(pending.find((w) => w.id === window.id)).toBeUndefined();
  });

  it('countHeldMessagesPerCard counts only uncleared messages, grouped by card', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    await enqueueMessage(pool, cardHash, subcardHash, 'payload-1');
    const cleared = await enqueueMessage(pool, cardHash, subcardHash, 'payload-2');
    const uuid = crypto.randomUUID();
    await setDeliveryUuid(pool, cleared.id, uuid);
    await clearMessageByDeliveryUuid(pool, uuid);

    const counts = await countHeldMessagesPerCard(pool);
    const found = counts.find((c) => c.card_hash === cardHash);
    expect(found?.count).toBe(1); // only the uncleared one
  });

  it('listUuidPoolSizes counts only unconsumed, unexpired uuids per (card, subcard)', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    await registerUuids(pool, cardHash, subcardHash, [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]);

    const sizesBefore = await listUuidPoolSizes(pool);
    expect(sizesBefore.find((s) => s.card_hash === cardHash && s.subcard_hash === subcardHash)?.available).toBe(3);

    await consumeAllForSubcard(pool, cardHash, subcardHash);
    const sizesAfter = await listUuidPoolSizes(pool);
    expect(sizesAfter.find((s) => s.card_hash === cardHash && s.subcard_hash === subcardHash)).toBeUndefined();
  });
});
