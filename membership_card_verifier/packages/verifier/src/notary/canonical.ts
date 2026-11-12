/**
 * Notary canonical-form helpers.
 *
 * Implements: protocol-objects.md §Notary Objects — Conventions (§20–§34),
 *   §24 (SealedInput identity), §27 (input_commitment Merkle root), §33 (user_data layout).
 * Decisions: plans/notary-questions-phase-5.md Q6 (strict numbers, no null), Q7 (strict
 *   base64url, timestamps, durations, card pointers, CIDs), E1 (empty Merkle root).
 *
 * The Rust twin is notary/runtime/crates/notary-types; both are checked against notary/vectors/.
 * The existing `canonicalize.ts` is not changed: this layer validates first, then calls it.
 */
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { canonicalize } from "../canonicalize.js";

export class NotaryFormatError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "NotaryFormatError";
  }
}

// ---------------------------------------------------------------------------
// base64url (unpadded, canonical)
// ---------------------------------------------------------------------------

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_REV: Record<string, number> = Object.fromEntries([...B64U].map((c, i) => [c, i]));

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64U[(n >> 18) & 63]! + B64U[(n >> 12) & 63]! + B64U[(n >> 6) & 63]! + B64U[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64U[(n >> 18) & 63]! + B64U[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64U[(n >> 18) & 63]! + B64U[(n >> 12) & 63]! + B64U[(n >> 6) & 63]!;
  }
  return out;
}

/** Strict decode: no padding, no foreign characters, trailing bits must be zero. */
export function b64uDecode(s: string, expectedLen?: number): Uint8Array {
  if (s.length % 4 === 1) throw new NotaryFormatError("BASE64URL_INVALID", "bad length");
  const vals: number[] = [];
  for (const c of s) {
    const v = B64U_REV[c];
    if (v === undefined) throw new NotaryFormatError("BASE64URL_INVALID", `bad character ${JSON.stringify(c)}`);
    vals.push(v);
  }
  const out: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const a = vals[i]!, b = vals[i + 1]!, c = vals[i + 2], d = vals[i + 3];
    out.push((a << 2) | (b >> 4));
    if (c !== undefined) out.push(((b & 15) << 4) | (c >> 2));
    if (d !== undefined) out.push(((c! & 3) << 6) | d);
  }
  const bytes = Uint8Array.from(out);
  if (b64uEncode(bytes) !== s) throw new NotaryFormatError("BASE64URL_INVALID", "non-canonical trailing bits");
  if (expectedLen !== undefined && bytes.length !== expectedLen)
    throw new NotaryFormatError("BASE64URL_LENGTH", `expected ${expectedLen} bytes, got ${bytes.length}`);
  return bytes;
}

// ---------------------------------------------------------------------------
// Strict canonical JSON for notary objects (RFC 8785 + integers only, no null)
// ---------------------------------------------------------------------------

