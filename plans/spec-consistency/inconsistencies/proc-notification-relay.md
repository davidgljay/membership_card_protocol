# Inconsistency Log — `proc-notification-relay` (`specs/process_specs/notification_relay.md`)

Reviewed against: `specs/object_specs/relay.md`, `specs/object_specs/relay_data_model.md`,
`specs/process_specs/oblivious_transport.md`, `specs/object_specs/app_sdk.md`,
`specs/process_specs/message_routing.md`, `specs/process_specs/subcard_creation_policy.md`,
`specs/subcards.md`, `specs/process_specs/wallet_backup_and_recovery.md`,
`specs/object_specs/registry_contract.md`, `specs/messaging_protocol.md`.

## Confirmation of the three Phase 1 edits named in the assignment

- **Fix #16 (`wallet_ws_url` → `wallet_base_url`):** Verified. No occurrence of `wallet_ws_url`, `ws://`, or `wss://` (aside from the legitimate `wss://relay.example/ws/{uuid}` chat-session URL in §Process 3, which is a different thing — the WebSocket upgrade URL, not the wallet's field) remains anywhere in the file. `wallet_base_url` is used consistently in Process 1 step 3/4, Process 6, and the Failure Handling table, and matches `relay.md` §5/§6.1 and `relay_data_model.md` §2.2/§6.1 exactly (an `https://`-only base URL used solely for staggered `DELETE {wallet_base_url}/messages/{uuid}` calls). **Consistent.**
- **Fix #17 (`push_token` → `device_credential` for message-store/connection-map keying):** Verified against `relay_data_model.md` §3.1/§3.4/§8.4 and `relay.md` §6.1/§7.2 step 5. The Privacy Properties table (line 50) and Process 2 step 2c both now say the message store and delivery lookups are keyed by `device_credential`, matching the object specs' explicit isolation guarantee. **Consistent** — but see Finding 2 below for a related, narrower scope problem in a different section of the same file.
- **Decision B (`ObliviousProtocolTransport` alone satisfies the anonymizing-transport requirement for `registerCardUuids`, no additional Tor requirement):** Verified against `oblivious_transport.md` (which states the same thing almost verbatim, cross-referencing back to `notification_relay.md §Process 1` step 6 / §Registration Privacy) and `app_sdk.md` §4.7 (`ObliviousProtocolTransport`, used by `registerCardUuids` per app_sdk.md §9.3). All three documents agree. **Consistent** — this is a solid three-way agreement, no gaps found.

## New findings

### Finding 1 (high confidence) — Stale cross-references to "Process 5" that should say "Process 6"

