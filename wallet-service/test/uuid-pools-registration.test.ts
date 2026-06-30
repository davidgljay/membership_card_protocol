import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  registerUuids,
  subcardHasAnyHistory,
  consumeAllForSubcard,
  pruneExpiredConsumedUuids,
  claimNextUuid,
} from '../server/db/uuid-pools.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

function randomUuids(n: number): string[] {
  return Array.from({ length: n }, () => crypto.randomUUID());
}

describe('uuid_pools registration / deregistration / pruning', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('registers a batch of UUIDs with ~30-day expiry', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const uuids = randomUuids(3);
    await registerUuids(pool, cardHash, subcardHash, uuids);

    const { rows } = await pool.query('SELECT uuid, expires_at, registered_at FROM uuid_pools WHERE card_hash = $1', [
      cardHash,
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.uuid).sort()).toEqual([...uuids].sort());
    const daysOut =
      (new Date(rows[0].expires_at).getTime() - new Date(rows[0].registered_at).getTime()) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(29.9);
    expect(daysOut).toBeLessThan(30.1);
  });

  it('is a no-op for re-registering an already-known uuid', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const uuids = randomUuids(1);
    await registerUuids(pool, cardHash, subcardHash, uuids);
    await registerUuids(pool, cardHash, subcardHash, uuids); // duplicate

    const { rows } = await pool.query('SELECT uuid FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    expect(rows).toHaveLength(1);
  });

  it('subcardHasAnyHistory is false before registration and true after', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    expect(await subcardHasAnyHistory(pool, cardHash, subcardHash)).toBe(false);

    await registerUuids(pool, cardHash, subcardHash, randomUuids(1));
    expect(await subcardHasAnyHistory(pool, cardHash, subcardHash)).toBe(true);
  });

  it('subcardHasAnyHistory stays true after all UUIDs are consumed (deregistered, not erased)', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    await registerUuids(pool, cardHash, subcardHash, randomUuids(2));
    await consumeAllForSubcard(pool, cardHash, subcardHash);
    expect(await subcardHasAnyHistory(pool, cardHash, subcardHash)).toBe(true);
  });

  it('consumeAllForSubcard marks every unconsumed uuid consumed and is idempotent', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    await registerUuids(pool, cardHash, subcardHash, randomUuids(3));

    const firstCount = await consumeAllForSubcard(pool, cardHash, subcardHash);
    expect(firstCount).toBe(3);

    const secondCount = await consumeAllForSubcard(pool, cardHash, subcardHash);
    expect(secondCount).toBe(0);

    // claimNextUuid should find nothing left
    expect(await claimNextUuid(pool, cardHash, subcardHash)).toBeNull();
  });

  it('prunes only expired, consumed rows', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    const subcardHash = `0xsubcard-${crypto.randomUUID()}`;
    const [expiredConsumed, expiredUnconsumed, freshConsumed] = randomUuids(3);

    await pool.query(
      `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, consumed, registered_at, expires_at)
       VALUES ($1, $2, $3, true, now() - interval '31 days', now() - interval '1 day')`,
      [expiredConsumed, cardHash, subcardHash]
    );
    await pool.query(
      `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, consumed, registered_at, expires_at)
       VALUES ($1, $2, $3, false, now() - interval '31 days', now() - interval '1 day')`,
      [expiredUnconsumed, cardHash, subcardHash]
    );
    await pool.query(
      `INSERT INTO uuid_pools (uuid, card_hash, subcard_hash, consumed, registered_at, expires_at)
       VALUES ($1, $2, $3, true, now(), now() + interval '30 days')`,
      [freshConsumed, cardHash, subcardHash]
    );

    await pruneExpiredConsumedUuids(pool);

    const { rows } = await pool.query('SELECT uuid FROM uuid_pools WHERE card_hash = $1', [cardHash]);
    const remaining = rows.map((r) => r.uuid);
    expect(remaining).not.toContain(expiredConsumed);
    expect(remaining).toContain(expiredUnconsumed);
    expect(remaining).toContain(freshConsumed);
  });
});
