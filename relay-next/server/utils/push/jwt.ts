// Minimal JWT signing, built on Web Crypto (`crypto.subtle`), which is
// available natively in both the Cloudflare Workers runtime and Node.js —
// no runtime branching needed (unlike transport.ts/env.ts, which need it
// because Node's `net`/`tls` modules and Workers' `connect()` are genuinely
// different APIs; signing is not).
//
// Supports exactly the two algorithms this relay's push clients need:
// ES256 (APNs, elliptic curve P-256, matches Apple's .p8 key format) and
// RS256 (FCM/Google service-account JWTs, RSA). No dependency on a JWT
// library — consistent with decision #4's thin-dependency-tree rationale
// for the push clients specifically.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(input: string): string {
  return base64UrlEncode(new TextEncoder().encode(input));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface SignJwtOptions {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Signs a JWT with an ES256 (P-256) private key supplied in PKCS#8 PEM
 * format (the format Apple's .p8 APNs auth keys use). Returns the compact
 * JWS serialization (`header.payload.signature`).
 */
export async function signJwtEs256(pkcs8Pem: string, opts: SignJwtOptions): Promise<string> {
  const key = await importEs256PrivateKey(pkcs8Pem);
  return signJwtWithKey(key, { name: 'ECDSA', hash: 'SHA-256' }, opts, 'raw-p1363');
}

/**
 * Signs a JWT with an RS256 private key supplied in PKCS#8 PEM format (the
 * format Google service-account JSON's `private_key` field uses).
 */
export async function signJwtRs256(pkcs8Pem: string, opts: SignJwtOptions): Promise<string> {
  const key = await importRs256PrivateKey(pkcs8Pem);
  return signJwtWithKey(key, { name: 'RSASSA-PKCS1-v1_5' }, opts, 'raw');
}

async function signJwtWithKey(
  key: CryptoKey,
  algorithm: EcdsaParams | RsaPssParams | AlgorithmIdentifier,
  opts: SignJwtOptions,
  sigFormat: 'raw-p1363' | 'raw'
): Promise<string> {
  const headerB64 = base64UrlEncodeString(JSON.stringify(opts.header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(opts.payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  // Copy-construct to a fresh Uint8Array<ArrayBuffer> (not
  // ArrayBufferLike/SharedArrayBuffer) — satisfies stricter BufferSource
  // typing in newer lib.dom.d.ts snapshots for crypto.subtle.sign, on both
  // the Cloudflare Workers and Node runtimes (functionally a no-op copy;
  // see pemToPkcs8Bytes's identical fix above for why .slice() alone does
  // not resolve this).
  const signingInputBytes = new Uint8Array(new TextEncoder().encode(signingInput));
  const signature = await crypto.subtle.sign(algorithm, key, signingInputBytes);
  // Web Crypto's ECDSA sign() already returns the IEEE P1363 (r||s) format
  // JOSE/JWT expects for ES256 — no DER-to-P1363 conversion needed, unlike
  // Node's `crypto` module (which defaults to DER unless
  // `dsaEncoding: 'ieee-p1363'` is passed). This is one of the reasons this
  // client uses Web Crypto throughout rather than Node's `crypto` module:
  // one code path, correct on both runtimes, with no format-conversion step
  // to get subtly wrong.
  void sigFormat;
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${signingInput}.${signatureB64}`;
}

function pemToPkcs8Bytes(pem: string): Uint8Array<ArrayBuffer> {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  // new Uint8Array(bytes) — copy constructor, not .slice() (which does not
  // change the generic ArrayBufferLike parameter in this TS lib version) —
  // produces a fresh, definitely-ArrayBuffer-backed (never
  // SharedArrayBuffer-backed) Uint8Array, satisfying newer lib.dom.d.ts's
  // stricter BufferSource typing for crypto.subtle.importKey/sign on both
  // the Cloudflare Workers and Node runtimes.
  return new Uint8Array(base64ToBytes(cleaned));
}

async function importEs256PrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  const keyData = pemToPkcs8Bytes(pkcs8Pem);
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function importRs256PrivateKey(pkcs8Pem: string): Promise<CryptoKey> {
  const keyData = pemToPkcs8Bytes(pkcs8Pem);
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}
