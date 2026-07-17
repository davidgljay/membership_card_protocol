# Inconsistency Review — `obj-app-sdk` (`specs/object_specs/app_sdk.md`)

Reviewed against: `wallet_sdk.md`, `client_sdk.md`, `registry_contract.md`, `ipfs_card.md`, `press.md`, `wallet.md`, `relay.md`, `relay_data_model.md`, `card_verifier.md`, `matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`, `protocol-objects.md`, `card_protocol_spec.md`, `ARCHITECTURE.md`, and all in-scope process specs.

## Summary

The `app_sdk.md` / `wallet_sdk.md` split itself is clean: capability ownership is cross-referenced consistently in both directions (offer construction vs. offer review/countersign, sub-card request vs. sub-card authorization, UUID registration vs. active-subcard-directory maintenance, etc.), and I found no case where both specs claim ownership of the same key-custody operation, nor a capability from `client_sdk.md` that fell into the gap between the two successor specs. `client_sdk.md` itself is correctly banner-marked `SUPERSEDED` and points to the two successor specs. However, I found one substantive object-spec-vs-process-spec contradiction on a transport requirement, plus several stale references to the pre-split `client-sdk` package name in *other* specs that were not updated when the split happened.

---

## Finding 1 (Substantive): `app_sdk.md`'s OQ-SDK-4 ("not Tor") contradicts `notification_relay.md`'s mandatory-Tor requirement for the exact call it implements

**Specs in conflict:** `specs/object_specs/app_sdk.md` (§4.7, §9.3, §15 OQ-SDK-4) vs. `specs/process_specs/notification_relay.md` (§Process 1 step 6, §Registration Privacy)

**The conflict:**

`app_sdk.md` §9.3 states that `registerCardUuids` "implements `notification_relay.md §Process 1` step 6: `POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` ... via `ObliviousProtocolTransport`." §4.7 describes `ObliviousProtocolTransport` as an HPKE/OHTTP (RFC 9180) relay-forwarding mechanism, explicitly "not Tor" — §15's resolved decision OQ-SDK-4 reads: "Network-level privacy for press and relay traffic: oblivious-relay (HPKE + relay forwarding), not Tor."

But `notification_relay.md` §Process 1 step 6 says, for that exact wallet-registration call:

> "This session is conducted over Tor (or another anonymizing transport) — see §Registration Privacy for why this is the expected mechanism here, not an optional upgrade."

And §Registration Privacy is even more explicit:

> "**Transport:** wallet registration sessions (§Process 1, step 6) are conducted over Tor or another anonymizing transport by default — this is the expected mechanism, not an opt-in reserved for 'users with strong privacy requirements.' ... should not treat anonymizing transport itself as optional without a concrete reason."

`process_specs/oblivious_transport.md` (the spec that defines the HPKE/OHTTP mechanism `ObliviousProtocolTransport` implements) is aware of this tension and frames its own mechanism as strictly *complementary*, not a substitute: "It is complementary to, and does not substitute for, the content/timing-level unlinkability work already specified in `notification_relay.md §Registration Privacy`... both are required where applicable" (line 15). Nothing in `app_sdk.md` mentions layering Tor (or another anonymizing transport) on top of `ObliviousProtocolTransport` for this specific call — `registerCardUuids` is described as using `ObliviousProtocolTransport` alone, and OQ-SDK-4 explicitly frames this as an alternative to Tor, not an addition to it.

**Why this matters:** As written, an app-sdk-based client that calls `registerCardUuids` per spec is not conforming to `notification_relay.md`'s explicit, non-optional transport requirement for that call. This isn't a documentation nit — `notification_relay.md`'s changelog (line 8) shows this requirement was deliberately tightened in a recent revision ("Registration Privacy is also clarified to name Tor ... as the expected mechanism ... rather than an opt-in"), while `app_sdk.md`'s OQ-SDK-4 was resolved independently (referenced by `oblivious_transport.md` as "the Tor-alternative evaluation") without reconciling the two documents.

**Recommended resolution:** This needs a design decision, not just an editorial fix, so it should go to the consolidated fix list for explicit sign-off rather than being silently resolved. Two plausible directions:
1. Update `notification_relay.md` §Process 1 step 6 / §Registration Privacy to acknowledge `ObliviousProtocolTransport` (HPKE/OHTTP via the relay) as satisfying the "anonymizing transport" requirement for this call, if that was the actual intent of OQ-SDK-4 superseding the Tor requirement — but then `oblivious_transport.md`'s "complementary, not a substitute" framing (line 15) would also need revisiting, since it currently denies that OHTTP alone is sufficient.
2. Or, if Tor is still required in addition to the oblivious-relay transport for this specific call, `app_sdk.md` §9.3 (and/or §4.7) needs to say so explicitly — right now a reader of `app_sdk.md` alone would reasonably conclude `ObliviousProtocolTransport` is the complete privacy mechanism for this call.

---

## Finding 2 (Stale reference): `process_specs/oblivious_transport.md` still names `client-sdk` as a current system component

**Specs in conflict:** `specs/process_specs/oblivious_transport.md` (line 48) vs. the `app_sdk.md`/`wallet_sdk.md` split

**The conflict:** `oblivious_transport.md` line 48 describes the system's trust boundary as: "The wallet service, press, and client SDK are all parts of the same closed, four-party system (`client-sdk`, `relay`, `wallet-service`, `press`)". This isn't framed as historical — it's asserting the *current* architecture, but `client-sdk` was split into `app-sdk` and `wallet-sdk` as of 2026-07-06 (per both split specs' headers), predating this reference. The four-party framing is now either stale (should be five parties: `app-sdk`, `wallet-sdk`, `relay`, `wallet-service`, `press`) or needs to say "client SDK" collectively without naming the retired package/directory.

