# Oblivious Transport — Process Spec

**Version:** 0.1 (draft)
**Date:** 2026-07-04
**Status:** Draft

**Changelog (spec-consistency Phase 2):** Fix #6 — corrected the `relay/server/...` Nitro-style file-path citations in §Relay Target Registry to the actual `relay/src/...` convention (`relay.md`'s v0.9 changelog abandoned the Nitro-style layout); `app_sdk.md §4.7` still needs the same path correction in a future pass, since it wasn't in scope for this edit. Fix #8 — merged §Overview's "sub-card registration/deregistration" and "UUID pool registration/deregistration" wallet-service categories into one, per `wallet.md §7.7` (same endpoint pair). Fix #9 — changed §Request Path's wire format from `Content-Type: message/ohttp-req` (the RFC 9458 Binary HTTP media type, which conflicted with this document's own rejection of RFC 9458 encoding) to a custom `application/x-card-protocol-ohttp+hpke` type. Fix #10 — added a disambiguation note to §Related Specs distinguishing this document's OHTTP usage from `card_protocol_spec.md`'s unrelated wallet↔requesting-site CHAPI usage. See `plans/spec-consistency/inconsistencies/phase-2-consolidated-fixes.md`.

---

## Overview

Every sensitive call a device makes — to its wallet service or directly to a press — currently reaches its destination as a direct HTTPS connection. That means the destination operator sees the device's IP address on every such call, regardless of how well the *content* of the call is protected by end-to-end encryption elsewhere in the protocol. For a wallet service, that's account creation, `service_secret` retrieval, keyring reads/writes, backup registration and recovery, and sub-card registration/deregistration (per `wallet.md §7.7`, the same endpoint pair also performs the wallet service's local UUID-pool bookkeeping — this is not a separate endpoint category). For a press, it's claim submission, offer finalization, update/revocation intents, and sub-card registration/deregistration submission — traffic the wallet service does not proxy on the device's behalf (`plans/wallet-service/strategic-plan.md`'s "What this service explicitly does NOT do" leaves press communication to the device directly).

This spec defines a single mechanism that removes that IP exposure for both destination kinds: the device HPKE-encrypts each request to the destination's published key configuration, and sends the opaque, encrypted blob through the relay as a stateless oblivious forwarder. The relay cannot decrypt the request; the destination sees only the relay's IP as the connecting peer. This is the protocol's existing OHTTP precedent (`ARCHITECTURE.md` ADR-007, `message_routing.md §Transport Extensibility`, `transport_flags 0x02`) applied to device-to-wallet-service and device-to-press traffic, rather than only to wallet-to-wallet message routing.

This mechanism addresses **IP-level correlation** only. For `registerCardUuids` specifically, this IP-level protection is what satisfies `notification_relay.md §Registration Privacy`'s anonymizing-transport requirement — Tor or another network-level anonymizer is not additionally required for that call (see `notification_relay.md §Process 1` step 6 / §Registration Privacy "Transport"). It remains complementary to, and does not substitute for, the separate **content/timing-level unlinkability** work also specified in `notification_relay.md §Registration Privacy` (per-card session separation, staggered timing) — a device that routes every request through the oblivious path but still batches two cards' UUID registrations into one signed envelope has not achieved unlinkability; those two protections address different halves of the same problem and both are still required where applicable.

---

## Actors

| Actor | Role |
|---|---|
| **Device** | Runs the client SDK's `ObliviousProtocolTransport`; HPKE-encapsulates requests, sends them to the relay, decapsulates responses |
| **Relay** | Stateless oblivious forwarder; holds no HPKE key material for either destination; maps an opaque `target_id` to a destination's gateway URL and forwards the still-encrypted blob |
| **Wallet service** | One of two destination kinds; runs an OHTTP gateway that decapsulates, dispatches in-process to its existing route handlers, and encapsulates the response |
| **Press** | The other destination kind; runs an equivalent OHTTP gateway dispatching to its existing handler functions |

