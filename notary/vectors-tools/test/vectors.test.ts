import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mlDsa44Verify } from "@membership-card-protocol/verifier";
import {
  b64uDecode, b64uEncode, canonicalNotary, parseCanonicalNotary, H, withoutFields, cidFromDigest, assertNotaryObject,
  inputCommitment, decodeUserData, parseTimestamp, parseDuration, NotaryFormatError,
} from "@membership-card-protocol/verifier/notary";
import { sha256 } from "@noble/hashes/sha256";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V = join(ROOT, "vectors");
const load = (f: string, base = V) => JSON.parse(readFileSync(join(base, f), "utf8"));
const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return e instanceof NotaryFormatError ? e.code : "other"; } };
const OBJECTS = ["genesis_request", "job", "announcement", "input", "countersign", "sealed_input", "host_receipt", "validation_receipt",
  "validation_receipt_rejected", "notarization", "job_log", "identity_log", "handoff", "heartbeat", "state_blob", "propagation_batch", "list_approval"];

describe("committed vectors, TypeScript side", () => {
  it.each(OBJECTS)("object %s: bytes, hash, CID, strict fields, signatures", (name) => {
    for (const c of load(`objects/${name}.json`).cases) {
      const canon = canonicalNotary(c.input);
      expect(new TextDecoder().decode(canon)).toBe(c.canonical_utf8);
      expect(b64uEncode(canon)).toBe(c.canonical_b64u);
      expect(H(c.input)).toBe(c.h);
      expect(cidFromDigest(sha256(canon))).toBe(c.cid);
      expect(parseCanonicalNotary(canon)).toEqual(c.input);
      assertNotaryObject(c.input, c.type);
      for (const chk of c.signature_checks ?? []) {
        const e = c.input[chk.field];
        const msg = canonicalNotary(withoutFields(c.input, ...c.signature_checks.map((x: { field: string }) => x.field)));
        expect(b64uEncode(msg)).toBe(c.signing_bytes_b64u);
        expect(mlDsa44Verify(b64uDecode(e.public_key), msg, b64uDecode(e.signature)), `${name}.${chk.field}`).toBe(true);
      }
    }
  });

  it("rejects, formats, merkle, user_data", () => {
    const r = load("objects/rejects.json");
    for (const c of r.json) expect(c.expected_any ?? [c.expected]).toContain(code(() => parseCanonicalNotary(new TextEncoder().encode(c.text))));
    for (const c of r.objects) expect(code(() => assertNotaryObject(c.object, c.expected_type))).toBe(c.expected);
    const f = load("formats.json");
    for (const c of f.timestamp.valid) expect(parseTimestamp(c.value)).toBe(c.ms);
    for (const c of f.timestamp.invalid) expect(code(() => parseTimestamp(c.value))).toBe(c.expected);
    for (const c of f.duration.valid) expect(parseDuration(c.value)).toBe(c.ms);
    for (const c of f.duration.invalid) expect(code(() => parseDuration(c.value))).toBe(c.expected);
    for (const c of load("objects/merkle.json").cases)
      expect(b64uEncode(inputCommitment(c.input_hashes_b64u.map((x: string) => b64uDecode(x))))).toBe(c.root_b64u);
    for (const c of load("user_data/layouts.json").invalid) {
      const hex: string = c.user_data_hex;
      expect(code(() => decodeUserData(Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16)))))).toBe(c.expected);
    }
  });

  it("RFC 8785 conformance cases from specs/serialization-conformance.json", () => {
    const j = load("specs/serialization-conformance.json", ROOT + "/..");
    let n = 0;
    for (const c of j.cases) { try { expect(new TextDecoder().decode(canonicalNotary(c.input))).toBe(c.expected_json); n++; } catch (e) { if (!(e instanceof NotaryFormatError)) throw e; } }
    expect(n).toBeGreaterThanOrEqual(20);
  });

  it("ML-DSA-44: opens Rust-made signatures and rejects tampering (Rust → TS)", () => {
    for (const c of load("signatures_rust.json").cases) {
      const pk = b64uDecode(c.public_key_b64u), m = b64uDecode(c.message_b64u), s = b64uDecode(c.signature_b64u);
      expect(mlDsa44Verify(pk, m, s), c.id).toBe(true);
      expect(mlDsa44Verify(pk, Uint8Array.from([...m, 1]), s)).toBe(false);
    }
  });
});
