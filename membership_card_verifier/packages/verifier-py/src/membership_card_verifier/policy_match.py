import re
from typing import Any, Optional

from .types import ChainLink, PolicyMatchConditions


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
) -> Optional[bool]:
    """Implements `policy_match`: does the chain (as already walked by Stage 3)
    include a card whose own CardDocument's `policy_id` field equals
    `conditions.policy_id`, with every `field_match` entry also matching that
    same card's fields?

    Reuses the chain data Stage 3 already computes — no second chain walk or
    IPFS fetch pass. Returns `None` when `conditions` was not supplied
    (preserving prior behavior for callers who don't use this feature).
    """
    if not conditions:
        return None

    for link in chain:
        if link.card_content.get("policy_id") != conditions.policy_id:
            continue

        field_match = conditions.field_match
        if not field_match:
            return True

        all_fields_match = all(
            _field_value_matches(link.card_content.get(field), matcher)
            for field, matcher in field_match.items()
        )
        if all_fields_match:
            return True

    return False