---

## Why the Relay, Not a New Component

The relay already sits between devices and the rest of the system for message delivery (`notification_relay.md`), and its trust model already assumes it holds no card-identifying information — it forwards opaque blobs and cannot read them (`notification_relay.md §Relay Service Trust Model`). Extending it to forward a second kind of opaque blob (an HPKE-encapsulated HTTP-shaped request, rather than an encrypted message payload) reuses infrastructure and an operational trust boundary this system already has, instead of introducing a new intermediary with its own deployment and trust story. The relay's role here is stateless pass-through: it does not need to know what a device is asking a wallet service or press to do, only which gateway URL to forward the encrypted bytes to.

---

## Envelope Format

**Decision (Clarification Checkpoint CP-0, resolved):** requests are wrapped in a **lightweight, protocol-specific HPKE envelope**, not strict RFC 9458 Binary HTTP encoding. Concretely, the plaintext sealed by HPKE is a JSON object:

```json
{
  "path":   "<the destination route path, e.g. /accounts/challenge>",
  "method": "<HTTP method, e.g. POST>",
  "body":   "<the request body the plaintext route would normally receive>"
}
```

This is deliberately simpler than full RFC 9458 Binary HTTP message encoding. The wallet service, press, and client SDKs are all parts of the same closed, five-party system (`app-sdk`, `wallet-sdk`, `relay`, `wallet-service`, `press`) with no external interoperability requirement — there is no third-party OHTTP relay or gateway this protocol needs to speak Binary HTTP to. Taking on a Binary HTTP codec dependency would buy interop this system doesn't use, at the cost of implementation complexity neither destination gateway needs. This is an explicit, accepted non-interop trade-off: if a future need arises to interoperate with a third-party or public OHTTP relay/gateway, this wire format would need to be revisited at that time.

**Changelog (spec-consistency Phase 1):** Fix #27 — updated the retired `client-sdk` name to the current `app-sdk`/`wallet-sdk` split (five-party system, not four). Decision B — §"IP-level correlation" scope note revised to state that this transport's IP-level protection satisfies `notification_relay.md`'s anonymizing-transport requirement for `registerCardUuids`; Tor is not additionally required for that call. See `plans/spec-consistency/inconsistencies/phase-1-consolidated-fixes.md`.

The response is sealed back through the same HPKE context established during request decapsulation — encapsulation and decapsulation of a given request/response pair share one HPKE context, not two independent operations.

Both destination kinds (wallet service, press) use this identical envelope shape. There is one implementation of the HPKE sealing/unsealing logic per side (device, wallet-service gateway, press gateway), not a bespoke format per destination.

---

## Key Configuration Discovery

Each destination publishes an unauthenticated key-configuration endpoint:

```
GET /ohttp/key-config
```

