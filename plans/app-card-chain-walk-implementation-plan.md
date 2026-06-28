# Implementation Plan: Verifier-Side app_card Chain Walk

**Date:** 2026-06-28  
**Status:** Complete  
**Strategic plan:** `plans/app-card-chain-walk-strategic-plan.md`

---

## Resolved Open Questions

| # | Question | Decision |
|---|----------|----------|
| OQ-1 | Config field placement | New `VerifierConfig.appCertificationRoot: string` (required, separate from `trustedRoots`); also add `governance/app_certification_body.md` |
| OQ-2 | Chain failure behavior | Hard reject: `scope_clean: false`, abort stages 3–6, error `APP_CARD_CHAIN_NOT_TRUSTED` |
| OQ-3 | Missing config | Constructor throws `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` via `CardProtocolError` |
| OQ-4 | Result versioning | Deferred to a separate plan; `app_card_chain_valid` added as additive field for now |

---

## Summary of Changes

| Area | File | Change |
|------|------|--------|
| Governance | `governance/app_certification_body.md` | New document |
| Spec | `specs/protocol-objects.md §16` | Remove "press-side, not runtime" paragraph; add verifier walk description; update numbered list |
| Spec | `specs/card_protocol_spec.md §7 Step 2` | Add app_card chain walk as explicit sub-step 2d |
| Spec | `specs/object_specs/press.md §5.4` | Reframe `verifyAppCertificationChain` as early gate, not sole authority |
| Types | `src/types.ts` | Add `appCertificationRoot: string` to `VerifierConfig`; add `app_card_chain_valid: boolean \| "skipped"` to `SignatureVerificationResult` |
| Verifier | `src/stages/stage2.ts` | Update function signature to accept `config`; add Stage 13 app_card chain walk; update `Stage2Result` |
| Verifier | `src/CardVerifier.ts` | Validate `appCertificationRoot` in constructor; thread config to `verifyStage2`; propagate `app_card_chain_valid` through all result paths |
| Tests | `test/stages/stage2.test.ts` | Four new test cases |
| Tests | `test/integration/` | Update fixtures to include `appCertificationRoot`; add uncertified app_card rejection test |

---

## Execution Order

```
Phase 1 → Milestone 1 → Phase 2 → Milestone 2 → Phase 3 → Phase 4 → Phase 5 → Milestone 5
```

Phases 1 and 2 (governance + spec) are independent of Phase 3 (types). Phase 4 (code) depends on Phase 3 types being stable. Phase 5 (tests) depends on Phase 4.

---

## Phase 1 — Governance Documentation ✅

### Step 1.1 — Write `governance/app_certification_body.md` ✅

**What:**  
Create the directory and file if they don't exist. The document must cover four elements:

**Role and mandate.** The AppCertificationBody is the governance body responsible for certifying wallet applications in the Card Protocol. Certification means issuing an `app_card` (a card held by the wallet application operator) that can be referenced in sub-card documents. Only app cards whose chain reaches the governance authority's app-certification policy root are accepted by verifiers. The body's core mandate is to ensure that certified wallet applications do not abuse or leak the sub-cards they create on behalf of holders.

**Trust chain structure.** There is no new on-chain mechanism; the existing `PolicyAuthorizerKeys` and card issuance model is sufficient:

1. The Root Policy Body creates an app-certification policy root — an address registered in `PolicyAuthorizerKeys` on Arbitrum One. This address is what operators configure as `VerifierConfig.appCertificationRoot`.
2. The Root Policy Body issues cards to AppCertificationBody members from that root.
3. AppCertificationBody members issue `app_card`s to wallet application operators. These are ordinary cards in the on-chain registry whose `ancestry_pubkeys` chain eventually reaches the app-cert policy root.
4. When a verifier walks an `app_card` chain, it follows `ancestry_pubkeys` hop by hop until it reaches `appCertificationRoot`. If the chain is missing, broken, or terminates at a different address, the sub-card is rejected.

**Accountability model.** AppCertificationBody members are listed as auditors on every `app_card` they certify. This makes the certification chain visible in the on-chain audit trail via EAS annotations. If a member is compromised or acts in bad faith, their certifications can be identified and revoked card-by-card. The Root Policy Body's ability to revoke the member's card provides a governance backstop.

