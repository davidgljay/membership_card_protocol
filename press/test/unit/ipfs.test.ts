/**
 * Piñata IPFS client unit tests.
 *
 * All network calls are mocked so these run offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createIpfsClient } from '../../src/ipfs/client.js';
import type { PressConfig } from '../../src/config.js';

const MOCK_CONFIG = {
  PINATA_JWT: 'test-jwt',
  PINATA_GATEWAY_URL: 'https://test.mypinata.cloud',
} as unknown as PressConfig;

const SAMPLE_BYTES = new TextEncoder().encode('{"card":"data","version":1}');
const MOCK_CID = 'bafybeiabc123testcid';

// ---------------------------------------------------------------------------
// Mock PinataSDK
// ---------------------------------------------------------------------------

vi.mock('pinata', () => {
  return {
    PinataSDK: vi.fn().mockImplementation(() => ({
      upload: {
        public: {
          file: vi.fn().mockResolvedValue({ cid: MOCK_CID }),
        },
      },
    })),
  };
});

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

  it('throws P-24 when the Piñata upload itself fails', async () => {
    const { PinataSDK } = await import('pinata');
    vi.mocked(PinataSDK).mockImplementationOnce(() => ({
      upload: {
        public: {
          file: vi.fn().mockRejectedValue(new Error('Network error')),
        },
      },
    }) as never);
    const client = createIpfsClient(MOCK_CONFIG);
    await expect(client.pinToIPFS(SAMPLE_BYTES)).rejects.toMatchObject({
      pressCode: 'P-24',
    });
  });

  it('throws P-10 when the gateway fetch fails after upload', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
    }) as typeof fetch;
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
      `${MOCK_CONFIG.PINATA_GATEWAY_URL}/ipfs/${MOCK_CID}`
    );
  });

  it('throws when the gateway returns a non-200 status', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    const client = createIpfsClient(MOCK_CONFIG);
    await expect(client.fetchFromIPFS(MOCK_CID)).rejects.toThrow('404');
  });
});