**Where:** `notification_relay.md` line 200 (Process 2, step 3), line 205 (Process 2, step 2's SSE sub-bullet), and line 301 (Process 4, step 7).

**What:** All three lines refer to staggered wallet clearance as `(Process 5)`:
- Line 200: `"...until it receives DELETE /messages/{uuid} from the relay (staggered clearance, Process 5)."`
- Line 205: `"...schedule a staggered delete to the wallet (Process 5)..."`
- Line 301: `"...schedule a staggered delete to the wallet service for each acknowledged UUID (Process 5)..."`

But the section actually titled "Staggered Wallet Clearance" is **Process 6** (line 342), not Process 5 — Process 5 is "Device Catch-up via `GET /pending`" (line 314). Tellingly, Process 5's own step 5 (line 336) correctly says `"...schedule a staggered delete to the wallet service for each acknowledged UUID (Process 6)."` — i.e. one of the four cross-references in the document is right and three are wrong.

**Likely cause:** This reads as a renumbering artifact — Process 4 (Device-Level SSE) was probably inserted after an earlier version where staggered clearance was Process 5, shifting it to Process 6, and three of the four back-references were never updated.

**Recommended resolution:** Change `(Process 5)` to `(Process 6)` at lines 200, 205, and 301. Leave line 336 as-is (already correct).

### Finding 2 (high confidence) — "UUID Pools and Device Credential" section understates which endpoints the credential authenticates

**Where:** `notification_relay.md` §"UUID Pools and Device Credential" (line 66): *"The device uses this credential to authenticate `GET /sse` and `GET /pending` requests."*

**What:** This lists only two endpoints. But:
- `relay.md` §6.1 ("What it protects") explicitly lists **three**: `GET /sse`, `GET /pending`, **and `POST /ack`**.
- `notification_relay.md`'s own Process 4 step 6 and Process 5 step 4 both show `POST /ack` requests carrying `Authorization: Bearer {device_credential}`.

So the overview sentence in §"UUID Pools and Device Credential" is inconsistent with both the authoritative object spec (`relay.md`) and this same document's own process steps a few sections later.

**Recommended resolution:** Expand the sentence at line 66 to `"...to authenticate GET /sse, GET /pending, and POST /ack requests."`

### Finding 3 (high confidence, security-relevant) — Failure Handling table's "push token rotated" row contradicts the credential-lifecycle model in `relay.md`/`relay_data_model.md`

**Where:** `notification_relay.md` §Failure Handling (line 400): *"Push token rotated by platform | Device re-registers with relay using new token; relay issues new device credential; device issues fresh UUIDs to all wallet services"*

**What:** This says push-token rotation causes the relay to issue a **new** device credential. That contradicts the object specs' explicit credential-lifecycle model:
- `relay.md` §6.3 (Credential Lifecycle table): *"Replenishment `POST /register` (with auth) | Existing credential TTL refreshed; push_token updated if rotated"* — the existing credential is **kept**, only the `push_token` field is updated.
- `relay_data_model.md` §8.3: *"Replenishment: `POST /register` with `Authorization: Bearer {device_credential}`. The relay validates the credential exists and is not expired, issues new UUIDs under the same credential (updating the `push_token` if it has rotated), and refreshes the credential TTL."*

Both object specs are explicit and consistent with each other that a rotated push token is handled by the *existing* credential's replenishment path — the device still holds and presents its credential (rotation is a platform push-token event, unrelated to the device losing its credential), and the relay updates `push_token` in place rather than minting a new credential. `notification_relay.md`'s Failure Handling row describes a different, more disruptive mechanism (new credential issuance, implying something closer to a full re-bootstrap) that isn't what either object spec describes.

This is more than a wording nit: a reader implementing against `notification_relay.md`'s Failure Handling table alone would build the wrong recovery flow (treating push-token rotation as credential-invalidating, when it isn't).