returning its current HPKE public key and suite identifiers as JSON. The device fetches and caches this per destination, refreshed on a TTL — the same pattern a TLS certificate or a JWKS endpoint would use. There is exactly one such configuration for the wallet service (a device's SDK configuration names a single preferred wallet-service base URL — see `plans/wallet-service/` for why this SDK is not federation-aware in its core API). A press's key configuration is fetched and cached per press base URL the first time the device needs to talk to that press, since a policy may name more than one approved press and a given offer or update names one specific press at a time.

---

## Request Path

```
Device
  → HPKE-encapsulate { path, method, body } to the destination's cached key config
  → POST the opaque blob to the relay's oblivious-forwarding endpoint:
      POST /ohttp/{target_id}
      Content-Type: application/x-card-protocol-ohttp+hpke
      Body: <opaque HPKE-encapsulated bytes>

Relay
  → resolve target_id via its oblivious-targets registry → { ohttp_gateway_url }
  → if target_id is unknown: return 404, do not forward
  → forward the request body as-is (no parsing, no interpretation) to ohttp_gateway_url
      via a plain outbound HTTPS POST
  → return the destination's response body back to the device unmodified

Destination gateway (wallet service or press)
  → decapsulate the blob → { path, method, body }
  → dispatch in-process (a direct function call, not a second network hop) to the
      handler that path/method would normally route to
  → apply the same auth/validation logic that handler applies when reached directly
      (session token, master-card-signature, subcard-signature — whichever the
      route requires)
  → encapsulate the handler's result through the same HPKE context
  → return the encapsulated response
```

The relay never sees `path`, `method`, or `body` — those exist only inside the HPKE ciphertext. It sees `target_id` (which destination to forward to) and nothing else about the request's content.

**Note on `Content-Type`:** `application/x-card-protocol-ohttp+hpke` is a custom media type, deliberately not `message/ohttp-req` (the RFC 9458 media type for Binary HTTP). This document's §Envelope Format already rejects strict RFC 9458 Binary HTTP encoding in favor of the lightweight JSON-in-HPKE envelope described there; reusing an RFC 9458-reserved media type for a non-RFC-9458-conformant body would be misleading to any tooling or reader that recognizes that type. The custom type signals unambiguously that the body is this protocol's own envelope shape, not standard Binary HTTP.

---

## Relay Target Registry

The relay resolves `target_id → { ohttp_gateway_url }` via a registry that is **structurally independent of the push-notification `AppConfig`** (`relay/src/utils/apps.ts`). `AppConfig` carries `apns`/`fcm` fields specific to push delivery that have no meaning for a press, so the oblivious-forwarding registry is its own file (`relay/src/utils/oblivious-targets.ts`), loaded from `OBLIVIOUS_TARGETS_PATH` the same way `AppRegistryFile` is loaded from `APP_REGISTRY_PATH` today (`relay_data_model.md §6.4`). `target_id` is opaque to the relay: it may reuse a wallet service's existing `app_id`, or a press's own identifier (its press-card mutable pointer, or an operator-assigned string) — the relay does not need to know or care which kind of destination a given `target_id` names.

---

## Scope: Which Endpoints Are Oblivious-Routed

**Wallet-service-facing** (all of it, by default): account creation, `service_secret` retrieval, keyring reads/writes, backup registration and recovery, sub-card registration/deregistration (which, per `wallet.md §7.7`, also carries the wallet service's local UUID-pool bookkeeping — not a separate endpoint).

**Press-facing** (the sensitive/state-changing subset only):

| Endpoint | Oblivious-routed? |
|---|---|
| `/issue` | Yes |
| `/issue/finalize` | Yes |
| `/open-offer/claim` | Yes |
| `/update` | Yes |
| `/sub-card/register` | Yes |
| `/sub-card/deregister` | Yes |
| `/press` | No — direct HTTPS |
| `/health` | No — direct HTTPS |
| `/app-gas/:address` | No — direct HTTPS |

The three excluded press endpoints are public reads with no device-correlation value to protect — there is nothing sensitive in a response to "what's this press's identity" or "is it healthy" that IP-hiding improves, and routing them through the relay would add latency with no corresponding privacy benefit. A request naming a path outside the six sensitive press endpoints is rejected by the press gateway's dispatcher rather than silently forwarded.

This is the default transport for every in-scope call, with no separate "enable privacy mode" the host application must remember to turn on. An explicit direct-HTTPS bypass mode exists for testing and for the excluded public-read endpoints, but the oblivious path is the default for every sensitive call — falling back to direct HTTPS is the explicit opt-out, not the default behavior.

---

## What Each Party Observes

| Observable | Relay | Destination (wallet service or press) |
|---|---|---|
| Device's IP address | **Yes** — the relay is the device's direct connection peer | **No** — sees only the relay's IP |
| `target_id` (which destination) | **Yes** | N/A (it's the destination) |
| Request path, method, body | **No** — opaque HPKE ciphertext | **Yes** — after decapsulation |
| Response content | **No** — opaque HPKE ciphertext | N/A (it's the destination) |

Neither party alone observes both "which device" and "what request." The relay knows a device connected and which destination it targeted, but not what was asked. The destination knows what was asked, but only that it came from the relay's IP.

---

## Honest Caveat: Operator Separation Is Load-Bearing, Not Defense-in-Depth

This is the property this section exists to state plainly, because it is easy to understate. `notification_relay.md §Relay Service Trust Model` frames relay/wallet-service operator separation as **defense-in-depth** for the properties the relay already protects (UUID-to-card unlinkability) — those properties hold even if the same operator runs both services, because UUIDs are opaque to both sides by design regardless of who operates them.

**That is not true for the IP-hiding property this spec defines.** If the relay and a destination (wallet service or press) are operated by the same party, or the operators collude, the relay operator trivially sees the device's IP on the inbound leg and can just as trivially correlate it with the request it is about to forward in decapsulated form on its own infrastructure — the HPKE encryption hides the request's content from the relay, not the fact that a specific IP connected to it. For this specific property, **operator separation is the property, not an optional hardening on top of it.** Anyone deploying a wallet service and a relay together should be told this plainly, not left to infer it from a general "defense-in-depth" framing that applies to a different guarantee.

---

## Failure Handling

| Scenario | Behavior |
|---|---|
| Relay's oblivious-forwarding endpoint unreachable | Device retries with backoff; falls back to the documented direct-HTTPS bypass mode only if the host app has explicitly opted into that fallback — silent fallback to direct HTTPS is not the default, since it would silently drop the IP-hiding property |
| `target_id` unknown to the relay | Relay returns 404 without attempting any forward |
| Destination gateway unreachable (relay's outbound leg fails) | Relay surfaces an error to the device; the device retries the full oblivious request, not a partial retry |
| Destination gateway decapsulation fails (malformed or replayed envelope) | Gateway returns an error through the same HPKE-response path where possible, or a plain HTTP error if the failure occurs before a context is established |
| Destination's key configuration rotated | Device's cached key config is stale for at most one TTL window; a decapsulation failure using a stale key should trigger the device to refetch `GET /ohttp/key-config` and retry once |

---

## Related Specs

- `specs/ARCHITECTURE.md` ADR-007 — transport layer decisions; OHTTP as an optional wallet-to-wallet transport upgrade; this spec extends the same primitive to device-to-wallet-service and device-to-press traffic
- `specs/process_specs/message_routing.md §Transport Extensibility` — the existing wallet-to-wallet OHTTP precedent (`transport_flags 0x02`) this spec's envelope and key-configuration pattern mirrors
- `specs/process_specs/notification_relay.md §Registration Privacy, §Relay Service Trust Model` — the content/timing-level unlinkability protections this spec complements but does not substitute for; the relay trust-model framing this spec's Honest Caveat section narrows for the IP-hiding property specifically
- `specs/object_specs/relay.md` — relay service API spec; where the oblivious-forwarding endpoint and target registry are implemented
- `specs/object_specs/press.md` — press endpoints; identifies which are sensitive/state-changing (oblivious-routed) versus public reads (excluded)
- `plans/client-sdk/strategic-plan.md` Goal 7, OQ-SDK-4 — the client-side design rationale, the Tor-alternative evaluation, and the press extension
- `plans/client-sdk/implementation-plan.md` Steps 1.4a–1.4d, CP-0 — the concrete implementation plan spanning `client-sdk/`, `relay/`, `wallet-service/`, and `press/`
- `plans/wallet-service/strategic-plan.md` — states that the wallet service does not proxy press communication, which is why the press needs its own gateway rather than being reachable only via the wallet service
- **Disambiguation:** `specs/card_protocol_spec.md` also uses the term OHTTP, but for an unrelated purpose — the wallet↔requesting-site CHAPI authentication flow, not the device↔wallet-service/press IP-hiding transport this spec defines. The two are independent uses of the same underlying primitive with different parties, different trust boundaries, and no shared implementation; do not conflate the two when reading either document.
