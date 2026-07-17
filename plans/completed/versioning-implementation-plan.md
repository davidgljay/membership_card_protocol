# Versioning System — Implementation Plan

**Date:** 2026-06-28  
**Strategic plan:** [versioning-strategic-plan.md](./versioning-strategic-plan.md)

---

## Clarification Checkpoints

- **Before modifying any existing type** that is also referenced in `dist/`: confirm the change compiles and existing tests still pass before moving to the next step.
- **Before generating test vectors**: confirm the card and message schemas are frozen — no further field additions to v0.1.
- **Before closing Phase 3**: run the full test suite and confirm zero regressions.

---

## Phase 1: Schema — Add `protocol_version` to Cards and Messages

This phase touches the TypeScript type definitions, the constants file, and the Rust signing scripts. No logic changes yet — this is purely additive schema work.

---

### Step 1.1 — Add `PROTOCOL_VERSION_0_1` constant

**What:** Add a versioning constant to the verifier package.

**Who:** Claude

**Context needed:** `membership_card_verifier/packages/verifier/src/constants.ts`

**Changes:**
```typescript
// Append to constants.ts:
export const PROTOCOL_VERSION_0_1 = "0.1";

/** All protocol versions recognized by this verifier build. */
export const KNOWN_PROTOCOL_VERSIONS = ["0.1"] as const;

export type ProtocolVersion = typeof KNOWN_PROTOCOL_VERSIONS[number];
```

**Done when:** `constants.ts` exports `PROTOCOL_VERSION_0_1`, `KNOWN_PROTOCOL_VERSIONS`, and `ProtocolVersion`. TypeScript compiles cleanly.

---

### Step 1.2 — Add `protocol_version` to `CardDocument` type

**What:** Add the required `protocol_version` field to the `CardDocument` interface. Mark it required (not optional) — v0.1 documents must carry it. Add `[key: string]: unknown` already present so this is backward-compatible for parse-and-ignore use, but the type enforces presence for construction.

**Who:** Claude

**Context needed:** `membership_card_verifier/packages/verifier/src/types.ts` — `CardDocument` interface (lines 65–77); `Step 1.1` output

**Changes:**

```typescript
// In types.ts, update CardDocument:
export interface CardDocument {
  policy_id: string;
  issuer_card: string;
  press_card: string;
  press_signature: string;
  protocol_version: string;   // ← ADD: required; "0.1" for all v0.1 cards
  recipient_pubkey: string;
  issued_at: string;
  ancestry_pubkeys: string[];
  past_keys?: PastKey[];
  issuer_signature: string;
  holder_signature: string;
  [key: string]: unknown;
}
```

**RFC 8785 field ordering note:** In canonical JSON, `protocol_version` sorts lexicographically after `press_signature` (`'p','r','e'` < `'p','r','o'`) and before `recipient_pubkey` (`'p','r','o','t'` < `'r'`). The field order above matches this canonical ordering. Any signing tool that constructs `CardDocument` objects and then canonicalizes them will produce the version field in the correct position automatically — RFC 8785 re-sorts regardless of insertion order.

**Done when:** `CardDocument` has `protocol_version: string` as a required field. TypeScript reports any call sites constructing `CardDocument` without it (expected: test fixtures).

---

### Step 1.3 — Add `protocol_version` to the message payload type

**What:** The `SignedMessageEnvelope.payload` is currently typed as `{ message: string; timestamp: string; [key: string]: unknown }`. Add `protocol_version` as required.

**Who:** Claude

**Context needed:** `membership_card_verifier/packages/verifier/src/types.ts` — `SignedMessageEnvelope` interface (lines 116–123); `Step 1.1` output

**Changes:**

```typescript
export interface SignedMessageEnvelope {
  payload: {
    message: string;
    protocol_version: string;   // ← ADD: required; "0.1" for all v0.1 messages
    timestamp: string;
    [key: string]: unknown;
  };
  signatures: SignatureEntry[];
}
```

**RFC 8785 field ordering note:** In the canonical payload, `protocol_version` sorts after `message` (`'m'` < `'p'`) and before `timestamp` (`'p'` < `'t'`), and before any future `recipients` or `retracts` fields (`'p','r','o'` < `'r'`). The order above reflects this.

