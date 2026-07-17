# Verifier Packages — Criteria Matching & Chain Return — Implementation Plan

**Date:** 2026-07-11
**Status:** Complete — all 7 steps implemented, reviewed, and committed (see Status section at the end)
**Packages affected:** `membership_card_verifier/packages/verifier` (TypeScript, `@membership-card-protocol/verifier`), `membership_card_verifier/packages/verifier-py` (Python, `membership-card-verifier`)
**Motivation:** requested directly, to support the Matrix policy module's needs (chain data for `chain_includes`/`card_field_matches` predicates, and a general-purpose "does this card qualify" check) without rolling bespoke verification logic inside the Matrix code — but this is a verifier-package feature, useful independent of Matrix.

---

## What I found before designing this, that shapes the plan

- **`policy_match` already exists as a reserved, never-populated field** in both packages' result types (`CardVerificationResult`/`SignatureVerificationResult`), with a code comment reading *"per-call predicate not supported in VerifierConfig; null = not supplied."* It is set to `None`/`null` in every code path in both languages today. **Decision (David): keep the name `policy_match` — implement it, don't rename or duplicate it.**
- **There is no existing complete implementation of `card_protocol_spec.md §The Predicate System`'s full grammar anywhere in the codebase to reuse.** I checked `press/src/functions/predicates.ts`, the only other predicate-evaluation code in the repo — it's an explicitly incomplete stub (its own comments: `field_match` "not implemented in Phase 3", unknown predicate types "pass permissively", a loose untyped `{ type: string, [key: string]: unknown }` shape). So this plan implements real predicate evaluation from the spec directly.
- **Stage 3 (chain walk) already fetches and decrypts every ancestor's `CardDocument` internally, per hop, and then discards it** once it's used to continue the walk (`stage3.py`/`stage3.ts`, the `ancestor_doc` variable). Exposing that data is mostly "stop throwing it away," not new fetching logic.
- **Decision (David): avoid reproducing any logic.** `policy_match` must be computed by reusing the chain data Stage 3 already walks (extended by Feature 2 below) — not a second, independent chain walk or a second IPFS-fetch pass. Both features share one walk.

---

## Interface Design

### Feature 1 — `policy_match`

New optional field on `VerifierConfig`:

```ts
conditions?: {
  policy_id: string;                                    // CID — checked via issued_under_template semantics
  field_match?: Record<string, string | { regex: string }>;  // plain string = exact-match shorthand; { regex } = full regex
}
```

`field_match` accepts **plain-equality shorthand by default** (Decision, David) — `{ user_type: "admin" }` means an exact-match check — with `{ regex: "..." }` as the escape hatch for anything more complex than equality. This still mirrors `card_field_matches`'s underlying semantics (a field/pattern check against a card in the chain issued under a specific policy); it just doesn't force regex syntax for the common case.

This deliberately mirrors the shape already established for Matrix's room predicate documents (`matrix_room.md`'s `policies` list entries) rather than inventing a third shape for the same idea. It does **not** expose the full `any_of`/`all_of`/`none_of` combinator grammar — just the flat "one policy, N field conditions" case. Boolean combinators are a bigger, separately-justified addition if ever needed (YAGNI for now).

