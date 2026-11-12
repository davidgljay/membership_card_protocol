import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const files = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });

describe("the notary subpath is opt-in (code-plan §3.1, §7.1)", () => {
  it("no module outside src/notary imports notary code at runtime (type-only imports are erased)", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      if (f.includes(`${join(SRC, "notary")}/`)) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?from\s*["']([^"']*notary[^"']*)["']/gm)) offenders.push(`${f.replace(SRC, "src")}: ${m[2]}`);
      for (const m of src.matchAll(/import\(\s*["']([^"']*notary[^"']*)["']\s*\)/g)) offenders.push(`${f.replace(SRC, "src")}: dynamic ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
  it("the core entry point does not re-export notary symbols", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(/from\s*["'][^"']*notary/.test(index.replace(/export type[^;]*from\s*["'][^"']*notary[^"']*["'];?/g, ""))).toBe(false);
  });
  it("the package exposes the subpath", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
    expect(pkg.exports["./notary"].import).toBe("./dist/notary/index.js");
  });
});
