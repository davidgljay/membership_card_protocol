import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  findRoutingEntry,
  upsertRoutingEntry,
  recordNonceIfNew,
  listRoutingTable,
  type RoutingTableRow,
} from '../server/db/routing.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wallet_service:wallet_service@localhost:5433/wallet_service';

function row(cardHash: string, overrides: Partial<RoutingTableRow> = {}): RoutingTableRow {
  return {
    card_hash: cardHash,
    wallet_service_id: '0xws1',
    endpoint: 'https://ws1.example.com',
    type: 'card_registration',
    announced_at: new Date(),
    nonce: crypto.randomUUID(),
    signatures: [{ public_key: 'pk', role: 'wallet_service', signature: 'sig' }],
    ...overrides,
  };
}

describe('routing_table / routing_nonces repository', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('upserts and finds a routing entry, round-tripping signatures', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    await upsertRoutingEntry(pool, row(cardHash));
    const found = await findRoutingEntry(pool, cardHash);
    expect(found?.wallet_service_id).toBe('0xws1');
    expect(found?.signatures).toEqual([{ public_key: 'pk', role: 'wallet_service', signature: 'sig' }]);
  });

  it('overwrites the existing row on a second upsert (current-binding-only semantics)', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    await upsertRoutingEntry(pool, row(cardHash, { wallet_service_id: '0xws1' }));
    await upsertRoutingEntry(pool, row(cardHash, { wallet_service_id: '0xws2', nonce: crypto.randomUUID() }));
    const found = await findRoutingEntry(pool, cardHash);
    expect(found?.wallet_service_id).toBe('0xws2');
  });

  it('records a new nonce exactly once', async () => {
    const nonce = crypto.randomUUID();
    expect(await recordNonceIfNew(pool, nonce)).toBe(true);
    expect(await recordNonceIfNew(pool, nonce)).toBe(false);
  });

  it('lists the full routing table', async () => {
    const cardHash = `0xtest-${crypto.randomUUID()}`;
    await upsertRoutingEntry(pool, row(cardHash));
    const all = await listRoutingTable(pool);
    expect(all.some((r) => r.card_hash === cardHash)).toBe(true);
  });
});
