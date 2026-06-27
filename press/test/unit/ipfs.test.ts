/**
 * Filebase IPFS client unit tests.
 *
 * All S3 and network calls are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createIpfsClient } from '../../src/ipfs/client.js';
import type { PressConfig } from '../../src/config.js';

const MOCK_CONFIG = {
  FILEBASE_KEY: 'test-key',
  FILEBASE_SECRET: 'test-secret',
  FILEBASE_BUCKET: 'test-bucket',
  FILEBASE_GATEWAY_URL: 'https://ipfs.filebase.io',
} as unknown as PressConfig;

const SAMPLE_BYTES = new TextEncoder().encode('{"card":"data","version":1}');
const MOCK_CID = 'bafybeiabc123testcid';

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-s3
// ---------------------------------------------------------------------------

const mockSend = vi.fn();
const mockMiddlewareStack = {
  resolve: vi.fn((middleware, _opts) => {
    // Execute the middleware with a mock next handler and capture the CID
    // returned by the middleware interceptor.
    return async (command: unknown) => {
      const mockNext = vi.fn().mockResolvedValue({
        output: {},
        response: {
          headers: { 'x-amz-meta-cid': MOCK_CID },
        },
      });
      return middleware(mockNext)(command);
    };
  }),
};

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockSend,
    middlewareStack: mockMiddlewareStack,
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
    // Default: HeadObject (fallback) returns no CID; middleware path is primary.
    mockSend.mockResolvedValue({ Metadata: {} });
  });

  it('returns the CID when upload succeeds and content matches', async () => {
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;
    const client = createIpfsClient(MOCK_CONFIG);
    const cid = await client.pinToIPFS(SAMPLE_BYTES);
    expect(cid).toBe(MOCK_CID);
  });

  it('throws P-10 when fetched bytes differ from uploaded bytes', async () => {
    const differentBytes = new TextEncoder().encode('different content');
    global.fetch = makeFetchMock(differentBytes) as typeof fetch;
    const client = createIpfsClient(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-10',
    });
  });

  it('falls back to HeadObject when x-amz-meta-cid header is absent', async () => {
    // Middleware returns response with no CID header.
    mockMiddlewareStack.resolve.mockImplementationOnce((middleware, _opts) => {
      return async (command: unknown) => {
        const mockNext = vi.fn().mockResolvedValue({
          output: {},
          response: { headers: {} }, // no CID header
        });
        return middleware(mockNext)(command);
      };
    });
    // HeadObject fallback returns CID in Metadata.
    mockSend.mockResolvedValueOnce({ Metadata: { cid: MOCK_CID } });
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;

    const client = createIpfsClient(MOCK_CONFIG);
    const cid = await client.pinToIPFS(SAMPLE_BYTES);
    expect(cid).toBe(MOCK_CID);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ _type: 'HeadObject' }));
  });

  it('throws P-24 when the S3 upload itself throws', async () => {
    mockMiddlewareStack.resolve.mockImplementationOnce((middleware, _opts) => {
      return async () => {
        throw new Error('Network error');
      };
    });
    const client = createIpfsClient(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-24',
    });
  });

  it('throws P-10 when the gateway fetch fails after upload', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 504 }) as typeof fetch;
    const client = createIpfsClient(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-10',
    });
  });
});

describe('fetchFromIPFS', () => {
  it('returns bytes from the gateway', async () => {
    global.fetch = makeFetchMock(SAMPLE_BYTES) as typeof fetch;
    const client = createIpfsClient(MOCK_CONFIG);
    const result = await client.fetchFromIPFS(MOCK_CID);
    expect(result).toEqual(SAMPLE_BYTES);
    expect(global.fetch).toHaveBeenCalledWith(
      `${MOCK_CONFIG.FILEBASE_GATEWAY_URL}/ipfs/${MOCK_CID}`
    );
  });

  it('throws when the gateway returns a non-200 status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    const client = createIpfsClient(MOCK_CONFIG);
    await expect(client.fetchFromIPFS(MOCK_CID)).rejects.toThrow('404');
  });
});
