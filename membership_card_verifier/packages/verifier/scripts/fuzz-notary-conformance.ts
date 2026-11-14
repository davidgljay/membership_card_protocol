/**
 * Code-plan §7.5, mechanism 4: differential fuzzing of `notary-cards` against this verifier.
 *
 * Mutates the committed contributor cases (a flipped character, a dropped key or array element, a changed integer, a
 * shifted clock), judges each mutant with the TypeScript verifier (`checkContributor`), and writes the mutants and
 * verdicts for the Rust side to judge:
 *
 *   node --experimental-strip-types scripts/fuzz-notary-conformance.ts --seed 1 --count 500 --out /tmp/fuzz.json
 *   NOTARY_FUZZ_FILE=/tmp/fuzz.json cargo test -p notary-cards --test fuzz   (in notary/)
 *
 * Not gating. Every disagreement is a bug in the port or in the verifier; once understood it becomes a committed case in
 * `gen-notary-conformance.ts`. Deterministic for a given seed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { checkContributor } from "../dist/notary/index.js";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1]! : d; };
const seed = Number(arg("--seed", "1")), count = Number(arg("--count", "300")), out = arg("--out", "fuzz-cases.json");
const base = JSON.parse(readFileSync(new URL("../../../../notary/vectors/cards/cases.json", import.meta.url), "utf8")).cases as Record<string, any>[];

let s = seed >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

type Path = (string | number)[];
function leaves(v: unknown, path: Path = [], acc: { path: Path; v: unknown }[] = []) {
  if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, i], acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], acc);
  else acc.push({ path, v });
  return acc;
}
const at = (root: any, path: Path) => path.slice(0, -1).reduce((o, k) => o[k], root);
const alphabets = [/^[0-9a-f]+$/, /^[A-Za-z0-9_-]+$/];

function mutate(c: Record<string, any>): string {
  const parts = ["input", "world", "predicate", "parameters"] as const;
  const root = c;
  const kind = pick(["flip", "flip", "flip", "drop", "int", "clock"]);
  if (kind === "clock") { const d = new Date(Date.parse(c.config.nowIso) + Math.floor((rnd() - 0.5) * 4e9)); c.config.nowIso = d.toISOString(); return `clock → ${c.config.nowIso}`; }
  const part = pick([...parts]);
  const ls = leaves(root[part], [part]);
  if (ls.length === 0) return "none";
  if (kind === "flip") {
    const strs = ls.filter((l) => typeof l.v === "string" && (l.v as string).length > 3);
    if (strs.length === 0) return "none";
    const l = pick(strs), str = l.v as string, i = Math.floor(rnd() * str.length);
    const set = alphabets.find((a) => a.test(str));
    const pool = set === alphabets[0] ? "0123456789abcdef" : set ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" : "xyz ?{}";
    let ch = pick([...pool]); if (ch === str[i]) ch = pool[(pool.indexOf(ch) + 1) % pool.length]!;
    at(root, l.path)[l.path[l.path.length - 1]!] = str.slice(0, i) + ch + str.slice(i + 1);
    return `flip ${l.path.join(".")}[${i}]`;
  }
  if (kind === "int") {
    const ns = ls.filter((l) => typeof l.v === "number");
    if (ns.length === 0) return "none";
    const l = pick(ns); at(root, l.path)[l.path[l.path.length - 1]!] = (l.v as number) + pick([-1, 1]);
    return `int ${l.path.join(".")}`;
  }
  const l = pick(ls), parent = at(root, l.path), key = l.path[l.path.length - 1]!;
  if (Array.isArray(parent)) parent.splice(key as number, 1); else delete parent[key];
  return `drop ${l.path.join(".")}`;
}

const mutants: Record<string, unknown>[] = [];
let tsErrors = 0;
for (let n = 0; n < count; n++) {
  const b = pick(base);
  const c = JSON.parse(JSON.stringify(b));
  const what = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => mutate(c)).join("; ");
  try {
    const r = await checkContributor({ input: c.input, contributorPredicate: c.predicate, parameters: c.parameters, world: c.world, config: c.config });
    const expect = r.ok ? { ok: true, root_key_hash: r.root_key_hash, chain_addresses: r.chain_addresses } : { ok: false, code: r.code };
    mutants.push({ id: `fuzz-${seed}-${n} (${b.id}: ${what})`, config: c.config, predicate: c.predicate, parameters: c.parameters, input: c.input, world: c.world, expect });
  } catch { tsErrors++; } // a mutant the verifier itself can't take (malformed world); not a verdict
}
writeFileSync(out, JSON.stringify({ seed, count, ts_errors: tsErrors, cases: mutants }));
console.log(`wrote ${mutants.length} mutants (${tsErrors} the verifier could not take) to ${out}`);
