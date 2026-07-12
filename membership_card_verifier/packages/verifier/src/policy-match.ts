import type { ChainLink, PolicyMatchConditions } from "./types.js";

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
 * Reuses the chain data Stage 3 already computes — no second chain walk or
 * IPFS fetch pass. Returns `null` when `conditions` was not supplied
 * (preserving prior behavior for callers who don't use this feature).
 */
export function evaluatePolicyMatch(
  chain: ChainLink[],
  conditions: PolicyMatchConditions | undefined
): boolean | null {
  if (!conditions) return null;

  for (const link of chain) {
    if (link.card_content["policy_id"] !== conditions.policy_id) continue;

    const fieldMatch = conditions.field_match;
    if (!fieldMatch) return true;

    const allFieldsMatch = Object.entries(fieldMatch).every(([field, matcher]) =>
      fieldValueMatches(link.card_content[field], matcher)
    );
    if (allFieldsMatch) return true;
  }

  return false;
}
