/**
 * RFC 8785 conformance tests.
 * All 26 cases from specs/serialization-conformance.json must pass.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, canonicalizeExcluding } from '../../src/serialization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const conformancePath = resolve(__dirname, '../../../specs/serialization-conformance.json');

interface ConformanceCase {
  id: string;
  description: string;
  input: unknown;
  expected_json: string;
}

interface ConformanceFile {
  cases: ConformanceCase[];
}

const { cases } = JSON.parse(readFileSync(conformancePath, 'utf8')) as ConformanceFile;

describe('RFC 8785 canonicalize — conformance corpus', () => {
  for (const tc of cases) {
    it(`${tc.id}: ${tc.description}`, () => {
      const result = new TextDecoder().decode(canonicalize(tc.input));
      expect(result).toBe(tc.expected_json);
    });
  }
});

describe('canonicalizeExcluding', () => {
  it('omits the specified top-level key', () => {
    const doc = { a: 1, press_signature: 'sig', b: 2 };
    const result = new TextDecoder().decode(canonicalizeExcluding(doc, ['press_signature']));
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('omits multiple keys', () => {
    const doc = { a: 1, holder_signature: 'h', press_signature: 'p', b: 2 };
    const result = new TextDecoder().decode(
      canonicalizeExcluding(doc, ['holder_signature', 'press_signature'])
    );
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('is a no-op when excluded key is absent', () => {
    const doc = { a: 1, b: 2 };
    const result = new TextDecoder().decode(canonicalizeExcluding(doc, ['press_signature']));
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('absent optional fields are omitted, not null', () => {
    const doc: Record<string, unknown> = { a: 1 };
    const result = new TextDecoder().decode(canonicalize(doc));
    expect(result).not.toContain('null');
    expect(result).toBe('{"a":1}');
  });
});
