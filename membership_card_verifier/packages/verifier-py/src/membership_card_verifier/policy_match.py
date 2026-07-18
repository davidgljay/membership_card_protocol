import re
from typing import Any, Optional

from .types import ChainLink, PolicyMatchConditions, PolicyMatchResult


def _field_value_matches(value: Any, matcher: str | dict[str, str]) -> bool:
    """Evaluates a single field_match entry against a card's field value.

    Plain string values are exact-match shorthand; `{ regex }` values are
    evaluated as a full regular expression against string field values.
    """
    if isinstance(matcher, str):
        return value == matcher
    if not isinstance(value, str):
        return False
    try:
        return bool(re.search(matcher["regex"], value))
    except Exception:
        return False


def evaluate_policy_match(
    chain: list[ChainLink], conditions: Optional[PolicyMatchConditions]
) -> Optional[PolicyMatchResult]:
    """Implements `policy_match`: does the chain (as already walked by Stage 3)
    include a card whose own CardDocument's `policy_id` field equals
    `conditions.policy_id`, with every `field_match` entry also matching that
    same card's fields? Returns a `PolicyMatchResult` with matched=true when a
    fully-satisfying link is found (no `reason`), or when no match, returns a
    `PolicyMatchResult` with matched=false and a reason: "field_mismatch" if at
    least one link matched the policy_id but failed field checks, otherwise
    "no_policy_match" if no link ever matched the policy_id.

    Reuses the chain data Stage 3 already computes — no second chain walk or
    IPFS fetch pass. Returns `None` when `conditions` was not supplied
    (preserving prior behavior for callers who don't use this feature).
    """
    if not conditions:
        return None

    saw_policy_id_match = False

    for link in chain:
        if link.card_content.get("policy_id") != conditions.policy_id:
            continue
        saw_policy_id_match = True

        field_match = conditions.field_match
        if not field_match:
            return PolicyMatchResult(matched=True)

        all_fields_match = all(
            _field_value_matches(link.card_content.get(field), matcher)
            for field, matcher in field_match.items()
        )
        if all_fields_match:
            return PolicyMatchResult(matched=True)

    return PolicyMatchResult(
        matched=False,
        reason="field_mismatch" if saw_policy_id_match else "no_policy_match",
    )
