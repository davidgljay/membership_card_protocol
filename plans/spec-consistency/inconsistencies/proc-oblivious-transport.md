# Inconsistency Review — `proc-oblivious-transport` (`specs/process_specs/oblivious_transport.md`)

Reviewed against: all 11 Phase-1-fixed object specs (`registry_contract.md`, `ipfs_card.md`, `press.md`, `wallet.md`, `relay.md`, `relay_data_model.md`, `card_verifier.md`, `app_sdk.md`, `wallet_sdk.md`, `matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`, `protocol-objects.md`, `card_protocol_spec.md`, `ARCHITECTURE.md`) plus the two most directly-coupled process specs (`notification_relay.md`, `message_routing.md`).

The unit's own text (current, post-Fix-#27/Decision-B) was re-read fresh, not assumed from the prior version.

---

## Checked and confirmed consistent (no action needed)

1. **Decision B / Tor-vs-oblivious-transport for `registerCardUuids`.** `oblivious_transport.md`'s "Why the Relay, Not a New Component" section and its changelog line state that this transport's IP-level protection satisfies `notification_relay.md §Registration Privacy`'s anonymizing-transport requirement for `registerCardUuids`, and that Tor is not additionally required for that call. `notification_relay.md §Registration Privacy` ("Transport" paragraph) states the identical resolution in the identical direction, and both sides cross-reference each other correctly. No drift between the two Phase-1 edits.

2. **Press endpoint routing table.** `oblivious_transport.md §Scope`'s table of six oblivious-routed press endpoints (`/issue`, `/issue/finalize`, `/open-offer/claim`, `/update`, `/sub-card/register`, `/sub-card/deregister`) plus the three excluded public reads (`/press`, `/health`, `/app-gas/:address`) exactly matches `press.md §4`'s HTTP Endpoints table, both in path names and in which are public reads. No mismatch.

3. **Wallet-service OHTTP gateway.** `wallet.md §7.9` ("Oblivious Transport (OHTTP)") defines `GET /ohttp/key-config` and `POST /ohttp/gateway`, matching `oblivious_transport.md`'s description of the wallet-service gateway (key-config discovery + decapsulate-dispatch-encapsulate). No mismatch on the wallet-service side.

4. **Five-party system framing.** `oblivious_transport.md`'s Envelope Format section (Fix #27) describes the closed system as `app-sdk`, `wallet-sdk`, `relay`, `wallet-service`, `press`. This matches `wallet_sdk.md`/`app_sdk.md`'s own descriptions of the split-SDK architecture and `app_sdk.md §4.7`'s `ObliviousProtocolTransport` definition, which `oblivious_transport.md` and `notification_relay.md` both cite as the implementing interface. No stale `client_sdk.md` references remain in this file (the changelog confirms Fix #27 already corrected these).

---

## Inconsistencies found

### 1. Relay's oblivious-forwarding endpoint is undocumented in `relay.md`, and referenced file paths use a superseded convention

`oblivious_transport.md §Relay Target Registry` and `§Request Path` describe the relay's oblivious-forwarding endpoint as `POST /ohttp/{target_id}`, backed by a target registry at `relay/server/utils/oblivious-targets.ts`, described as "structurally independent" of the push-notification app registry at `relay/server/utils/app-registry.ts`. `app_sdk.md §4.7` corroborates with a named server-side counterpart: `relay/server/api/ohttp/[target_id].post.ts`.

However, `relay.md` (v0.9, the current Phase-1-fixed object spec) — and its companion `relay_data_model.md` (v0.9) — describe **no such endpoint at all**. `relay.md §7`'s complete endpoint list is `POST /register`, `POST /deliver/{uuid}`, `GET /ws/{uuid}`, `GET /sse`, `GET /pending`, `POST /ack`, `GET /health`, and the deprecated `POST /notify/{uuid}` — nothing under `/ohttp`. Both files also use `relay/src/...` file paths throughout (e.g. `relay/src/routes/ws.ts`, `relay/src/routes/deliver.ts`, `relay/src/utils/apps.ts`'s `loadAppRegistry`, `relay/src/utils/storage/redis.ts`), not `relay/server/...`.

This isn't a coincidental naming drift — `relay.md`'s own changelog explains why: v0.9 is an explicit **reversion away from a serverless (Nitro/Cloudflare-Workers-style) architecture back to a plain Node.js/Express Docker app**, and the `server/api/...` route-file convention (visible in `oblivious_transport.md`'s and `app_sdk.md`'s paths) is exactly the Nitro-style convention that reversion moved away from. The relay object spec that is supposed to be authoritative post-Phase-1 doesn't reflect this: it neither documents the oblivious-forwarding endpoint under any name, nor uses a path convention consistent with its own v0.9 architecture.

**Recommendation:** Add `POST /ohttp/{target_id}` (or whatever the actual current route is) to `relay.md §7`'s endpoint table and `relay_data_model.md`'s config section, using the `relay/src/...` convention consistent with the rest of both documents. Correct `oblivious_transport.md`'s and `app_sdk.md §4.7`'s file-path references (`relay/server/utils/oblivious-targets.ts`, `relay/server/utils/app-registry.ts`, `relay/server/api/ohttp/[target_id].post.ts`) to match. If the endpoint genuinely doesn't exist yet in the relay's real implementation, this is a spec gap, not just a naming slip — flag it as such rather than silently renaming paths.