**Done when:** `SignedMessageEnvelope.payload` has `protocol_version: string`. TypeScript flags any call sites constructing payloads without it (expected: test fixtures and `test/fixtures.ts`).

---

### Step 1.4 — Update test fixtures to include `protocol_version`

**What:** Fix all TypeScript compilation errors introduced by steps 1.2 and 1.3. Test fixtures and integration test helpers that construct `CardDocument` or message payloads need `protocol_version: "0.1"` added.

**Who:** Claude

**Context needed:** 
- `membership_card_verifier/packages/verifier/test/fixtures.ts`
- `membership_card_verifier/packages/verifier/test/integration/` (all files)
- `membership_card_verifier/packages/verifier/test/stages/` (all files)
- TypeScript compiler errors from steps 1.2–1.3
- `PROTOCOL_VERSION_0_1` from step 1.1

**Done when:** `pnpm tsc --noEmit` in `packages/verifier` exits 0. All existing tests pass.

---

### Step 1.5 — Update the Rust card signing script

**What:** The `sign_card_message.rs` script constructs card message payloads. Add `"protocol_version": "0.1"` to all JSON payloads it produces. Because RFC 8785 sorts the payload before hashing, the field just needs to be present — the canonicalizer will place it correctly.

**Who:** Claude

**Context needed:** `contracts/scripts/sign_card_message.rs` — full file

**Changes:** In the message construction block (the `--message` input is passed in pre-formed, so this script may not construct the JSON directly). If the script constructs the payload itself, add `"protocol_version": "0.1"` to the struct/string. If it accepts pre-formed JSON from the caller, add a note to the usage comment that v0.1 payloads must include this field.

**Done when:** Usage comment in `sign_card_message.rs` documents the `protocol_version` requirement. If the script constructs JSON directly, `"protocol_version": "0.1"` is present in the output. `cargo build --bin sign_card_message` exits 0.

---

### Phase 1 Milestone Review

**Context needed:** 
- `membership_card_verifier/packages/verifier/src/constants.ts` (output of 1.1)
- `membership_card_verifier/packages/verifier/src/types.ts` (output of 1.2–1.3)
- `membership_card_verifier/packages/verifier/test/fixtures.ts` (output of 1.4)
- `contracts/scripts/sign_card_message.rs` (output of 1.5)

**Done when:** All of the following are true:
1. `pnpm tsc --noEmit` in `packages/verifier` exits 0
2. `pnpm vitest run` in `packages/verifier` exits 0 (no regressions)
3. `CardDocument` has `protocol_version: string` (required)
4. `SignedMessageEnvelope.payload` has `protocol_version: string` (required)
5. `PROTOCOL_VERSION_0_1`, `KNOWN_PROTOCOL_VERSIONS`, and `ProtocolVersion` are exported from `constants.ts`
6. A one-paragraph summary is written to `plans/milestones/versioning-phase-1-summary.md`

---

## Phase 2: Version-Aware Verification Routing

This phase adds version reading, routing, and rejection logic to `CardVerifier`. The current 6-stage pipeline becomes the v0.1 handler. No behavior changes for v0.1 — this is structural only.

---

### Step 2.1 — Add version extraction helper

**What:** Create `src/version.ts` in `packages/verifier`. This module extracts and validates the `protocol_version` field from a card document or message payload, and returns the version or throws a typed error.

**Who:** Claude

**Context needed:** 
- `membership_card_verifier/packages/verifier/src/errors.ts` (current `CardProtocolError`)
- `membership_card_verifier/packages/verifier/src/constants.ts` (output of step 1.1)

**New file:** `membership_card_verifier/packages/verifier/src/version.ts`

