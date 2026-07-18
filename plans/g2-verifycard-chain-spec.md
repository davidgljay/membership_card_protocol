# G2 Spec — `verifyCard`/`verify_card` optional-pubkey chain population

Implements `plans/todo-implementation-plan.md` Phase 2 (G2), resolving
`plans/completed/membership_card_verifier_todo.md` item 2's "recommendation
for whenever this is revisited." Decision locked in from `strategic-plan.md`
§G2: the new parameter is a **pubkey only** (base64url string), not an
alternative `CardDocument` input.

## 0. Current behavior (confirmed by reading both implementations)

`verifyCard(cardAddress, options?)` / `verify_card(card_address, options=None)`
never has a public key for the given address, so it can never derive the
AES content key needed to decrypt that card's IPFS document — `chain` is
therefore hardcoded to `[]` unconditionally, `returnChain`/`return_chain`
has no effect on this path, and `chain_card_addresses` is just
`[card_address]` (a single-element stub, not a real walked chain).

No current call site (confirmed by repo-wide grep) passes anything that
could carry a pubkey to `verifyCard`/`verify_card` today:
`client-sdk/.../offerVerification.ts`, `client-sdk/.../handleSubCardRequest.ts`,
and `matrix-policy-module/chain_context.py`'s `verify_card_revocation` (the
Watcher's post-time revocation re-check) all call it with a bare address.
This means the new parameter is purely additive/opt-in — omitting it is
byte-for-byte identical to today's behavior in every existing call site.

## 1. New parameter: `VerifyCardOptions.pubkey`

**TS** (`packages/verifier/src/types.ts` ~line 195):

```ts
export interface VerifyCardOptions {
  asOf?: string;
  pubkey?: string; // base64url-encoded public key for cardAddress, if the caller has it —
  // enables real chain population the same way verifyEnvelope's signature-carried
  // pubkey does. Omit to keep today's chain: [] behavior.
}
```

**Python** (`packages/verifier-py/.../types.py` ~line 231):

```python
@dataclass
class VerifyCardOptions:
    as_of: Optional[str] = None
    pubkey: Optional[str] = None  # base64url-encoded public key for card_address, if the
    # caller has it — enables real chain population the same way verify_envelope's
    # signature-carried pubkey does. Omit to keep today's chain: [] behavior.
```

The caller is asserting that `pubkey` corresponds to `cardAddress` — this
implementation **must not trust that claim blindly**; see §3's address-
binding check.

## 2. What "populate a real chain" means here

Mirrors exactly what `#verifySignatureEntry`/`_verify_signature_entry` already
does for the signature-carrying path (`CardVerifier.ts` ~lines 256-266,
`card_verifier.py` ~lines matching the same logic): derive the content key
from the pubkey, fetch+decrypt+parse the card's own `CardDocument` from
`cardEntry.log_head_cid`, then hand that document + address + pubkey to
`verifyStage3`/`verify_stage3` exactly as today's sub-card path does. Stage 3
already knows how to walk ancestry from there — no new chain-walk logic is
being written, only a new entry point into the existing one.

## 3. Exact implementation — TS (`CardVerifier.ts`, `verifyCard` method)

Insert after the existing `isTrustedRoot`/`chainAddresses` computation
(~line 166), replacing the hardcoded `const chain: ChainLink[] = [];` at
line 185 with:

```ts
let chain: ChainLink[] = [];
let realChainReachesTrustedRoot: boolean | "skipped" = isTrustedRoot;
let realChainAddresses: string[] = chainAddresses;

if (options?.pubkey) {
  const pubkeyBytes = new Uint8Array(Buffer.from(options.pubkey, "base64url"));
  const derivedAddress = keccak256(pubkeyBytes);

  if (derivedAddress !== cardAddress) {
    errors.push({
      stage: 3,
      code: "ADDRESS_BINDING_MISMATCH",
      message: `Supplied pubkey does not correspond to cardAddress: ${cardAddress}`,
    });
    // chain stays [], realChainReachesTrustedRoot stays isTrustedRoot (today's behavior)
  } else {
    const contentKey = hkdfSha3256(pubkeyBytes, "card-content-v1");
    try {
      const encrypted = await this.config.ipfs.fetch(cardEntry.log_head_cid);
      const decrypted = aes256gcmDecrypt(contentKey, encrypted);
      const cardDoc = JSON.parse(new TextDecoder().decode(decrypted)) as CardDocument;

      const stage3 = await verifyStage3(cardDoc, cardAddress, this.config.rpc, this.config.ipfs, this.config, pubkeyBytes);
      errors.push(...stage3.errors);
      chain = stage3.chain;
      realChainReachesTrustedRoot = stage3.chain_reaches_trusted_root;
      realChainAddresses = stage3.chain_card_addresses;
    } catch (e) {
      const code = e instanceof CardProtocolError ? e.code : "DECRYPTION_FAILED";
      errors.push({ stage: 3, code, message: String(e) });
      // chain stays [] — decryption/parse failure falls back to today's behavior,
      // not a hard rejection of the whole verifyCard call.
    }
  }
}
```