### 2. Press's OHTTP gateway endpoints are undocumented in `press.md`

`oblivious_transport.md §Key Configuration Discovery` states every destination — including a press — publishes `GET /ohttp/key-config`, and that the press "runs an equivalent OHTTP gateway dispatching to its existing handler functions." `app_sdk.md §4.7` names the implemented server-side counterpart: `press/server/api/ohttp/{key-config,gateway}.*.ts`.

`press.md §4`'s HTTP Endpoints table — otherwise a complete and exactly-matching list of the six oblivious-routed endpoints plus the three excluded public reads (see Confirmed-consistent item 2 above) — has no entry for `GET /ohttp/key-config` or an OHTTP gateway/dispatch endpoint. Unlike the relay case, the `server/api/...` path convention `app_sdk.md` cites is plausible for press (press.md §3.1 confirms press is itself a Nitro serverless app, so `server/api/` is press's actual route convention, not a superseded one) — so this looks like a pure documentation gap in `press.md`, not a path-convention mismatch.

**Recommendation:** Add `GET /ohttp/key-config` and the gateway/dispatch endpoint to `press.md §4`'s HTTP Endpoints table, consistent with the Nitro `server/api/` convention press.md already uses elsewhere.

---

## Minor issues (lower confidence / clarity, not hard contradictions)

### 3. `oblivious_transport.md`'s wallet-service scope list double-counts one endpoint pair under two names

`oblivious_transport.md §Overview` lists six wallet-service-facing categories: "account creation, `service_secret` retrieval, keyring reads/writes, backup registration and recovery, sub-card registration/deregistration, UUID pool registration/deregistration." Per `wallet.md §7.7` (confirmed via direct read), "sub-card registration/deregistration" and "UUID pool registration/deregistration" are **the same pair of endpoints** at the wallet-service layer (`POST /cards/{card_hash}/subcards/{subcard_hash}/uuids` and `DELETE /cards/{card_hash}/subcards/{subcard_hash}`) — there is no separate wallet-service-side "sub-card registration" endpoint distinct from UUID pool registration. Genuine on-chain sub-card registration/deregistration is a **press**-side operation (`/sub-card/register`, `/sub-card/deregister`), already correctly and separately listed in the same document's press-facing table.

This reads as if there are six distinct wallet-service endpoint categories when `wallet.md` only defines five. Not a factual error about what's oblivious-routed (both endpoints are, correctly, in scope), just imprecise phrasing that could mislead a reader into looking for a nonexistent sixth wallet-service endpoint pair.

**Recommendation:** Reword the Overview bullet list to either merge these into one item or explicitly note that "sub-card registration/deregistration" here refers to the wallet-service's local UUID-pool bookkeeping (per `notification_relay.md`'s own careful distinction between this and on-chain sub-card revocation), not a separate endpoint.

### 4. `Content-Type: message/ohttp-req` header used despite explicitly rejecting RFC 9458 Binary HTTP encoding

`oblivious_transport.md §Envelope Format` explicitly and deliberately rejects RFC 9458 Binary HTTP message encoding in favor of a custom lightweight JSON-in-HPKE envelope, with a stated rationale (closed five-party system, no third-party OHTTP interop need). But `§Request Path`'s wire format then sends `Content-Type: message/ohttp-req` — the IANA-registered media type RFC 9458 defines specifically for encapsulated **Binary HTTP** requests. Labeling a non-Binary-HTTP JSON payload with the RFC 9458 media type is an internal inconsistency: generic OHTTP-aware tooling (or a future engineer skimming the header) would reasonably assume RFC 9458 conformance that the spec has explicitly disclaimed two sections earlier.

**Recommendation:** Use a custom content-type (e.g. `application/x-card-protocol-ohttp+hpke`) instead of the RFC-9458-reserved `message/ohttp-req`, or add an explicit note that the media type is being reused non-conformantly and why that's safe within this closed system.

### 5. Not a conflict, but worth a cross-reference note: a second, unrelated OHTTP usage exists elsewhere

`card_protocol_spec.md` (§Authentication, the CHAPI-based site-authentication flow, lines ~1307–1337) also specifies "OHTTP (Oblivious HTTP, RFC 9458)" as an optional transport — but for wallet-to-**requesting-site** delivery of signed authentication statements, an entirely different actor pair from `oblivious_transport.md`'s device-to-wallet-service/press scope. Because requesting sites are arbitrary external parties (not part of the closed five-party system), true RFC 9458 conformance is appropriate there and this is **not** a contradiction with `oblivious_transport.md`'s closed-system rationale for using a lighter envelope. Flagging only so a future reader doesn't conflate the two OHTTP usages or assume they share one implementation — `oblivious_transport.md`'s Related Specs section does not currently cross-reference `card_protocol_spec.md`'s usage, and might benefit from a one-line disambiguating note.

---

## Summary

- 4 items checked and confirmed consistent.
- 2 substantive inconsistencies (both are documentation gaps in Phase-1-"fixed" object specs — `relay.md` and `press.md` — that don't reflect endpoints `oblivious_transport.md` and `app_sdk.md` assume exist; the relay case additionally has a stale, pre-reversion file-path convention).
- 3 minor/lower-confidence clarity issues (redundant category phrasing, a mismatched media-type label, and a disambiguation note for a same-named-but-unrelated OHTTP usage elsewhere).

Total: 5 findings logged. Below the 15-item pause threshold.
