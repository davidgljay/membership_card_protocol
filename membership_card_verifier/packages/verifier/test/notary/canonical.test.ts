import { describe, it, expect } from "vitest";
import {
  b64uEncode, b64uDecode, canonicalNotary, parseCanonicalNotary, inputCommitment, encodeUserData, decodeUserData,
  parseTimestamp, parseDuration, cidFromDigest, digestFromCid, assertNotaryObject, NotaryFormatError, H,
} from "../../src/notary/index.js";
import { sha256 } from "@noble/hashes/sha256";

const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as NotaryFormatError).code; } return "none"; };

describe("notary canonical helpers", () => {
  it("rejects floats, unsafe integers, null", () => {
    expect(code(() => canonicalNotary({ a: 1.5 }))).toBe("JSON_NON_INTEGER");
    expect(code(() => canonicalNotary({ a: 2 ** 53 }))).toBe("JSON_INTEGER_RANGE");
    expect(code(() => canonicalNotary({ a: null }))).toBe("JSON_NULL");
    expect(new TextDecoder().decode(canonicalNotary({ b: 1, a: [true, "x"] }))).toBe('{"a":[true,"x"],"b":1}');
  });
  it("parseCanonicalNotary rejects non-canonical bytes", () => {
    expect(code(() => parseCanonicalNotary(new TextEncoder().encode('{"b":1,"a":2}')))).toBe("JSON_NOT_CANONICAL");
    expect(parseCanonicalNotary(new TextEncoder().encode('{"a":2,"b":1}'))).toEqual({ a: 2, b: 1 });
  });
  it("strict base64url", () => {
    for (const n of [0, 1, 2, 3, 32]) { const b = new Uint8Array(n).map((_, i) => i * 7); expect(b64uDecode(b64uEncode(b))).toEqual(b); }
    expect(code(() => b64uDecode("AA=="))).toBe("BASE64URL_INVALID");
    expect(code(() => b64uDecode("AB"))).toBe("BASE64URL_INVALID"); // non-canonical trailing bits
    expect(code(() => b64uDecode("A"))).toBe("BASE64URL_INVALID");
    expect(code(() => b64uDecode("AAAA", 2))).toBe("BASE64URL_LENGTH");
  });
  it("timestamps and durations", () => {
    expect(parseTimestamp("2026-11-12T10:00:00Z")).toBe(Date.UTC(2026, 10, 12, 10));
    expect(parseTimestamp("2026-11-12T10:00:00.5Z")).toBe(Date.UTC(2026, 10, 12, 10, 0, 0, 500));
    for (const bad of ["2026-11-12T10:00:00+00:00", "2026-02-30T00:00:00Z", "2026-11-12 10:00:00Z", "2026-11-12T24:00:00Z"])
      expect(code(() => parseTimestamp(bad))).toBe("TIMESTAMP_INVALID");
    expect(parseDuration("P7D")).toBe(7 * 86400000);
    expect(parseDuration("PT6H")).toBe(6 * 3600000);
    expect(parseDuration("P1DT2H3M4S")).toBe(((24 + 2) * 60 + 3) * 60000 + 4000);
    for (const bad of ["P1Y", "P1M", "P", "PT", "7D", "P1DT"]) expect(code(() => parseDuration(bad))).toBe("DURATION_INVALID");
  });
  it("CID round trip and rejection", () => {
    const d = sha256(new Uint8Array([1, 2, 3]));
    const c = cidFromDigest(d);
    expect(c.startsWith("bafkrei")).toBe(true);
    expect(digestFromCid(c)).toEqual(d);
    expect(code(() => digestFromCid("z" + c.slice(1)))).toBe("CID_INVALID");
    expect(code(() => digestFromCid(c.slice(0, -1)))).toBe("CID_INVALID");
  });
  it("Merkle commitment: empty, one, odd promotion, ordering", () => {
    expect(inputCommitment([])).toEqual(sha256(new Uint8Array(0)));
    const hs = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
    const leaf = (h: Uint8Array) => sha256(Uint8Array.from([0, ...h]));
    const node = (l: Uint8Array, r: Uint8Array) => sha256(Uint8Array.from([1, ...l, ...r]));
    expect(inputCommitment([hs[0]!])).toEqual(leaf(hs[0]!));
    expect(inputCommitment(hs)).toEqual(node(node(leaf(hs[0]!), leaf(hs[1]!)), leaf(hs[2]!)));
    expect(code(() => inputCommitment([hs[1]!, hs[0]!]))).toBe("MERKLE_UNSORTED");
    expect(code(() => inputCommitment([hs[0]!, hs[0]!]))).toBe("MERKLE_UNSORTED");
  });
  it("user_data layout is 181 bytes", () => {
    const u = encodeUserData({ purpose: 0x02, idKeyHash: new Uint8Array(32).fill(1), instKeyHash: new Uint8Array(32).fill(2),
      programHash: new Uint8Array(32).fill(3), jobHash: new Uint8Array(32).fill(4), epoch: 258n, isolation: 0x01 });
    expect(u.length).toBe(181);
    expect(u[172 + 6]).toBe(1); expect(u[172 + 7]).toBe(2); // big-endian epoch
    const d = decodeUserData(u);
    expect(d.epoch).toBe(258n); expect(d.purpose).toBe(2); expect(d.chainKeyHash).toEqual(new Uint8Array(32));
    const bad = u.slice(); bad[0] = 0x58;
    expect(code(() => decodeUserData(bad))).toBe("ATT_USER_DATA_MALFORMED");
    expect(code(() => decodeUserData(u.slice(0, 180)))).toBe("ATT_USER_DATA_MALFORMED");
  });
  it("strict field table", () => {
    const ok = { ct: "AA", enc: "AA", epoch: 0, job_hash: "AA", kem: "x-wing-draft-06", type: "notary.sealed_input.v1" };
    expect(() => assertNotaryObject(ok, "notary.sealed_input.v1")).not.toThrow();
    expect(code(() => assertNotaryObject({ ...ok, extra: 1 }, "notary.sealed_input.v1"))).toBe("UNKNOWN_FIELD");
    expect(code(() => assertNotaryObject({ ...ok, type: "notary.job.v1" }, "notary.sealed_input.v1"))).toBe("TYPE_MISMATCH");
    expect(H(ok).length).toBe(43);
  });
});
