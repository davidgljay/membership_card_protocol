import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAuthenticationResponse = vi.fn();
vi.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: (...args: unknown[]) => verifyAuthenticationResponse(...args),
}));

const { verifyWebAuthnLogin } = await import('../src/auth/webauthn.js');

function credential(counter: number) {
  return { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter };
}

describe('verifyWebAuthnLogin', () => {
  beforeEach(() => {
    verifyAuthenticationResponse.mockReset();
  });

  it('accepts a verified assertion with an increasing counter', async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });

    const result = await verifyWebAuthnLogin(
      {} as never,
      'challenge',
      'rp-id',
      'https://origin',
      credential(4)
    );
    expect(result).toEqual({ ok: true, newCounter: 5 });
  });

  it('accepts a non-incrementing counter when both are zero (single-device credentials)', async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    });

    const result = await verifyWebAuthnLogin(
      {} as never,
      'challenge',
      'rp-id',
      'https://origin',
      credential(0)
    );
    expect(result).toEqual({ ok: true, newCounter: 0 });
  });

  it('rejects when verification fails', async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: false,
      authenticationInfo: { newCounter: 5 },
    });

    const result = await verifyWebAuthnLogin(
      {} as never,
      'challenge',
      'rp-id',
      'https://origin',
      credential(4)
    );
    expect(result).toEqual({ ok: false, reason: 'verification_failed' });
  });

  it('rejects a replayed (non-increasing) counter', async () => {
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    });

    const result = await verifyWebAuthnLogin(
      {} as never,
      'challenge',
      'rp-id',
      'https://origin',
      credential(4)
    );
    expect(result).toEqual({ ok: false, reason: 'counter_reused' });
  });

  it('returns an error result when the underlying library throws', async () => {
    verifyAuthenticationResponse.mockRejectedValue(new Error('bad assertion'));

    const result = await verifyWebAuthnLogin(
      {} as never,
      'challenge',
      'rp-id',
      'https://origin',
      credential(0)
    );
    expect(result).toEqual({ ok: false, reason: 'error' });
  });
});