```typescript
import { KNOWN_PROTOCOL_VERSIONS, ProtocolVersion } from "./constants.js";
import { CardProtocolError } from "./errors.js";

/**
 * Extract and validate the protocol_version field from a card document
 * or message payload.
 *
 * Throws UNKNOWN_PROTOCOL_VERSION if the field is missing or not in
 * KNOWN_PROTOCOL_VERSIONS. Never returns undefined.
 */
export function extractProtocolVersion(doc: { protocol_version?: unknown }): ProtocolVersion {
  const v = doc.protocol_version;
  if (typeof v !== "string") {
    throw new CardProtocolError(
      "MISSING_PROTOCOL_VERSION",
      `protocol_version field is missing or not a string`
    );
  }
  if (!(KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(v)) {
    throw new CardProtocolError(
      "UNKNOWN_PROTOCOL_VERSION",
      `Unrecognized protocol version: "${v}". Known versions: ${KNOWN_PROTOCOL_VERSIONS.join(", ")}`
    );
  }
  return v as ProtocolVersion;
}
```

**Done when:** `version.ts` compiles cleanly. `extractProtocolVersion` throws `MISSING_PROTOCOL_VERSION` for missing/non-string fields and `UNKNOWN_PROTOCOL_VERSION` for unrecognized versions.

---

### Step 2.2 — Add `protocol_version` to verification result types

**What:** Consumers need to know which protocol version was used to verify an artifact. Add `protocol_version` to `EnvelopeVerificationResult` and `CardVerificationResult`.

**Who:** Claude

**Context needed:** 
- `membership_card_verifier/packages/verifier/src/types.ts` — `EnvelopeVerificationResult` (lines 137–141), `CardVerificationResult` (lines 161–164)
- `Step 1.1` output

**Changes:**

```typescript
export interface EnvelopeVerificationResult {
  envelope_id: string;
  verified_at: string;
  protocol_version: string;   // ← ADD
  signatures: SignatureVerificationResult[];
}

export interface CardVerificationResult
  extends Omit<SignatureVerificationResult, "signature_valid"> {
  signature_valid: null;
  protocol_version: string;   // ← ADD
}
```

**Done when:** Both result types have `protocol_version: string`. TypeScript reports call sites that construct these types without the field (expected: `CardVerifier.ts`).

---

### Step 2.3 — Wire version extraction and routing into `CardVerifier`

**What:** Update `CardVerifier.verifyEnvelope` and `CardVerifier.verifyCard` to:
1. Extract `protocol_version` from the artifact before any stage runs.
2. Return `MISSING_PROTOCOL_VERSION` or `UNKNOWN_PROTOCOL_VERSION` as a `VerificationError` (stage 1) rather than throwing — callers should get a structured result, not an unhandled exception.
3. Include `protocol_version` in the returned result.
4. The dispatch itself is trivial for now (only one version exists), but the pattern must be in place.

**Who:** Claude

**Context needed:**
- `membership_card_verifier/packages/verifier/src/CardVerifier.ts` (full file)
- `membership_card_verifier/packages/verifier/src/version.ts` (output of step 2.1)
- `membership_card_verifier/packages/verifier/src/types.ts` (output of step 2.2)

**Changes to `verifyEnvelope`:**
```typescript
async verifyEnvelope(envelope: SignedMessageEnvelope): Promise<EnvelopeVerificationResult> {
  // Extract version first — fail fast if unknown
  let protocol_version: string;
  try {
    protocol_version = extractProtocolVersion(envelope.payload);
  } catch (e) {
    if (e instanceof CardProtocolError) {
      return {
        envelope_id: "",
        verified_at: new Date().toISOString(),
        protocol_version: (envelope.payload.protocol_version as string) ?? "unknown",
        signatures: [],
        // ... populate a single error entry
      };
    }
    throw e;
  }

  // dispatch: only "0.1" exists today; add new cases here as versions are added
  // For v0.1: existing stage pipeline (no changes to stages)
  const canonicalEnvelope = canonicalize(envelope);
  const envelope_id = createHash("sha256").update(canonicalEnvelope).digest("hex");
  const verified_at = new Date().toISOString();
  const signatures = await Promise.all( /* ... existing logic ... */ );

  return { envelope_id, verified_at, protocol_version, signatures };
}
```

Apply the same pattern to `verifyCard`: extract version from the fetched `CardDocument` (after stage 2 fetches it from IPFS), include in result.

