import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { Pool } from 'pg';
import { enqueueMessage } from '../server/db/messages.js';
import { deliverMessage } from '../server/utils/message-delivery.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

async function seedUuid(pool: Pool, cardHash: string, subcardHash: string) {
  const uuid = crypto.randomUUID();
  await pool.query(
    `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, registered_at, expires_at)
     VALUES ($1, $2, $3, now(), now() + interval '30 days')`,
    [uuid, cardHash, subcardHash]
  );
  return uuid;
}

describe('deliverMessage', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers to relay and records the delivery uuid on success', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const uuid = await seedUuid(pool, cardHash, subcardHash);
    const message = await enqueueMessage(pool, cardHash, subcardHash, Buffer.from('payload').toString('base64url'));

    const fetchMock = vi.fn(async (url: string) => new Response(null, { status: url.includes(uuid) ? 200 : 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await deliverMessage(pool, message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query('SELECT delivery_uuid FROM message_queue WHERE id = $1', [message.id]);
    expect(rows[0]?.delivery_uuid).toBe(uuid);
  });

  it('advances to the next uuid on 404/410 and delivers successfully', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const badUuid = await seedUuid(pool, cardHash, subcardHash);
    const goodUuid = await seedUuid(pool, cardHash, subcardHash);
    const message = await enqueueMessage(pool, cardHash, subcardHash, Buffer.from('payload').toString('base64url'));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(badUuid)) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await deliverMessage(pool, message);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const { rows } = await pool.query('SELECT delivery_uuid FROM message_queue WHERE id = $1', [message.id]);
    expect(rows[0]?.delivery_uuid).toBe(goodUuid);
  });

  it('advances to the next uuid on a 5xx relay error', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const badUuid = await seedUuid(pool, cardHash, subcardHash);
    const goodUuid = await seedUuid(pool, cardHash, subcardHash);
    const message = await enqueueMessage(pool, cardHash, subcardHash, Buffer.from('payload').toString('base64url'));

    const fetchMock = vi.fn(async (url: string) => new Response(null, { status: url.includes(badUuid) ? 500 : 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await deliverMessage(pool, message);

    const { rows } = await pool.query('SELECT delivery_uuid FROM message_queue WHERE id = $1', [message.id]);
    expect(rows[0]?.delivery_uuid).toBe(goodUuid);
  });

  it('gives up (no throw) when the uuid pool is exhausted', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    // no UUIDs registered at all
    const message = await enqueueMessage(pool, cardHash, subcardHash, Buffer.from('payload').toString('base64url'));

    vi.stubGlobal('fetch', vi.fn());
    await expect(deliverMessage(pool, message)).resolves.toBeUndefined();
  });
});
