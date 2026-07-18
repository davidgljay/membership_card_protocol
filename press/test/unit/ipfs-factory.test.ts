import { describe, it, expect } from 'vitest';
import { createIpfsClient } from '../../src/ipfs/index.js';
import type { PressConfig } from '../../src/config.js';

describe('createIpfsClient', () => {
  it('returns a provider with the IpfsPinningProvider shape for each IPFS_PROVIDER value', () => {
    const base = {
      FILEBASE_KEY: 'k',
      FILEBASE_SECRET: 's',
      FILEBASE_BUCKET: 'b',
      FILEBASE_GATEWAY_URL: 'https://ipfs.filebase.io',
      FILEBASE_ENDPOINT: 'https://s3.filebase.com',
      FILEBASE_REGION: 'us-east-1',
      KUBO_API_URL: 'http://ipfs:5001',
      KUBO_GATEWAY_URL: 'http://ipfs:8080',
    };

    for (const provider of ['filebase', 'kubo', 'mock'] as const) {
      const config = { ...base, IPFS_PROVIDER: provider } as unknown as PressConfig;
      const client = createIpfsClient(config);
      expect(typeof client.pinToIPFS).toBe('function');
      expect(typeof client.fetchFromIPFS).toBe('function');
      expect(typeof client.checkHealth).toBe('function');
    }
  });
});
