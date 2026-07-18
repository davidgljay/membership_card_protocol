/**
 * Kubo IPFS provider unit tests. All network calls are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKuboProvider } from '../../src/ipfs/kubo.js';
import type { PressConfig } from '../../src/config.js';

const MOCK_CONFIG = {
  KUBO_API_URL: 'http://ipfs:5001',
  KUBO_GATEWAY_URL: 'http://ipfs:8080',
} as unknown as PressConfig;

const SAMPLE_BYTES = new TextEncoder().encode('{"card":"data","version":1}');
const MOCK_CID = 'bafybeiabc123testcid';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

function bytesResponse(bytes: Uint8Array, ok = true, status = 200) {
  return { ok, status, arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) };
}

describe('pinToIPFS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the CID when add succeeds and content matches', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Hash: MOCK_CID }))
      .mockResolvedValueOnce(bytesResponse(SAMPLE_BYTES)) as typeof fetch;

    const client = createKuboProvider(MOCK_CONFIG);
    const cid = await client.pinToIPFS(SAMPLE_BYTES);
    expect(cid).toBe(MOCK_CID);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      `${MOCK_CONFIG.KUBO_API_URL}/api/v0/add?cid-version=1&pin=true`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws P-24 when the add call fails', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({}, false, 500)) as typeof fetch;
    const client = createKuboProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({ pressCode: 'P-24' });
  });

  it('throws P-24 when the add response has no Hash', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({})) as typeof fetch;
    const client = createKuboProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({ pressCode: 'P-24' });
  });

  it('throws P-10 when fetched bytes differ from uploaded bytes', async () => {
    const differentBytes = new TextEncoder().encode('different content');
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ Hash: MOCK_CID }))
      .mockResolvedValueOnce(bytesResponse(differentBytes)) as typeof fetch;

    const client = createKuboProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({ pressCode: 'P-10' });
  });
});

describe('fetchFromIPFS', () => {
  it('returns bytes from the gateway', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(bytesResponse(SAMPLE_BYTES)) as typeof fetch;
    const client = createKuboProvider(MOCK_CONFIG);
    const result = await client.fetchFromIPFS(MOCK_CID);
    expect(result).toEqual(SAMPLE_BYTES);
    expect(global.fetch).toHaveBeenCalledWith(`${MOCK_CONFIG.KUBO_GATEWAY_URL}/ipfs/${MOCK_CID}`);
  });

  it('throws when the gateway returns a non-200 status', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(bytesResponse(new Uint8Array(), false, 404)) as typeof fetch;
    const client = createKuboProvider(MOCK_CONFIG);
    await expect(client.fetchFromIPFS(MOCK_CID)).rejects.toThrow('404');
  });
});

describe('checkHealth', () => {
  it('resolves when the Kubo node responds to /api/v0/id', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ ID: 'peer-id' })) as typeof fetch;
    const client = createKuboProvider(MOCK_CONFIG);
    await expect(client.checkHealth()).resolves.toBeUndefined();
  });

  it('throws when the Kubo node is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('connection refused')) as typeof fetch;
    const client = createKuboProvider(MOCK_CONFIG);
    await expect(client.checkHealth()).rejects.toThrow('connection refused');
  });
});
