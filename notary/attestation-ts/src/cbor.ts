/**
 * A small strict CBOR decoder for COSE_Sign1 attestation documents.
 *
 * Accepts only what such documents contain: unsigned and negative integers, byte and text strings,
 * arrays, maps, tags, `null`, `true`, `false`. Rejects indefinite lengths, floats, `undefined`, other
 * simple values, trailing bytes, excessive depth and oversize items. Map keys keep order and
 * duplicates are the caller's to reject (maps are returned as pair lists).
 */
export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | CborMap | CborTag;
export interface CborTag { tag: number; value: CborValue }
export class CborMap { constructor(public readonly pairs: [CborValue, CborValue][]) {} }

export class CborError extends Error {}

const MAX_DEPTH = 8;
const MAX_ITEMS = 4096;

export function decodeCbor(bytes: Uint8Array): CborValue {
  let pos = 0;
  let items = 0;
  const fail = (m: string): never => { throw new CborError(m); };
  const need = (n: number) => { if (n < 0 || pos + n > bytes.length) fail("truncated"); };

  function head(): { major: number; arg: number } {
    need(1);
    const b = bytes[pos++]!;
    const major = b >> 5, info = b & 31;
    if (info < 24) return { major, arg: info };
    const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const w = widths[info];
    if (w === undefined) return fail("indefinite length or reserved additional info");
    need(w);
    let v = 0n;
    for (let i = 0; i < w; i++) v = (v << 8n) | BigInt(bytes[pos++]!);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail("integer too large");
    return { major, arg: Number(v) };
  }

  function item(depth: number): CborValue {
    if (depth > MAX_DEPTH) fail("too deep");
    if (++items > MAX_ITEMS) fail("too many items");
    const { major, arg } = head();
    switch (major) {
      case 0: return arg;
      case 1: return -1 - arg;
      case 2: { need(arg); const out = bytes.slice(pos, pos + arg); pos += arg; return out; }
      case 3: {
        need(arg);
        const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos, pos + arg));
        pos += arg;
        return s;
      }
      case 4: { if (arg > MAX_ITEMS) fail("array too long"); const a: CborValue[] = []; for (let i = 0; i < arg; i++) a.push(item(depth + 1)); return a; }
      case 5: {
        if (arg > MAX_ITEMS) fail("map too long");
        const pairs: [CborValue, CborValue][] = [];
        for (let i = 0; i < arg; i++) { const k = item(depth + 1); pairs.push([k, item(depth + 1)]); }
        return new CborMap(pairs);
      }
      case 6: return { tag: arg, value: item(depth + 1) };
      default: // major 7: only false (20), true (21), null (22)
        if (arg === 20) return false;
        if (arg === 21) return true;
        if (arg === 22) return null;
        return fail("unsupported simple value or float");
    }
  }

  const v = item(0);
  if (pos !== bytes.length) fail("trailing bytes");
  return v;
}

/** Encodes the few shapes COSE `Sig_structure` needs: definite arrays of byte/text strings. */
export function encodeSigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const hdr = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  };
  const bstr = (b: Uint8Array) => [...hdr(2, b.length), ...b];
  const ctx = new TextEncoder().encode("Signature1");
  return Uint8Array.from([0x84, ...hdr(3, ctx.length), ...ctx, ...bstr(protectedBytes), ...bstr(new Uint8Array(0)), ...bstr(payload)]);
}