Then update the `return` statement (~line 187-207) to use
`realChainReachesTrustedRoot`/`realChainAddresses` in place of
`isTrustedRoot`/`chainAddresses` for the `chain_reaches_trusted_root` and
`chain_card_addresses` fields, and `evaluatePolicyMatch(chain, ...)` (already
references `chain`, which now may be non-empty — no change needed there
beyond the reassignment above making `chain` mutable `let` instead of
`const`).

**Imports needed** in `CardVerifier.ts`: confirmed neither `hkdfSha3256` nor
`aes256gcmDecrypt` nor `CardDocument` is currently imported — add
`hkdfSha3256, aes256gcmDecrypt` to the existing `import { keccak256 } from "./crypto.js";`
line, and add `CardDocument` to the existing `import type { ... } from "./types.js";`
block.

**Stage numbering note:** use `stage: 3` for the new error codes above (not
`stage: 2`), since this is conceptually the same decrypt-and-walk operation
Stage 3 performs elsewhere in the pipeline for `verifyEnvelope` — even though
it's happening inside `verifyCard`'s method body rather than a call into
`verifyStage2`. This keeps error-stage semantics consistent with where a
caller would look for "did the chain walk succeed."

## 4. Exact implementation — Python (`card_verifier.py`, `verify_card` method)

Mirror of §3. Replace the hardcoded `chain: list[ChainLink] = []` (~line
matching `chain: list[ChainLink] = []` before the final `return`) with:

```python
chain: list[ChainLink] = []
real_chain_reaches_trusted_root: bool | Literal["skipped"] = is_trusted_root
real_chain_addresses: list[str] = chain_addresses

if options is not None and options.pubkey:
    pubkey_bytes = _b64url_decode(options.pubkey)
    derived_address = keccak256(pubkey_bytes)

    if derived_address != card_address:
        errors.append(
            VerificationError(
                stage=3,
                code="ADDRESS_BINDING_MISMATCH",
                message=f"Supplied pubkey does not correspond to card_address: {card_address}",
            )
        )
        # chain stays [], real_chain_reaches_trusted_root stays is_trusted_root
    else:
        content_key = hkdf_sha3_256(pubkey_bytes, "card-content-v1")
        try:
            encrypted = await self.config.ipfs.fetch(card_entry.log_head_cid)
            decrypted = aes256gcm_decrypt(content_key, encrypted)
            card_doc = json.loads(decrypted.decode("utf-8"))

            stage3 = await verify_stage3(
                card_doc, card_address, self.config.rpc, self.config.ipfs, self.config, pubkey_bytes
            )
            errors.extend(stage3.errors)
            chain = stage3.chain
            real_chain_reaches_trusted_root = stage3.chain_reaches_trusted_root
            real_chain_addresses = stage3.chain_card_addresses
        except CardProtocolError as e:
            errors.append(VerificationError(stage=3, code=e.code, message=str(e)))
            # chain stays [] — decryption/parse failure falls back to today's behavior
```

Then use `real_chain_reaches_trusted_root`/`real_chain_addresses` in the
final `CardVerificationResult(...)` construction in place of
`is_trusted_root`/`chain_addresses`.

**Imports needed** in `card_verifier.py` — confirmed by reading the file's
current import block (lines 1-30): `json` is **not** currently imported at
module level (add `import json` at the top); `keccak256` **is** already
imported from `.crypto` (line 9: `from .crypto import keccak256`) — extend
this to `from .crypto import aes256gcm_decrypt, hkdf_sha3_256, keccak256`.
For base64url decoding: this repo's established convention (confirmed in
`stages/stage1.py`, `stages/stage2.py`, `stages/stage3.py`, which each
independently define their own private `_b64url_decode`, rather than
cross-importing one another's) is to duplicate the 3-line helper per
module, not share it across files — add the same private helper directly in
`card_verifier.py`:

```python
def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)
```

(requires `import base64` at the top of `card_verifier.py` as well).

## 5. Fallback behavior (explicit)

- `options` omitted, or `options.pubkey` omitted/falsy: byte-for-byte
  identical to today — `chain: []`, `chain_reaches_trusted_root: isTrustedRoot`
  (the existing `trustedRoots.includes(cardAddress) || isPolicyAuthorizer(...)`
  check), `chain_card_addresses: [cardAddress]`.
- `options.pubkey` supplied but doesn't hash to `cardAddress`: hard address-
  binding check fails → push `ADDRESS_BINDING_MISMATCH` error, chain stays
  `[]`, no exception thrown (the caller gets a normal result object with an
  error entry, not a thrown error — consistent with how the rest of
  `verifyCard` never throws for input-shape problems).
- `options.pubkey` supplied, address matches, but IPFS fetch or decryption
  fails: push `DECRYPTION_FAILED` (or whatever `CardProtocolError` code the
  underlying call raises) error, chain stays `[]` — same graceful-degradation
  behavior as the address-mismatch case, not a thrown error.
