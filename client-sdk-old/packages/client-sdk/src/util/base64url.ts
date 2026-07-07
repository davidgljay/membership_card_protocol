/**
 * Minimal base64url (RFC 4648 §5) codec with no dependency on `Buffer`,
 * `btoa`, or `atob` — this package runs in browser, React Native, and Node
 * contexts, and none of those three is guaranteed to have all of the
 * others' globals. Verified byte-for-byte against Node's own
 * `Buffer.from(...).toString('base64url')` across a range of lengths
 * before use (see `test/util/base64url.test.ts`).
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    output += CHARS[b0 >> 2];
    output += CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) {
      output += CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    }
    if (b2 !== undefined) {
      output += CHARS[b2 & 0x3f];
    }
  }
  return output;
}

export function base64UrlToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/-/g, '+').replace(/_/g, '/');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of cleaned) {
    const value = STANDARD_ALPHABET.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
