import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { contributorPolicySet, isClosedPredicate } from "../../src/notary/policySet.js";

const file = JSON.parse(readFileSync(new URL("../../../../../notary/vectors/policy_set/cases.json", import.meta.url), "utf8")) as {
  cases: { id: string; predicate: unknown; parameters: Record<string, unknown>; closed: boolean; policy_set: string[] | null }[];
};

describe("contributor policy set (notary_runtime.md §6, A12): the shared vectors", () => {
  it("has the cases", () => expect(file.cases.length).toBeGreaterThanOrEqual(15));
  for (const c of file.cases) {
    it(c.id, () => {
      expect(isClosedPredicate(c.predicate)).toBe(c.closed);
      expect(contributorPolicySet(c.predicate, c.parameters)).toEqual(c.policy_set);
    });
  }
});
