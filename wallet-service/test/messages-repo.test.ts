import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  enqueueMessage,
  findUnclearedMessagesForSubcard,
  setDeliveryUuid,
  clearMessageByDeliveryUuid,
} from '../server/db/messages.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

describe('message_queue repository', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('enqueues a message scoped to a subcard and finds it as uncleared', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const message = await enqueueMessage(pool, cardHash, subcardHash, 'opaque-payload');
    expect(message.subcard_hash).toBe(subcardHash);

    const uncleared = await findUnclearedMessagesForSubcard(pool, cardHash, subcardHash);
    expect(uncleared.map((m) => m.id)).toContain(message.id);
  });

  it('does not return another subcard\'s messages', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    await enqueueMessage(pool, cardHash, '0xsubcard-a', 'payload-a');
    const uncleared = await findUnclearedMessagesForSubcard(pool, cardHash, '0xsubcard-b');
    expect(uncleared).toEqual([]);
  });

  it('clears the correct message via its delivery uuid', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const message = await enqueueMessage(pool, cardHash, subcardHash, 'opaque-payload');
    const uuid = crypto.randomUUID();
    await setDeliveryUuid(pool, message.id, uuid);

    const cleared = await clearMessageByDeliveryUuid(pool, uuid);
    expect(cleared).toBe(true);

    const uncleared = await findUnclearedMessagesForSubcard(pool, cardHash, subcardHash);
    expect(uncleared.map((m) => m.id)).not.toContain(message.id);
  });

  it('returns false on a second clear of the same uuid', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const message = await enqueueMessage(pool, cardHash, subcardHash, 'opaque-payload');
    const uuid = crypto.randomUUID();
    await setDeliveryUuid(pool, message.id, uuid);

    expect(await clearMessageByDeliveryUuid(pool, uuid)).toBe(true);
    expect(await clearMessageByDeliveryUuid(pool, uuid)).toBe(false);
  });

  it('returns false for an unknown uuid', async () => {
    expect(await clearMessageByDeliveryUuid(pool, crypto.randomUUID())).toBe(false);
  });

  it('a later setDeliveryUuid call supersedes an earlier one for clearance purposes (retransmission)', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const message = await enqueueMessage(pool, cardHash, subcardHash, 'opaque-payload');
    const firstUuid = crypto.randomUUID();
    const secondUuid = crypto.randomUUID();
    await setDeliveryUuid(pool, message.id, firstUuid);
    await setDeliveryUuid(pool, message.id, secondUuid);

    expect(await clearMessageByDeliveryUuid(pool, firstUuid)).toBe(false); // no longer the current delivery uuid
    expect(await clearMessageByDeliveryUuid(pool, secondUuid)).toBe(true);
  });
});
