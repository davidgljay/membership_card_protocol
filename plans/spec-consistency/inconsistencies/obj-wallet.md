# Inconsistency Review: `obj-wallet` (`specs/object_specs/wallet.md`)

**Reviewer pass:** Step A, Phase 1 (object specs). Read `wallet.md` in full, then every other in-scope object spec and every in-scope process spec (see task scope), checking for contradictions, stale cross-references, and one-sided claims (a spec assumes an endpoint/behavior on the wallet service that `wallet.md` doesn't define, or vice versa).

`wallet.md`'s own status line explicitly frames it as "describes the wallet service as implemented," so — per the strategic plan's flag — drift here is treated as an active risk, not a hypothetical one. Several of the findings below are exactly that kind of drift: other specs describe wallet-service behavior/endpoints that `wallet.md` simply doesn't mention, most likely because `wallet.md` (dated 2026-07-04) predates later work (the Matrix integration, per the repo's git history: "Implement Matrix Phase 3... Phase 4," "Implement Matrix Phase 5," both landed after this spec's date).

---

## 1. [HIGH] `wallet.md` documents no Matrix-related endpoints, config, or data-model rows, though other in-scope specs describe them as already implemented on the wallet service

**Conflicting specs:** `specs/object_specs/wallet.md` (§5 Data Model, §7 Endpoints, §2 Relationship to Existing Specs) vs. `specs/object_specs/matrix_room.md`, `specs/process_specs/room_discovery.md`, `specs/object_specs/matrix_synapse_module.md`.

- `matrix_room.md` §"Room Creation: `POST /matrix/rooms`": *"New `wallet-service` endpoint (implemented in Phase 4, Step 16). Requires an authenticated card holder (existing session-token auth, per `wallet-service/src/auth/session-token.ts`)."*
- `room_discovery.md` documents two more wallet-service endpoints as already implemented: `GET https://<wallet-service-public-host>/matrix/room-index` ("Written by `wallet-service`'s `POST /matrix/rooms` handler... appends an entry at room-creation time") and `POST /matrix/discover-rooms` ("authenticated via existing session-token auth, same as other wallet-service endpoints").
- `matrix_synapse_module.md` references a `matrix_credentials` table inside wallet-service ("an audit-trail copy is *separately* kept in wallet-service's `matrix_credentials` table via the normal secrets abstraction") and a `wallet-service/scripts/generate-matrix-secrets.ts` script.

`wallet.md`'s §7 Endpoints table of contents lists only: Health, Account Creation and Login, Keyring and Service Secret, Backup Registration and Recovery, Federation and Routing, Message Routing, Sub-card and UUID Lifecycle, Admin, Oblivious Transport. No `/matrix/*` endpoint appears anywhere. §5 Data Model lists `holder_accounts`, `keyring_blobs`, `backup_registrations`, `recovery_windows`, `message_queue`, `uuid_pools`, `routing_table`, `routing_nonces`, `kv_store`, `auth_challenges`, `notification_jobs`, `subcard_action_nonces` — no `matrix_credentials` table. §2's Relationship table does not cite `matrix_room.md`, `matrix_synapse_module.md`, `matrix_encryption.md`, `room_discovery.md`, or `matrix_join_attestation_and_revocation.md` at all.

**Why this matters:** `wallet.md` claims to be sourced from "`wallet-service/server/` or `wallet-service/src/` as of the review underlying `plans/wallet-service/spec-phase1-*.md`" — i.e., it describes the pre-Matrix build phases only. The Matrix work (Phases 3–5 per the repo's commit history) added real, already-implemented endpoints and storage to the same service `wallet.md` claims to fully describe, but `wallet.md` was never updated to reflect this.

**Recommended resolution:** Add a §7.x "Matrix" endpoints subsection (`POST /matrix/rooms`, `GET /matrix/room-index`, `POST /matrix/discover-rooms`) and a `matrix_credentials` row to §5, plus Relationship-table entries for the five Matrix specs — or, if this is judged out of scope for `wallet.md` deliberately, add an explicit scope note ("Matrix endpoints are out of scope for this document; see `matrix_synapse_module.md`") so readers aren't left inferring a gap is an oversight.

---

## 2. [MEDIUM] No wallet-service endpoint is documented for open-offer hosting/claim-link serving, inbound targeted-offer delivery, or SCIP/audit-record delivery — though three process specs assume these exist

**Conflicting specs:** `wallet.md` (§1 Overview, §7 Endpoints) vs. `specs/process_specs/card_offering_and_acceptance.md`, `specs/process_specs/open_offer_creation.md`, `specs/process_specs/open_offer_acceptance_new_wallet.md`.

- `open_offer_creation.md` Steps 7–9: *"The issuer submits the signed `OpenCardOffer` document to a wallet service via HTTPS POST"* ... *"The wallet service stores the offer and generates a claim link"* including a *"Hosted form: a wallet-service URL that serves the offer JSON on demand."*
- `open_offer_acceptance_new_wallet.md` Step 1: *"The recipient follows the claim link — a URL hosted by the wallet service (e.g., `https://<wallet-service>/claim/<offer-id>`)."*
- `card_offering_and_acceptance.md` Step 10: *"the issuer's wallet service POSTs the signed offer directly to the recipient's wallet service endpoint."* Steps 23–24: the press sends the SCIP/confirmation and the audit record "via HTTPS to their wallet service endpoint."

`wallet.md`'s §7 Endpoints has no offer-storage, claim-link-serving, inbound-offer-receiving, or SCIP/audit-receiving endpoint. §1's "What this service does not do" list disclaims only "card offer construction" and "press communication" — it says nothing about offer *hosting/serving* or *receiving* deliveries from a press or peer wallet service, so it's genuinely ambiguous whether this functionality belongs to the object `wallet.md` describes at all, or to some other undocumented component.

**Recommended resolution:** Either add these endpoints to `wallet.md` (offer storage/hosting, claim-link serving, inbound offer/SCIP/audit-notification receipt) if they are in fact implemented there, or add an explicit line to `wallet.md` §1 stating which component actually hosts offers and receives these HTTPS deliveries, so the three process specs above can cite the correct source of truth.

---

## 3. [MEDIUM] `card_migration.md`'s "old wallet service" behavior (message forwarding, local-store removal) is not confirmed or described anywhere in `wallet.md`

**Conflicting specs:** `specs/process_specs/card_migration.md` §6 vs. `wallet.md` §2 Relationship table.

`card_migration.md` §6 "Old wallet service behavior on receiving the announcement" states:
> "It forwards any queued, undelivered messages for that card to the new wallet service by re-posting each routing envelope to the new wallet service's endpoint... It removes the card from its local store."

`wallet.md`'s §2 Relationship-table row for `card_migration.md` says only: *"this service implements the routing-table side (`POST /bindings/announce`, `410 Gone` handling) but not client-side migration initiation."* This describes the *new* wallet service's role but is silent on whether the *old* wallet service's message-forwarding and local-store-removal behavior is implemented. No corresponding logic appears anywhere in `wallet.md` §7 (Federation and Routing, or Message Routing).

**Recommended resolution:** Add an explicit statement to `wallet.md` (§2 relationship row or §7.5/§7.6) confirming whether outbound message-forwarding-on-migration and local-card-removal are implemented; if not, log as a new Open Question (parallel to OQ-WALLET-1–5) rather than leaving it a silent gap.

---

## 4. [MEDIUM] Card migration's client-side initiation has no implementing object spec

**Conflicting specs:** `specs/process_specs/card_migration.md` §Protocol Steps 1–3 vs. `specs/object_specs/wallet_sdk.md` and `specs/object_specs/app_sdk.md`.

`card_migration.md` describes a cardholder-initiated flow: the cardholder authenticates to the new wallet service via a signed challenge, and both the new wallet service and cardholder dual-sign the migration announcement (Steps 1–3). `wallet.md` explicitly excludes "client-side migration initiation" from its own scope (§2). Confirmed by grep, neither `wallet_sdk.md` nor `app_sdk.md` mentions "migrat" anywhere — `card_migration.md` is absent from both SDKs' "Related Specs" sections and Implementation Status tables. This leaves the entire cardholder-side half of card migration (the dual-signature construction, the new-wallet-service challenge/response) without any object spec in scope claiming to implement it.

**Recommended resolution:** Either add `card_migration.md` to `wallet_sdk.md`'s Related Specs / Implementation Status (if the wallet SDK is meant to drive migration, analogous to how it drives recovery), or add a note to `card_migration.md` itself flagging that client-side implementation ownership is unassigned.

---

## 5. [LOW] `wallet_backup_and_recovery.md`'s "revoke old backup registrations" step has no corresponding endpoint in `wallet.md` — already self-flagged by `wallet.md`, but worth carrying into the fix list

**Conflicting specs:** `specs/process_specs/wallet_backup_and_recovery.md` Process 3, Step 13 vs. `wallet.md` §7.4 and OQ-WALLET-2.

`wallet_backup_and_recovery.md` Process 3 Step 13: *"Revoke the old backup registrations at the backup service."* `wallet.md` §7.4 (Backup Registration and Recovery) defines only `POST /accounts/{card_hash}/backups` and `GET /accounts/{card_hash}/backups/{backup_id}` — no revoke/delete endpoint. `wallet.md`'s own **OQ-WALLET-2** already documents this as a known, unimplemented gap ("this is not implemented... Not a currently-exploitable gap, but a real divergence from the spec worth closing").

This is not a hidden drift — `wallet.md` already surfaces it as an Open Question — but it is a live, currently-true inconsistency between the two specs' authoritative claims and should be included in the Phase 1 consolidated fix list rather than silently dropped for being "already known."

**Recommended resolution:** Either implement a backup-registration-revoke endpoint and update `wallet.md`, or soften `wallet_backup_and_recovery.md` Process 3 Step 13's wording to match the weaker guarantee actually provided today (old `keyring_id` deleted federation-wide, but the backup registration record and its notification channels remain live and queryable).

---

## 6. [LOW / informational] Minor naming variance: `SecretsBackend` vs. `SecretsService`

`wallet.md` §7.1 (`GET /health`) refers to the configured `SecretsBackend`. `matrix_synapse_module.md` refers to wallet-service's `SecretsService.decryptSecret`. These may be the same underlying component referenced under two different names in two different specs, or two genuinely distinct things — I could not confirm from the specs alone (would require reading `wallet-service/src/config.ts` / the secrets module directly, which is out of scope for a spec-only review). Flagging for awareness; low confidence, likely benign, but worth a one-line clarification in whichever spec is wrong if the reviewer confirms they're meant to be the same thing.

---

## Checks that passed (no inconsistency found)

- **`client_sdk.md` staleness:** `wallet.md` does not cite `client_sdk.md` anywhere — no stale reference to clean up.
- **Message routing wire format:** `wallet.md` §7.6's `POST /messages` request shape (`{ to, subcard_hash, payload }`), `410 Gone` handling, and relay delivery (`POST /deliver/{uuid}`, `DELETE /messages/{uuid}`) all match `message_routing.md`, `notification_relay.md`, `relay.md`, and `relay_data_model.md` exactly, including the `subcard_hash`-keyed UUID pool model and the "never clear on relay-delivery-response alone" invariant.
- **Sub-card UUID registration/deregistration wire format:** `wallet.md` §7.7's signed-envelope shapes and the "never checks `SubCardEntry.active`" rule match `notification_relay.md` and `subcard_creation_policy.md` verbatim, including the rationale (local deregistration vs. on-chain revocation are independent).
- **Keyring storage model:** `wallet.md`'s `keyring_blobs` table, `keyring_id = keccak256(encrypted_blob)`, and federation-replication/delete-on-rotation behavior match `wallet_backup_and_recovery.md` and `ARCHITECTURE.md` ADR-009-AMEND exactly.
- **Recovery flow:** `wallet.md` §7.4's `POST /accounts/{card_hash}/recovery`, `POST /recovery/{recovery_id}/cancel`, and `GET /recovery/{recovery_id}/release` (including the "no `service_secret` released here" detail) match `wallet_backup_and_recovery.md` Processes 2a/2b precisely.
- **`SubCardEntry` on-chain shape:** `registry_contract.md`'s `SubCardEntry.active` field name matches every reference to it across `wallet.md`, `notification_relay.md`, and `subcard_creation_policy.md`.
- **Open-offer acceptance flows:** `open_offer_acceptance_new_wallet.md` and `open_offer_acceptance_existing_wallet.md`'s references to `wallet.md`'s account-creation, keyring-update, and WebAuthn-login endpoints (§7.2, §7.3, §6.3) are all consistent with how those endpoints are actually defined in `wallet.md`.
