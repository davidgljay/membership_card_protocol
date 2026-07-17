# Inconsistency Review — `obj-wallet-sdk` (`specs/object_specs/wallet_sdk.md`)

Reviewed against: `app_sdk.md`, `client_sdk.md` (archived), `registry_contract.md`, `ipfs_card.md`, `press.md`, `wallet.md`, `relay.md`, `relay_data_model.md`, `card_verifier.md`, `matrix_encryption.md`, `matrix_room.md`, `matrix_synapse_module.md`, `protocol-objects.md`, `card_protocol_spec.md`, `ARCHITECTURE.md`, and the in-scope process specs (`wallet_backup_and_recovery.md`, `card_offering_and_acceptance.md`, `open_offer_*`, `card_signing.md`, `card_updates.md`, `card_validation.md`, `subcard_creation_policy.md`, `message_routing.md`, `notification_relay.md`, `oblivious_transport.md`, `dns_governance_verifier.md`, `log_auditing.md`, `card_migration.md`, `matrix_*`, `policy_creation.md`, `room_discovery.md`), plus `specs/subcards.md` (referenced extensively by wallet_sdk.md though not itself in the object-spec scope list).

The App SDK / Wallet SDK split (from `client_sdk.md`) is largely clean: master-key/keyring/backup/recovery, offer review + countersigning, and granter-side sub-card authorization are consistently claimed only by `wallet_sdk.md`; offer construction, requester-side sub-card requests, and all messaging/UUID/relay machinery are consistently claimed only by `app_sdk.md`. Both specs cross-reference each other's ownership statements without contradiction in the majority of sections (verified section-by-section against `app_sdk.md` §§1–16). Two real problems were found, both concentrated in `wallet_sdk.md` itself (not disagreements with `app_sdk.md`'s own text), plus one pre-existing (not split-introduced) ordering conflict against a process spec.

---

## 1. `wallet_sdk.md` §4 misattributes `SecureKeyProvider` and `RealtimeTransportProvider` to capabilities this package's own later sections say it does *not* use them for

**Conflicting sections:** `wallet_sdk.md` §4 ("Provider Interfaces (Inherited)") vs. `wallet_sdk.md` §10 ("Security Invariants") and §12 (Implementation Status), and vs. `app_sdk.md` §4.2/§4.5/§11.

`wallet_sdk.md` §4 lists, under "Key providers for wallet-specific flows":

> - `SecureKeyProvider` — used for the master key's ML-DSA-44 signing during offer countersigning and sub-card authorization (via `masterSecretKey` parameters passed through function signatures).
> - `RealtimeTransportProvider` — used for SSE/WebSocket messaging delivery during active wallet sessions.

Both claims are contradicted elsewhere in the same document:

- §10 states plainly: "Every other function that needs `decryption_key` or `masterSecretKey` (e.g., offer countersigning, sub-card authorization) receives it as a direct parameter from a caller that obtained it some other way — this package has no general 'unlock the wallet again after initial setup' primitive." Every master-key-consuming function in §6/§7 (`countersignSubCardRequest`, `revokeSubCard`, `deregisterSubCard`, `postSubCardAddedToDirectory`/`postSubCardRemovedFromDirectory`) takes `masterSecretKey: Uint8Array` as a **direct, raw parameter** — never a `SecureKeyProvider`-style `keyId`. `SecureKeyProvider`'s whole contract (`app_sdk.md` §4.2) is `generateKey`/`sign`/`getPublicKey`/`delete` operating on an opaque `keyId`, precisely so the private key material never leaves hardware-backed storage. A raw `masterSecretKey: Uint8Array` argument is structurally incompatible with that interface — you cannot pass a raw secret key *through* a provider whose entire point is that raw secret keys never surface.
- `app_sdk.md` §4.2 and §11 both describe `SecureKeyProvider` as used only for "the requester-side sub-card key" and "offer-construction key" (App SDK) — no mention of the master key anywhere, consistent with §10's own claim that the master key never crosses a function boundary except as a direct parameter.
- Messaging delivery (`openDeviceSse`/`openCardWebSocket`/`fetchPending`/`ack`, the actual consumers of `RealtimeTransportProvider`) is implemented entirely in `app_sdk.md` §9.5 (`messaging/delivery.ts`). `wallet_sdk.md`'s own §12 Implementation Status table confirms this: "5 | — (messaging/UUID delivery is App SDK responsibility) | **Implemented in App SDK**." Wallet SDK never implements SSE/WebSocket delivery itself.

