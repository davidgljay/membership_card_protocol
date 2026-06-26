/**
 * RFC 8785 (JCS) canonical serialization helpers for the press.
 *
 * Re-exports canonicalize from the verifier package (single authoritative
 * implementation) and adds press-specific helpers.
 */

export { canonicalize } from '@membership-card-protocol/verifier';

/**
 * Serialize `obj` as canonical RFC 8785 JSON, omitting the specified top-level
 * keys. Used by signing steps that must exclude the field being produced
 * (e.g. exclude "press_signature" before computing it).
 */
export function canonicalizeExcluding(
  obj: Record<string, unknown>,
  exclude: string[]
): Uint8Array {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!exclude.includes(k)) {
      filtered[k] = v;
    }
  }
  // Inline canonicalize to avoid a separate import cycle.
  return new TextEncoder().encode(serializeValue(filtered));
}

function serializeValue(val: unknown): string {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (!isFinite(val)) throw new RangeError(`canonicalize: non-finite number ${val}`);
    return JSON.stringify(val);
  }
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(serializeValue).join(',')}]`;
  if (typeof val === 'object')
    return serializeObject(val as Record<string, unknown>);
  throw new TypeError(`canonicalize: unsupported type ${typeof val}`);
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${serializeValue(obj[k])}`);
  return `{${pairs.join(',')}}`;
}
