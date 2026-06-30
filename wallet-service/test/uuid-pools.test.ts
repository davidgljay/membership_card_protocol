import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { claimNextUuid } from '../server/db/uuid-pools.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

async function seedUuid(pool: Pool, cardHash: string, subcardHash: string, registeredAt: Date) {
  const uuid = crypto.randomUUID();
  await pool.query(
    `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, registered_at, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
    [uuid, cardHash, subcardHash, registeredAt]
  );
  return uuid;
}

describe('uuid_pools.claimNextUuid', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('claims the oldest unconsumed uuid first (FIFO)', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = '0xsubcard';
    const older = await seedUuid(pool, cardHash, subcardHash, new Date('2026-01-01T00:00:00Z'));
    await seedUuid(pool, cardHash, subcardHash, new Date('2026-02-01T00:00:00Z'));

    const claimed = await claimNextUuid(pool, cardHash, subcardHash);
    expect(claimed).toBe(older);
  });

  it('never claims the same uuid twice', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = '0xsubcard';
    await seedUuid(pool, cardHash, subcardHash, new Date());

    const first = await claimNextUuid(pool, cardHash, subcardHash);
    const second = await claimNextUuid(pool, cardHash, subcardHash);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('returns null when no unconsumed uuids remain', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const claimed = await claimNextUuid(pool, cardHash, '0xsubcard');
    expect(claimed).toBeNull();
  });

  it('ignores expired uuids', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = '0xsubcard';
    const uuid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, registered_at, expires_at)
       VALUES ($1, $2, $3, now() - interval '31 days', now() - interval '1 day')`,
      [uuid, cardHash, subcardHash]
    );
    expect(await claimNextUuid(pool, cardHash, subcardHash)).toBeNull();
  });

  it('does not let two concurrent claims race onto the same uuid', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = '0xsubcard';
    await seedUuid(pool, cardHash, subcardHash, new Date());

    const [a, b] = await Promise.all([
      claimNextUuid(pool, cardHash, subcardHash),
      claimNextUuid(pool, cardHash, subcardHash),
    ]);
    const claimed = [a, b].filter((x) => x !== null);
    expect(claimed.length).toBe(1);
  });
});