**Recommendation:** Correct §4's "Key providers for wallet-specific flows" bullets. Either drop the `SecureKeyProvider` bullet's parenthetical (it should describe *device sub-card / requester-side* keys inherited from App SDK, not the master key) or replace it with an accurate statement that the master key is handled outside any provider abstraction (per §10). Drop or reword the `RealtimeTransportProvider` bullet — Wallet SDK doesn't consume this provider directly; if it's listed because a wallet integrator's app happens to also use App SDK's messaging delivery, say so explicitly rather than implying Wallet SDK owns that consumption.

---

## 2. `wallet_sdk.md` §6.5 conflates its own on-chain, master-key-signed `deregisterSubCard` with App SDK's unrelated wallet-service-local UUID-pool deregistration

**Conflicting sections:** `wallet_sdk.md` §6.5 ("Sub-Card Deregistration") vs. `press.md` §5.4 (`processSubCardDeregistration`) and `app_sdk.md` §9.6 (`deregisterCardUuids`); also a regression against `client_sdk.md`'s own (pre-split) §9.5.

`wallet_sdk.md` §6.5 describes:

```ts
function deregisterSubCard(options: DeregisterSubCardOptions): Promise<DeregisterSubCardResult>;
```

authorized "per `subcards.md §Authorization for Deregistration`: deregistration requires and is signed by the **primary card key only**, structurally enforced ... only a direct `masterSecretKey: Uint8Array` argument." It then adds:

