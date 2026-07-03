import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRedisHarness, type TestRedisHarness } from './test-harness';
import { CredentialStore } from './credential-store';

describe('CredentialStore (relay_data_model.md §8)', () => {
  let harness: TestRedisHarness;
  let store: CredentialStore;

  beforeEach(async () => {
    harness = await createTestRedisHarness();
    store = new CredentialStore(harness.client, 2_592_000);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('creates a credential record with TTL', async () => {
    await store.create('cred-1', {
      push_token: 'tok-1',
      app_id: 'app-1',
      created_at: '2026-07-02T00:00:00Z',
    });
    const record = await store.get('cred-1');
    expect(record).toEqual({
      push_token: 'tok-1',
      app_id: 'app-1',
      created_at: '2026-07-02T00:00:00Z',
    });
    const ttl = await harness.client.ttl('cred:cred-1');
    expect(ttl).toBeGreaterThan(0);
  });

  it('returns null for an unknown credential (relay.md §7.1 INVALID_CREDENTIAL case)', async () => {
    const record = await store.get('never-issued');
    expect(record).toBeNull();
  });

  it('refresh updates push_token and resets TTL (replenishment path, relay.md §7.1)', async () => {
    await store.create('cred-2', {
      push_token: 'old-token',
      app_id: 'app-1',
      created_at: '2026-07-02T00:00:00Z',
    });
    await store.refresh('cred-2', 'new-token');
    const record = await store.get('cred-2');
    expect(record?.push_token).toBe('new-token');
    // app_id and created_at unchanged.
    expect(record?.app_id).toBe('app-1');
  });

  it('exists() reflects presence', async () => {
    expect(await store.exists('cred-3')).toBe(false);
    await store.create('cred-3', {
      push_token: 't',
      app_id: 'a',
      created_at: '2026-07-02T00:00:00Z',
    });
    expect(await store.exists('cred-3')).toBe(true);
  });
});
