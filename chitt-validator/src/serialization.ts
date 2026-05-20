/**
 * Canonical CBOR serialization per the Chitt Protocol Appendix A.
 *
 * Base standard: RFC 8949 §6.1 (JSON→CBOR) + §4.2 (deterministic encoding).
 * Protocol overrides:
 *   - Binary fields (keys, signatures, CIDs, pointers, hashes): base64url string → CBOR byte string (major type 2)
 *   - Timestamp fields: ISO 8601 string → CBOR Tag 1 + uint (Unix epoch seconds)
 *   - Absent optional fields: must be omitted (not encoded as null)
 * Map keys sorted by (1) length of CBOR-encoded key, then (2) lexicographic byte order.
 */

/**
 * Binary fields whose values are base64url strings that must be encoded
 * as CBOR byte strings (major type 2) per Appendix A §A.2.1.
 */
export const BINARY_FIELDS = new Set([
  'recipient_pubkey',
  'public_key',
  'offer_signature',
  'holder_signature',
  'signature',
  'policy_id',
  'press_chitt',
  'signer_chitt',
  'prev_log_root',
  'in_reply_to',
  'edit_of',
  'retracts',
]);

/**
 * Fields whose values are arrays of binary items (base64url strings)
 * that each encode as CBOR byte strings.
 */
export const BINARY_ARRAY_FIELDS = new Set([
  'recipients',
  'approved_presses',
  'auditors',
]);

/**
 * Timestamp fields whose values are ISO 8601 strings that must be encoded
 * as CBOR Tag 1 + unsigned integer (Unix epoch seconds) per Appendix A §A.2.2.
 */
export const TIMESTAMP_FIELDS = new Set([
  'issued_at',
  'effective_date',
  'expires',
  'valid_until',
  'timestamp',
  'expires_at',
]);

// ---------------------------------------------------------------------------
// Base64url decode (RFC 4648 §5, no padding)
// ---------------------------------------------------------------------------

export function base64urlDecode(s: string): Uint8Array {
  const padded = s.padEnd(s.length + (4 - (s.length % 4)) % 4, '=');
  const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function base64urlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ---------------------------------------------------------------------------
// Low-level CBOR encoding primitives (RFC 8949 §4.2 deterministic)
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Encode a CBOR head: major type (0-7) and argument value. Shortest form. */
function head(major: number, arg: number): Uint8Array {
  const mt = (major & 0x7) << 5;
  if (arg < 24) return new Uint8Array([mt | arg]);
  if (arg <= 0xff) return new Uint8Array([mt | 24, arg]);
  if (arg <= 0xffff) return new Uint8Array([mt | 25, arg >> 8, arg & 0xff]);
  if (arg <= 0xffffffff) {
    return new Uint8Array([
      mt | 26,
      (arg >>> 24) & 0xff,
      (arg >>> 16) & 0xff,
      (arg >>> 8) & 0xff,
      arg & 0xff,
    ]);
  }
  // 8-byte form needed for large timestamps (though standard Unix timestamps fit in 32 bits until 2106)
  const hi = Math.floor(arg / 0x100000000);
  const lo = arg >>> 0;
  return new Uint8Array([
    mt | 27,
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ]);
}

function encodeInteger(n: number): Uint8Array {
  if (n >= 0) return head(0, n);
  return head(1, -1 - n);
}

function encodeByteString(bytes: Uint8Array): Uint8Array {
  return concat(head(2, bytes.length), bytes);
}

function encodeTextString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(head(3, bytes.length), bytes);
}

function encodeTag1Uint(epochSeconds: number): Uint8Array {
  // Tag 1 = 0xc1 (major type 6, additional info 1)
  return concat(new Uint8Array([0xc1]), head(0, epochSeconds));
}

/**
 * Encode a float using the shortest IEEE 754 form that round-trips.
 * Tries float16, then float32, then float64.
 */
function encodeFloat(value: number): Uint8Array {
  // Float16
  const f16 = toFloat16Bytes(value);
  if (fromFloat16(f16) === value) {
    return new Uint8Array([0xf9, f16[0], f16[1]]);
  }
  // Float32
  const buf32 = new ArrayBuffer(4);
  const view32 = new DataView(buf32);
  view32.setFloat32(0, value, false);
  if (view32.getFloat32(0, false) === value) {
    return new Uint8Array([0xfa, ...new Uint8Array(buf32)]);
  }
  // Float64
  const buf64 = new ArrayBuffer(8);
  new DataView(buf64).setFloat64(0, value, false);
  return new Uint8Array([0xfb, ...new Uint8Array(buf64)]);
}

function toFloat16Bytes(value: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, false);
  const f32 = new DataView(buf).getUint32(0, false);
  const sign = (f32 >> 31) & 1;
  const exp32 = (f32 >> 23) & 0xff;
  const frac32 = f32 & 0x7fffff;

  let h: number;
  if (exp32 === 0xff) {
    h = (sign << 15) | 0x7c00 | (frac32 ? 0x0200 : 0);
  } else if (exp32 === 0) {
    h = sign << 15;
  } else {
    const e = exp32 - 127 + 15;
    if (e >= 31) {
      h = (sign << 15) | 0x7c00;
    } else if (e <= 0) {
      h = sign << 15;
    } else {
      h = (sign << 15) | (e << 10) | (frac32 >> 13);
    }
  }
  return new Uint8Array([h >> 8, h & 0xff]);
}

