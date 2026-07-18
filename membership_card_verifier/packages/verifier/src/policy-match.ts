import type { ChainLink, PolicyMatchConditions, PolicyMatchResult } from "./types.js";

/**
 * Evaluates a single field_match entry against a card's field value.
 * Plain string values are exact-match shorthand; `{ regex }` values are
 * evaluated as a full regular expression against string field values.
 */
function fieldValueMatches(value: unknown, matcher: string | { regex: string }): boolean {
  if (typeof matcher === "string") {
    return value === matcher;
  }
  if (typeof value !== "string") return false;
  try {
    return new RegExp(matcher.regex).test(value);
  } catch {
    return false;
  }
}

/**
 * Implements `policy_match`: does the chain (as already walked by Stage 3)
 * include a card whose own CardDocument's `policy_id` field equals
 * `conditions.policy_id`, with every `field_match` entry also matching that
 * same card's fields?
 *
 * Returns `{ matched: true }` when a link fully satisfies the policy conditions.
 * Returns `{ matched: false, reason: "field_mismatch" }` when a link matches
 * the policy_id but its fields don't satisfy the field_match conditions.
 * Returns `{ matched: false, reason: "no_policy_match" }` when no link in the
 * chain matches the target policy_id at all.
 * Returns `null` when `conditions` was not supplied (preserving prior behavior
 * for callers who don't use this feature).
 *
 * Reuses the chain data Stage 3 already computes — no second chain walk or
 * IPFS fetch pass.
 */
export function evaluatePolicyMatch(
  chain: ChainLink[],
  conditions: PolicyMatchConditions | undefined
): PolicyMatchResult | null {
  if (!conditions) return null;

  let sawPolicyIdMatch = false;

  for (const link of chain) {
    if (link.card_content["policy_id"] !== conditions.policy_id) continue;
    sawPolicyIdMatch = true;

    const fieldMatch = conditions.field_match;
    if (!fieldMatch) return { matched: true };

    const allFieldsMatch = Object.entries(fieldMatch).every(([field, matcher]) =>
      fieldValueMatches(link.card_content[field], matcher)
    );
    if (allFieldsMatch) return { matched: true };
  }

  return { matched: false, reason: sawPolicyIdMatch ? "field_mismatch" : "no_policy_match" };
}
