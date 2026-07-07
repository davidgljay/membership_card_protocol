import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../../src/crypto/canonicalize.js';
// The verifier package's own canonicalize.ts, imported directly from its
// source location (not yet published to npm — see Step 1.3's note in
// canonicalize.ts). Used only to prove the two implementations produce
// byte-identical output; not a runtime dependency of client-sdk.
import { canonicalize as verifierCanonicalize } from '../../../../../membership_card_verifier/packages/verifier/src/canonicalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const conformance = JSON.parse(
  readFileSync(join(__dirname, '../../../../../specs/serialization-conformance.json'), 'utf-8')
) as { cases: Array<{ id: string; description: string; input: unknown; expected_json: string }> };

describe('canonicalize — RFC 8785 conformance', () => {
  for (const tc of conformance.cases) {
    it(`${tc.id}: ${tc.description}`, () => {
      const result = canonicalize(tc.input);
      const resultStr = new TextDecoder().decode(result);
      expect(resultStr).toBe(tc.expected_json);
    });
  }
});

describe('canonicalize — byte-identical to the verifier package', () => {
  for (const tc of conformance.cases) {
    it(`${tc.id}: matches verifier's canonicalize() output`, () => {
      expect(canonicalize(tc.input)).toEqual(verifierCanonicalize(tc.input));
    });
  }

  it('matches on a nested object with mixed key ordering', () => {
    const input = { z: 1, a: { nested: true, another: [3, 2, 1] }, m: 'text' };
    expect(canonicalize(input)).toEqual(verifierCanonicalize(input));
  });
});
