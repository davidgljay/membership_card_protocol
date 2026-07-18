from membership_card_verifier import ChainLink

from matrix_policy_module.predicates import evaluate_room_predicate

POLICY_A = "bafyreigh2akiscaildc-community-policy-v1"
POLICY_B = "bafyreiabc123-partner-org-policy-v3"
POLICY_C = "bafyreiznomatch-other-policy"


def _chain(policy_id: str, **fields: object) -> list[ChainLink]:
    return [ChainLink(card_address="0xabc", public_key="pk", card_content={"policy_id": policy_id, **fields})]


def test_single_entry_matching_policy_and_field() -> None:
    doc = {
        "policies": [
            {"ref_type": "cid", "ref": POLICY_A, "field_match": {"field": "status", "regex": "^active$"}},
        ]
    }
    chain = _chain(POLICY_A, status="active")
    assert evaluate_room_predicate(doc, chain) == (True, None)


def test_single_entry_matching_policy_wrong_field() -> None:
    doc = {
        "policies": [
            {"ref_type": "cid", "ref": POLICY_A, "field_match": {"field": "status", "regex": "^active$"}},
        ]
    }
    chain = _chain(POLICY_A, status="suspended")
    assert evaluate_room_predicate(doc, chain) == (False, "field_mismatch")


def test_single_entry_non_matching_policy() -> None:
    doc = {"policies": [{"ref_type": "cid", "ref": POLICY_A}]}
    chain = _chain(POLICY_C)
    assert evaluate_room_predicate(doc, chain) == (False, "no_policy_match")


def test_multi_entry_any_of_only_one_matches() -> None:
    doc = {
        "policies": [
            {"ref_type": "cid", "ref": POLICY_A, "field_match": {"field": "status", "regex": "^active$"}},
            {"ref_type": "pointer", "ref": "0xpartner", "resolved_ref": POLICY_B},
        ]
    }
    # Doesn't satisfy entry 1 (wrong policy_id), does satisfy entry 2 (no field_match).
    chain = _chain(POLICY_B)
    assert evaluate_room_predicate(doc, chain) == (True, None)


def test_multi_entry_any_of_none_match() -> None:
    doc = {
        "policies": [
            {"ref_type": "cid", "ref": POLICY_A},
            {"ref_type": "pointer", "ref": "0xpartner", "resolved_ref": POLICY_B},
        ]
    }
    chain = _chain(POLICY_C)
    assert evaluate_room_predicate(doc, chain) == (False, "no_policy_match")


def test_pointer_entry_uses_resolved_ref_not_ref() -> None:
    # resolved_ref, not the raw pointer address, is what's actually evaluated.
    doc = {
        "policies": [
            {"ref_type": "pointer", "ref": "0x9f2c-partner-org-policy-address", "resolved_ref": POLICY_B},
        ]
    }
    chain = _chain(POLICY_B)
    assert evaluate_room_predicate(doc, chain) == (True, None)


def test_empty_policies_list_denies() -> None:
    assert evaluate_room_predicate({"policies": []}, _chain(POLICY_A)) == (False, "no_policy_match")
