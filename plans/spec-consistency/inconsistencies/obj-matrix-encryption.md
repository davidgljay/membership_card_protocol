# Step A Findings — `obj-matrix-encryption` (`specs/object_specs/matrix_encryption.md`)

**Reviewed against:** all in-scope object specs (`matrix_room.md`, `matrix_synapse_module.md`, `registry_contract.md`, `ipfs_card.md`, `press.md`, `wallet.md`, `relay.md`, `relay_data_model.md`, `card_verifier.md`, `app_sdk.md`, `wallet_sdk.md`, `protocol-objects.md`, `card_protocol_spec.md`, `ARCHITECTURE.md`), the Matrix process specs (`matrix_join_attestation_and_revocation.md`, `matrix_room_membership.md`, `room_discovery.md`), `messaging_protocol.md` (companion doc, referenced extensively by this spec), and briefly `wallet-service/matrix-policy-module/` and related wallet-service files.

**Overall assessment:** this spec is tightly and carefully cross-referenced with the rest of the Matrix cluster (`matrix_room.md`, `matrix_synapse_module.md`, `matrix_join_attestation_and_revocation.md`, `matrix_room_membership.md`) — dates, field names (`chain_reaches_trusted_root`, `revocation.status`, `card_hash = keccak256(public_key)`), and the crypto scheme (ML-DSA-44 signing, RFC 8785 canonicalization) all line up exactly across every companion document, including the resolved `registry_contract.md` OQ-6 entry that explicitly matches the event-driven watcher design this cluster depends on. The Megolm-vs-ML-KEM divergence from `messaging_protocol.md`'s 1:1 encryption model is explained deliberately (§1, and the §5 summary table), not a silent conflict. One real inconsistency was found, below.

---

## Finding 1 — Stale `client-sdk/` code citation for the ML-DSA-44 signing call site, when `app_sdk.md` (in scope, dated earlier) already relocated it to `app-sdk/`

**Conflicting specs:** `matrix_encryption.md §2` ("What is reused, unchanged, from `messaging_protocol.md`") vs. `app_sdk.md` (Crypto section) and `client_sdk.md`'s own superseded banner.

**Concrete conflict:**

`matrix_encryption.md §2` states:

> Signing: `signatures[].signature` is an ML-DSA-44 signature (`mlDsa44Sign`, `client-sdk/packages/client-sdk/src/crypto/mldsa.ts`) over the canonical RFC 8785 JSON encoding (`canonicalize()`, `wallet-service/src/canonicalize.ts` and its `client-sdk` equivalent) of `payload` — the identical signing call site and canonicalization function used for every other message type, not a new one.

This cites `client-sdk/packages/client-sdk/src/crypto/mldsa.ts` as the current, authoritative implementation location for `mlDsa44Sign`, and refers to a "`client-sdk` equivalent" of `canonicalize()`.

But `client_sdk.md` itself carries an explicit supersession banner:

> ⚠️ SUPERSEDED — This spec has been split into two packages as of 2026-07-06. See: `specs/object_specs/app_sdk.md` ... `specs/object_specs/wallet_sdk.md` ... This document is retained as a historical reference; future changes should target one of the two split specs.

