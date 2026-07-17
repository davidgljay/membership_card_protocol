# Inconsistencies — `obj-press` (`specs/object_specs/press.md`)

Reviewed against: `registry_contract.md`, `ipfs_card.md` (does not yet exist — see note at bottom), `wallet.md`, `relay.md` + `relay_data_model.md`, `card_verifier.md`, `app_sdk.md`, `wallet_sdk.md`, `matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`, `protocol-objects.md`, `card_protocol_spec.md`, `ARCHITECTURE.md`, and the process specs `card_offering_and_acceptance.md`, `open_offer_creation.md`, `open_offer_acceptance_existing_wallet.md`, `open_offer_acceptance_new_wallet.md`, `card_signing.md`, `card_updates.md`, `card_validation.md`, `subcard_creation_policy.md`, `log_auditing.md`, plus (spot-checked for specific claims press.md makes) `messaging_protocol.md`, `dns_governance_verifier.md`.

press.md is v0.3 (2026-06-25). Several of its cross-referenced specs have moved on since — most findings below are "press.md (or the spec it references) has gone stale relative to a newer spec," not a fresh contradiction introduced by press.md itself.

---

## 1. `press.md` §5.4 `registerSubCardOnChain` does not implement the DNS-admin-card secp256r1 authorization path required by `registry_contract.md` v0.6 §4.3

**Conflict.** `registry_contract.md` (v0.6, amended after press.md's v0.3) added two new required parameters to `RegisterSubCard`:

> `admin_secp_payload bytes, — Canonical RFC 8785 JSON of AdminAuthorizeSubCardPayload... Required (non-empty) when DnsAdminCardKeys[master_card_address] is non-zero`
> `admin_secp_signature bytes[64], — secp256r1 signature... Required (non-zero) when master is a DNS admin card.`
> Precondition 5: the contract reverts with **E-47** if these are missing/invalid/spurious.

But press.md's own `registerSubCardOnChain` (§5.4) is:

> 1. Confirm the requesting app's gas balance is sufficient... 2. Build the `RegisterSubCardPayload` and sign with secp256r1. 3. Call `RegisterSubCard(sub_card_address, master_card_address, registration_log_head, sub_card_doc_cid, master_sig_payload, master_signature)` on the registry.

— a 6-argument call with no `admin_secp_payload`/`admin_secp_signature` at all. Nor does `processSubCardRegistration` (§5.4, steps 1–11) ever check `DnsAdminCardKeys[master_card_address]` or obtain/attach the admin card holder's secp256r1 signature. press.md's error table (§7) also has no analogue of E-47 (it only has P-13/P-14 for the ML-DSA-44-side binding/signature checks).

**Impact:** following press.md's function as written, a press would submit `RegisterSubCard` for a sub-card of a DNS admin master card without the now-mandatory admin signature, and the on-chain call would revert with E-47 every time. This isn't a cosmetic doc drift — it's a functional gap in the flow press.md describes as authoritative.

**Recommendation:** Update press.md §5.4 (`processSubCardRegistration` and `registerSubCardOnChain`) to: (a) read `GetDnsAdminCardKey(master_card_address)` (or track it from `DnsAdminCardKeys` state) to determine whether the admin path applies; (b) if so, obtain/verify the admin card holder's secp256r1 signature over an `AdminAuthorizeSubCardPayload` and pass it through to `RegisterSubCard`; (c) add an error code (or reuse E-47 pass-through) to press.md §7 for this path. This is DNS/domain-admin functionality, so `dns_governance_verifier.md` (Phase 2, `proc-dns`) should also be checked — it currently makes no mention of `RegisterSubCard`, `admin_secp`, or `DnsAdminCardKeys` at all, so the gap may need closing on that side too.

---

## 2. `press.md` §5.1 never sets `protocol_version`, which `protocol-objects.md` requires the press to add and sign

**Conflict.** `protocol-objects.md` §1 `CardDocument`, signing-sequence step 5, is explicit that the **press** is the party responsible for this field:

> "the countersigned card is sent to the press, which calls `getProtocolVersion()` on the logic contract to obtain the current protocol version string, adds `protocol_version` to the document, validates policy compliance, signs canonical RFC 8785 JSON of the complete document (including `protocol_version`)..."

and the field table states: `protocol_version` — Required — "Set by the press: the press reads `getProtocolVersion()` from the logic contract and includes the returned value... Verifiers reject cards whose `protocol_version` is not in their known-versions list."

But press.md's `assembleCardDocument` (§5.1, steps 1–6) and `signCardDocument` (§5.1, steps 1–3) never mention `protocol_version` or a call to `getProtocolVersion()`. As written, a press following press.md would produce a `CardDocument` missing a required field, which `protocol-versioning.md` says verifiers must reject at Stage 1.

**Secondary gap this exposes:** `registry_contract.md` §5 (Read Operations) — the authoritative list of on-chain view functions — has no `GetProtocolVersion()` entry at all, despite `protocol-objects.md` describing it as a logic-contract read the press performs at every issuance. Either the read operation is missing from `registry_contract.md`'s otherwise-exhaustive §5 table, or `protocol-objects.md`'s signing sequence describes a function that doesn't exist yet on-chain.

**Recommendation:** Add a step to press.md's `assembleCardDocument` (or `signCardDocument`, immediately before serialization) that calls `getProtocolVersion()` and sets `protocol_version` on the document, consistent with `protocol-objects.md §1`. Separately, add `GetProtocolVersion()` to `registry_contract.md §5` (or confirm it's meant to live on the logic contract as a constant/view function and cross-reference it there) so the read press.md needs actually exists in the authoritative contract spec.

