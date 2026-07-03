import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRedisHarness, type TestRedisHarness } from './test-harness';
import { MessageStore } from './message-store';

describe('MessageStore (relay_data_model.md §3)', () => {
  let harness: TestRedisHarness;
  let store: MessageStore;

  beforeEach(async () => {
    harness = await createTestRedisHarness();
    store = new MessageStore(harness.client, 2_592_000);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('appends messages keyed by device_credential, not push_token', async () => {
    await store.append('cred-1', {
      uuid: 'u1',
      blob: 'blob1',
      wallet_url: 'https://wallet.example',
      received_at: '2026-07-02T00:00:00Z',
    });
    await store.append('cred-1', {
      uuid: 'u2',
      blob: 'blob2',
      wallet_url: 'https://wallet.example',
      received_at: '2026-07-02T00:01:00Z',
    });

    const ttl = await harness.client.ttl('messages:cred-1');
    expect(ttl).toBeGreaterThan(0);

    const entries = await store.readAndClear('cred-1');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.uuid).toBe('u1');
    expect(entries[1]?.uuid).toBe('u2');
  });

  it('readAndClear atomically empties the store (relay.md §7.5)', async () => {
    await store.append('cred-2', {
      uuid: 'u1',
      blob: 'blob1',
      wallet_url: 'https://wallet.example',
      received_at: '2026-07-02T00:00:00Z',
    });
    const first = await store.readAndClear('cred-2');
    expect(first).toHaveLength(1);
    const second = await store.readAndClear('cred-2');
    expect(second).toHaveLength(0);
  });

  it('two different credentials with different values have isolated stores (relay_data_model.md §8.1 isolation)', async () => {
    await store.append('cred-a', {
      uuid: 'ua',
      blob: 'blob-a',
      wallet_url: 'https://wallet.example',
      received_at: '2026-07-02T00:00:00Z',
    });
    await store.append('cred-b', {
      uuid: 'ub',
      blob: 'blob-b',
      wallet_url: 'https://wallet.example',
      received_at: '2026-07-02T00:00:00Z',
    });

    const aEntries = await store.readAndClear('cred-a');
    expect(aEntries.map((e) => e.uuid)).toEqual(['ua']);

    const bEntries = await store.readAndClear('cred-b');
    expect(bEntries.map((e) => e.uuid)).toEqual(['ub']);
  });

  it('readAndClear on an empty/nonexistent store returns an empty array, not an error', async () => {
    const entries = await store.readAndClear('never-existed');
    expect(entries).toEqual([]);
  });
});
