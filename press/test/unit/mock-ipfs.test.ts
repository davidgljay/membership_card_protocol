import { describe, it, expect } from 'vitest';
import { createMockProvider } from '../../src/ipfs/mock.js';

describe('createMockProvider', () => {
  it('round-trips pinned content by CID', async () => {
    const provider = createMockProvider();
    const bytes = new TextEncoder().encode('{"card":"data"}');
    const cid = await provider.pinToIPFS(bytes);
    expect(cid).toMatch(/^mockcid/);
    await expect(provider.fetchFromIPFS(cid)).resolves.toEqual(bytes);
  });

  it('throws when fetching an unpinned CID', async () => {
    const provider = createMockProvider();
    await expect(provider.fetchFromIPFS('mockcidnonexistent')).rejects.toThrow(
      'no content pinned'
    );
  });

  it('checkHealth always resolves', async () => {
    const provider = createMockProvider();
    await expect(provider.checkHealth()).resolves.toBeUndefined();
  });

  it('is isolated per instance (no shared state across providers)', async () => {
    const a = createMockProvider();
    const b = createMockProvider();
    const cid = await a.pinToIPFS(new TextEncoder().encode('only in a'));
    await expect(b.fetchFromIPFS(cid)).rejects.toThrow();
  });
});
