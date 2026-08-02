/**
 * Filebase IPFS provider unit tests.
 *
 * All aws4fetch and network calls are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFilebaseProvider } from '../../src/ipfs/filebase.js';
import type { PressConfig } from '../../src/config.js';

const MOCK_CONFIG = {
  FILEBASE_KEY: 'test-key',
  FILEBASE_SECRET: 'test-secret',
  FILEBASE_BUCKET: 'test-bucket',
  FILEBASE_GATEWAY_URL: 'https://ipfs.filebase.io',
  FILEBASE_ENDPOINT: 'https://s3.filebase.com',
  FILEBASE_REGION: 'us-east-1',
} as unknown as PressConfig;

const SAMPLE_BYTES = new TextEncoder().encode('{"card":"data","version":1}');
const MOCK_CID = 'bafybeiabc123testcid';

// ---------------------------------------------------------------------------
// Mock aws4fetch
//
// The real implementation (filebase.ts) does a two-round-trip upload: PUT,
// then HEAD to recover the Filebase-assigned CID from the x-amz-meta-cid
// response header. The mock only needs to answer `.fetch()` for PUT/HEAD
// requests against the object URL.
// ---------------------------------------------------------------------------

const mockAwsFetch = vi.fn();

vi.mock('aws4fetch', () => ({
  AwsClient: vi.fn().mockImplementation(() => ({
    fetch: mockAwsFetch,
  })),
}));

function jsonHeaders(cid?: string): Headers {
  const h = new Headers();
  if (cid) h.set('x-amz-meta-cid', cid);
  return h;
}

// ---------------------------------------------------------------------------
// Mock fetch for gateway requests
// ---------------------------------------------------------------------------

function makeFetchMock(responseBytes: Uint8Array) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(responseBytes.buffer.slice(0)),
  });
}

describe('pinToIPFS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default sequence: PUT succeeds, then HEAD returns the CID via header.
    mockAwsFetch
      .mockResolvedValueOnce({ ok: true, status: 200 }) // PUT
      .mockResolvedValueOnce({ ok: true, status: 200, headers: jsonHeaders(MOCK_CID) }); // HEAD
  });

  it('returns the CID when upload succeeds and content matches', async () => {
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    const cid = await client.pinToIPFS(SAMPLE_BYTES);
    expect(cid).toBe(MOCK_CID);
    expect(mockAwsFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'PUT' }));
    expect(mockAwsFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'HEAD' }));
  });

  it('throws P-10 when fetched bytes differ from uploaded bytes', async () => {
    const differentBytes = new TextEncoder().encode('different content');
    global.fetch = makeFetchMock(differentBytes) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-10',
    });
  });

  it('throws P-24 when the HEAD response has no cid header', async () => {
    mockAwsFetch.mockReset();
    mockAwsFetch
      .mockResolvedValueOnce({ ok: true, status: 200 }) // PUT
      .mockResolvedValueOnce({ ok: true, status: 200, headers: jsonHeaders() }); // HEAD: no cid
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;

    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-24',
    });
  });

  it('throws P-24 when the PUT itself fails', async () => {
    mockAwsFetch.mockReset();
    mockAwsFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-24',
    });
  });

  it('throws P-10 when the gateway fetch fails after upload', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 504 }) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-10',
    });
  });
});

describe('fetchFromIPFS', () => {
  it('returns bytes from the gateway', async () => {
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    const result = await client.fetchFromIPFS(MOCK_CID);
    expect(result).toEqual(SAMPLE_BYTES);
    expect(global.fetch).toHaveBeenCalledWith(
      `${MOCK_CONFIG.FILEBASE_GATEWAY_URL}/ipfs/${MOCK_CID}`
    );
  });

  it('throws when the gateway returns a non-200 status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.fetchFromIPFS(MOCK_CID)).rejects.toThrow('404');
  });
});

describe('checkHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves when HEAD returns 404 (bucket reachable, key absent)', async () => {
    mockAwsFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.checkHealth()).resolves.toBeUndefined();
  });

  it('throws when HEAD fails for any other reason', async () => {
    mockAwsFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.checkHealth()).rejects.toThrow('403');
  });
});