**Per-signature and envelope-level semantics (Decision, David):**
- `verify_card()`: `policy_match` on the single result — `true`/`false` per the chain-inclusion + field-match check above, `null` if `conditions` wasn't supplied.
- `verify_envelope()`: `conditions`, if supplied, applies **per signature** (each `SignatureVerificationResult.policy_match` reflects that signer's own chain) **and** the envelope-level result gains a new top-level `policy_match: boolean | null` field that is the **OR** across all signatures — `true` if at least one signer's card meets the criteria, `false` if `conditions` was supplied and none did, `null` if `conditions` wasn't supplied. This is new: `EnvelopeVerificationResult` doesn't have a `policy_match`-equivalent field today (only `signatures: SignatureVerificationResult[]`) — Step 2 adds it.

When `conditions` is supplied: the chain-inclusion check is `issued_under_template`-equivalent (the chain includes a card whose CardDocument's own `policy_id` field equals `conditions.policy_id`); every `field_match` entry is then checked against that same card's fields.

### Feature 2 — `return_chain`

New optional boolean, same param surface as `conditions`. When `true`, the result gains:

```ts
chain?: {
  card_address: string;       // keccak256(pubkey) — same as chain_card_addresses today, internal-only
  public_key: string;         // base64url — the raw ML-DSA-44 public key ("public id")
  card_content: Record<string, unknown>;  // the decrypted CardDocument's fields, as already parsed internally
}[]
```

Ordered from the starting card outward to the trusted root (or as far as the walk got before a failure — a partial chain is still returned on a later failure, since a caller checking `card_field_matches`-style conditions against ancestors wants to know what was actually resolved, not nothing).

Confirmed reading of "public id": the raw ML-DSA-44 public key (base64url), distinct from `card_address` (the keccak256 hash). Both are included per chain link.

**Both features share one internal chain walk** (Decision, David, "avoid reproducing logic") — `policy_match`'s evaluation runs against the same per-hop data Feature 2 threads out, regardless of whether the caller asked for `return_chain: true` on the output. `return_chain` only controls whether that data is *exposed* on the result; it's always computed internally once `conditions` needs it.

---

## Steps

### Step 1 — TS: extend Stage 3 to carry chain data forward (backs both features) + thread `return_chain` through `CardVerifier.ts`

**What:** Extend `Stage3Result` with the `chain` array above, populated from data the stage already fetches per hop (no new I/O) — always computed internally, exposed on the result only when `return_chain: true`. Thread through `CardVerifier.verifyCard`/`verifyEnvelope`. Update `types.ts`.

**Who:** Sonnet — touches the stage pipeline's control flow and the partial-chain-on-failure decision.

### Step 2 — TS: implement `policy_match` using Step 1's chain data + envelope-level OR aggregate

**What:** Implement the `conditions` evaluation (policy-id chain inclusion + `field_match`, with plain-equality shorthand and regex escape hatch) against Step 1's already-walked chain — no second walk, no second IPFS fetch pass, per the "avoid reproducing logic" decision. Add the new envelope-level `policy_match` field to `EnvelopeVerificationResult` (OR across `signatures[].policy_match`). Likely lands in `stages/stage5.ts` (where `policy_match` already lives structurally) or a small new predicate-evaluation module it calls into.

**Who:** Sonnet — the actual predicate-evaluation logic, the part of this plan with genuine correctness risk.

### Step 3 — TS: tests + README updates for both features

**What:** Unit tests for `return_chain` (multi-hop chain, a chain that fails partway through, confirm partial-chain behavior) and `policy_match` (matching policy + matching fields → true; matching policy + non-matching field → false; non-matching policy → false; no `conditions` supplied → null; envelope-level OR with one matching signer among several non-matching ones; plain-equality shorthand and regex both tested). Update `README.md`'s `§Reading a result` and `§Configuration` sections, following the doc's existing style exactly.

**Who:** Haiku — mechanical test-writing and doc-formatting against an already-implemented, already-reviewed feature (Steps 1–2 land first).

### Step 4 — Python: port Step 1 (chain-data threading) from the reviewed TS diff

**Who:** Haiku — mirroring an already-correct, already-reviewed reference implementation into the parallel language is much lower-risk than originating it.

### Step 5 — Python: port Step 2 (`policy_match` logic + envelope-level OR) from the reviewed TS diff

**Who:** Haiku, with a closer look than Step 4 given it's the actual predicate-logic port — if review finds the mirrored logic subtly diverges (e.g. regex engine differences between JS and Python), escalate that specific fix to Sonnet rather than have Haiku guess.

### Step 6 — Python: tests + README updates, mirroring Step 3

**Who:** Haiku.

### Step 7 — Cross-language parity check + shared interop vectors

**What:** Add `return_chain`/`policy_match` cases (including the envelope-level OR case) to the packages' existing shared interop-vector fixtures (`vectors/`, `test_interop_vectors.py` and its TS equivalent). Confirm both packages produce identical output for the same fixture inputs.

**Who:** Sonnet, or me directly — this step verifies the two ports actually agree, so it shouldn't be done by the same tier of agent that just mirrored the code without independent scrutiny.

---

## Done when

- [x] Both packages expose `conditions`/`return_chain` with identical behavior on shared fixtures, including the envelope-level OR case.
- [x] `policy_match` is implemented in place — same field, same name, both languages — computed from one shared internal chain walk, not a second independent one.
- [x] READMEs updated in both packages.

## Status: Complete (2026-07-11)

All 7 steps landed and were independently verified (not just trusted from agent reports), across three commits:
- `2709e500` — TS implementation (Steps 1–2), plus a pre-existing bug found and fixed during review: the chain walk for a sub-card signer started from the signer's own address paired with the master card's document, mismatching `chain[0]`'s address against its content. Fixed to start from the master's own address.
- `372d88fc` — TS test/doc completion (Step 3) and the Python port (Steps 4–6), including independently re-deriving and fixing the same master/signer address bug in the Python code (it predated the TS fix).
- `2258b908` — Step 7: a new kind of interop vector (beyond the existing crypto-primitive ones) — a deterministic multi-card chain replayed through both languages' `CardVerifier`, generated from the real TS package's actual output. 5 cases, all passing on both sides, including the envelope-level OR across two signers.

Notable findings during review, not assumed away:
- One agent's Python port initially reported it "couldn't run tests due to a pre-existing cryptography library incompatibility" — this was verified independently and found to be a stale global-environment `cryptography` install in that agent's sandbox, not a real incompatibility; a clean venv install ran all 125 (now 130) tests successfully.
- Final state: TS 101/101 tests + `tsc` clean; Python 130/130 tests + `mypy` clean (17 source files); 5/5 cross-language interop cases passing.

Final counts: TS 101 tests, Python 130 tests (125 unit + 5 cross-language interop), both packages' `mypy`/`tsc` clean.

## Downstream note (not part of this plan's scope, just context)

If this lands as designed, Matrix's Step 9c (`predicates.py`) gets substantially smaller — most of what it needed to do server-side (chain data + field matching against a policy) can now come directly from `policy_match`/`return_chain` instead of a separate hand-written evaluator. I'd revisit that step's scope once this is done, rather than build it twice.