export function assertNotaryJson(v: unknown, path = "$"): void {
  if (v === null) throw new NotaryFormatError("JSON_NULL", `null at ${path}`);
  if (v === undefined) throw new NotaryFormatError("JSON_UNDEFINED", `undefined at ${path}`);
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new NotaryFormatError("JSON_NON_INTEGER", `non-integer at ${path}`);
    if (Math.abs(v) > Number.MAX_SAFE_INTEGER) throw new NotaryFormatError("JSON_INTEGER_RANGE", `out of range at ${path}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertNotaryJson(x, `${path}[${i}]`));
  } else if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertNotaryJson(x, `${path}.${k}`);
  } else if (typeof v !== "string" && typeof v !== "boolean") {
    throw new NotaryFormatError("JSON_TYPE", `unsupported ${typeof v} at ${path}`);
  }
}

/** Canonical bytes of a notary object. Throws on floats, unsafe integers, null. */
export function canonicalNotary(v: unknown): Uint8Array {
  assertNotaryJson(v);
  return canonicalize(v);
}

/** Parse received bytes, rejecting anything that is not already canonical (so hashes are over the raw bytes). */
export function parseCanonicalNotary(bytes: Uint8Array): unknown {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new NotaryFormatError("JSON_NOT_CANONICAL", "not valid UTF-8 JSON");
  }
  const re = canonicalNotary(v);
  if (re.length !== bytes.length || re.some((b, i) => b !== bytes[i]))
    throw new NotaryFormatError("JSON_NOT_CANONICAL", "bytes are not RFC 8785 canonical");
  return v;
}

/** H(x) = SHA-256(JCS(x)) as 32 raw bytes. */
export function hBytes(v: unknown): Uint8Array {
  return sha256(canonicalNotary(v));
}

/** H(x), base64url. */
export function H(v: unknown): string {
  return b64uEncode(hBytes(v));
}

/** `object` without the named signature fields (signing form, §Conventions "Signatures"). */
export function withoutFields(obj: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!names.includes(k)) out[k] = v;
  return out;
}

/** Strict unknown-field check for versioned §21–§34 objects (Q6). */
export function assertExactFields(obj: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw new NotaryFormatError("UNKNOWN_FIELD", `unknown field ${k}`);
  for (const k of required) if (!(k in obj)) throw new NotaryFormatError("MISSING_FIELD", `missing field ${k}`);
}

// ---------------------------------------------------------------------------
// Card pointers, timestamps, durations
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** keccak256(public key) as 64 lowercase hex characters, no 0x. */
export function cardPointer(publicKey: Uint8Array): string {
  return hex(keccak_256(publicKey));
}

export function assertCardPointer(s: string): void {
  if (!/^[0-9a-f]{64}$/.test(s)) throw new NotaryFormatError("CARD_POINTER_INVALID", s);
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Strict UTC `YYYY-MM-DDTHH:MM:SS(.fff)?Z`. Returns milliseconds since the Unix epoch. */
export function parseTimestamp(s: string): number {
  const m = TS_RE.exec(s);
  if (!m) throw new NotaryFormatError("TIMESTAMP_INVALID", s);
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const back = new Date(t);
  if (h > 23 || mi > 59 || se > 59 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    throw new NotaryFormatError("TIMESTAMP_INVALID", s);
  return t;
}

const DUR_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** ISO 8601 duration, no years or months. Returns milliseconds. */
export function parseDuration(s: string): number {
  const m = DUR_RE.exec(s);
  if (!m || s === "P" || s.endsWith("T")) throw new NotaryFormatError("DURATION_INVALID", s);
  const [w, d, h, mi, se] = m.slice(1, 6).map((x) => (x ? Number(x) : 0)) as [number, number, number, number, number];
  return (((w * 7 + d) * 24 + h) * 60 + mi) * 60_000 + se * 1000;
}

// ---------------------------------------------------------------------------
// CIDv1 (raw, sha2-256, base32 lower)
// ---------------------------------------------------------------------------

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function cidFromDigest(digest32: Uint8Array): string {
  if (digest32.length !== 32) throw new NotaryFormatError("CID_INVALID", "digest must be 32 bytes");
  const bytes = Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest32]);
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]!; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]!;
  return "b" + out;
}

/** Parse a raw-codec sha2-256 CIDv1 string and return its digest. */
export function digestFromCid(cid: string): Uint8Array {
  if (!cid.startsWith("b")) throw new NotaryFormatError("CID_INVALID", "multibase must be base32 lower");
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const c of cid.slice(1)) {
    const v = B32.indexOf(c);
    if (v < 0) throw new NotaryFormatError("CID_INVALID", "bad base32 character");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
  }
  if (acc !== 0 || out.length !== 36) throw new NotaryFormatError("CID_INVALID", "wrong length or trailing bits");
  if (out[0] !== 0x01 || out[1] !== 0x55 || out[2] !== 0x12 || out[3] !== 0x20)
    throw new NotaryFormatError("CID_INVALID", "must be CIDv1, raw codec, sha2-256");
  return Uint8Array.from(out.slice(4));
}

/** CID of the exact bytes of a public notary object (digest = H(object) when bytes are canonical). */
export function cidOfBytes(bytes: Uint8Array): string {
  return cidFromDigest(sha256(bytes));
}

// ---------------------------------------------------------------------------
// input_commitment (§27): Merkle root over sorted input_hash values
// ---------------------------------------------------------------------------

const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

/**
 * Leaf = SHA-256(0x00 ‖ input_hash), node = SHA-256(0x01 ‖ left ‖ right), odd node promoted unchanged.
 * Empty list: SHA-256("") (erratum E1, agreed 2026-11-12).
 * Input must be strictly increasing byte-wise (sorted, no duplicates).
 */
export function inputCommitment(inputHashes: Uint8Array[]): Uint8Array {
  for (const h of inputHashes) if (h.length !== 32) throw new NotaryFormatError("MERKLE_INPUT", "input_hash must be 32 bytes");
  for (let i = 1; i < inputHashes.length; i++)
    if (compareBytes(inputHashes[i - 1]!, inputHashes[i]!) >= 0) throw new NotaryFormatError("MERKLE_UNSORTED", "inputs must be strictly increasing");
  if (inputHashes.length === 0) return sha256(new Uint8Array(0));
  let level = inputHashes.map((h) => sha256(cat(Uint8Array.of(0), h)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? sha256(cat(Uint8Array.of(1), level[i]!, level[i + 1]!)) : level[i]!);
    level = next;
  }
  return level[0]!;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Attestation user_data (§33)
// ---------------------------------------------------------------------------

export type AttestationPurpose = 0x01 | 0x02 | 0x03 | 0x04;
export type Isolation = 0x00 | 0x01 | 0x02;

export interface UserData {
  purpose: AttestationPurpose;
  idKeyHash: Uint8Array;     // keccak256(K_id)  — purposes 0x01, 0x02, 0x04
  chainKeyHash: Uint8Array;  // SHA-256(K_chain) — purpose 0x01
  instKeyHash: Uint8Array;   // SHA-256(K_inst)  — all
  programHash: Uint8Array;   // 0x02, 0x04
  jobHash: Uint8Array;       // 0x02, 0x04
  epoch: bigint;             // 0x02, 0x04
  isolation: Isolation;      // 0x02, 0x04
}

export const USER_DATA_LEN = 181;
const TAG = new TextEncoder().encode("CARDNOTARY");
const ZERO32 = new Uint8Array(32);

export function encodeUserData(u: Partial<UserData> & { purpose: AttestationPurpose }): Uint8Array {
  const out = new Uint8Array(USER_DATA_LEN);
  out.set(TAG, 0);
  out[10] = 0x01;
  out[11] = u.purpose;
  let o = 12;
  for (const f of [u.idKeyHash, u.chainKeyHash, u.instKeyHash, u.programHash, u.jobHash]) {
    if (f && f.length !== 32) throw new NotaryFormatError("USER_DATA_FIELD", "hash fields are 32 bytes");
    out.set(f ?? ZERO32, o);
    o += 32;
  }
  new DataView(out.buffer).setBigUint64(o, u.epoch ?? 0n, false);
  out[o + 8] = u.isolation ?? 0x00;
  return out;
}

/** Parse the layout. Tag, version and length problems are ATT_USER_DATA_MALFORMED at the verifier (V8). */
export function decodeUserData(b: Uint8Array): UserData {
  if (b.length !== USER_DATA_LEN) throw new NotaryFormatError("ATT_USER_DATA_MALFORMED", "length");
  for (let i = 0; i < 10; i++) if (b[i] !== TAG[i]) throw new NotaryFormatError("ATT_USER_DATA_MALFORMED", "tag");
  if (b[10] !== 0x01) throw new NotaryFormatError("ATT_USER_DATA_MALFORMED", "layout version");
  const purpose = b[11]!;
  if (purpose < 1 || purpose > 4) throw new NotaryFormatError("ATT_USER_DATA_MALFORMED", "purpose");
  const iso = b[180]!;
  if (iso > 2) throw new NotaryFormatError("ATT_USER_DATA_MALFORMED", "isolation");
  return {
    purpose: purpose as AttestationPurpose,
    idKeyHash: b.slice(12, 44),
    chainKeyHash: b.slice(44, 76),
    instKeyHash: b.slice(76, 108),
    programHash: b.slice(108, 140),
    jobHash: b.slice(140, 172),
    epoch: new DataView(b.buffer, b.byteOffset + 172, 8).getBigUint64(0, false),
    isolation: iso as Isolation,
  };
}
