# G1 Spec — `evaluate_policy_match` reason codes

Implements `plans/todo-implementation-plan.md` Phase 1 (G1), resolving
`plans/completed/membership_card_verifier_todo.md` item 1. Decision locked in
from `strategic-plan.md` §G1: plain discriminated object, not a tagged-union
type.

## 1. New shared shape: `PolicyMatchResult`

**TS** (`packages/verifier/src/types.ts`, add near `PolicyMatchConditions`):

```ts
export interface PolicyMatchResult {
  matched: boolean;
  reason?: "no_policy_match" | "field_mismatch"; // present only when matched === false
}
```

**Python** (`packages/verifier-py/src/membership_card_verifier/types.py`, add
near `PolicyMatchConditions`):

```python
@dataclass
class PolicyMatchResult:
    matched: bool
    reason: Optional[Literal["no_policy_match", "field_mismatch"]] = None
```

`reason` is always `None`/absent when `matched` is `True`. Never set both
`matched: true` and a `reason`.

## 2. `evaluate_policy_match` return-shape change

**Old signature:** `(chain, conditions) -> boolean | null` (TS) /
`Optional[bool]` (Python).

**New signature:** `(chain, conditions) -> PolicyMatchResult | null` (TS) /
`Optional[PolicyMatchResult]` (Python).

- `conditions` not supplied (`undefined`/`None`) → return `null`/`None`,
  unchanged from today.
