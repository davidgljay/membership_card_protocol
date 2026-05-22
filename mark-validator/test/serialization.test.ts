/**
 * Serialization conformance tests against the corpus in
 * specs/serialization-conformance.json (22 test cases covering all encoding rules).
 *
 * Each case specifies:
 *   - input: JSON-shaped object
 *   - binary_fields: field names whose values are base64url → byte string
 *   - timestamp_fields: field names whose values are ISO 8601 → Tag 1 uint
 *   - expected_cbor_hex: the canonical CBOR output in lowercase hex
 *
 * The per-case binary_fields list may include both scalar binary fields and
 * binary array fields. We split them against the global protocol sets so the
 * encoder applies the correct override type.
 *
 * All 22 cases must pass before this package is considered serialization-conformant.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalize,
  toHex,
  BINARY_FIELDS,
  BINARY_ARRAY_FIELDS,
  TIMESTAMP_FIELDS,
} from '../src/serialization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(__dirname, '../../specs/serialization-conformance.json');

interface ConformanceCase {
  id: string;
  description: string;
  input: Record<string, unknown>;
  binary_fields: string[];
  timestamp_fields: string[];
  expected_cbor_hex: string;
  notes?: string;
}

interface ConformanceCorpus {
  version: string;
  cases: ConformanceCase[];
}

/**
 * Run a single conformance case.
 *
 * Builds per-case field sets from the corpus binary_fields list:
 *   - Fields in the global BINARY_FIELDS set → scalar binary override
 *   - Fields in the global BINARY_ARRAY_FIELDS set → array binary override
 *   - Fields in neither → added to scalar binary set (unknown field; assume scalar)
 *
 * Fields NOT listed in the case's binary_fields are NOT treated as binary,
 * even if they appear in the global protocol sets. This allows TC-18 to test
 * plain text array encoding for the `recipients` field.
 */
function runCase(tc: ConformanceCase): string {
  const caseBinaryFields = new Set<string>();
  const caseBinaryArrayFields = new Set<string>();

  for (const field of tc.binary_fields) {
    if (BINARY_ARRAY_FIELDS.has(field)) {
      caseBinaryArrayFields.add(field);
    } else {
      // Either it's in BINARY_FIELDS or it's an unknown field — treat as scalar binary
      caseBinaryFields.add(field);
    }
  }

  const caseTimestampFields = new Set<string>(tc.timestamp_fields);

  // Verify all timestamp_fields are known to the protocol
  for (const field of tc.timestamp_fields) {
    if (!TIMESTAMP_FIELDS.has(field)) {
      throw new Error(
        `Test case ${tc.id}: timestamp field '${field}' is not in TIMESTAMP_FIELDS. ` +
        `Add it to serialization.ts.`,
      );
    }
  }

  const bytes = canonicalize(tc.input, {
    binaryFields: caseBinaryFields,
    binaryArrayFields: caseBinaryArrayFields,
    timestampFields: caseTimestampFields,
  });
  return toHex(bytes);
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8')) as ConformanceCorpus;

describe('Canonical CBOR serialization — conformance corpus', () => {
  for (const tc of corpus.cases) {
    it(`${tc.id}: ${tc.description}`, () => {
      const hex = runCase(tc);
      expect(hex).toBe(tc.expected_cbor_hex);
    });
  }
});

describe('Canonical CBOR serialization — additional edge cases', () => {
  it('empty object encodes as empty map (0xa0)', () => {
    const bytes = canonicalize({});
    expect(toHex(bytes)).toBe('a0');
  });

  it('null values are stripped before encoding', () => {
    const bytes = canonicalize({ content: 'hello', edit_of: null });
    const expected = canonicalize({ content: 'hello' });
    expect(toHex(bytes)).toBe(toHex(expected));
  });

  it('undefined values are stripped before encoding', () => {
    const bytes = canonicalize({ content: 'hello', retracts: undefined });
    const expected = canonicalize({ content: 'hello' });
    expect(toHex(bytes)).toBe(toHex(expected));
  });

  it('map key order is deterministic regardless of input order', () => {
    const a = canonicalize({ z: 1, a: 2, m: 3 });
    const b = canonicalize({ a: 2, m: 3, z: 1 });
    expect(toHex(a)).toBe(toHex(b));
  });

  it('nested map key order is also sorted', () => {
    const a = canonicalize({ outer: { z: 1, a: 2 } });
    const b = canonicalize({ outer: { a: 2, z: 1 } });
    expect(toHex(a)).toBe(toHex(b));
  });

  it('protocol default field sets encode recipients as binary array', () => {
    // With default sets, recipients are encoded as binary (chitt-pointer-array)
    const bytes = canonicalize({
      recipients: ['AAEC', 'BAED'],
    });
    // AAEC = bytes [0,1,2], BAED = bytes [4,1,3]
    expect(toHex(bytes)).toContain('43000102'); // byte string [0,1,2]
    expect(toHex(bytes)).toContain('43040103'); // byte string [4,1,3]
  });
});
