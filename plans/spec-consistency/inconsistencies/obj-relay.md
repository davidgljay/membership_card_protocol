# Inconsistency Review — `obj-relay` (`relay.md` + `relay_data_model.md`)

Reviewed: `specs/object_specs/relay.md` (v0.9), `specs/object_specs/relay_data_model.md` (v0.9), against every other in-scope object spec and process spec listed in the task brief, with particular attention to `specs/process_specs/notification_relay.md`, `message_routing.md`, and `oblivious_transport.md`.

## Step 1: Internal consistency (relay.md vs relay_data_model.md)

No contradictions found. These two files are unusually tightly cross-referenced and appear to have been revised together specifically to reconcile the serverless-migration-and-reversion history (both carry matching "Amends" changelogs, both explicitly call out and preserve the same three corrections: `device_credential`-keyed message store, `wallet_base_url` naming/https-only semantics, and the UUID state machine). Field names, endpoint list, error codes, UUID lifecycle states, and topology description all agree between the two files. No further action needed on this half of the task.

## Step 2: Cross-spec contradictions found

### Finding 1 — `notification_relay.md` uses a stale `wallet_ws_url` field name that contradicts the corrected `wallet_base_url` model in `relay.md`/`relay_data_model.md` (and contradicts itself)

**Conflicting specs:** `specs/process_specs/notification_relay.md` (Process 1, steps 3–4; Process 6 "Properties" bullet) vs. `specs/object_specs/relay.md` (§5 App Registry, §6.1) and `specs/object_specs/relay_data_model.md` (§2.2 UUID Record Fields, §6.1 App Registry JSON Schema).

**The conflict:**

`relay_data_model.md` §2.2 explicitly documents the UUID record's field as:

> `wallet_base_url` | string | Base HTTPS URL of the wallet service; used when sending staggered deletes (`DELETE {wallet_base_url}/messages/{uuid}`). Not used by the relay for any outbound connection to the wallet service.

and `relay.md`'s own changelog preamble (lines 9, 13) states this was a **deliberate correction carried forward from the serverless-migration period**: "**`wallet_base_url`** (§5, §6.1)... Confirmed correct and consistent throughout this revision — **no `wallet_ws_url`/`ws://`/`wss://` language remains**." Both files are emphatic that the relay never opens any connection (WebSocket or otherwise) to the wallet service — `relay.md` §7.3: "the relay never opens a connection to the wallet service."

`notification_relay.md` (the process spec `relay.md` §2 names as the "Process-level spec this document implements") was not updated to match. It still says:

- Process 1, step 3: "Each UUID is mapped to the push token and **wallet WebSocket URL** (looked up from the app registry via `app_id`)."
- Process 1, step 4 (UUID storage schema): `uuid → { app_id, push_token, wallet_ws_url, device_credential, status: "unused" }`
- Process 6 ("Properties"): "The relay makes one outbound delete call per delivered message, to the **`wallet_ws_url`** stored in the UUID record at registration time."