---

## 3. `log_auditing.md` (and `card_offering_and_acceptance.md`) describe the audit-epoch/AEK model press.md explicitly says was removed

**Conflict.** press.md §5.6 states, in full:

> "**5.6 Audit Epoch Management.** Removed. Audit epochs and ML-KEM-based AEK distribution are replaced by direct auditor messaging (see §5.5). Auditors maintain their own records of issuance notifications received from the press."

`protocol-objects.md` agrees and marks its own object definitions dead: §12 `AuditEpochEntry` and §13 `AuditEpochCommitment` both read "**Removed.** Audit epoch key distribution via ML-KEM is replaced by direct auditor messaging. See press spec §5.6 for the current auditor notification model." §11 `PressIssuanceRecord` in `protocol-objects.md` has no `epoch_id` field, matching press.md's `appendIssuanceRecord` (§5.5) plaintext shape (`card_cid`, `recipient_pubkey`, `scip_cid`, `issued_at`, `offer_type`).

But `log_auditing.md` (in scope for Phase 2 as `proc-log-auditing`) still describes the entire epoch/AEK/ML-KEM architecture as live and current — "Process 1: Opening an Epoch," `AuditEpochEntry`/`AuditEpochCommitment` objects, wrapped-AEK key packages, epoch close triggers, etc. — with no note that it has been superseded. It even cites a specific (now nonexistent) location in press.md for a step that no longer exists there:

> "5. The press retains the AEK in process memory... At epoch close, the press zeroes the in-memory AEK (see Process 2, Press side, step 6 in **`press.md §5.7`**)."

press.md's actual §5.7 is "On-Chain Operations" (`buildPressSignedPayload`, `getNextSequence`, `batchUpdateCardHeads`) — nothing about AEKs.

`card_offering_and_acceptance.md` (Phase 2, part of `proc-card-creation`) has the same staleness: its Preconditions require "An audit epoch is open for this policy, or the press is prepared to open one," and steps 19–21 describe opening/using an audit epoch and a `PressIssuanceRecord` shape with `epoch_id` and `requester_card` fields that don't exist in the current (protocol-objects.md-aligned) `PressIssuanceRecord`.

**Recommendation:** This is squarely a Phase 2 fix (both files are process specs), but it's flagged here because press.md is the object spec that already made the authoritative call and the two process specs never caught up. Rewrite `log_auditing.md` to describe the direct-auditor-messaging model (or mark it superseded/archived analogous to `client_sdk.md` if a decision is made to retire audit epochs from the spec set entirely), and update `card_offering_and_acceptance.md` steps 19–21 and its Preconditions to match press.md §5.5's `appendIssuanceRecord` flow instead of the epoch model.

---

## 4. `press.md` §5.4's subcard-sibling notifications don't match `messaging_protocol.md`'s envelope model for those message types

**Conflict.** `messaging_protocol.md` §9–11 defines `subcard_sibling_added`, `subcard_sibling_removed`, and `subcard_sibling_rotated` as ordinary entries in the protocol's message-type taxonomy — i.e., `payload.content` objects that ride inside the standard signed `SignedMessageEnvelope` / routing-layer architecture like every other type in that document (implicitly ML-DSA-44-signed and, per `ARCHITECTURE.md` ADR-007 / `message_routing.md`, E2E-encrypted in transit).

