import { describe, it, expect, vi } from 'vitest';
import { provisionShadowAccount } from '../src/matrix/provisioning.js';
import { deriveMatrixUserId } from '../src/matrix/account-id.js';

// Mirrors test/relay-client.test.ts's convention of injecting a fetchImpl
// mock rather than hitting the network (matrix-implementation-plan.md
// Phase 4 Step 15b).
const CARD_HASH = '0x' + 'ab'.repeat(32);
const SERVER_NAME = 'matrix.internal';
const SYNAPSE_BASE_URL = 'http://synapse:8008';
const AS_TOKEN = 'test-as-token';

describe('provisionShadowAccount (Step 15b)', () => {
  it('registers the derived shadow account and reports created: true on success', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`${SYNAPSE_BASE_URL}/_matrix/client/v3/register`);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${AS_TOKEN}`);
      const body = JSON.parse(init?.body as string);
      expect(body.type).toBe('m.login.application_service');
      const expectedUserId = deriveMatrixUserId(CARD_HASH, SERVER_NAME);
      expect(`@${body.username}:${SERVER_NAME}`).toBe(expectedUserId);
      return new Response(JSON.stringify({ user_id: expectedUserId }), { status: 200 });
    });

    const result = await provisionShadowAccount({
      cardHash: CARD_HASH,
      serverName: SERVER_NAME,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      asToken: AS_TOKEN,
      fetchImpl,
    });

    expect(result.matrixUserId).toBe(deriveMatrixUserId(CARD_HASH, SERVER_NAME));
    expect(result.created).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: M_USER_IN_USE is treated as success (created: false), not an error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errcode: 'M_USER_IN_USE', error: 'User ID already taken.' }), { status: 400 })
    );

    const result = await provisionShadowAccount({
      cardHash: CARD_HASH,
      serverName: SERVER_NAME,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      asToken: AS_TOKEN,
      fetchImpl,
    });

    expect(result.matrixUserId).toBe(deriveMatrixUserId(CARD_HASH, SERVER_NAME));
    expect(result.created).toBe(false);
  });

  it('calling it twice for the same card succeeds both times', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ user_id: 'whatever' }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 'M_USER_IN_USE' }), { status: 400 });
    });

    const first = await provisionShadowAccount({
      cardHash: CARD_HASH,
      serverName: SERVER_NAME,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      asToken: AS_TOKEN,
      fetchImpl,
    });
    const second = await provisionShadowAccount({
      cardHash: CARD_HASH,
      serverName: SERVER_NAME,
      synapseBaseUrl: SYNAPSE_BASE_URL,
      asToken: AS_TOKEN,
      fetchImpl,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.matrixUserId).toBe(second.matrixUserId);
  });

  it('throws on an unexpected Synapse error (not M_USER_IN_USE)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errcode: 'M_UNKNOWN', error: 'Something else broke.' }), { status: 400 })
    );

    await expect(
      provisionShadowAccount({
        cardHash: CARD_HASH,
        serverName: SERVER_NAME,
        synapseBaseUrl: SYNAPSE_BASE_URL,
        asToken: AS_TOKEN,
        fetchImpl,
      })
    ).rejects.toThrow();
  });

  it('throws on a 5xx from Synapse', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      provisionShadowAccount({
        cardHash: CARD_HASH,
        serverName: SERVER_NAME,
        synapseBaseUrl: SYNAPSE_BASE_URL,
        asToken: AS_TOKEN,
        fetchImpl,
      })
    ).rejects.toThrow();
  });
});
