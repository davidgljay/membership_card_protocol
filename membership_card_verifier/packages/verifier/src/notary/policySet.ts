/**
 * The contributor policy set (notary_runtime.md §6, A12; protocol-objects.md §27 `contributor_policies`).
 *
 * A `contributor_predicate` is closed when a card can satisfy it only by being issued under one of a finite list of
 * policies: `issued_under_template` is closed; `any_of` is closed if it is non-empty and every child is; `all_of` is
 * closed if at least one child is; everything else is not. The policy set is the union of the closed leaves, with
 * `{ "param": name }` references resolved from the job's `parameters`.
 *
 * The Rust twin is `notary-types/src/policy_set.rs`; both are checked against `notary/vectors/policy_set/`.
 */
type Json = unknown;

const paramName = (v: Json): string | null => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const k = Object.keys(v);
  const name = (v as Record<string, Json>)["param"];
  return k.length === 1 && typeof name === "string" ? name : null;
};

const single = (pred: Json): [string, Json] | null => {
  if (pred === null || typeof pred !== "object" || Array.isArray(pred)) return null;
  const k = Object.keys(pred);
  return k.length === 1 ? [k[0]!, (pred as Record<string, Json>)[k[0]!]] : null;
};

/** Structural closedness, independent of parameter values (what admission and `notary-lint` check). */
export function isClosedPredicate(pred: Json): boolean {
  const e = single(pred);
  if (!e) return false;
  const [op, v] = e;
  switch (op) {
    case "issued_under_template": return typeof v === "string" || paramName(v) !== null;
    case "any_of": return Array.isArray(v) && v.length > 0 && v.every(isClosedPredicate);
    case "all_of": return Array.isArray(v) && v.some(isClosedPredicate);
    default: return false;
  }
}

function collect(pred: Json, params: Record<string, unknown>, out: Set<string>): boolean {
  const e = single(pred);
  if (!e) return false;
  const [op, v] = e;
  if (op === "issued_under_template") {
    const name = paramName(v);
    const value = name !== null ? (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined) : v;
    if (typeof value !== "string") return false;
    out.add(value);
    return true;
  }
  if (op === "any_of" && Array.isArray(v)) return v.every((c) => collect(c, params, out));
  if (op === "all_of" && Array.isArray(v)) return v.filter(isClosedPredicate).every((c) => collect(c, params, out));
  return false;
}

/** The policy set, sorted and without duplicates; `null` when the predicate is open or a parameter is absent or not text. */
export function contributorPolicySet(pred: Json, params: Record<string, unknown>): string[] | null {
  if (!isClosedPredicate(pred)) return null;
  const out = new Set<string>();
  if (!collect(pred, params, out)) return null;
  return [...out].sort();
}
