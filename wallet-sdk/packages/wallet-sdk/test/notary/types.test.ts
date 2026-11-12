import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotaryObject, canonicalNotary, H, b64uEncode } from "../../src/notary/notary-types.js";
import type { NotaryJob, JobAnnouncement, NotaryInput, SealedInput, HostReceipt, ValidationReceipt, NotaryCountersign } from "../../src/notary/notary-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const V = join(here, "..", "..", "..", "..", "..", "notary", "vectors", "objects");
const first = <T>(name: string): { input: T; canonical_b64u: string; h: string; type: string } => JSON.parse(readFileSync(join(V, `${name}.json`), "utf8")).cases[0];

describe("wallet notary types (§21–§26) against shared vectors", () => {
  it.each([
    ["job"], ["announcement"], ["input"], ["countersign"], ["sealed_input"], ["host_receipt"], ["validation_receipt"],
  ])("%s vector is canonical, strict, and hashes as committed", (name) => {
    const c = first<Record<string, unknown>>(name);
    assertNotaryObject(c.input, c.type);
    expect(b64uEncode(canonicalNotary(c.input))).toBe(c.canonical_b64u);
    expect(H(c.input)).toBe(c.h);
  });

  it("vector objects satisfy the TypeScript interfaces", () => {
    const a: NotaryJob = first<NotaryJob>("job").input;
    const b: JobAnnouncement = first<JobAnnouncement>("announcement").input;
    const c: NotaryInput = first<NotaryInput>("input").input;
    const d: SealedInput = first<SealedInput>("sealed_input").input;
    const e: HostReceipt = first<HostReceipt>("host_receipt").input;
    const f: ValidationReceipt = first<ValidationReceipt>("validation_receipt").input;
    const g: NotaryCountersign = first<NotaryCountersign>("countersign").input;
    expect([a.type, b.type, c.type, d.type, e.type, f.type, g.type].every((t) => t.startsWith("notary."))).toBe(true);
    expect(b.job.type).toBe("notary.job.v1");
  });

  it("the notary-types subpath imports nothing from the rest of the wallet (Q4)", () => {
    const dist = join(here, "..", "..", "dist", "notary");
    for (const f of ["notary-types.js", "types.js"]) {
      const src = readFileSync(join(dist, f), "utf8");
      const specs = [...src.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of specs) expect(s === "@membership-card-protocol/verifier/notary" || s === "./types.js", `${f} imports ${s}`).toBe(true);
    }
  });
});
