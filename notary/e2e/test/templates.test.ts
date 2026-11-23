/**
 * 7.1, G3: "a community activates each template with no code". The three committed template policies
 * (`templates/{aggregate,vote-yna,derive}/policy.json`) are what this e2e world runs (`src/world.ts`). The policy a community
 * runs may differ from its template only in the fields the template leaves to the community: who may contribute, `k_min`,
 * where the result goes, the program CID, the platform, and (derived cards) the issuance and propagation values. Anything
 * else changed would be code or policy a community was never meant to write.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NOTARY_SECTION, VOTE_NOTARY_SECTION, DERIVE_NOTARY_SECTION, EXPIRY_NOTARY_SECTION } from "../src/world.ts";

const template = (n: string) => (JSON.parse(readFileSync(new URL(`../../templates/${n}/policy.json`, import.meta.url), "utf8")) as { notary: Record<string, unknown> }).notary;
const COMMUNITY = ["contributor_predicate", "platform", "privacy", "program_cid", "output_recipients", "job_requester_predicate", "derived_card", "revocation_propagation"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

for (const [name, dir, run] of [["aggregate", "aggregate", NOTARY_SECTION], ["vote", "vote-yna", VOTE_NOTARY_SECTION], ["derived card (sealed_link)", "derive", DERIVE_NOTARY_SECTION], ["derived card (expiry_only)", "derive", EXPIRY_NOTARY_SECTION]] as const) {
  describe(`${name} template`, () => {
    const t = template(dir);
    const r = run as Record<string, unknown>;
    it("the running policy changes only what the template leaves to the community", () => {
      const changed = [...new Set([...Object.keys(t), ...Object.keys(r)])].filter((k) => !same(t[k], r[k]));
      expect(changed.filter((k) => !COMMUNITY.includes(k))).toEqual([]);
    });
    it("every placeholder the template carries is filled", () => {
      expect(JSON.stringify(r)).not.toMatch(/<[^"]*>/);
    });
    it("the template's schemas, bounds and replacement rule are used as published", () => {
      for (const k of ["input_schema", "output_schema", "parameter_bounds", "input_replacement", "isolation", "mode", "output_action"]) expect(r[k]).toEqual(t[k]);
    });
  });
}

describe("control", () => {
  it("a policy that changes a field outside the community's list is caught", () => {
    const t = template("vote-yna");
    const edited = { ...VOTE_NOTARY_SECTION, retention: "forever" } as Record<string, unknown>;
    const changed = Object.keys(edited).filter((k) => !same(t[k], edited[k]));
    expect(changed.filter((k) => !COMMUNITY.includes(k))).toEqual(["retention"]);
  });
});
