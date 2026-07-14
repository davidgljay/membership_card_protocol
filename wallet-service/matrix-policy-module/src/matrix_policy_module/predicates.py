"""Room predicate document evaluator (Step 9c).

Per matrix_room.md, a room predicate document is a fixed, constrained shape —
not the protocol's general any_of/all_of/none_of grammar: a flat `policies`
list, each entry a pinned CID (`ref`, or `resolved_ref` for pointer-originated
entries — resolved_ref is what's actually evaluated when present) plus an
optional single `field_match: {field, regex}`, combined by a bare `any_of`
across the list. This module does not implement `is_holder`/`is_issuer`/
`chain_depth_at_most`/`code_equals`/`chain_includes` — none of them appear in
this fixed schema.

This is deliberately a thin loop over the verifier package's own exported
`evaluate_policy_match`, not a reimplementation of exact-match/regex field
logic — reimplementing it here would be exactly the "parallel implementation
that can drift out of sync" matrix-strategic-plan.md's Goal 2 exists to
prevent.
"""

from __future__ import annotations

from typing import Any

from membership_card_verifier import ChainLink, PolicyMatchConditions, evaluate_policy_match


def _entry_conditions(entry: dict[str, Any]) -> PolicyMatchConditions:
    policy_id = entry.get("resolved_ref") or entry["ref"]
    field_match_entry = entry.get("field_match")
    field_match: dict[str, Any] | None = None
    if field_match_entry is not None:
        field_match = {field_match_entry["field"]: {"regex": field_match_entry["regex"]}}
    return PolicyMatchConditions(policy_id=policy_id, field_match=field_match)


def evaluate_room_predicate(
    predicate_document: dict[str, Any], chain: list[ChainLink]
) -> bool:
    """True if `chain` was issued under *any* policy entry in the room's
    predicate document (and satisfies that entry's field_match, if present).
    False otherwise, including for an entry whose evaluate_policy_match
    returns None (indeterminate — treated as non-match, not an exception;
    deny-by-default per matrix_room_membership.md §4 is enforced by the
    caller treating "no entry matched" as a deny)."""
    for entry in predicate_document.get("policies", []):
        conditions = _entry_conditions(entry)
        if evaluate_policy_match(chain, conditions):
            return True
    return False