press.md §5.4 candidly documents that its actual delivery mechanism does not do this:

> "**Delivery is currently best-effort plaintext JSON POSTed to a per-recipient-address endpoint stub**, mirroring the existing Phase 3 auditor-notification precedent... — not full ADR-007 E2E encryption to each subcard's ML-KEM-768 public key, because no field anywhere in this protocol yet records a subcard's ML-KEM public key for the press to resolve."

So the notification is sent unsigned and unencrypted, direct HTTP, rather than as a signed envelope through the routing layer `messaging_protocol.md` implies. This is already self-flagged in press.md's own prose (with a reason), but `messaging_protocol.md` §9–11 doesn't carry any note that these three types are, for now, an exception to the envelope/encryption model the rest of the document assumes — a reader of `messaging_protocol.md` alone would expect signed+encrypted delivery.

**Recommendation:** Add a note to `messaging_protocol.md` §9–11 (or a general caveat near the top of the message-type taxonomy) stating that `subcard_sibling_*` notifications are currently delivered out-of-band as unsigned/unencrypted HTTP POSTs pending a protocol field for subcard ML-KEM public keys, cross-referencing press.md §5.4's note and the tracked next-step in `plans/milestones/subcard-registry-final-summary.md`. Alternatively, if/when a subcard ML-KEM pubkey field is added, update press.md §5.4 to route these through the standard signed-envelope/routing path and remove the exception.

---

## Minor / informational (not logged as full findings)

- **`PressIssuanceRecord` has no entry in `messaging_protocol.md`'s type taxonomy.** press.md §5.5 (`appendIssuanceRecord`) and `protocol-objects.md` §11 both say the record is "delivered directly to each auditor card address... via E2E encrypted message using the normal message routing layer," implying it travels as a `payload.content` of some message `type`. `messaging_protocol.md`'s taxonomy (the document `card_signing.md` calls "the authoritative list of valid values for the `type` field") has no `press_issuance_record` (or similar) type defined. Worth a one-line addition to `messaging_protocol.md` if a Phase 2 pass touches that file, but low severity since the intent is otherwise unambiguous.
- **`update_codes.md`, `key_rotation.md`, `subcards.md`, `dns_resolution.md` are referenced heavily by press.md** (e.g., "per `update_codes.md §5xx`") but are not in the strategic plan's in-scope spec list. They exist in the repo and weren't reviewed in depth here since they're out of this pass's scope — flagging only so a future scoping decision can consider whether they should be pulled in (they're clearly load-bearing for press.md's P-23/510-511-512 logic).
- **`ipfs_card.md` does not yet exist** (Phase 0 deliverable, not yet drafted at the time of this review). press.md's IPFS-facing behavior (§3.4, §3.5, `pinToIPFS`) was cross-checked against `registry_contract.md`'s CID handling (§3.1 encoding, 64-byte max) and no conflict was found there, but a proper cross-check against the dedicated card/CID object spec should be re-run once `ipfs_card.md` is drafted.
- No conflicts found between press.md's P-xx error codes (§7) and `registry_contract.md`'s E-xx codes (§8) — the two namespaces are disjoint by design and every on-chain error code press.md references (E-07, E-08, E-12, E-13, E-14, E-22, E-28) matches its definition in `registry_contract.md §8` exactly, including which ones are "press-side rejection, not an on-chain revert" (E-14, E-22, E-28, E-44) — press.md is consistent with that distinction throughout.
- No conflicts found in the `RpcProvider`/`IpfsProvider` interfaces press.md's §5.0 setup code implements against `card_verifier.md §4`'s interface definitions — field names and types line up (`getCardEntry`, `getPressAuthorization`, `getSubCardEntry`, `getLogEntries`, `getEasAnnotations`, `IpfsProvider.fetch`).
- `wallet.md`, `relay.md`/`relay_data_model.md`, `app_sdk.md`, `wallet_sdk.md`, and the three Matrix specs have no direct references to or from press.md's content (press.md doesn't call the wallet service, relay, or Matrix layer, and none of those specs describe calling press.md's HTTP endpoints in a way that conflicts with press.md §4) — no inconsistencies found in that direction.
