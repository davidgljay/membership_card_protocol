import { describe, it, expect } from 'vitest';
import { bytesToBase64Url, base64UrlToBytes } from '../../src/util/base64url.js';

describe('base64url codec', () => {
  const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 16, 32, 1312];

  for (const len of lengths) {
    it(`matches Node's Buffer base64url output for length ${len}`, () => {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 5) % 256);
      const encoded = bytesToBase64Url(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64UrlToBytes(encoded)).toEqual(bytes);
    });
  }

  it('round-trips arbitrary bytes including ones that produce -/_ characters', () => {
    const bytes = new Uint8Array([251, 255, 254, 62, 63, 0, 128]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });
});