**Done when:** 
- Both `verifyEnvelope` and `verifyCard` read `protocol_version` and include it in the result.
- An envelope or card with a missing/unknown version returns a result with `errors` containing `MISSING_PROTOCOL_VERSION` or `UNKNOWN_PROTOCOL_VERSION` at stage 1, rather than throwing.
- `pnpm tsc --noEmit` exits 0.

---

### Step 2.4 — Export new error codes and version utilities from `index.ts`

**What:** Consumers need to be able to import `extractProtocolVersion`, `PROTOCOL_VERSION_0_1`, `KNOWN_PROTOCOL_VERSIONS`, and `ProtocolVersion` from the package public API.

**Who:** Claude

**Context needed:** `membership_card_verifier/packages/verifier/src/index.ts`

**Changes:** Add exports for the new constants, types, and utilities introduced in steps 1.1 and 2.1. Also export the new `EnvelopeVerificationResult` and `CardVerificationResult` updated types (already exported; just confirm `protocol_version` is part of the exported shape).

**Done when:** `index.ts` exports `PROTOCOL_VERSION_0_1`, `KNOWN_PROTOCOL_VERSIONS`, `ProtocolVersion` (type), and `extractProtocolVersion`. Package public API is complete.

---

### Phase 2 Milestone Review

**Context needed:**
- `packages/verifier/src/version.ts` (output of 2.1)
- `packages/verifier/src/types.ts` (output of 2.2)
- `packages/verifier/src/CardVerifier.ts` (output of 2.3)
- `packages/verifier/src/index.ts` (output of 2.4)

**Done when:** All of the following are true:
1. `pnpm tsc --noEmit` exits 0
2. `pnpm vitest run` exits 0 (no regressions — existing tests still pass with `protocol_version: "0.1"` in their fixtures)
3. An envelope missing `protocol_version` returns a result with error code `MISSING_PROTOCOL_VERSION` (verified manually or via test)
4. An envelope with `protocol_version: "99.0"` returns a result with error code `UNKNOWN_PROTOCOL_VERSION` (verified manually or via test)
5. A one-paragraph summary is written to `plans/milestones/versioning-phase-2-summary.md`

---

## Phase 3: Test Vectors and Test Coverage

This phase freezes the v0.1 schema by generating canonical test vectors, and adds explicit test coverage for the versioning behavior.

---

### Step 3.1 — Generate v0.1 test vectors

**What:** Create a `specs/versioning-test-vectors.json` file containing at least:
- One well-formed v0.1 `CardDocument` (synthetic, no real keys required — use placeholder base64url strings of the correct length)
- One well-formed v0.1 `SignedMessageEnvelope` payload
- The expected RFC 8785 canonical JSON string for each
- A description of what each vector exercises

This file is the permanent record of what v0.1 schema looks like. When v0.2 is added, a second set of vectors goes in the same file.

**Who:** Claude

**Context needed:**
- `membership_card_verifier/packages/verifier/src/types.ts` (finalized types)
- `membership_card_verifier/packages/verifier/src/canonicalize.ts` (to produce expected output)
- `specs/serialization-conformance.json` format (for consistency with existing test infrastructure)

**Done when:** `specs/versioning-test-vectors.json` exists with at least one card vector and one message vector, each with `input` and `expected_canonical_json` fields.

---

### Step 3.2 — Add unit tests for version extraction

**What:** Add `test/version.test.ts` to `packages/verifier`:

- `extractProtocolVersion` with `protocol_version: "0.1"` → returns `"0.1"`
- `extractProtocolVersion` with no `protocol_version` field → throws `MISSING_PROTOCOL_VERSION`
- `extractProtocolVersion` with `protocol_version: "99.0"` → throws `UNKNOWN_PROTOCOL_VERSION`
- `extractProtocolVersion` with `protocol_version: 1` (number) → throws `MISSING_PROTOCOL_VERSION`

**Who:** Claude

**Context needed:**
- `membership_card_verifier/packages/verifier/src/version.ts`
- `membership_card_verifier/packages/verifier/test/setup.ts` (existing test setup pattern)

**Done when:** `test/version.test.ts` exists with all four cases. `pnpm vitest run` passes.

---

### Step 3.3 — Add integration tests for version rejection behavior

