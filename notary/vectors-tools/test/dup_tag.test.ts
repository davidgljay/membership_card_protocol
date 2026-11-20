import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { b64uDecode, b64uEncode } from "@membership-card-protocol/verifier/notary";

const v = JSON.parse(readFileSync(new URL("../../vectors/dup_tag/cases.json", import.meta.url), "utf8"));
const be8 = (p: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(p)); return b; };

describe("dup_tag and its ratchet (derived_card_revocation_propagation.md §1): Rust (the broker) and TypeScript agree", () => {
  it("k_T,p = HKDF-SHA256(k_T,p-1, info = ratchet label || p as 8 bytes big-endian)", () => {
    const k100 = b64uDecode(v.k_t_100, 32);
    const info = new Uint8Array([...new TextEncoder().encode(v.ratchet_info), ...be8(101)]);
    const k101 = hkdf(sha256, k100, undefined, info, 32);
    expect(b64uEncode(k101)).toBe(v.cases.find((c: { period: number }) => c.period === 101).k_t_p);
  });
  it("dup_tag = HMAC-SHA256(k_T,p, root_source_key || source_policy || p)", () => {
    for (const c of v.cases) {
      const msg = new Uint8Array([...b64uDecode(c.root_source_key), ...new TextEncoder().encode(c.source_policy), ...be8(c.period)]);
      expect(b64uEncode(hmac(sha256, b64uDecode(c.k_t_p, 32), msg))).toBe(c.dup_tag);
    }
  });
});