And `app_sdk.md` (dated 2026-07-06, i.e. **before** `matrix_encryption.md`'s 2026-07-10 date) documents the same function as living in the new package:

> `mlDsa44GenerateKeypair` / `mlDsa44Sign` / `mlDsa44Verify` / `mlDsa44GetPublicKey` | `@noble/post-quantum` | Every ML-DSA-44 signing operation in this package

— i.e. `app-sdk/packages/app-sdk/src/crypto/mldsa.ts` (confirmed to exist in the repo at that path; the old `client-sdk/packages/client-sdk/src/crypto/mldsa.ts` file also still physically exists in the repo, which is presumably why this drifted unnoticed — both paths currently compile, so nothing forced the citation to be updated).

**Why this matters:** the SDK split (app_sdk.md/wallet_sdk.md) predates matrix_encryption.md by four days, so when this section was written the authoritative location for signing had already moved. This isn't a hypothetical future drift — it's citing the superseded package as the real call site in a spec written after the supersession took effect. A reader of `matrix_encryption.md` following this citation lands in the historical/frozen package rather than the one `app_sdk.md`/`wallet_sdk.md` (both in Phase 1 scope) now say is authoritative for every other signing use in the protocol.

**Recommended resolution:** update `matrix_encryption.md §2` to cite `app-sdk/packages/app-sdk/src/crypto/mldsa.ts` (or wherever `wallet_sdk.md` says the wallet-side call site actually lives — `app_sdk.md` is key-independent, so the client that holds the signing key and calls `mlDsa44Sign` for outgoing room messages is presumably going through `wallet-sdk`'s consumption of `app-sdk`'s crypto module; confirm which package the actual sending call site sits in before editing) in place of the `client-sdk/...` path, and replace "its `client-sdk` equivalent" with the corresponding `app-sdk`/`wallet-sdk` canonicalization reference. This is a documentation-citation fix only — no semantic/behavioral change, since the underlying algorithm (ML-DSA-44 over RFC 8785 canonical JSON) is identical in both locations per `app_sdk.md`.

---

## Non-findings (checked, no contradiction)

- **Crypto scheme choice for room messages (Megolm, not ML-KEM-768/HPKE):** `matrix_encryption.md §1` deliberately does not use the protocol's usual ML-KEM-768/HPKE E2E key-encapsulation scheme (`ARCHITECTURE.md` ADR-004, `messaging_protocol.md`) for room messages, using Matrix's native Megolm instead. This is explicitly justified (§1, and the §5 summary table's "Confidentiality" row) as a deliberate substitution for the *transport-layer* confidentiality mechanism, not a silent divergence — the *signing* layer (ML-DSA-44 over canonical RFC 8785 JSON) is identical to the rest of the protocol and is called out as unchanged. No inconsistency.
- **`card_hash` derivation:** `matrix_encryption.md §3`'s `card_hash = keccak256(recipient_pubkey)` matches `messaging_protocol.md §Address Model`'s `keccak256(recipient_pubkey)` (also `ARCHITECTURE.md` ADR-006) exactly, and the signer's card hash via `keccak256(public_key)` matches `messaging_protocol.md §Common Envelope`'s identical statement.
- **`chain_reaches_trusted_root`, `revocation.status` field names** cited by `matrix_synapse_module.md` (this spec's tight companion) against `card_verifier.md`'s actual `CardVerificationResult`/`SignatureVerificationResult` types: exact match, confirmed by direct comparison.
- **`registry_contract.md` OQ-6** ("efficient log head change detection") is marked resolved 2026-07-11 with text describing exactly the watcher/watch-set design in `matrix_join_attestation_and_revocation.md §3`, which this spec (`matrix_encryption.md §3`) also references consistently ("wallet-service is never queried by the Synapse module at authorization time").
- **`verifyMatrixUserIdBinding`, `deriveMatrixUserId`, `shadowAccountCommitment`** (§3): used identically and without contradiction across `matrix_room.md`, `matrix_synapse_module.md`, `matrix_join_attestation_and_revocation.md`, and `matrix_room_membership.md` — same signature, same semantics, same "no general inverse" claim everywhere it's invoked.
- **Sender-binding check (§4)** and its "enforcement boundary" text is quoted near-verbatim and attributed correctly in both directions between `matrix_encryption.md §4` and `matrix_room_membership.md §5` — each cites the other as the source of the same invariant, and neither contradicts the other's framing of what Synapse can/cannot see.
- **Supersession note re: `raw_notes/matrix.md`:** the document's own supersession banner (hybrid AES-256 room-key model, `unsigned.card_signatures`, "server signature over ciphertext") is consistent with `matrix_room.md`'s parallel supersession note for the same raw-notes file's room/policy section — both describe the same obsolete design being replaced, not conflicting accounts of what was replaced.
- **`client_sdk.md` archival status:** per `strategic-plan.md`'s resolved Open Question 1 (2026-07-16), `client_sdk.md` is kept, archived, with a `SUPERSEDED` banner — this is working as intended and is not itself a finding; only the stale citation in Finding 1 above is a problem (a citation to the *code path* the superseded spec described, not a citation to the spec document itself).
- **Wallet-service Matrix module references:** `matrix_encryption.md` cites `wallet-service/src/matrix/account-id.ts` (§3) and `wallet-service/src/canonicalize.ts` (§2) — both paths exist in the repo (confirmed: `wallet-service/src/matrix/` and `wallet-service/src/canonicalize.ts` are present). No missing-file issue at the Phase 1 level.