function fromFloat16(bytes: Uint8Array): number {
  const h = (bytes[0] << 8) | bytes[1];
  const sign = (h >> 15) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  if (exp === 0) return sign * 5.9604644775390625e-8 * frac;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Sort CBOR map entries per RFC 8949 §4.2.1:
 * by encoded key length first, then lexicographic by key bytes.
 */
function sortedMapEntries(
  pairs: Array<[Uint8Array, Uint8Array]>,
): Array<[Uint8Array, Uint8Array]> {
  return [...pairs].sort(([a], [b]) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Main encoder
// ---------------------------------------------------------------------------

/** Field-set configuration threaded through the encoder. */
interface EncoderCtx {
  binaryFields: Set<string>;
  binaryArrayFields: Set<string>;
  timestampFields: Set<string>;
}

/**
 * Encode a value to canonical CBOR with protocol-specific overrides.
 *
 * @param value     The value to encode (JSON-shaped object).
 * @param fieldName The field name in the parent object (used to apply overrides).
 * @param ctx       Field-set configuration.
 * @returns Canonical CBOR bytes.
 */
function encodeValue(value: unknown, fieldName: string | undefined, ctx: EncoderCtx): Uint8Array {
  if (value === null || value === undefined) {
    throw new Error(
      `null/undefined must be stripped before encoding (field: ${fieldName ?? 'root'})`,
    );
  }

  // Binary field override: base64url string → CBOR byte string
  if (fieldName && ctx.binaryFields.has(fieldName) && typeof value === 'string') {
    return encodeByteString(base64urlDecode(value));
  }

  // Timestamp field override: ISO 8601 string → CBOR Tag 1 + uint
  if (fieldName && ctx.timestampFields.has(fieldName) && typeof value === 'string') {
    const epochMs = Date.parse(value);
    if (isNaN(epochMs)) throw new Error(`Invalid timestamp: ${value}`);
    return encodeTag1Uint(Math.floor(epochMs / 1000));
  }

  if (typeof value === 'string') return encodeTextString(value);

  if (typeof value === 'number') {
    if (Number.isInteger(value)) return encodeInteger(value);
    return encodeFloat(value);
  }

  if (typeof value === 'boolean') {
    return new Uint8Array([value ? 0xf5 : 0xf4]);
  }

  if (Array.isArray(value)) {
    // Binary array fields: each element is a base64url string → byte string
    const isBinaryArray = fieldName !== undefined && ctx.binaryArrayFields.has(fieldName);
    const items = value
      .filter(item => item !== null && item !== undefined)
      .map(item => {
        if (isBinaryArray && typeof item === 'string') {
          return encodeByteString(base64urlDecode(item));
        }
        return encodeValue(item, undefined, ctx);
      });
    return concat(head(4, items.length), ...items);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const pairs: Array<[Uint8Array, Uint8Array]> = [];

    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue; // §A.2.3: omit absent optional fields
      pairs.push([encodeTextString(k), encodeValue(v, k, ctx)]);
    }

    const sorted = sortedMapEntries(pairs);
    return concat(head(5, sorted.length), ...sorted.flatMap(([k, v]) => [k, v]));
  }

  throw new Error(`Unsupported value type: ${typeof value}`);
}

/**
 * Options for canonicalize() — override the default protocol field sets.
 * Useful for testing or for fields outside the standard protocol schema.
 */
export interface SerializationOptions {
  /** Fields whose string values are base64url-encoded binary → CBOR byte string. */
  binaryFields?: Set<string>;
  /** Fields whose array elements are each base64url-encoded binary → CBOR byte string. */
  binaryArrayFields?: Set<string>;
  /** Fields whose string values are ISO 8601 timestamps → CBOR Tag 1 + uint. */
  timestampFields?: Set<string>;
}

/**
 * Produce the canonical CBOR bytes for a JSON-shaped object.
 *
 * This is the serialization form used for all signatures in the Chitt Protocol.
 * By default applies the protocol field sets from Appendix A. Pass `options` to
 * override specific sets (useful for conformance tests or non-standard fields).
 */
export function canonicalize(
  value: Record<string, unknown>,
  options?: SerializationOptions,
): Uint8Array {
  const ctx: EncoderCtx = {
    binaryFields: options?.binaryFields ?? BINARY_FIELDS,
    binaryArrayFields: options?.binaryArrayFields ?? BINARY_ARRAY_FIELDS,
    timestampFields: options?.timestampFields ?? TIMESTAMP_FIELDS,
  };
  return encodeValue(value, undefined, ctx);
}

/**
 * Hex-encode a Uint8Array (lowercase, for conformance test comparison).
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Decode a hex string to Uint8Array.
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Odd-length hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
