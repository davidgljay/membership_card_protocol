import { describe, it, expect } from "vitest";
import { parametersWithinBounds } from "../../src/notary/parameters.js";

// the derive template's bounds (notary/templates/derive/policy.json)
const bounds = [
  { name: "source_policy", type: "cid", required: true },
  { name: "projected_fields", type: "append-only-array", item_type: "text", required: true, min_count: 1, max_count: 3, regex: "[a-z][a-z0-9_]{0,63}" },
] as never;

describe("step 6.4: projected_fields is an append-only array of text (same rules as the runtime's params::check)", () => {
  it("accepts one to three distinct field names", () => {
    expect(parametersWithinBounds({ source_policy: "bafkreix", projected_fields: ["level"] }, bounds)).toBe(true);
    expect(parametersWithinBounds({ source_policy: "bafkreix", projected_fields: ["a", "b", "c"] }, bounds)).toBe(true);
  });
  it("refuses none, four, duplicates, bad names, a non-array and non-text items", () => {
    for (const f of [[], ["a", "b", "c", "d"], ["a", "a"], ["Level"], "level", [1]]) expect(parametersWithinBounds({ source_policy: "bafkreix", projected_fields: f }, bounds), JSON.stringify(f)).toBe(false);
  });
});
