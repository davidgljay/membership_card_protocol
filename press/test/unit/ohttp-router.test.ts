const mockHandleIssue = vi.fn();
const mockHandleIssueFinalize = vi.fn();
const mockHandleOpenOfferClaim = vi.fn();
const mockHandleUpdate = vi.fn();
const mockHandleSubCardRegister = vi.fn();
const mockHandleSubCardDeregister = vi.fn();

vi.mock('../../src/handlers/issue.js', () => ({
  handleIssue: (...args: unknown[]) => mockHandleIssue(...args),
  handleIssueFinalize: (...args: unknown[]) => mockHandleIssueFinalize(...args),
}));
vi.mock('../../src/handlers/open-offer.js', () => ({
  handleOpenOfferClaim: (...args: unknown[]) => mockHandleOpenOfferClaim(...args),
}));
vi.mock('../../src/handlers/update.js', () => ({
  handleUpdate: (...args: unknown[]) => mockHandleUpdate(...args),
}));
vi.mock('../../src/handlers/sub-card.js', () => ({
  handleSubCardRegister: (...args: unknown[]) => mockHandleSubCardRegister(...args),
  handleSubCardDeregister: (...args: unknown[]) => mockHandleSubCardDeregister(...args),
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dispatch } from '../../src/ohttp-router.js';
import type { PressContext } from '../../src/context.js';

const FAKE_CTX = {} as PressContext;

function encodeBody(body: unknown): string {
  return Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url');
}

function decodeBody<T>(body: string | undefined): T | undefined {
  if (!body) return undefined;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('press ohttp-router dispatch (client-sdk implementation plan Step 1.4d)', () => {
  it('routes each of the six sensitive endpoints to the exact handler function the plaintext route calls, with the decoded body', async () => {
    const cases: Array<[string, string, ReturnType<typeof vi.fn>]> = [
      ['/issue', 'POST', mockHandleIssue],
      ['/issue/finalize', 'POST', mockHandleIssueFinalize],
      ['/open-offer/claim', 'POST', mockHandleOpenOfferClaim],
      ['/update', 'POST', mockHandleUpdate],
      ['/sub-card/register', 'POST', mockHandleSubCardRegister],
      ['/sub-card/deregister', 'POST', mockHandleSubCardDeregister],
    ];

    for (const [path, method, mockFn] of cases) {
      mockFn.mockResolvedValueOnce({ ok: true, path });
      const body = { some: 'payload', for: path };

      const response = await dispatch({ path, method, body: encodeBody(body) }, FAKE_CTX);

      expect(mockFn).toHaveBeenCalledWith(FAKE_CTX, body);
      expect(response.status).toBe(200);
      expect(decodeBody(response.body)).toEqual({ ok: true, path });
    }
  });

  it('maps a thrown pressCode error to a 400-equivalent sealed response, same as the plaintext route', async () => {
    mockHandleIssue.mockRejectedValueOnce(
      Object.assign(new Error('P-02: predicate failed'), { pressCode: 'P-02' })
    );

    const response = await dispatch({ path: '/issue', method: 'POST', body: encodeBody({}) }, FAKE_CTX);

    expect(response.status).toBe(400);
    expect(decodeBody(response.body)).toMatchObject({ error: 'P-02' });
  });

  it('rejects a path outside the six reachable endpoints with 404 rather than forwarding it', async () => {
    const response = await dispatch({ path: '/press', method: 'GET' }, FAKE_CTX);

    expect(response.status).toBe(404);
    expect(mockHandleIssue).not.toHaveBeenCalled();
    expect(mockHandleOpenOfferClaim).not.toHaveBeenCalled();
  });

  it('a non-pressCode error is rethrown rather than swallowed', async () => {
    mockHandleUpdate.mockRejectedValueOnce(new Error('unexpected internal failure'));

    await expect(
      dispatch({ path: '/update', method: 'POST', body: encodeBody({}) }, FAKE_CTX)
    ).rejects.toThrow('unexpected internal failure');
  });
});
