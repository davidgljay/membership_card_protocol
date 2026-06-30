import { describe, it, expect, vi } from 'vitest';
import { deliverToRelay } from '../src/relay-client.js';

describe('deliverToRelay', () => {
  it('returns delivered on 200', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await deliverToRelay('https://relay.example.com', 'uuid-1', 'blob', fetchImpl);
    expect(result).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://relay.example.com/deliver/uuid-1',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns uuid_invalid on 404', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await deliverToRelay('https://relay.example.com', 'uuid-1', 'blob', fetchImpl)).toBe('uuid_invalid');
  });

  it('returns uuid_invalid on 410', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }));
    expect(await deliverToRelay('https://relay.example.com', 'uuid-1', 'blob', fetchImpl)).toBe('uuid_invalid');
  });

  it('returns server_error on 500', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    expect(await deliverToRelay('https://relay.example.com', 'uuid-1', 'blob', fetchImpl)).toBe('server_error');
  });

  it('returns server_error (not a throw) when the relay is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(deliverToRelay('https://relay.example.com', 'uuid-1', 'blob', fetchImpl)).resolves.toBe(
      'server_error'
    );
  });
});