This is also an **internal contradiction within `notification_relay.md` itself**: Process 6, step 1 correctly builds the delete job as `job = { wallet_url: record.wallet_base_url, uuid }` (matching `relay_data_model.md` §4.1's job schema), while the very next paragraph ("Properties") calls the same field `wallet_ws_url`.

Taken literally, "wallet WebSocket URL" implies the relay opens a WebSocket connection *to the wallet service* — which both object specs go out of their way to say never happens (delete calls are plain `DELETE` HTTPS requests, one-way, relay-initiated, no persistent connection). `wallet.md` §Actors correctly reflects the corrected model ("**Relay** | Receives `POST /deliver/{uuid}` calls from this service; sends `DELETE /messages/{uuid}` clearance calls back. Never opens a persistent connection to this service.") — so the drift is isolated to `notification_relay.md`.

**Recommended resolution:** Update `notification_relay.md` Process 1 steps 3–4 and Process 6 "Properties" to use `wallet_base_url` (matching `relay_data_model.md` §2.2's field name and https-only semantics), and drop "WebSocket" from the step-3 prose describing what's looked up from the app registry. This is a terminology-only fix; the described behavior (staggered `DELETE` calls) is otherwise already correct in `notification_relay.md`.

---

### Finding 2 — `notification_relay.md`'s Privacy Properties table and Process 2 delivery-channel lookups still describe `push_token`-keying, which `relay_data_model.md` documents as a corrected bug

**Conflicting specs:** `specs/process_specs/notification_relay.md` (§Privacy Properties table; Process 2, steps 4–5) vs. `specs/object_specs/relay.md` (§4 Privacy Properties, §6.1, §7.3, §7.4) and `specs/object_specs/relay_data_model.md` (§3.1, §3.4, §8.1, §8.4).

**The conflict:**

`relay_data_model.md` §3.1 is unusually explicit that this exact discrepancy was previously a real bug that has since been fixed and must not recur:

> "**This key schema is `device_credential`-keyed, not `push_token`-keyed — a correction that predates and is independent of the serverless migration and survives this reversion unchanged.** An earlier revision of this subsection said `messages:{push_token}`, which contradicted §8 (Device Credential Store)... Push-token-keying would also have broken the isolation guarantee §8.1 claims..."

`relay.md` §4 (Privacy Properties) accordingly states the relay knows "UUID → device credential + push token; **device credential → pending blobs**," and §7.3/§7.4 both describe the WebSocket and SSE connection maps as `Map<device_credential, ...>`.

`notification_relay.md`'s own Privacy Properties table, however, still says:

> "Relay service | Knows: UUID → push token; **push token → pending message blobs**"

and Process 2 (Message Delivery), steps 4–5, describe the delivery-channel checks the same (stale) way:

> 4. "The relay checks whether an SSE connection is open for **the device's `push_token`**..."
> 5. "The relay checks whether a WebSocket session is active for a UUID associated with **the same `push_token`**..."

This is not merely cosmetic: `relay_data_model.md` §8.1's threat model explicitly depends on credential-keying, not push-token-keying, to prevent an attacker who has learned a device's push token from draining its message store. A process spec that still describes push-token-keyed lookups understates (or actively misdescribes) the isolation property the object spec is designed to guarantee, and is exactly the kind of stale description this initiative's Phase 2 (process specs assume Phase 1's now-consistent object specs) is meant to catch before it propagates further.

**Recommended resolution:** Update `notification_relay.md`'s Privacy Properties table to read "UUID → device credential + push token; device credential → pending message blobs" (matching `relay.md` §4 verbatim), and update Process 2 steps 4–5 to say the relay resolves the UUID's `device_credential` and checks the SSE/WebSocket connection maps by that credential, not by `push_token`. Flagging this one specifically as security-relevant per the initiative's guidance (Phase 3 note about load-bearing/security-relevant findings) even though this is a Phase 1/2 object-vs-process check, because it touches an explicitly-documented isolation guarantee.

---

## Other checks performed, no issues found

- **Endpoint list and error codes:** `relay.md` §7/§10 endpoint and error-code tables are consistent with how `wallet.md`, `message_routing.md`, and `notification_relay.md` describe calling `POST /deliver/{uuid}` and receiving `DELETE /messages/{uuid}`.
- **UUID lifecycle states** (`unused` / `in_flight` / `active` / `consumed`): consistent across `relay.md` §8, `relay_data_model.md` §7, and `notification_relay.md`'s Process descriptions.
- **App registry schema** (`app_id`, `platform`, `wallet_base_url`, `apns`/`fcm` blocks): consistent between `relay.md` §5 and `relay_data_model.md` §6.1; no other spec redefines this schema.
- **Deregistration endpoint** (`DELETE /cards/{card_hash}/subcards/{subcard_hash}`): consistent between `notification_relay.md` (§Multi-Device Support "Deregistration") and `wallet.md` (this is correctly a wallet-service endpoint, not a relay endpoint — `relay.md` does not, and should not, define it).
- **`client_sdk.md`:** no references to it were found anywhere in the relay cluster or its directly-related specs; nothing to flag re: stale archival references.
- **`app_sdk.md` §4.7 (`ObliviousProtocolTransport`) and §9 (Messaging and UUID/Relay Management):** consistent with `relay.md`'s endpoint set and with `oblivious_transport.md`'s envelope/target-registry design; no field/type mismatches found.
- **`oblivious_transport.md`:** consistent with `relay.md`'s framing of the relay as reused infrastructure; its "Honest Caveat" section explicitly and correctly narrows `notification_relay.md`'s defense-in-depth framing for the IP-hiding property only, which is itself a documented, intentional (not contradictory) scoping — no action needed.
- **`ARCHITECTURE.md` ADR-007:** consistent with the relay's role as description in `oblivious_transport.md` and `message_routing.md`; no contradiction with relay.md/relay_data_model.md.
- **`protocol-objects.md` / `card_protocol_spec.md` "OHTTP relay" references** (badge/CHAPI authentication-request flow, `callbacks.ohttp.relay`): this is a distinct, generic OHTTP relay concept for auth-request response delivery, unrelated to the notification-relay service this unit covers. Not a contradiction with `relay.md`/`relay_data_model.md` — just a same-word, different-concept usage; noting it here only so a future reviewer doesn't mistake it for a relay.md cross-reference.
- **Matrix specs** (`matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`) and **`registry_contract.md`, `ipfs_card.md`, `press.md`, `card_verifier.md`:** none reference the relay service; no findings.

## Summary

Two findings, both isolated to `specs/process_specs/notification_relay.md` failing to track corrections that were already made in `relay.md`/`relay_data_model.md` (and, in Finding 1's case, failing to stay consistent with itself). No inconsistency was found between `relay.md` and `relay_data_model.md` themselves, and no other object or process spec in scope was found to contradict the relay cluster.
