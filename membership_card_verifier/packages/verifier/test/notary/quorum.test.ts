import { describe, expect, it } from "vitest";
import { singleOperatorQuorum } from "../../src/notary/index.js";

const ops: Record<string, string> = { a1: "opA", a2: "opA", b1: "opB", c1: "opC" };
const of = (c: string) => ops[c];

describe("single-operator quorums (notary_lifecycle.md L4)", () => {
  it("one card, any instances: single operator", () => {
    expect(singleOperatorQuorum([{ notary_card: "a1", instances: 3 }], of)).toEqual({ single: true, unknown: false });
  });
  it("two cards of one operator reach q together", () => {
    expect(singleOperatorQuorum([{ notary_card: "a1", instances: 1 }, { notary_card: "a2", instances: 1 }, { notary_card: "b1", instances: 1 }], of).single).toBe(true);
  });
  it("three operators, one instance each: no single operator reaches q = 2", () => {
    expect(singleOperatorQuorum([{ notary_card: "a1", instances: 1 }, { notary_card: "b1", instances: 1 }, { notary_card: "c1", instances: 1 }], of)).toEqual({ single: false, unknown: false });
  });
  it("one operator holding exactly q of N is single", () => {
    expect(singleOperatorQuorum([{ notary_card: "a1", instances: 3 }, { notary_card: "b1", instances: 2 }], of).single).toBe(true); // N=5, q=3
    expect(singleOperatorQuorum([{ notary_card: "a1", instances: 2 }, { notary_card: "b1", instances: 2 }, { notary_card: "c1", instances: 1 }], of).single).toBe(false);
  });
  it("an unknown operator is grouped by its card and reported", () => {
    expect(singleOperatorQuorum([{ notary_card: "x1", instances: 1 }, { notary_card: "b1", instances: 1 }, { notary_card: "c1", instances: 1 }], of)).toEqual({ single: false, unknown: true });
  });
});
