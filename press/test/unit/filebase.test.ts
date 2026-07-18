/**
 * Filebase IPFS provider unit tests.
 *
 * All S3 and network calls are mocked so these run offline.
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
// Mock @aws-sdk/client-s3
//
// The real implementation (filebase.ts) does a two-round-trip upload:
// PutObjectCommand, then HeadObjectCommand to recover the Filebase-assigned
// CID from object metadata. It never reads response middleware/headers, so
// the mock only needs to answer `send()` for those two command types.
// ---------------------------------------------------------------------------

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input, _type: 'PutObject' })),
  HeadObjectCommand: vi.fn().mockImplementation((input) => ({ input, _type: 'HeadObject' })),
}));

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
    // Default sequence: PutObject succeeds, then HeadObject returns the CID
    // in object metadata (the only mechanism the real code reads from).
    mockSend
      .mockResolvedValueOnce({}) // PutObjectCommand response (unused)
      .mockResolvedValueOnce({ Metadata: { cid: MOCK_CID } }); // HeadObjectCommand response
  });

  it('returns the CID when upload succeeds and content matches', async () => {
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    const cid = await client.pinToIPFS(SAMPLE_BYTES);
    expect(cid).toBe(MOCK_CID);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ _type: 'PutObject' }));
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ _type: 'HeadObject' }));
  });

  it('throws P-10 when fetched bytes differ from uploaded bytes', async () => {
    const differentBytes = new TextEncoder().encode('different content');
    global.fetch = makeFetchMock(differentBytes) as typeof fetch;
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-10',
    });
  });

  it('throws P-24 when HeadObject metadata has no cid', async () => {
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({}) // PutObjectCommand response
      .mockResolvedValueOnce({ Metadata: {} }); // HeadObjectCommand: no cid
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;

    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-24',
    });
  });

  it('throws P-24 when the S3 upload itself throws', async () => {
    mockSend.mockReset();
    mockSend.mockRejectedValueOnce(new Error('Network error'));
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

  it('resolves when HeadObject rejects with NotFound (bucket reachable, key absent)', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'NotFound' }));
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.checkHealth()).resolves.toBeUndefined();
  });

  it('throws when HeadObject fails for any other reason', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('access denied'), { name: 'AccessDenied' }));
    const client = createFilebaseProvider(MOCK_CONFIG);
    await expect(client.checkHealth()).rejects.toThrow('access denied');
  });
});
