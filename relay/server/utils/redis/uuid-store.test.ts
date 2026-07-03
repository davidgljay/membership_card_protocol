import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRedisHarness, type TestRedisHarness } from './test-harness';
import { UuidStore } from './uuid-store';

describe('UuidStore (against real RESP wire protocol + TLS, ioredis-mock command semantics)', () => {
  let harness: TestRedisHarness;
  let store: UuidStore;

  beforeEach(async () => {
    harness = await createTestRedisHarness();
    store = new UuidStore(harness.client, 2_592_000);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('creates a UUID record in unused status with a TTL set', async () => {
    await store.create('11111111-1111-4111-8111-111111111111', {
      app_id: 'test-app',
      push_token: 'tok-abc',
      wallet_base_url: 'https://wallet.example',
      device_credential: 'cred-xyz',
      created_at: '2026-07-02T00:00:00Z',
    });

    const record = await store.get('11111111-1111-4111-8111-111111111111');
    expect(record).toEqual({
      app_id: 'test-app',
      push_token: 'tok-abc',
      wallet_base_url: 'https://wallet.example',
      device_credential: 'cred-xyz',
      status: 'unused',
      created_at: '2026-07-02T00:00:00Z',
    });

    const ttl = await harness.client.ttl('uuid:11111111-1111-4111-8111-111111111111');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2_592_000);
  });

  it('returns null for a nonexistent UUID', async () => {
    const record = await store.get('00000000-0000-4000-8000-000000000000');
    expect(record).toBeNull();
  });

  describe('casTransition (Lua CAS script — relay_data_model.md §2.4)', () => {
    const uuid = '22222222-2222-4222-8222-222222222222';

    beforeEach(async () => {
      await store.create(uuid, {
        app_id: 'a',
        push_token: 'p',
        wallet_base_url: 'https://w.example',
        device_credential: 'c',
        created_at: '2026-07-02T00:00:00Z',
      });
    });

    it('succeeds when current status matches expected', async () => {
      const result = await store.casTransition(uuid, 'unused', 'in_flight');
      expect(result).toEqual({ ok: true });
      const record = await store.get(uuid);
      expect(record?.status).toBe('in_flight');
    });

    it('rejects with WRONG_STATUS when current status does not match', async () => {
      await store.casTransition(uuid, 'unused', 'in_flight'); // now in_flight
      const result = await store.casTransition(uuid, 'unused', 'consumed');
      expect(result).toEqual({
        ok: false,
        error: 'WRONG_STATUS',
        currentStatus: 'in_flight',
      });
    });

    it('rejects with NOT_FOUND for an unknown UUID', async () => {
      const result = await store.casTransition(
        '99999999-9999-4999-8999-999999999999',
        'unused',
        'in_flight'
      );
      expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('prevents double-delivery: two concurrent unused->in_flight only one wins', async () => {
      const [a, b] = await Promise.all([
        store.casTransition(uuid, 'unused', 'in_flight'),
        store.casTransition(uuid, 'unused', 'in_flight'),
      ]);
      const results = [a, b];
      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
    });
  });

  describe('simpleTransition (plain conditional update — relay_data_model.md §7.3 simplification)', () => {
    const uuid = '33333333-3333-4333-8333-333333333333';

    beforeEach(async () => {
      await store.create(uuid, {
        app_id: 'a',
        push_token: 'p',
        wallet_base_url: 'https://w.example',
        device_credential: 'c',
        created_at: '2026-07-02T00:00:00Z',
      });
    });

    it('unused -> active succeeds', async () => {
      const result = await store.simpleTransition(uuid, 'unused', 'active');
      expect(result.ok).toBe(true);
      const record = await store.get(uuid);
      expect(record?.status).toBe('active');
    });

    it('rejects wrong expected status', async () => {
      await store.simpleTransition(uuid, 'unused', 'active');
      const result = await store.simpleTransition(uuid, 'unused', 'active');
      expect(result).toEqual({ ok: false, error: 'WRONG_STATUS', currentStatus: 'active' });
    });
  });

  it('forceConsumed sets status to consumed unconditionally (reconciliation scan use)', async () => {
    const uuid = '44444444-4444-4444-8444-444444444444';
    await store.create(uuid, {
      app_id: 'a',
      push_token: 'p',
      wallet_base_url: 'https://w.example',
      device_credential: 'c',
      created_at: '2026-07-02T00:00:00Z',
    });
    await store.casTransition(uuid, 'unused', 'in_flight');
    await store.forceConsumed(uuid);
    const record = await store.get(uuid);
    expect(record?.status).toBe('consumed');
  });
});