**App obligations.** Certified wallet applications must:
- Implement access controls preventing unauthorized sub-card creation (a holder's consent is required for each sub-card).
- Not export or share sub-card private keys with third parties.
- Honor holder revocation requests by deregistering the relevant sub-cards promptly.
- Implement the full sub-card lifecycle (create, use, deactivate/rotate) per protocol spec.
- Surface their app card address publicly so users can verify certification status independently.

**Context files:**
- `specs/ARCHITECTURE.md` ADR-011 for governance framing  
- `specs/protocol-objects.md §16` for app_card/app_card_pubkey semantics

**Done when:** File saved at `governance/app_certification_body.md` covering all four elements.

---

> ## ⚑ Milestone Review 1
>
> **Pause here.** Share `governance/app_certification_body.md` with David before modifying any spec or code file.  
>
> Confirm:
> - Is the trust chain structure (Root Policy Body → app-cert root → AppCertificationBody members → wallet app cards) correct?
> - Is "members are auditors on issued app cards" the right accountability mechanism, or is something different intended?
> - Are the four app obligations accurate?

---

## Phase 2 — Spec Updates ✅

### Step 2.1 — Update `specs/protocol-objects.md §16` ✅

**Remove** the entire paragraph beginning with `**App-certification chain: press-side, not runtime.**` (the paragraph that says "Runtime verifiers do NOT independently walk the `app_card` chain").

**Replace** it with:

```
**App-certification chain: verifier-enforced.** Runtime verifiers independently walk
the `app_card` chain from `app_card_pubkey` up to the governance authority's
app-certification policy root configured as `appCertificationRoot` in `VerifierConfig`.
A sub-card whose `app_card` does not reach that root is rejected at Stage 2
(`APP_CARD_CHAIN_NOT_TRUSTED`) regardless of whether a press accepted it at
registration time. The press also performs this check as an early gate before
submitting `RegisterSubCard` (see §5.4 of press.md), but the verifier's check is
the binding enforcement layer.
```

**Also update** the numbered "Verifier chain walk (runtime)" list: after the existing final step (currently step 11 — verify `app_signature`), add:

```
12. Walk the `app_card` chain: derive `app_card` content key via
    `HKDF-SHA3-256(app_card_pubkey_bytes, "card-content-v1")`; fetch and decrypt
    the app card document from IPFS; walk `ancestry_pubkeys` hop by hop until the
    chain reaches `VerifierConfig.appCertificationRoot`. Hard-reject with
    `APP_CARD_CHAIN_NOT_TRUSTED` and `scope_clean: false` if the chain exhausts
    without reaching the configured root or exceeds `maxChainDepth`.
```

**Context files:** `specs/protocol-objects.md §16` — read the file to locate exact paragraph boundaries before editing.

**Done when:** "press-side, not runtime" paragraph is gone; replacement paragraph exists; numbered list step 12 exists with the correct content.

---

### Step 2.2 — Update `specs/card_protocol_spec.md §7 Step 2` ✅

Locate the Step 2 verification stage description. Add an explicit sub-step after the existing binding checks and on-chain registration check:

```
2d. **App card chain walk.** Derive the `app_card` content key from `app_card_pubkey`
    bytes using `HKDF-SHA3-256(app_card_pubkey_bytes, "card-content-v1")`; fetch and
    decrypt the app card document from IPFS; walk `ancestry_pubkeys` hop by hop until
    the chain reaches `VerifierConfig.appCertificationRoot`. Hard-reject with
    `APP_CARD_CHAIN_NOT_TRUSTED` (`scope_clean: false`, abort) if the chain does not
    reach the configured root within `maxChainDepth` hops.
```

**Context files:** `specs/card_protocol_spec.md §7` — read before editing.

**Done when:** Step 2 in the spec lists sub-steps 2a through at least 2d; the app card chain walk is explicitly present with the right error code and abort behavior.

---

### Step 2.3 — Update `specs/object_specs/press.md §5.4` ✅

In the `processSubCardRegistration` function and `verifyAppCertificationChain` description, add a note that the press check is now an early gate, not the sole authority:

```
Note: The press's app certification check is an early gate — it prevents uncertified
sub-cards from reaching the on-chain registry, providing fail-fast feedback before gas
is spent. It is not the sole line of defense: runtime verifiers independently re-walk
the app_card chain using their configured `appCertificationRoot`. A sub-card registered
by a compromised press with an uncertified app_card will fail Stage 2 verification
regardless.
```

**Context files:** `specs/object_specs/press.md §5.4` — read before editing.

**Done when:** The press spec no longer implies sole authority over app certification; the note is present.

---

> ## ⚑ Milestone Review 2
>
> **Pause here.** Share the three changed spec excerpts with David before writing any code.
>
> Confirm:
> - Does the replacement paragraph in `protocol-objects.md §16` accurately describe the new verification model?
> - Are the sub-step numbering and language in `card_protocol_spec.md §7` consistent with adjacent steps?
> - Is the press.md framing of "early gate" correct?

---

## Phase 3 — Type Changes ✅

### Step 3.1 — Update `src/types.ts` ✅

**Two changes:**

**1. `VerifierConfig` — add required field after `trustedRoots`:**

```typescript
appCertificationRoot: string;
```

This field is required (no `?`). The constructor enforces it at runtime; TypeScript enforces it at compile time for direct consumers.

**2. `SignatureVerificationResult` — add field after `chain_reaches_trusted_root`:**

```typescript
app_card_chain_valid: boolean | "skipped";
```

`"skipped"` is used when the signer is not a sub-card (i.e., the `verifyCard` path in `CardVerifier`, or any path where Stage 2 is bypassed). `CardVerificationResult` extends `SignatureVerificationResult` via `Omit<..., "signature_valid">`, so it inherits `app_card_chain_valid` automatically — no separate change needed.

**Done when:** TypeScript compiles after this change; `appCertificationRoot` has no `?` and requires callers to provide it.

---

### Step 3.2 — Error codes ✅

`CardProtocolError` accepts any string `code`, so no changes to `errors.ts` are needed. The two new codes are used inline:

- `APP_CARD_CHAIN_NOT_TRUSTED` — returned in `VerificationError` at stage 2 when the app_card chain walk fails.
- `APP_CERTIFICATION_ROOT_NOT_CONFIGURED` — thrown as a `CardProtocolError` in the `CardVerifier` constructor if `appCertificationRoot` is absent.

Document both codes in comments at the point of use.

---

## Phase 4 — Verifier Code Changes ✅

### Step 4.1 — Update `src/stages/stage2.ts` ✅

**Update `Stage2Result`** to add:
```typescript
app_card_chain_valid: boolean | "skipped";
```

**Update function signature:**
```typescript
export async function verifyStage2(
  publicKeyBytes: Uint8Array,
  rpc: RpcProvider,
  ipfs: IpfsProvider,
  config: Pick<VerifierConfig, "appCertificationRoot" | "maxChainDepth">
): Promise<Stage2Result>
```

**Update all existing early-return statements** to include `app_card_chain_valid: false`. These all correspond to `scope_clean: false` states where the chain walk never ran — `false` (not `"skipped"`) is appropriate because the sub-card failed validation.

**Add Step 13 — app_card chain walk** after the existing Step 12 (`app_signature` verification) and before the final return. The logic mirrors `stage3.ts` but terminates specifically at `config.appCertificationRoot` rather than any `PolicyAuthorizerKeys` entry:

```typescript
// Step 13: app_card chain walk — confirm app_card chains to appCertificationRoot
// (APP_CARD_CHAIN_NOT_TRUSTED if the chain does not reach the configured root)
const appCertRoot = config.appCertificationRoot;
const maxDepth = config.maxChainDepth ?? 64;

const appCardContentKey = hkdfSha3256(new Uint8Array(appPubkeyBytes), "card-content-v1");
const appCardEntry = await rpc.getCardEntry(appCardAddress);
if (!appCardEntry || !appCardEntry.exists) {
  errors.push({
    stage: 2,
    code: "APP_CARD_CHAIN_NOT_TRUSTED",
    message: `app_card ${appCardAddress} not found on-chain`,
  });
  return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
}

let appCardDoc: CardDocument;
try {
  const encrypted = await ipfs.fetch(appCardEntry.log_head_cid);
  const decrypted = aes256gcmDecrypt(appCardContentKey, encrypted);
  appCardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
} catch (e) {
  const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
  errors.push({ stage: 2, code, message: String(e) });
  return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
}

let currentDoc = appCardDoc;
let currentAddress = appCardAddress;
let chainReached = currentAddress === appCertRoot;

for (let depth = 0; depth < maxDepth && !chainReached; depth++) {
  if (currentDoc.ancestry_pubkeys.length === 0) {
    // Root base case: no ancestors; chain terminates here
    chainReached = currentAddress === appCertRoot;
    break;
  }
  const nextPubkeyB64 = currentDoc.ancestry_pubkeys[0];
  if (!nextPubkeyB64) break;
  const nextPubkeyBytes = new Uint8Array(Buffer.from(nextPubkeyB64, "base64url"));
  const nextAddress = keccak256(nextPubkeyBytes);

  if (nextAddress === appCertRoot) {
    chainReached = true;
    break;
  }

  const nextEntry = await rpc.getCardEntry(nextAddress);
  if (!nextEntry || !nextEntry.exists) {
    errors.push({
      stage: 2,
      code: "APP_CARD_CHAIN_NOT_TRUSTED",
      message: `Ancestor app card not found on-chain: ${nextAddress}`,
    });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }

  const nextContentKey = hkdfSha3256(nextPubkeyBytes, "card-content-v1");
  try {
    const encrypted = await ipfs.fetch(nextEntry.log_head_cid);
    const decrypted = aes256gcmDecrypt(nextContentKey, encrypted);
    currentDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;
    currentAddress = nextAddress;
  } catch (e) {
    const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
    errors.push({ stage: 2, code, message: String(e) });
    return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
  }
}

if (!chainReached) {
  errors.push({
    stage: 2,
    code: "APP_CARD_CHAIN_NOT_TRUSTED",
    message: `app_card chain for ${appCardAddress} does not reach appCertificationRoot (${appCertRoot})`,
  });
  return { scope_clean: false, signer_card: signerCard, app_card_chain_valid: false, errors };
}
```

**Update final return statement:**
```typescript
return {
  scope_clean: true,
  signer_card: signerCard,
  master_card_doc: masterCardDoc,
  master_card_pubkey: new Uint8Array(holderPubkeyBytes),
  app_card_chain_valid: true,
  errors,
};
```

**Key distinction from Stage 3:** The Stage 3 walk accepts any `isPolicyAuthorizer` address as a termination condition (any governance root). The Stage 2 app_card walk terminates **only** at `config.appCertificationRoot` — a specific address. This prevents a card in an unrelated governance tree from being mistakenly accepted as a valid app cert root.

**Context files:**
- `src/stages/stage2.ts` (full file already read)
- `src/stages/stage3.ts` (chain walk pattern reference, already read)
- `src/crypto.ts` (for available primitives)
- `src/types.ts` after Step 3.1

**Done when:** `verifyStage2` compiles; returns `app_card_chain_valid: true` for a valid chain; returns `scope_clean: false` + `app_card_chain_valid: false` + `APP_CARD_CHAIN_NOT_TRUSTED` for an invalid chain.

---

### Step 4.2 — Update `src/CardVerifier.ts` ✅

**Constructor — add validation after the existing `ipfs` check:**
```typescript
if (!config.appCertificationRoot) {
  throw new CardProtocolError(
    "APP_CERTIFICATION_ROOT_NOT_CONFIGURED",
    "VerifierConfig.appCertificationRoot is required"
  );
}
```

**`this.config` assignment — add:**
```typescript
appCertificationRoot: config.appCertificationRoot,
```

The `Required<Omit<VerifierConfig, "registryEndpoint">>` type on `this.config` will now include `appCertificationRoot`.

**`#verifySignatureEntry` — update `verifyStage2` call** (currently line 160):
```typescript
const stage2 = await verifyStage2(
  publicKeyBytes,
  this.config.rpc,
  this.config.ipfs,
  { appCertificationRoot: this.config.appCertificationRoot, maxChainDepth: this.config.maxChainDepth }
);
```

**`#verifySignatureEntry` — propagate `app_card_chain_valid` in the final return** (currently line 241):
```typescript
app_card_chain_valid: stage2.app_card_chain_valid,
```

**`#buildResult` — add to the return object:**
```typescript
app_card_chain_valid: "skipped",
```
(Early-exit paths never ran Stage 2 successfully, so `"skipped"` is correct here.)

**`verifyCard` — add to the return object:**
```typescript
app_card_chain_valid: "skipped",
```
(`verifyCard` takes a master card address directly; master cards do not have `app_card` fields.)

**`#skippedResult` — add to the return object:**
```typescript
app_card_chain_valid: "skipped",
```

**Context files:**
- `src/CardVerifier.ts` (full file already read)
- `src/types.ts` after Step 3.1
- `src/stages/stage2.ts` after Step 4.1

**Done when:** `CardVerifier` constructor throws on missing `appCertificationRoot`; `app_card_chain_valid` is present in every result path; TypeScript compiles cleanly.

---

## Phase 5 — Tests ✅

### Step 5.1 — Add unit tests to `test/stages/stage2.test.ts` ✅

Read `test/stages/stage2.test.ts` and `test/fixtures.ts` first to understand the existing mock/fixture structure before adding cases.

**Four new test cases:**

1. **`app_card_chain_valid: true` — direct hop to root**  
   Fixture: sub-card whose `app_card`'s `ancestry_pubkeys[0]` hashes to `appCertificationRoot`.  
   Mock: `rpc.getCardEntry(appCardAddress)` returns a valid entry; IPFS returns an encrypted doc whose `ancestry_pubkeys[0]` hashes to the root address.  
   Expected: `scope_clean: true`, `app_card_chain_valid: true`, no `APP_CARD_CHAIN_NOT_TRUSTED` errors.

2. **`app_card_chain_valid: true` — multi-hop chain**  
   Fixture: 2-hop chain: `app_card → intermediate_card → appCertificationRoot`.  
   Mock: Two `rpc.getCardEntry` calls, two IPFS fetches.  
   Expected: `scope_clean: true`, `app_card_chain_valid: true`.

3. **Hard reject — chain does not reach root**  
   Fixture: `app_card` whose chain reaches a different address (not `appCertificationRoot`), with `ancestry_pubkeys: []` at the end.  
   Expected: `scope_clean: false`, `app_card_chain_valid: false`, `errors[*].code === "APP_CARD_CHAIN_NOT_TRUSTED"`.

4. **Constructor rejects missing `appCertificationRoot`**  
   Call `new CardVerifier({ rpc: mockRpc, ipfs: mockIpfs /* no appCertificationRoot */ })`.  
   Expected: throws `CardProtocolError` with code `APP_CERTIFICATION_ROOT_NOT_CONFIGURED`.

**Done when:** All four test cases pass; `npm test` (or the project's equivalent) shows no regressions in existing stage2 tests.

---

### Step 5.2 — Update integration tests ✅

Read `test/integration/full-pipeline.test.ts` and `test/integration/verifier.test.ts` before editing.

**What to update:**
- Every place `VerifierConfig` is constructed in the test suite: add `appCertificationRoot: fixtures.appCertRoot` (or the equivalent fixture constant). This prevents TypeScript errors from the new required field.
- Add at least one integration test in `full-pipeline.test.ts`: a sub-card with a valid holder chain but an `app_card` that does not chain to `appCertificationRoot`. Expected: `scope_clean: false`, error `APP_CARD_CHAIN_NOT_TRUSTED`, stages 3–6 skipped.

**Done when:** All integration tests pass; the new test demonstrates uncertified app_card rejection end-to-end.

---

> ## ⚑ Milestone Review 5
>
> **Pause here.** Run the full test suite and confirm:
> - Zero regressions in existing tests.
> - All four new unit test cases pass.
> - The integration test for uncertified app_card rejection passes.
> - TypeScript compiles cleanly across the package.

---

## Clarification Checkpoints

**CC-1 (before Phase 2):** Resolved at Milestone Review 1 — confirm AppCertificationBody framing matches David's intent before touching spec files.

**CC-2 (before Step 4.1):** If, after reading `stage3.ts`, it seems worth extracting the chain-walk logic into a shared utility (e.g., `walkCardChain(startDoc, startAddress, terminationAddress, rpc, ipfs, maxDepth)`), pause and confirm with David whether to refactor before duplicating. Current plan assumes a local implementation in `stage2.ts` for clarity, since the termination condition differs from Stage 3.
