// ID/token generation. Uses the Web Crypto API (`crypto.randomUUID`,
// `crypto.getRandomValues`) exclusively — available natively in both the
// Cloudflare Workers runtime and Node.js 19+ (this project pins Node >=22,
// package.json `engines`), so no runtime branching is needed here unlike
// transport.ts/env.ts.

export function generateUuid(): string {
  return crypto.randomUUID();
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/** Opaque random device credential — relay_data_model.md §8: "cryptographically random, 32 bytes, hex or base64url encoded." */
export function generateDeviceCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function nowIso(): string {
  return new Date().toISOString();
}