- `options.pubkey` supplied, address matches, decrypt/parse succeeds: `chain`
  is the real Stage-3-walked chain, `chain_reaches_trusted_root` and
  `chain_card_addresses` reflect the real walk (which may differ from the
  `isTrustedRoot`/`[cardAddress]` stub values — e.g. a card whose bare
  address isn't itself a trusted root, but whose ancestry walk does reach
  one, now correctly reports `chain_reaches_trusted_root: true`).

**A known, pre-existing, out-of-scope gap this path inherits:** Stage 3's
per-hop ancestor loop unconditionally treats a fetched ancestor object as a
`CardDocument` rather than checking for a post-genesis `LogEntry`/`card_state`
shape — this is `plans/completed/membership_card_verifier_todo.md` item 5,
already flagged and explicitly deferred as a separate fix. This spec's new
code path calls the same `verifyStage3`/`verify_stage3` function every other
chain walk already uses, so it inherits that same gap rather than
introducing a new one — do not attempt to fix item 5 as part of implementing
G2; that's out of scope for this phase.

## 6. Regression guard against the Phase 4 fix (for step 2.5)

The Phase 4 fix (`membership_card_verifier_todo.md` item 2's "Fixed same-day"
section) exists because `wallet-service` structurally cannot hold a card's
private key, and therefore cannot supply a real pubkey to `verifyCard`
either — this new optional parameter must not become an invitation for
`wallet-service`'s `/matrix/discover-rooms` handler or `client-sdk`'s
`discoverRooms` to go back to calling `verifyCard` instead of
`verifyEnvelope`/`buildRoomDiscoveryEnvelope`. Step 2.5 (a separate plan
step, not part of this spec's implementation) greps both codebases for
`verifyCard`/`verify_card` call sites and confirms neither of the two fixed
call sites (`client-sdk/packages/client-sdk/src/matrix/discovery.ts`,
`wallet-service/src/matrix/room-discovery.ts`) reintroduces a `verifyCard`
call — they should still call `verifyEnvelope`/`verify_envelope` exclusively,
unaffected by this spec, since this spec only touches `verifyCard`'s
behavior when explicitly given a new opt-in parameter neither of those call
sites uses.

## 7. Test cases (step 2.4)

Add to each language's existing `verifyCard`-adjacent test file (TS:
`packages/verifier/test/integration/chain-and-policy-match.test.ts`'s
`policy_match` describe block already has `verifyCard()`-specific cases —
extend there, or add a sibling `describe("verifyCard with pubkey", ...)`
block in the same file; Python: `tests/integration/test_verifier.py`'s
existing `verify_card` tests, or a new function in the same file matching
its style):

1. **`returnChain: true` + supplied correct `pubkey` produces a non-empty,
   correct chain.** Reuse the existing `buildScenario` fixture (TS) /
   equivalent Python fixture — call `verifyCard(holder.address, { pubkey: <holder's base64url pubkey>, returnChain semantics via config })`. Wait — `returnChain` is a
   `VerifierConfig`-level setting (constructor), not a per-call option
   (confirm: yes, `this.config.returnChain` gates whether `chain` is exposed
   on the result at all, orthogonal to whether `chain` is populated
   internally). So: construct the verifier with `returnChain: true`, call
   `verifyCard(holder.address, { pubkey: <holder pubkey base64url> })`,
   assert `result.chain` is defined, non-empty, and matches the same shape/
   values `verifyEnvelope`'s chain walk produces for the same card (reuse
   the existing chain-shape assertions already in this file, e.g. lines
   165-170's `card_address`/`card_content["policy_id"]` checks, as the
   pattern to copy).
2. **No-pubkey path is byte-for-byte unchanged from today.** Call
   `verifyCard(holder.address)` (no `options`, or `options` without
   `pubkey`) and confirm `chain` is still `[]` / absent per `returnChain`,
   exactly matching the two existing tests at lines 360-399 of the TS file
   (these already pass and don't need modification — this new case is about
   confirming the *addition* of the pubkey path didn't regress the
   no-pubkey path, so it can literally reuse those two existing tests as
   its "before" baseline; no new assertions needed beyond what's already
   there, but note this explicitly in the PR/commit description per the
   plan's done-when).
3. **Wrong pubkey (mismatched address) case:** call `verifyCard(holder.address, { pubkey: <sub's base64url pubkey instead> })` (i.e. a
   pubkey for a *different* card) and assert: `chain` stays `[]`,
   `errors` contains a `stage: 3, code: "ADDRESS_BINDING_MISMATCH"` entry.

## 8. Done-when checklist for 2.2/2.3/2.4

- 2.2 (TS): `VerifyCardOptions.pubkey` added; `verifyCard` populates a real
  chain when supplied and valid per §3/§5; unchanged behavior when omitted.
- 2.3 (Python): mirror of 2.2 per §4/§5.
- 2.4: all three cases from §7 added and passing in both languages; existing
  test suite (108 TS / 137 Python, per Phase 1's milestone counts, plus
  whatever `verifier.test.ts`/`test_verifier.py` already contain) still
  passes unmodified.
