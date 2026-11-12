import { describe, it, expect } from "vitest";
import { b64uEncode, inputCommitment } from "@membership-card-protocol/verifier/notary";
import { checkInclusion, inclusionPath, verifyInclusionPath } from "../../src/notary/inclusion.js";

const hashes = (n: number) => Array.from({ length: n }, (_, i) => { const h = new Uint8Array(32); h[0] = i + 1; return h; });

describe("inclusion check (wallet_sdk.md §7b.6)", () => {
  const list = hashes(7);
  const root = b64uEncode(inputCommitment(list));
  const counted = list.map(b64uEncode);
  it("a counted input is included", () => expect(checkInclusion(counted[3]!, counted, root)).toEqual({ included: true }));
  it("an input that was not counted is reported", () => expect(checkInclusion(b64uEncode(new Uint8Array(32).fill(9)), counted, root)).toEqual({ included: false, reason: "NOT_COUNTED" }));
  it("a list that does not match the commitment is reported", () => expect(checkInclusion(counted[0]!, counted.slice(1), root)).toEqual({ included: false, reason: "COMMITMENT_MISMATCH" }));
  it("an unsorted or malformed list is invalid", () => {
    expect(checkInclusion(counted[0]!, [counted[1]!, counted[0]!], root)).toEqual({ included: false, reason: "LIST_INVALID" });
    expect(checkInclusion(counted[0]!, ["AA"], root)).toEqual({ included: false, reason: "LIST_INVALID" });
  });
  it("Merkle paths prove inclusion against the commitment alone, for every position and size", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9]) {
      const l = hashes(n), r = inputCommitment(l);
      for (let i = 0; i < n; i++) {
        expect(verifyInclusionPath(l[i]!, inclusionPath(l, i), r), `n=${n} i=${i}`).toBe(true);
        expect(verifyInclusionPath(new Uint8Array(32).fill(0xee), inclusionPath(l, i), r)).toBe(false);
      }
    }
  });
});