**Recommended resolution:** Correct the row to something like: *"Push token rotated by platform | Device calls `POST /register` (replenishment, with its existing device credential) supplying the new push token; relay updates the stored `push_token` under the same credential (§relay.md §6.3); no new credential is issued and existing UUIDs remain valid."* — and drop or qualify the "device issues fresh UUIDs to all wallet services" clause, since nothing about a push-token rotation on its own invalidates already-registered UUIDs at wallet services (they remain valid until consumed/expired regardless of the device's push token).

### Finding 4 (medium confidence) — Gap: `wallet_backup_and_recovery.md`'s post-recovery flow never mentions UUID pool (re-)registration

**Where:** `specs/process_specs/wallet_backup_and_recovery.md` §Process 3 "Post-Recovery Re-registration" (steps 10–13).

**What:** After wallet recovery, this process describes: registering with a new primary service (step 10), registering new device sub-cards on-chain (step 11), revoking compromised sub-cards (step 12), and updating backup registrations (step 13). It never mentions the device performing `notification_relay.md §Process 1` (UUID Registration) for the newly-created device sub-card(s). Without that step, a device that completes Process 3 in full would have a validly-registered, on-chain-active sub-card but no UUID pool at any wallet service, and would not receive messages until it separately, and not-explicitly-directed, runs UUID registration.

This may be an intentional omission (perhaps considered "obvious" or covered implicitly by "the app resumes normal operation"), but per the assignment's instruction that a lifecycle gap is itself a finding, it's worth flagging: nothing in `wallet_backup_and_recovery.md` cross-references `notification_relay.md`'s registration flow for the recovery case specifically, even though step 11's "new device sub-card" is exactly the kind of subcard that needs a fresh UUID pool per `notification_relay.md`'s model (a subcard with no UUID pool at a wallet service simply won't receive messages — see `notification_relay.md`'s own Failure Handling table, "UUID pool exhausted" row, for the general version of this state).

**Recommended resolution:** Either (a) add a step to `wallet_backup_and_recovery.md` Process 3 explicitly directing the device to run `notification_relay.md §Process 1` for each newly-registered device sub-card, or (b) if this is considered implicit/out-of-scope for that spec, add a one-line note there cross-referencing `notification_relay.md §Process 1` so the omission is clearly intentional rather than silent.

### Finding 5 (low confidence, one-sided claim) — `relay.md`'s "Relationship to Existing Specs" table overstates what `wallet_backup_and_recovery.md` covers

**Where:** `relay.md` §2 (Relationship to Existing Specs table): *"`specs/process_specs/wallet_backup_and_recovery.md` | Device registration and key management; UUID pool replenishment lifecycle."*

**What:** `wallet_backup_and_recovery.md` (321 lines, reviewed in full) covers keyring storage/replication, initial wallet setup, passkey/YubiKey recovery, and post-recovery re-registration of sub-cards and backups — but contains no mention of UUID pools, `push_token`, `device_credential`, or relay registration/replenishment anywhere in the document (confirmed by grep — zero matches). The "UUID pool replenishment lifecycle" clause in `relay.md`'s relationship table doesn't describe content that's actually in `wallet_backup_and_recovery.md`; that lifecycle is specified in `notification_relay.md` itself (§Replenishment) and `app_sdk.md` §9.4, not in the backup/recovery spec.

This is a one-sided claim in a spec outside my primary unit (`relay.md`, a Phase 1 object spec), surfaced here because it directly concerns the notification/UUID domain this unit owns, and it compounds Finding 4 above — `relay.md` credits `wallet_backup_and_recovery.md` with lifecycle coverage that doesn't exist there, which may be why the gap in Finding 4 wasn't caught earlier.

**Recommended resolution:** Since `relay.md` is a Phase 1 (already-fixed) object spec, this may need routing to whoever owns `obj-relay` reconciliation rather than being fixed as part of this process-spec unit — flagging here for the Phase 2 consolidation step to route appropriately. Suggested fix: either remove the "UUID pool replenishment lifecycle" clause from `relay.md`'s relationship-table row for `wallet_backup_and_recovery.md`, or (better, paired with Finding 4's fix) make it true by adding the missing cross-reference to `wallet_backup_and_recovery.md`.

## Areas checked with no inconsistency found

- `relay.md`/`relay_data_model.md` UUID state machine (`unused`/`in_flight`/`active`/`consumed`) vs. `notification_relay.md`'s implicit references to UUID states (delivery consumption, WebSocket `active`) — consistent.
- `message_routing.md`'s relay-delivery failure/retry behavior ("advance to next UUID in pool," bounded 5 attempts per delivery pass) vs. `notification_relay.md`'s Failure Handling table row for "Relay unreachable for `POST /deliver/{uuid}`" — consistent (this was the subject of the file's own "Changes from v0.4" note, and it checks out against `message_routing.md §Relay Delivery and Multi-Device Fan-out`).
- Deregistration endpoint verification steps (§Multi-Device Support "Deregistration") vs. `subcards.md §Step 5`'s `sub_card_doc_cid` → IPFS → `SubCardDocument.recipient_pubkey` resolution path — the section reference and mechanism both check out; `subcards.md` does have a "Step 5" section titled "Press Validates the App Card Chain and Registers On-Chain" that matches.
- The claim that registration/deregistration eligibility never consults `SubCardEntry.active` (on-chain revocation is a distinct mechanism) vs. `subcard_creation_policy.md`'s 8xx/9xx revocation model and `registry_contract.md`'s `SubCardRegistrations[addr].active` field — consistent; the two mechanisms (wallet-service-local deregistration vs. on-chain revocation) are cleanly distinguished in both directions, and no other spec claims the wallet service should gate on the on-chain flag.
- Multi-subcard fan-out / per-subcard independent encryption (no wallet-side re-encryption, no UMBRAL) — consistent across `notification_relay.md`, `message_routing.md`, and `app_sdk.md` §9.1.
- Registration Privacy's per-card session separation and content-vs-transport-anonymity distinction — consistent with `oblivious_transport.md`'s own framing (which explicitly says it "remains complementary to, and does not substitute for" the content/timing-level protections `notification_relay.md` specifies).