**Recommended resolution:** Update `oblivious_transport.md` line 48 to refer to `app-sdk`/`wallet-sdk` (or "the client SDKs," collectively) rather than the retired `client-sdk` package name.

---

## Finding 3 (Stale reference): `object_specs/matrix_encryption.md` cites a `client-sdk` source path that no longer exists under that name

**Specs in conflict:** `specs/object_specs/matrix_encryption.md` (line 58) vs. the `app_sdk.md` split

**The conflict:** `matrix_encryption.md` line 58 states signing uses "`mlDsa44Sign`, `client-sdk/packages/client-sdk/src/crypto/mldsa.ts`". Per `app_sdk.md` §3 and §5, ML-DSA-44 signing now lives in `app-sdk`'s `crypto/` module (`@membership-card-protocol/app-sdk`), not `client-sdk/packages/client-sdk/`. This reference predates the split and was not updated.

**Recommended resolution:** Update the path reference in `matrix_encryption.md` to the app-sdk equivalent (e.g. `app-sdk/src/crypto/mldsa.ts`, or however the file is actually named there — confirm against `app-sdk/` at fix time).

---

## Finding 4 (Stale reference, lower severity): `object_specs/wallet.md` refers to "the client-sdk" talking to a press directly

**Specs in conflict:** `specs/object_specs/wallet.md` (line 44) vs. the `app_sdk.md` split

**The conflict:** `wallet.md` line 44 states: "the client-sdk talks to a press directly." Per the split, press-facing calls for offer construction/finalization and sub-card registration are an `app-sdk` capability (`app_sdk.md` §4.7, §7.3, §8). `wallet.md` was not updated to reflect the split when it was made (`wallet.md` predates or wasn't touched by the 2026-07-06 split).

**Recommended resolution:** Update `wallet.md` line 44 to say "app-sdk" (or "the client SDK") instead of "the client-sdk," matching the current package name.

---

## Non-findings (checked, no conflict found)

- **App-sdk/wallet-sdk key-custody boundary:** No overlapping ownership claims found. Offer construction/offerer-finalization (app-sdk) vs. offer review/countersigning (wallet-sdk); sub-card request construction (app-sdk) vs. sub-card validation/consent/countersign/revocation (wallet-sdk); UUID registration/deregistration/messaging (app-sdk) vs. `active_subcards` directory read (wallet-sdk §8.1) and write (wallet-sdk §6.6) — all consistently cross-referenced from both sides, and both specs agree on which package owns which function name.
- **No capability silently dropped by the split:** Every functional area listed in `client_sdk.md`'s Overview (§1) — offer creation/acceptance, backup/recovery, sub-card request/validate/consent/countersign/revoke, messaging/UUID lifecycle — maps to an explicit section in one (or, for offers/sub-cards, both) of the two successor specs. `client_sdk.md` is correctly banner-marked `SUPERSEDED` with forward pointers to both.
- **`client_sdk.md` archival framing:** Correctly presented as historical (`## ⚠️ SUPERSEDED` banner, dated, points to both successor specs); `app_sdk.md`'s own "Provenance note" correctly frames `client_sdk.md` as the origin of the split, not as a current spec to follow.
- **Press API surface used by app-sdk:** `POST /sub-card/register`, `POST /issue/finalize` (app_sdk.md §7.3, §8.2) both exist in `press.md` (§5.1–§5.4) with matching purposes.
- **`CardVerifier` interface used by app-sdk/wallet-sdk:** `verifyCard(cardAddress: string, options?)` and `verifyEnvelope(envelope)` (app_sdk.md §6, wallet_sdk.md §6.1/§7.1) match `card_verifier.md` §6.1/§6.2 exactly (same signatures, same semantics).
- **Oblivious transport endpoint shapes:** `app_sdk.md` §4.7's `POST /ohttp/{target_id}`-style description and the named server files (`relay/server/api/ohttp/[target_id].post.ts`, `press/server/api/ohttp/{key-config,gateway}.*.ts`) match `oblivious_transport.md`'s endpoint definitions (`GET /ohttp/key-config`, `POST /ohttp/{target_id}`).
- **Open-offer construction fields:** `assembleAndSignOpenOffer`'s `offerId = keccak256(canonicalize(...))`, `acknowledgeUnconstrained` requirement, and future-`expires_at` check (app_sdk.md §8.1) all match `open_offer_creation.md` §Phase 1 and `registry_contract.md`'s `offer_id` derivation exactly.
- **Message-type taxonomy scoping:** `app_sdk.md` §9.1 explicitly narrows `MessageType` to a named subset of `messaging_protocol.md`'s full taxonomy and states "every other taxonomy entry is out of scope" as a deliberate design choice (not a silent omission). One adjacent observation, not logged as a full finding: `press.md` §5.4 requires sending `subcard_sibling_added`/`_removed`/`_rotated` notifications (types 9–11 in `messaging_protocol.md`) to subcards, which are outside app-sdk's `MessageType` union — but `press.md` itself notes this delivery is currently "best-effort plaintext JSON POSTed to a per-recipient-address endpoint stub," not routed through the standard E2E messaging pipeline app-sdk owns, so there's no present contradiction, only a forward-looking gap worth another unit's attention once that delivery path is wired into the real messaging system.