> **Explicitly not sub-card revocation.** This is wallet-service-local UUID pool deregistration (App SDK's concern, §9.6 in app_sdk.md), distinct from 8xx/9xx revocation (this section). A sub-card can be deregistered from the relay pool and then re-registered immediately, with **no impact on the sub-card's on-chain status.**

This is factually inconsistent with two other in-scope specs:

- The archived `client_sdk.md` (§9.5, the un-split original) annotates this exact function as `// POST /sub-card/deregister` — a **press** endpoint. `wallet_sdk.md`'s current text drops that endpoint annotation entirely.
- `press.md` §5.4 defines `processSubCardDeregistration(subCardAddress, masterSignature, sigPayload)` as: "**Called by:** `/sub-card/deregister` handler ... Verify the holder's deregistration request and submit `DeregisterSubCard` **on-chain**." Its steps explicitly verify `masterSignature` against the master card's key and call `DeregisterSubCard(...)` on the registry contract, returning "**Transaction hash on success.**" This is unambiguously an on-chain, registry-level operation authorized by the master key — matching `wallet_sdk.md` §6.5's own signer requirement (master-key-only) — **not** a wallet-service-local, no-on-chain-impact operation.
- `app_sdk.md` §9.6 (`deregisterCardUuids`) is a *different* function entirely: `DELETE /cards/{card_hash}/subcards/{subcard_hash}` against the **wallet service** (not the press), explicitly signed by the **sub-card's own key** (not the master key), and explicitly scoped to emptying a UUID pool with "no relationship to sub-card revocation... no shared code, no shared on-chain state."

So `wallet_sdk.md` §6.5's `deregisterSubCard` (master-key-signed, per `subcards.md`'s deregistration-authorization rule, matching `press.md`'s on-chain `/sub-card/deregister`) and `app_sdk.md` §9.6's `deregisterCardUuids` (sub-card-key-signed, wallet-service-local, no on-chain effect) are two distinct operations with different signers, different endpoints, different targets (press+chain vs. wallet-service), and different on-chain consequences. `wallet_sdk.md` §6.5 now describes its own function using language that actually belongs to the *other* function ("wallet-service-local UUID pool," "no impact on the sub-card's on-chain status") while simultaneously keeping the master-key-signing requirement and `subcards.md`'s on-chain-authorization citation that belong to the *press-facing* operation.

**Recommendation:** Re-derive §6.5 from `press.md` §5.4 and the archived `client_sdk.md` §9.5: `deregisterSubCard` submits `POST /sub-card/deregister` to the press (master-key-signed), causing an on-chain `DeregisterSubCard` call — it **does** affect on-chain status. Restore the `// POST /sub-card/deregister` endpoint annotation. Either remove the "Explicitly not sub-card revocation... wallet-service-local UUID pool... no impact on the sub-card's on-chain status" paragraph (it describes App SDK's §9.6 function, not this one) or rewrite it to correctly contrast: "distinct from App SDK's §9.6 `deregisterCardUuids`, which empties only the *wallet service's* local UUID pool and has no on-chain effect and no relationship to sub-card revocation *or* to this on-chain deregistration."

---

## 3. `setupWallet`'s described step ordering contradicts `wallet_backup_and_recovery.md` §Process 1's numbered steps (pre-existing, not split-introduced)

**Conflicting sections:** `wallet_sdk.md` §5.3 (`setupWallet`) vs. `wallet_backup_and_recovery.md` §Process 1.

`wallet_sdk.md` §5.3 states `setupWallet` "[i]mplements `wallet_backup_and_recovery.md §Process 1` Steps 1–14 as one continuous function," describing the pipeline as: master keypair → device-bound passkey → `service_secret` bootstrap → keyring persistence → **synced-passkey backup registration (always)** → optional YubiKey backup → **device sub-card generation and registration (§5.4)** — i.e., backup registration happens *before* device sub-card setup.

`wallet_backup_and_recovery.md` §Process 1's own numbered steps run in the opposite order: "**Device sub-card setup:**" is Steps 7–10 (device sub-card keypair generation, master-key-signed binding, on-chain registration), and only afterward does "**Synced passkey backup registration (default — automatic):**" begin, at Steps 11–13, with YubiKey backup as Steps 14–15. The process spec's own Step 10 even frames the ordering causally: "Routine operations ... now use the device sub-card key," implying the sub-card must exist before routine (post-setup) operation begins — which is awkward if backup registration (also part of setup) is described as happening first.

This ordering conflict is not introduced by the split — the archived `client_sdk.md` §7.3 uses identical wording/ordering ("keyring persistence ... synced-passkey backup registration (always) ... optional YubiKey backup ... device sub-card generation and registration (§7.4)"), so it predates the App SDK/Wallet SDK split. It remains a live inconsistency in scope for this unit since `wallet_sdk.md` still claims to implement "Steps 1–14" in this order.

**Recommendation:** Either correct `wallet_sdk.md` §5.3's prose to match the process spec's actual step order (device sub-card before backup registration), or — if the implementation genuinely runs backup-before-sub-card and that's an intentional deviation — update `wallet_backup_and_recovery.md` to reflect the as-implemented order and note the change. Do not leave the two specs silently describing different orderings of the same "Steps 1–14."

---

## 4. Minor: `SubCardMessageTarget.pubkey` type changed from `Uint8Array` (client_sdk.md) to `string` (wallet_sdk.md) — documented, not a silent drop, informational only

`client_sdk.md` §10.1 (original, planned) defines `SubCardMessageTarget = { pubkey: Uint8Array; address: string }`. `wallet_sdk.md` §8.1 (implemented, salvaged into Wallet SDK) defines `SubCardMessageTarget = { pubkey: string; address: string }`, explicitly noting the change: "`pubkey` is the base64url-encoded public key exactly as stored in `active_subcards`, not raw bytes." This is called out explicitly in the text (not a silent divergence) and is consistent with how `active_subcards` itself is typed in `protocol-objects.md` (`array of base64url`). No action needed beyond awareness — flagged only because a Step B/C reviewer comparing the archived spec byte-for-byte might otherwise flag it as an unexplained mismatch.

---

## Split-completeness check (no capability silently dropped)

Cross-checked every §4–§10 capability in the archived `client_sdk.md` against its landing spot in `app_sdk.md`/`wallet_sdk.md`:

- Providers, crypto/canonicalization core, verifier integration → `app_sdk.md` §4–§6 (inherited by wallet-sdk). ✓ present.
- Wallet setup/keyring/backup/recovery (§7) → `wallet_sdk.md` §5. ✓ present (see Finding 3 for an ordering-only issue, not a drop).
- Card offers: construction + offerer finalization (§8.1, §8.6-offerer-half) → `app_sdk.md` §8. Offer review/countersign/all three acceptance paths (§8.2–§8.6-recipient-half) → `wallet_sdk.md` §7. ✓ present, cleanly split, both sides cite each other correctly.
- Sub-cards: requester-side request (§9.1) → `app_sdk.md` §7.1. Wallet-side validation/consent/countersign/revocation (§9.2–§9.4) → `wallet_sdk.md` §6. Press submission (§9.4 registration half) → `app_sdk.md` §7.3. Deregistration (§9.5) → `wallet_sdk.md` §6.5 (see Finding 2). `active_subcards` gap (Planned in client_sdk.md) → now Implemented, split across `wallet_sdk.md` §6.6 (write) and §8.1 (read). ✓ present, no drop — gap has since been closed on both specs' accounts.
- Messaging/UUID/relay (§10) → `app_sdk.md` §9, entirely, except the `active_subcards`-reading helper (`resolveActiveSubCardTargets`) → `wallet_sdk.md` §8.1. ✓ present, matches both specs' mutual cross-references.
- Security invariants, result/error conventions, dependencies, resolved design decisions (§11–§16) → split faithfully across both specs' equivalent sections, each still accurate to its own package's actual scope (aside from Finding 1's §4 provider-list errors).

No capability from `client_sdk.md` was found to have been silently dropped by the split.