- Otherwise, walk `chain` exactly as today (same iteration order, same
  short-circuit on first fully-satisfying link), but track whether **any**
  link had a `policy_id` match, regardless of whether its `field_match` also
  passed. At the end:
  - a link satisfies fully (`policy_id` matches AND (`field_match` absent OR
    all fields match)) → return `{ matched: true }` immediately (no
    `reason`) — same early-return point as today's `return true`.
  - loop completes with no fully-satisfying link, but at least one link had a
    `policy_id` match (its fields just didn't satisfy `field_match`) →
    return `{ matched: false, reason: "field_mismatch" }`.
  - loop completes with no link ever matching `policy_id` at all → return
    `{ matched: false, reason: "no_policy_match" }`.

**TS implementation** (`packages/verifier/src/policy-match.ts`):

```ts
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
```

(`fieldValueMatches` is unchanged.) Update the doc comment to describe the
new return shape; keep the existing "reuses Stage 3's chain data" paragraph.

**Python implementation** (mirror exactly, same variable name
`saw_policy_id_match`):

```python
def evaluate_policy_match(
    chain: list[ChainLink], conditions: Optional[PolicyMatchConditions]
) -> Optional[PolicyMatchResult]:
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
```

(`_field_value_matches` unchanged.) Update the module docstring to describe
the new return shape.

## 3. Public result-type field change

`policy_match` on `EnvelopeVerificationResult`, `SignatureVerificationResult`,
and `CardVerificationResult` changes type from `boolean | null` /
`Optional[bool]` to `PolicyMatchResult | null` / `Optional[PolicyMatchResult]`
in **both languages**. No new field is added — the existing `policy_match`
field itself now carries the richer value. This is a breaking shape change
for anything that read `policy_match` as a bare boolean.

**TS** (`packages/verifier/src/types.ts` lines 201 and 218): change
`policy_match: boolean | null;` → `policy_match: PolicyMatchResult | null;`
in both `EnvelopeVerificationResult` and `SignatureVerificationResult`
(`CardVerificationResult` inherits it via `Omit<SignatureVerificationResult, ...>`,
no separate edit needed).

**Python** (`packages/verifier-py/.../types.py` lines 237, 293, 316): change
`policy_match: Optional[bool] = None` → `policy_match: Optional[PolicyMatchResult] = None`
on all three of `EnvelopeVerificationResult`, `SignatureVerificationResult`,
`CardVerificationResult`.

## 4. Call-site updates in `CardVerifier.ts` / `card_verifier.py`

Every call to `evaluatePolicyMatch`/`evaluate_policy_match` at existing call
sites (lines noted from the pre-change file; re-locate by the same
surrounding logic if line numbers have drifted) keeps its call shape
identical — only the aggregation helper's internals change:

- `CardVerifier.ts:84` (early sig1-failure path), `:200` (`verifyCard`),
  `:322` (main signature path), `:383` (`#buildResult`), `:415`
  (`#skippedResult`): no change needed — each already just assigns the
  return value straight into a `policy_match` field, which now holds the
  richer object instead of a bare boolean. Nothing else in these call sites
  branches on the boolean value directly.
- `card_verifier.py`: same — lines 115, 235, 366, 423, 448 need no change
  beyond what falls out of the type change.

**Aggregation helper** — this is the one place with real logic to update,
since it currently does a boolean OR:

`CardVerifier.ts` `#aggregateEnvelopePolicyMatch` (line 393):

```ts
#aggregateEnvelopePolicyMatch(signatures: SignatureVerificationResult[]): PolicyMatchResult | null {
  if (!this.config.conditions) return null;
  if (signatures.some((s) => s.policy_match?.matched === true)) return { matched: true };
  const anyFieldMismatch = signatures.some((s) => s.policy_match?.reason === "field_mismatch");
  return { matched: false, reason: anyFieldMismatch ? "field_mismatch" : "no_policy_match" };
}
```

`card_verifier.py` `_aggregate_envelope_policy_match` (line 457-463):

```python
def _aggregate_envelope_policy_match(
    self, signatures: list[SignatureVerificationResult]
) -> Optional[PolicyMatchResult]:
    """Aggregates policy_match across signatures as an OR on `matched`; when
    none matched, prefers surfacing `field_mismatch` over `no_policy_match`
    if any signature saw one, since it's the more specific/informative
    reason."""
    if not self.config.conditions:
        return None
    if any(s.policy_match is not None and s.policy_match.matched for s in signatures):
        return PolicyMatchResult(matched=True)
    any_field_mismatch = any(
        s.policy_match is not None and s.policy_match.reason == "field_mismatch"
        for s in signatures
    )
    return PolicyMatchResult(
        matched=False,
        reason="field_mismatch" if any_field_mismatch else "no_policy_match",
    )
```

Also update the one other place that directly compares `policy_match` to a
boolean literal: `card_verifier.py`'s docstring/line 463 pattern
(`any(s.policy_match is True for s in signatures)`) is being replaced by the
above; there is no TS equivalent needing a separate fix (TS never had that
exact comparison outside `#aggregateEnvelopePolicyMatch` itself).

Grep both files for `policy_match ===` / `policy_match is` before finishing
to confirm no other direct boolean comparison was missed.

## 5. `matrix-policy-module` consumers (Python only) — implemented in step 1.4, not 1.2/1.3

This section is authoritative for step **1.4** (predicates.py + module.py),
not step 1.2. Listed here so the whole shape change is specified in one
place.

**`predicates.py`** — `_entry_conditions` is unchanged. `evaluate_room_predicate`
changes signature and return shape, since a Python dataclass instance is
truthy regardless of `.matched` — the current `if evaluate_policy_match(...):`
is a latent bug against the new return type and must not survive:

```python
def evaluate_room_predicate(
    predicate_document: dict[str, Any], chain: list[ChainLink]
) -> tuple[bool, Optional[str]]:
    """Returns (matched, reason). matched is True if `chain` was issued
    under *any* policy entry in the room's predicate document (and satisfies
    that entry's field_match, if present). reason is None when matched is
    True; otherwise "field_mismatch" if any entry's policy_id matched but its
    field_match didn't, else "no_policy_match" — mirrors
    evaluate_policy_match's own reason priority, aggregated the same way
    #aggregateEnvelopePolicyMatch aggregates across signatures."""
    saw_field_mismatch = False
    for entry in predicate_document.get("policies", []):
        conditions = _entry_conditions(entry)
        result = evaluate_policy_match(chain, conditions)
        if result is None:
            continue
        if result.matched:
            return True, None
        if result.reason == "field_mismatch":
            saw_field_mismatch = True
    return False, ("field_mismatch" if saw_field_mismatch else "no_policy_match")
```

**`module.py`** — `_safe_evaluate_predicate` (~line 393) and its two call
sites (`_decide_join` ~line 280, `check_event_for_spam` ~line 383) need to
propagate the reason instead of collapsing to the bare string
`"policy_violation"`:

```python
def _safe_evaluate_predicate(
    self, predicate_document: dict[str, Any], chain: list, room_id: str, matrix_user_id: str
) -> tuple[Optional[bool], Optional[str]]:
    """Returns (matched, reason). matched is None (with reason
    "evaluation_error") on any exception from the evaluator, per
    matrix_room_membership.md §4's "Predicate evaluation itself throws" row."""
    try:
        return evaluate_room_predicate(predicate_document, chain)
    except Exception:
        logger.exception("predicate evaluation raised for %s in %s", matrix_user_id, room_id)
        return None, "evaluation_error"
```

`_decide_join` (currently):
```python
satisfies_policy = self._safe_evaluate_predicate(predicate_document, attestation.chain, room_id, matrix_user_id)
if satisfies_policy is not True:
    return False, "evaluation_error" if satisfies_policy is None else "policy_violation"
```
becomes:
```python
satisfies_policy, policy_reason = self._safe_evaluate_predicate(predicate_document, attestation.chain, room_id, matrix_user_id)
if satisfies_policy is not True:
    return False, policy_reason
```

`check_event_for_spam` (currently):
```python
satisfies_policy = self._safe_evaluate_predicate(predicate_document, cached.chain, room_id, matrix_user_id)
if satisfies_policy is not True:
    reason = "evaluation_error" if satisfies_policy is None else "policy_violation"
    logger.info("post denied for %s in %s: %s", matrix_user_id, room_id, reason)
    return Codes.FORBIDDEN
```
becomes:
```python
satisfies_policy, policy_reason = self._safe_evaluate_predicate(predicate_document, cached.chain, room_id, matrix_user_id)
if satisfies_policy is not True:
    logger.info("post denied for %s in %s: %s", matrix_user_id, room_id, policy_reason)
    return Codes.FORBIDDEN
```

The deny-reason string that was `"policy_violation"` becomes `"no_policy_match"`
or `"field_mismatch"` (or stays `"evaluation_error"` for the exception path,
unchanged). No other string constants in `module.py` change. Do not alter
`evaluate_room_predicate`'s or `_safe_evaluate_predicate`'s matching
behavior — only their return shape and what gets logged.

## 5b. `matrix-policy-module` test-file impact (for step 1.4, since it touches a different repo than 1.2/1.3)

**`wallet-service/matrix-policy-module/test/test_predicates.py`** — every
`assert evaluate_room_predicate(doc, chain) is True/False` needs mechanical
update to the new `(bool, Optional[str])` tuple:
- `is True` (lines 21, 49, 71) → `== (True, None)`.
- `is False` (lines 31, 37, 60, 75) → `== (False, "field_mismatch")` for line
  31 (`test_single_entry_matching_policy_wrong_field` — policy_id matched,
  field didn't); `== (False, "no_policy_match")` for lines 37, 60, 75 (no
  entry's `policy_id` ever matched).

**`wallet-service/matrix-policy-module/test/test_module.py`** lines ~249-266
and ~437-449 (`evaluate_room_predicate` monkeypatched to `throw`): no change
needed — these bypass the real function entirely and assert on
`_safe_evaluate_predicate`'s exception path (`Codes.FORBIDDEN` /
`"evaluation_error"` deny reason), which is unchanged by this spec. Confirm
by running the suite, don't edit these tests speculatively.

## 6. Test-file impact (exact list — for step 1.5, and for 1.2/1.3's "existing suite still passes" check)

**TS — `packages/verifier/test/integration/chain-and-policy-match.test.ts`**
(`describe("policy_match", ...)` block, lines 246-463): every assertion of
the form `expect(x.policy_match).toBe(true|false)` /
`.toBeNull()` needs mechanical unwrapping:

- `.toBeNull()` → `.toBeNull()` unchanged (null stays null when conditions
  absent — no shape change there).
- `.toBe(true)` → `.toEqual({ matched: true })`.
- `.toBe(false)` → needs a `reason` assertion added, not just
  `.toEqual({ matched: false, reason: "..." })` — pick the correct reason
  per scenario:
  - "is false when no card in the chain matches policy_id" (line 269-281):
    `reason: "no_policy_match"`.
  - "plain-string field_match with a non-matching value is false" (line
    296-307): `reason: "field_mismatch"`.
  - "multiple field_match conditions: one non-matching -> false" (line
    341-358): `reason: "field_mismatch"`.
  - "verifyCard() with conditions and returnChain returns empty chain and
    false policy_match" (line 360-382): chain is always `[]` for
    `verifyCard`, so no link ever matches `policy_id` →
    `reason: "no_policy_match"`.
  - "envelope-level policy_match is the OR across all signatures" (line
    401-462): the OR resolves `true` here (`.toBe(true)` → `.toEqual({ matched: true })`,
    both at line 460's per-signature check — update to
    `.some((s) => s.policy_match?.matched === true)` — and line 461's
    envelope-level check).
- Lines 251-252 (null check when conditions not supplied): unchanged.

Also add new reason-specific cases per step 1.5 (see §7 below) to this same
file.

**Python unit tests — `packages/verifier-py/tests/integration/test_chain_and_policy_match.py`**
(`TestPolicyMatch` class, lines ~141-272+): same mechanical pattern —
every direct call to `evaluate_policy_match(...)` currently asserted with
`assert result is True/False/None` needs:
- `is None` → unchanged.
- `is True` → `assert result == PolicyMatchResult(matched=True)` (import
  `PolicyMatchResult` from `membership_card_verifier.types` or the
  package's top-level `__init__` export, matching however
  `PolicyMatchConditions` is already imported in this file).
- `is False` → `assert result == PolicyMatchResult(matched=False, reason="...")`
  with the same per-test reason mapping as the TS list above
  (`test_policy_match_false_for_non_matching_policy` → `"no_policy_match"`;
  `test_policy_match_false_for_non_matching_field` → `"field_mismatch"`).
- Line 128 (`policy_match=None` in a constructed expected result, if it's a
  dataclass literal used for comparison rather than a produced value):
  leave as `None` — this is the "no conditions supplied" case, unchanged.

**Python interop — `packages/verifier-py/tests/test_policy_match_chain_interop.py`**
and **`packages/verifier-py/vectors/policy_match_chain_vectors.json`**: the
vectors file is generated by
`packages/verifier/scripts/gen-policy-match-chain-vectors.mjs`, which just
serializes `result.policy_match`/`result.signatures[0].policy_match`/etc.
verbatim (lines 258-259, 303-304) — once the TS side (step 1.3) lands, that
script needs to be **re-run** (`node packages/verifier/scripts/gen-policy-match-chain-vectors.mjs`
from the `verifier` package, or whatever its existing invocation convention
is — check for an npm script wrapping it) so the JSON vectors capture the
new `{ matched, reason? }` shape instead of stale plain booleans. Do this as
part of step 1.5, after both 1.2 and 1.3 are done. The interop test's
assertions (`test_policy_match_chain_interop.py` lines 143-144, 169-170)
comparing `result.policy_match == expected["envelope_policy_match"]` and
`result.signatures[0].policy_match == expected["signature_policy_match"]`
need updating to compare structurally against the new object shape — e.g.
`result.policy_match == (PolicyMatchResult(**expected["envelope_policy_match"]) if expected["envelope_policy_match"] else None)`,
or simpler: compare field-by-field (`.matched`, `.reason`) against the raw
dict loaded from JSON, whichever matches this file's existing style for
comparing other structured fields (check how it currently compares `chain`,
if at all, for the established pattern).

**No unit test file exists today calling `evaluatePolicyMatch`/
`evaluate_policy_match` in isolation outside the two integration files
above** (confirmed via repo-wide grep) — so there is no separate
`policy-match.test.ts` / `test_policy_match.py` to update.

## 7. New reason-specific test cases (step 1.5)

Add to both language's existing `policy_match`/`TestPolicyMatch` test blocks
(not new files — extend in place, matching existing style):

1. Explicit "reason is field_mismatch" case asserting the full object
   (`{ matched: false, reason: "field_mismatch" }` /
   `PolicyMatchResult(matched=False, reason="field_mismatch")`) — this
   already exists implicitly once §6's mechanical updates land, so this
   item is satisfied by §6, not an additional new test, as long as at least
   one case explicitly names `reason` (not just `matched`) in its
   assertion.
2. New case: chain has one link matching a *different* `policy_id` and a
   second link matching the target `policy_id` but failing `field_match` —
   confirms `sawPolicyIdMatch`/`saw_policy_id_match` correctly reflects the
   *target* policy's own match, not a coincidental match on an unrelated
   policy_id earlier in the chain. Expected: `{ matched: false, reason: "field_mismatch" }`.
3. New cross-language interop vector case (added to the `.mjs` generator,
   regenerating the `.json` vectors file) exercising the same
   `field_mismatch` vs `no_policy_match` distinction end-to-end through
   `CardVerifier`/`card_verifier.py`, not just the bare `evaluate_policy_match`
   function — reuse the existing `buildScenario` fixture with
   `field_match` conditions that fail, to get case coverage matching what
   §6 already mechanically updates but generated fresh through the TS
   pipeline for the interop vector specifically.

## 8. Boolean-coercion path

No dedicated coercion helper function is being added — per §3/§4, every
known caller (both languages' `CardVerifier`/`card_verifier.py`, and
`matrix-policy-module`'s `predicates.py`) has an explicit, spec'd update
above, rather than routing through a generic "make it a boolean again"
utility. If a future caller genuinely only wants the boolean, the
coercion is a one-line `result?.matched ?? null` / `result.matched if result is not None else None` inline — not
worth a named export for the one line it saves. (This intentionally
narrows the todo doc's original recommendation of "keep a
boolean-coercion path" — every caller's actual reason for wanting the
old boolean value has a more specific fix available: `matrix-policy-module`
wants the *reason*, not less information, and no other caller was found in
the codebase.)

## 9. Done-when checklist for 1.2/1.3/1.4/1.5

- 1.2 (Python): `PolicyMatchResult` dataclass added; `evaluate_policy_match`
  returns it per §2; `EnvelopeVerificationResult`/`SignatureVerificationResult`/
  `CardVerificationResult.policy_match` retyped per §3;
  `_aggregate_envelope_policy_match` updated per §4; all pre-existing
  Python tests in `tests/integration/test_chain_and_policy_match.py` and
  `tests/test_policy_match_chain_interop.py` updated per §6 and passing.
  Do **not** touch `matrix-policy-module` in this step (that's 1.4).
- 1.3 (TS): mirror of 1.2 for `packages/verifier/src/policy-match.ts`,
  `types.ts`, `CardVerifier.ts`; `test/integration/chain-and-policy-match.test.ts`
  updated per §6 and passing.
- 1.4: `predicates.py` and `module.py` updated per §5; existing
  `matrix-policy-module` test suite (whatever currently exercises
  `evaluate_room_predicate`/`_decide_join`/`check_event_for_spam`'s deny
  logging) still passes, updated mechanically for the new tuple return
  shape wherever it asserted on the old bare-bool return.
- 1.5: new cases from §7 added in both languages; vectors JSON regenerated
  per §6 and interop test passing against the regenerated file.
