# Versioning System — Strategic Plan

**Date:** 2026-06-28  
**Status:** Draft — awaiting open question review  
**Companion document:** [versioning-implementation-plan.md](./versioning-implementation-plan.md)

---

## Goals

### 1. Make every card and message self-describing about which protocol rules govern it

A card stored on IPFS today and retrieved in three years should carry enough information for a verifier to know exactly which version of the protocol it was created under — without consulting an external registry or inferring from context. The version number is the key that unlocks the right verification logic.

### 2. Enable backward-compatible verification across all protocol versions

The verifier must remain able to verify cards and messages from any prior version. Version .1 cards issued now must still verify correctly when the protocol is at version .5 or .9. The verifier's responsibility is to route each artifact to the right verification logic for its declared version, not to require all parties to upgrade in lockstep.

### 3. Establish a clean versioning contract before any artifacts are deployed

The initial version (.1) sets the schema for how version information is expressed. Getting this right before production deployment means every future version has a known, stable way to declare itself — and every future verifier knows where to look.

### 4. Preserve verifier integrity: version cannot be forged or stripped

A version field that can be stripped, altered, or omitted defeats the purpose. The version must be part of the signed payload so that its authenticity is covered by the same cryptographic guarantee as everything else in the artifact. A verifier must reject any artifact where the version field is missing or doesn't correspond to a known protocol version.

---

## Rationale

### Why versioning matters now

The protocol's crypto primitives are in active transition. Cards today use secp256r1 for on-chain ops and ML-DSA-44 for IPFS content. Future versions will change that balance — the on-chain key scheme upgrade path (Phase 1 → Phase 2 → Phase 3) is already designed in. Messages reference the current spec's envelope structure, but that structure will likely evolve as edits, retractions, and private message routing get refined.

IPFS content is permanent. A card written today will be retrievable indefinitely. If the protocol later changes its signing algorithm, canonical serialization format, or envelope schema, a verifier needs to know "this card was signed with ML-DSA-44 under the v0.1 schema" rather than trying to detect the version from the content shape. Version detection from content heuristics is fragile and becomes a security boundary (if an attacker can make a v.2 card look like a v.1 card to get the weaker verification rules, that's a downgrade attack).

The protocol is also at the moment just before the npm API lock. Adding a `protocol_version` field to the card schema and message envelope now costs almost nothing — adding it after deployment requires a migration story.

### Where version information lives

There are three distinct artifacts that need versioning:

**Card documents** — IPFS-stored JSON blobs that carry key material, policy references, and metadata. Version must be in the signed content so it's covered by the ML-DSA-44 signature.

**Messages** — the signed envelope (`payload` + `signatures`). Version must be in the payload so it's covered by each signer's signature. A stripped version field would mean the payload hash changes, invalidating the signature — which is exactly the right behavior.

**The verifier** — not a versioned artifact itself, but a versioned dispatcher: given a version-tagged artifact, apply the rules for that version. The verifier needs a registry of version handlers, each implementing the full verification logic for one protocol version.

### What version .1 covers

Version .1 is the baseline. It defines:
- secp256r1 for on-chain write authorization
- ML-DSA-44 for IPFS content signatures (cards and sub-card documents)
- The message envelope structure as described in `raw_notes/Message composition and verification.md`
- RFC 8785 canonical JSON as the serialization format (pending the open question below)

The version number `.1` (not `1` or `1.0`) is chosen to reflect that this is a pre-1.0 protocol under active development. The format is a single decimal with one fractional digit: `.1`, `.2`, ... `.9`, `1.0`, `1.1`, etc. Stored as a string to avoid floating-point ambiguity.

---

## Key Objectives

### Goal 1: Self-describing artifacts

- Every card document contains a `"protocol_version": "0.1"` field inside the signed content.
- Every message payload contains a `"protocol_version": "0.1"` field.
- The field is positioned consistently (defined position in the canonical field ordering) so the verifier parser can find it without ambiguity.
- A card or message with a missing `protocol_version` field is rejected by all verifiers.

### Goal 2: Backward-compatible verification

- The verifier exposes a single entry point that accepts any versioned artifact and routes internally to the correct version handler.
- Adding a new protocol version requires adding a new handler module — no changes to existing handlers.
- Verification of a v.1 artifact produces the same result regardless of which verifier version is running (v.1 handler behavior is frozen at spec lock).
- The verifier returns a structured result that includes the protocol version under which the artifact was verified.

### Goal 3: Clean initial schema

- The `protocol_version` field is specified in a versioning spec document alongside the serialization rules (field position in canonical ordering, accepted format, validation rules).
- The field is added to all existing card-creation and message-signing scripts before the first production artifact is generated.
- A test vector is generated for a v.1 card and a v.1 message, usable as regression tests when future versions are added.

### Goal 4: Version integrity under signing

- The version field is inside the content that is ML-DSA-44 signed (for cards) or inside the canonical payload that is signer-signed (for messages). Altering or stripping the field breaks the signature, making version tampering cryptographically detectable.
- The verifier checks that the `protocol_version` field is present and recognized before attempting signature verification. An unrecognized version produces an explicit `UnknownProtocolVersion` error, not a silent failure.
- There is no fallback behavior that allows verification to proceed with a missing or unrecognized version.

---

## Open Questions

### 1. Canonical serialization format — RFC 8785 or CBOR?

The architecture memory notes this is a blocking open question for the npm API lock. The `protocol_version` field needs to be positioned correctly within whichever canonical format is chosen. If RFC 8785 (canonical JSON), the field ordering is lexicographic and `"protocol_version"` would appear between `"public_key"` and `"recipients"` in a message payload — that needs to be verified against actual field names. If CBOR, the encoding is different and field ordering rules differ. **This plan assumes RFC 8785 canonical JSON as the format for all signed content, consistent with the existing `payload_parser` module in protocol-types. This assumption must be confirmed before implementation starts.**

### 2. Version format: string `"0.1"` or numeric representation?

The user specified `.1` as the initial version. For JSON representation, the options are:
- String `"0.1"` — human readable, no floating-point ambiguity, clear ordering (lexicographic won't work beyond single digits but semver-style parsing can)
- Integer with implicit decimal: `1` meaning `.1`, `2` meaning `.2`, `10` meaning `1.0` — compact but requires documentation
- Two-integer tuple `[0, 1]` — unambiguous but verbose

**Recommended: string `"0.1"` — matches the spec's version notation (`v0.3`, `v0.4`) and avoids floating-point edge cases. Requires: confirmation from David that this format works for client display and storage.**

### 3. Scope of versioning: card documents only, messages only, or both in v.1?

The user request covers both card files and messages. However, the card-creation tooling (`sign_card_message.rs`, etc.) and the message envelope are at different levels of completeness. Should both be versioned in the same implementation pass, or should card versioning ship first as a more contained change? **This plan assumes both are versioned together since they share the same version number and the implementation is straightforward.**

### 4. Where does the off-chain verifier live?

The request mentions "the verifier script." The on-chain verifier module (`contracts/verifier-module/`) is a stateless secp256r1 precompile wrapper — it doesn't need protocol versioning. The off-chain verification logic (checking card chains, message signatures, sub-card registration) is what needs version-aware routing. There is a `membership_card_verifier` directory in the project. **Is this the primary target for the versioned verifier dispatcher, or should the version-routing logic live in the contracts scripts, or a new dedicated module?**
