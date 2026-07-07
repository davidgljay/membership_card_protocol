import { describe, it, expect } from 'vitest';
import { keccak256, hkdfSha3256 } from '../../src/crypto/hashes.js';

describe('keccak256', () => {
  it('matches a known test vector (empty input)', () => {
    // keccak256("") — standard test vector, verified independently against
    // @noble/hashes' keccak_256 directly.
    expect(keccak256(new Uint8Array())).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('is deterministic for the same input', () => {
    const input = new TextEncoder().encode('membership card protocol');
    expect(keccak256(input)).toBe(keccak256(input));
  });

  it('differs for different inputs', () => {
    const a = keccak256(new TextEncoder().encode('a'));
    const b = keccak256(new TextEncoder().encode('b'));
    expect(a).not.toBe(b);
  });

  it('returns lowercase hex', () => {
    const hash = keccak256(new TextEncoder().encode('anything'));
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe('hkdfSha3256', () => {
  it('is deterministic for the same ikm and info', () => {
    const ikm = new TextEncoder().encode('some-public-key-bytes');
    expect(hkdfSha3256(ikm, 'card-content-v1')).toEqual(hkdfSha3256(ikm, 'card-content-v1'));
  });

  it('produces different output for different info strings (domain separation)', () => {
    const ikm = new TextEncoder().encode('some-public-key-bytes');
    expect(hkdfSha3256(ikm, 'card-content-v1')).not.toEqual(hkdfSha3256(ikm, 'other-context'));
  });

  it('defaults to 32-byte output', () => {
    const out = hkdfSha3256(new TextEncoder().encode('ikm'), 'info');
    expect(out.length).toBe(32);
  });

  it('respects an explicit output length', () => {
    const out = hkdfSha3256(new TextEncoder().encode('ikm'), 'info', 16);
    expect(out.length).toBe(16);
  });
});
