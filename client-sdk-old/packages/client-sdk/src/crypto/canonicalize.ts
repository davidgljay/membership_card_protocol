/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 * Keys sorted by Unicode code point, no whitespace, UTF-8, no BOM.
 * Null values are preserved (pure RFC 8785; no null stripping).
 *
 * Vendored verbatim from `membership_card_verifier/packages/verifier/src/canonicalize.ts`
 * per the client-sdk implementation plan's Step 1.3 ("vendor the identical
 * ~30-line implementation with a test asserting byte-identical output
 * against the verifier package's version, so the two never silently
 * diverge") — the verifier package isn't yet published to npm, so this
 * can't be a direct dependency. `test/crypto/canonicalize.test.ts` imports
 * the verifier's actual source and asserts identical output across the
 * shared conformance corpus; keep the two files in sync if either changes.
 */
export function canonicalize(obj: unknown): Uint8Array {
  return new TextEncoder().encode(serializeValue(obj));
}

function serializeValue(val: unknown): string {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return serializeNumber(val);
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(serializeValue).join(',')}]`;
  if (typeof val === 'object') return serializeObject(val as Record<string, unknown>);
  throw new TypeError(`canonicalize: unsupported type ${typeof val}`);
}

function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${serializeValue(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

function serializeNumber(n: number): string {
  if (!isFinite(n)) throw new RangeError(`canonicalize: non-finite number ${n}`);
  return JSON.stringify(n);
}