**What:** Add cases to `test/integration/verifier.test.ts` (or a new `test/integration/versioning.test.ts`):

- `verifyEnvelope` with `protocol_version: "0.1"` → proceeds through stages normally
- `verifyEnvelope` with missing `protocol_version` → returns result with `errors[0].code === "MISSING_PROTOCOL_VERSION"`, does not throw
- `verifyEnvelope` with `protocol_version: "99.0"` → returns result with `errors[0].code === "UNKNOWN_PROTOCOL_VERSION"`, does not throw
- `verifyCard` with a card document that lacks `protocol_version` → returns result with appropriate error, does not throw

**Who:** Claude

**Context needed:**
- `membership_card_verifier/packages/verifier/test/integration/verifier.test.ts`
- `membership_card_verifier/packages/verifier/test/fixtures.ts`
- `membership_card_verifier/packages/verifier/src/CardVerifier.ts`

**Done when:** New integration test cases exist and pass. `pnpm vitest run` exits 0.

---

### Step 3.4 — Add `protocol_version` to `specs/` versioning spec document

**What:** Create `specs/protocol-versioning.md` documenting:
- The version format (`"0.1"` string)
- Where `protocol_version` appears (card documents, message payloads)
- RFC 8785 canonical field ordering implications
- What v0.1 covers (secp256r1 on-chain, ML-DSA-44 IPFS, current message envelope schema)
- How to add a new version (add to `KNOWN_PROTOCOL_VERSIONS`, add handler, add test vectors)
- The rejection policy (missing or unknown version → `VerificationError`, not throw)

**Who:** Claude

**Context needed:**
- `versioning-strategic-plan.md` (goals and rationale)
- Finalized types from phases 1–2

**Done when:** `specs/protocol-versioning.md` exists and covers all six points above.

---

### Phase 3 Milestone Review (Final)

**Context needed:**
- `specs/versioning-test-vectors.json`
- `packages/verifier/test/version.test.ts`
- `packages/verifier/test/integration/versioning.test.ts` (or updated `verifier.test.ts`)
- `specs/protocol-versioning.md`
- All `src/` files modified across all phases

**Done when:** All of the following are true:
1. `pnpm vitest run` in `packages/verifier` exits 0 with all new tests passing
2. `pnpm tsc --noEmit` exits 0
3. `specs/versioning-test-vectors.json` exists with v0.1 card and message vectors
4. `specs/protocol-versioning.md` exists and is complete
5. No existing test regressions — the Phase 1 fixture updates are the only changes to existing tests
6. A one-paragraph summary is written to `plans/milestones/versioning-phase-3-summary.md`

---

## Files Modified Summary

| File | Change |
|------|--------|
| `membership_card_verifier/packages/verifier/src/constants.ts` | Add `PROTOCOL_VERSION_0_1`, `KNOWN_PROTOCOL_VERSIONS`, `ProtocolVersion` |
| `membership_card_verifier/packages/verifier/src/types.ts` | Add `protocol_version` to `CardDocument`, `SignedMessageEnvelope.payload`, `EnvelopeVerificationResult`, `CardVerificationResult` |
| `membership_card_verifier/packages/verifier/src/version.ts` | **New** — `extractProtocolVersion` helper |
| `membership_card_verifier/packages/verifier/src/CardVerifier.ts` | Extract + route on version; include in results; return structured error on unknown |
| `membership_card_verifier/packages/verifier/src/index.ts` | Export new constants, types, and helper |
| `membership_card_verifier/packages/verifier/test/fixtures.ts` | Add `protocol_version: "0.1"` to all fixture card docs and payloads |
| `membership_card_verifier/packages/verifier/test/version.test.ts` | **New** — unit tests for `extractProtocolVersion` |
| `membership_card_verifier/packages/verifier/test/integration/versioning.test.ts` | **New** — integration tests for version routing |
| `contracts/scripts/sign_card_message.rs` | Document `protocol_version` requirement in usage comment |
| `specs/protocol-versioning.md` | **New** — versioning spec |
| `specs/versioning-test-vectors.json` | **New** — v0.1 canonical test vectors |
