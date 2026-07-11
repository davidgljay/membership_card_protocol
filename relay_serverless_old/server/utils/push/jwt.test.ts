import { describe, it, expect } from 'vitest';
import { signJwtEs256, signJwtRs256 } from './jwt';

// Synthetic test-only keypairs generated locally for these tests — never
// real Apple/Google credentials (per the task's explicit instruction that
// tests must not require real credentials to pass).

async function generateEs256Pkcs8Pem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return derToPem(pkcs8, 'PRIVATE KEY');
}

function derToPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function decodeJwtPart(part: string): unknown {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '=');
  return JSON.parse(atob(padded));
}

describe('JWT signing (server/utils/push/jwt.ts)', () => {
  it('signJwtEs256 produces a well-formed compact JWS with correct header/payload', async () => {
    const pem = await generateEs256Pkcs8Pem();
    const jwt = await signJwtEs256(pem, {
      header: { alg: 'ES256', kid: 'TESTKEY01' },
      payload: { iss: 'TESTTEAM01', iat: 1234567890 },
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(decodeJwtPart(parts[0]!)).toEqual({ alg: 'ES256', kid: 'TESTKEY01' });
    expect(decodeJwtPart(parts[1]!)).toEqual({ iss: 'TESTTEAM01', iat: 1234567890 });
    // Signature is base64url and non-empty; ES256 signatures (P1363 r||s
    // format, 32+32 bytes) base64url-encode to 86 chars with no padding.
    expect(parts[2]!.length).toBe(86);
    expect(parts[2]).not.toMatch(/[+/=]/);
  });

  it('signJwtEs256 produces a signature verifiable by the matching public key', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const pem = derToPem(pkcs8, 'PRIVATE KEY');

    const jwt = await signJwtEs256(pem, {
      header: { alg: 'ES256', kid: 'k1' },
      payload: { iss: 'team1', iat: 1000 },
    });
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const signingInput = `${headerB64}.${payloadB64}`;
    const sigBytes = base64UrlToBytes(sigB64!);

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      sigBytes,
      new TextEncoder().encode(signingInput)
    );
    expect(valid).toBe(true);
  });

  it('signJwtRs256 produces a well-formed compact JWS verifiable by the matching public key', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const pem = derToPem(pkcs8, 'PRIVATE KEY');

    const jwt = await signJwtRs256(pem, {
      header: { alg: 'RS256', typ: 'JWT' },
      payload: { iss: 'service-account@example.iam.gserviceaccount.com', scope: 'x', aud: 'y', iat: 1, exp: 2 },
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(decodeJwtPart(parts[0]!)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const signingInput = `${parts[0]}.${parts[1]}`;
    const sigBytes = base64UrlToBytes(parts[2]!);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      keyPair.publicKey,
      sigBytes,
      new TextEncoder().encode(signingInput)
    );
    expect(valid).toBe(true);
  });

  it('two signatures for the same input are deterministic-length but not necessarily byte-identical (ECDSA is randomized)', async () => {
    const pem = await generateEs256Pkcs8Pem();
    const jwt1 = await signJwtEs256(pem, { header: { alg: 'ES256' }, payload: { a: 1 } });
    const jwt2 = await signJwtEs256(pem, { header: { alg: 'ES256' }, payload: { a: 1 } });
    // Header+payload identical, but ECDSA nonce randomization means
    // signatures usually differ — this test just documents that behavior
    // rather than asserting equality, which would be flaky/wrong to assert.
    expect(jwt1.split('.')[0]).toBe(jwt2.split('.')[0]);
    expect(jwt1.split('.')[1]).toBe(jwt2.split('.')[1]);
  });

  it('rejects to a rejected promise for malformed PEM input rather than hanging', async () => {
    await expect(
      signJwtEs256('not a real pem', { header: {}, payload: {} })
    ).rejects.toThrow();
  });
});

function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64url.length + ((4 - (b64url.length % 4)) % 4), '=');
  const binary = atob(padded);
  // Explicit ArrayBuffer (not the wider ArrayBufferLike) backing, allocated
  // up front — this is what crypto.subtle.verify's BufferSource parameter
  // requires under TS's typed-array generics (5.7+): Uint8Array's default
  // type parameter widened to ArrayBufferLike (which also covers
  // SharedArrayBuffer) no longer satisfies ArrayBufferView<ArrayBuffer>
  // even though nothing here ever produces a SharedArrayBuffer at runtime.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
