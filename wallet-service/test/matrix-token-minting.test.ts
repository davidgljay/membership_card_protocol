import { describe, it, expect, vi } from 'vitest';
import { mintMatrixAccessToken } from '../src/matrix/token-minting.js';
import type { KvStore } from '../src/kv.js';

// Same in-memory KvStore fixture as test/auth.test.ts.
function inMemoryKv(): KvStore {
  const store = new Map<string, { value: unknown; expiresAt: number | null }>();
  return {
    async getItem<T>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value as T;
    },
    async setItem<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    },
    async removeItem(key: string): Promise<void> {
      store.delete(key);
    },
    async increment(key: string, delta = 1): Promise<number> {
      const current = ((await this.getItem<number>(key)) ?? 0) + delta;
      await this.setItem(key, current);
      return current;
    },
  };
}

const MATRIX_USER_ID = '@card_' + 'ab'.repeat(32) + ':matrix.internal';
const SYNAPSE_BASE_URL = 'http://synapse:8008';
const AS_TOKEN = 'test-as-token';

describe('mintMatrixAccessToken (Step 15c)', () => {
  it('returns the expected shape, minted via Synapse /login as the AS', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`${SYNAPSE_BASE_URL}/_matrix/client/v3/login`);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${AS_TOKEN}`);
      const body = JSON.parse(init?.body as string);
      expect(body.type).toBe('m.login.application_service');
      expect(body.identifier).toEqual({ type: 'm.id.user', user: MATRIX_USER_ID });
      return new Response(JSON.stringify({ access_token: 'minted-token-1' }), { status: 200 });
    });

    const result = await mintMatrixAccessToken({
      matrixUserId: MATRIX_USER_ID,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      kv: inMemoryKv(),
      asToken: AS_TOKEN,
      fetchImpl,
    });

    expect(result).toEqual({ matrixAccessToken: 'minted-token-1', matrixUserId: MATRIX_USER_ID });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never mints twice for the same user while a cached token is still valid', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'minted-token-1' }), { status: 200 }));
    const kv = inMemoryKv();

    const first = await mintMatrixAccessToken({
      matrixUserId: MATRIX_USER_ID,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      kv,
      asToken: AS_TOKEN,
      fetchImpl,
    });
    const second = await mintMatrixAccessToken({
      matrixUserId: MATRIX_USER_ID,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      kv,
      asToken: AS_TOKEN,
      fetchImpl,
    });

    expect(first.matrixAccessToken).toBe('minted-token-1');
    expect(second.matrixAccessToken).toBe('minted-token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call served entirely from cache
  });

  it('mints a fresh token per distinct matrix_user_id (cache keys do not collide)', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return new Response(JSON.stringify({ access_token: `minted-token-${call}` }), { status: 200 });
    });
    const kv = inMemoryKv();
    const otherUserId = '@card_' + '01'.repeat(32) + ':matrix.internal';

    const first = await mintMatrixAccessToken({
      matrixUserId: MATRIX_USER_ID,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      kv,
      asToken: AS_TOKEN,
      fetchImpl,
    });
    const second = await mintMatrixAccessToken({
      matrixUserId: otherUserId,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      kv,
      asToken: AS_TOKEN,
      fetchImpl,
    });

    expect(first.matrixAccessToken).not.toBe(second.matrixAccessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when Synapse /login fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      mintMatrixAccessToken({
        matrixUserId: MATRIX_USER_ID,
        synapseBaseUrl: SYNAPSE_BASE_URL,
        kv: inMemoryKv(),
        asToken: AS_TOKEN,
        fetchImpl,
      })
    ).rejects.toThrow();
  });

  it('throws when Synapse /login responds 200 without an access_token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));

    await expect(
      mintMatrixAccessToken({
        matrixUserId: MATRIX_USER_ID,
        synapseBaseUrl: SYNAPSE_BASE_URL,
        kv: inMemoryKv(),
        asToken: AS_TOKEN,
        fetchImpl,
      })
    ).rejects.toThrow();
  });
});
