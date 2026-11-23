# Derived Cards and Revocation Propagation — Process Spec

**Version:** 0.1 (draft)  
**Date:** 2026-11-11  
**Status:** Draft. `expiry_only` and `sealed_link` are in v1. `escrowed_link` is **specified, not implemented in v1**.  
**Architecture:** `ARCHITECTURE.md` ADR-013 · **Objects:** `protocol-objects.md` §1 (`expires_at`), §2.1, §2.2, §20–§24, §26, §28, §31, §32 · **Lifecycle:** `notary_lifecycle.md` · **Replication:** `notary_replication_and_recovery.md` · **Design record:** `plans/notary-design-decisions.md` §2.6

**Amended 2026-11-15 (6.4), for David's review; security items D1, D2, D4 and D8 approved by David 2026-11-19, the rest still for review** (`plans/notary-questions-6.4.md`): §1 `source_policy` in the `dup_tag` input is the policy CID's UTF-8 bytes (the registry's CID-bytes convention); the ratchet label is followed by `p` as 8 bytes big-endian; the key's period travels in the template handoff, and two seeds of one generation settle on the lower SHA-256; §3 an offer whose boundary passes is replaced when the holder resubmits the same signed input (the header of its `chain_ref` stays pinned for the period), and the countersign answers `DERIVE_OFFER_UNKNOWN`, `DERIVE_OFFER_STALE` or `DERIVE_COUNTERSIGN_INVALID`; check D4 compares the program's output with the projected values; `projected_fields` never names a protocol field; a v1 runtime serves a derived-card job with one replica and `expiry_only`.

**Amended 2026-11-19 (6.5), for David's review** (`plans/notary-questions-6.5.md`): §3 step 6 the sealed link is made when the card is released (E7); §6 step 2 a source update counts only if it decrypts under the source card's content key **and** a certified press of the source policy signed it (E4, decided by David 2026-11-19); §6 step 3, after the holder names a successor under the same source policy, only 801 and 810 end the link without propagating; every other revocation is propagated (E2, decided by David 2026-11-19); §6 a source-policy snapshot runs through the same test as an update; §7 step 1 eligibility counts from the later of the block time and the enclave's receipt of the update (E3).

**Amended 2026-11-21 (notary step 6.5a), approved by David** (`plans/notary-spec-6.5a.md`, Q1–Q6): §3 check D5 and the consent lines, §8 two new disclosure lines, §9 note, new §10 "member as of date" template, error `DERIVE_FIELD_NOT_DERIVABLE`.

**Amended 2026-11-14 (6.3):** §1 and §3: periods, issuance batch boundaries and renewal windows are judged on the enclave's attested clock. David approved 2026-11-14 (`plans/notary-questions-phase-6.md`, Q5–Q9).

> **Terminology.** "The enclave" means an AWS Nitro Enclaves enclave. See `ARCHITECTURE.md`, terminology note.

---

## Overview

A **derived card** is a reduced card that a notary issues to a holder who presents a full **source card**. For example, a Meta employee card can yield a card that states only "Meta employee". The derived card must:

- state only the source policy and the source field values the job projects;
- pass ordinary card verification;
- be unlinkable to the source card by anyone outside the enclave, the operator included;
- stop being valid after the source card is revoked: at expiry under `expiry_only`, or by a propagated revocation under `sealed_link`.

Derived cards are issued only under **template policies** (`protocol-objects.md §2.2`). These are registered by governance, one per audited `derive` program. Anyone may open a standing derived-card job under a template, naming a source policy and the fields to project.

This spec covers:
- §1 periods, `dup_tag` and renewal;
- §2 evidence and policy snapshots, which keep the source card hidden;
- §3 issuance;
- §4 the anonymity-set rule;
- §5–§8 the three propagation modes and their timing defenses;
- §9 all parameters.

Each flow is numbered, with a threat note per step for a **hostile host**. The general threat model is in `notary_lifecycle.md` §Threat Model.

---

## Actors

| Actor | Role |
|---|---|
| **Holder** | Holds the source card. Their wallet requests, countersigns and receives the derived card. |
| **Job opener** | Anyone; template policies set no `job_requester_predicate`. Signs a `per_input` `NotaryJob` under template `T` with `parameters.source_policy` and `parameters.projected_fields`. |
| **Notary** | The enclaves of a notary card approved for `T`. `K_id` signs derived cards. The identity leader holds `K_chain` and is the only one that writes chain payloads. |
| **Notary host** | Relays inputs, supplies policy snapshots and updates, submits `RegisterCard` and `BatchUpdateCardHeads`, and pins derived cards. Untrusted. |
| **Template holder (PressRegistryBody)** | Maintains `T`: `approved_notaries`, `revocation_permissions`, parameters |
| **Verifier** | Checks a derived card (`card_verifier.md`) |

---

## Preconditions

- `T` is registered (`RegisterPolicy`), and each serving notary card has `AuthorizePress(T, …)`.
- **The write gate binds signed payloads to calldata** (`registry_contract.md §6.1`). Derived cards must not ship before this. Without it, a host could reuse a signed payload to point a derived card's head at junk.
- The notary holds the current template key `k_T,p` (§1). It is shared with the other notaries serving `T` by template-scope handoff.

---

## §1 Periods, `dup_tag` and renewal

**Periods.** Let `P = derived_card.nullifier_period`. Period `p` covers `[p·P, (p+1)·P)`, measured in seconds from the Unix epoch. Periods are aligned to these boundaries. *(Amended 2026-11-14, Q6.)* The enclave judges periods, `issuance_batch_interval` boundaries, `renewal_window` and the D1 period check on its **attested clock**, read at most once per host `tick` (`notary_runtime.md` §9), never on header or host time. A derived card issued for period `p` has `expires_at = (p+1)·P`, so every card in a period expires at the same moment and expiry says nothing about the holder.

**`dup_tag`.** Every derived card carries:

```
dup_tag = HMAC-SHA256(k_T,p, root_source_key || source_policy || p)

root_source_key = the source card's past_keys[0].pubkey if present, else its recipient_pubkey
                  (key rotation doesn't produce a new tag)
source_policy   = the source card's policy_id (CID bytes)
p               = 8-byte big-endian period index
k_T,p           = HKDF-SHA256(k_T,p-1, info = "card-notary-dup-tag-ratchet" || p)
```

How the key behaves:
- **One key per template.** `k_T,p` is shared by every enclave serving template `T`, across operators (template-scope handoff, `notary_replication_and_recovery.md` §3). Two cards derived from the same source card for the same period therefore carry the same tag, whichever notary issued them.
- **Old keys are erased.** A period key is erased once the period plus `renewal_window` has passed. The ratchet is one-way, so a key taken later can't reproduce earlier tags.
- **Re-seeding after exposure** *(added 2026-11-12)*. The ratchet runs forward, so an exposed `k_T,p` exposes every later period's key too. When an enclave finds `k_T,p` exposed (`notary_runtime.md` §4), the chain is re-seeded:
  - **New seed.** A clean enclave serving `T` generates a fresh random key for the current period as **generation** `g + 1`. Template handoffs carry the generation (`protocol-objects.md §29`, `key_generation`), and enclaves accept only a higher generation, and only from a peer whose own lineage is clean (P5).
  - **Conflicts.** If two clean enclaves each create generation `g + 1`, the seed whose `SHA-256` is lower wins. The other enclave switches over at its next template handoff.
  - **Issuing.** Enclaves issue new tags only under the newest generation.
  - **Keeping the exposed key.** The exposed key is kept until the period ends, **only** to run D3 against tags already issued in that period. It is never used to issue.
  - **Limit.** Until every operator serving `T` holds the new generation, two operators can issue the same source card a card each in that period without D3 catching it (`notary_lifecycle.md` L11). From the next period on, tags agree again.
- **Why it's keyed.** Every card under a source policy is listed on-chain. An unkeyed hash of a source card's identity could be reversed by hashing each one.

**Duplicates.**
- The enclave refuses to issue a second card with a tag it has already issued in that period (`DERIVE_DUPLICATE`).
- A verifier that wants one card per person per period (for a vote, say) accepts one card per `dup_tag`.
- Tags change every period, so a holder's cards in different periods can't be linked.

**Renewal.** During the last `renewal_window` of period `p`, the holder may present the source card again for period `p+1`. They get a **fresh** derived card with a new key, the period `p+1` tag, and `expires_at = (p+2)·P`. The old card lapses at the end of `p`. Cards are never updated in place, and code 301 is not used.

---

## §2 Keeping the source card hidden: evidence and policy snapshots

The host must never learn which source card is presented, and must never learn which source cards are linked to derived cards. So:

1. **Evidence.** The holder's `NotaryInput.evidence` carries every IPFS object the enclave needs to check the source card:
   - its genesis document and current head;
   - its sub-card document;
   - its ancestors.

   The enclave checks each object against its CID and the signatures inside it. It never fetches a card by CID through the host.
2. **Policy snapshot.** For each `source_policy` with a live job, the host supplies a snapshot and keeps it current. The snapshot covers:
   - every card registered under the policy (address, log head CID, last press address);
   - the `SubCardRegistrations` entries whose primary card is one of those cards;
   - the IPFS bytes of each card's current head.

   The enclave reads registry state only from its local copy. It never queries one card.
3. **Snapshot updates.** These are every `CardHeadUpdated` under the policy, with the new head's bytes. They keep the snapshot current and drive the `sealed_link` watch loop (§6).
4. **What remains visible.** Ancestors registered under other policies (for example, the steward card that issued the source card) are fetched by address. That reveals the issuer, which many cards share, not the holder.

**Trust level.** The snapshot is as trustworthy as any registry read in v1. That is limit L4: host-supplied and unverified, recorded through `chain_state`.

**Cost.** Roughly 150 bytes per card plus its head object. That is about 100 KB for a 1,000-card policy and tens of MB for 100,000 cards.

---

## §3 Issuance flow

*(Amended 2026-11-14, Q6.)* Every boundary in this section is a time on the enclave's attested clock (§1).

1. **Holder's wallet.** Fetches the job's announcement and runs algorithm W (`notary_lifecycle.md` Appendix A.2). Shows consent built from `T` and the job:
   - the source policy;
   - the field names to be copied, and their values;
   - the issuing notary;
   - `expires_at`;
   - the disclosure lines in §8, including (6.5a) who can end the card and what the source issuer can see.
   - *Threat note:* the host learns that some device fetched the announcement, through the relay, not which one.
2. **Wallet.** Generates a fresh derived key `D`. Builds a `NotaryInput`:
   - `contributor_card` = the source card;
   - `payload` = `{ "derived_recipient_pubkey": D_pub, "target_period": p }`;
   - `evidence` as in §2;
   - `revision` 0.

   It signs with the source card's sub-card, seals the input, and submits it (`notary_lifecycle.md` Phase 5).
   - *Threat note:* the host sees only a ciphertext. It can drop the request, which shows up as no receipt.
3. **Enclave.** Runs B1–B11 (`notary_lifecycle.md` Appendix B), with B7 against the source-policy snapshot and B8 resolving `{ "param": "source_policy" }`. Then runs the derive checks:

   | # | Check | Code |
   |---|---|---|
   | D1 | `target_period` is the current period, or the next one when inside `renewal_window` | `DERIVE_PERIOD_INVALID` |
   | D2 | `D_pub` has never appeared in any input this notary accepted | `DERIVE_KEY_REUSED` |
   | D3 | `dup_tag` for (root source key, `source_policy`, `target_period`) has not been issued | `DERIVE_DUPLICATE` |
   | D4 | The `derive` program, run on the source card's fields named in `parameters.projected_fields`, returns output that passes the output checks | `OUTPUT_SCHEMA_VIOLATION` |
   | D5 | *(Added 2026-11-21, 6.5a.)* Every field in `parameters.projected_fields` is `derivable` at the source policy's **current head** (`notary_lifecycle.md` A.7, step R6, cached at most 10 minutes). An empty list always passes. Renewals are inputs, so they run D5 too. Cards already pooled or released are not recalled. | `DERIVE_FIELD_NOT_DERIVABLE` |

   - *Threat note:* the host learns nothing about which source card was checked (§2).
4. **Enclave.** Builds the derived card offer (`protocol-objects.md §2.2`):
   - `policy_id = T`;
   - `issuer_card` = `press_card` = the notary card;
   - `issued_at` = the next `issuance_batch_interval` boundary;
   - `expires_at` as in §1;
   - `source_policy`;
   - `projected` (RFC 8785 JSON of the program's output);
   - `dup_tag`;
   - `ancestry_pubkeys = [K_id public key, T's public key]`.

   It signs `issuer_signature` with `K_id`, and returns the offer as `derived_offer` inside the sealed validation receipt, once a quorum of replicas has acknowledged the input.
   - *Threat note:* the receipt is sealed under a key the host doesn't have, so the host can't read the offer.
5. **Wallet.** Checks the offer:
   - `projected` equals its own source card's values for those fields;
   - `expires_at`, `source_policy`, `issuer_card` and `policy_id` match what was consented to;
   - `issuer_signature` verifies against the notary card's key.

   It then adds `recipient_pubkey = D_pub`, signs `holder_signature` with `D`, and sends a `NotaryCountersign` (`protocol-objects.md §23.1`), sealed and submitted the same way as an input. No new prompt is needed; consent was given at step 1.
   - *Threat note:* the host can delay the countersign, which delays issuance.
6. **Enclave.** Verifies `holder_signature`. Places the card in the **issuance pool** for its period, and records `dup_tag` as issued. Under `sealed_link` it also records the link (§6). Updates the state blob (`notary_replication_and_recovery.md` §8).
7. **Enclave, at each `issuance_batch_interval` boundary.** Releases every pooled card whose **group** has reached `min_anonymity_set` members (§4). The batch must hold at least `min_batch_size` cards; otherwise everything waits for the next boundary. For each released batch the enclave:
   - shuffles the order;
   - signs each card's `press_signature` with `K_id`;
   - asks the host to pin each card, encrypted under its content key (ADR-006);
   - has the identity leader sign one `RegisterCard` payload per card with `K_chain`;
   - writes an `issued` job-log record (`protocol-objects.md §28`) with only `{ count, period, batch_boundary }`.

   No `PressIssuanceRecord`s are sent (`protocol-objects.md §11` exception).
   - *Threat note:* the host can withhold registrations, which is denial of service attributable through the holder's receipts. It cannot register a forged card, because the content needs `K_id`. It cannot deface heads once the write-gate fix is in place. It cannot match a registration to a request beyond 1 in the batch size.
8. **A card whose `issued_at` boundary passes before its group qualifies.** The enclave issues a fresh offer with the next boundary, and the wallet countersigns again (step 5).
9. **Wallet.** Watches the registry for `keccak256(D_pub)`. When the card appears, it reads the head CID and stores the card. No delivery message is needed.
10. **End of period.** Cards still pooled when their period ends are dropped. Their tags are released, since nothing was issued. The wallet shows "not issued: too few holders share these values".

**Verifying a derived card** (`card_verifier.md`). This is ordinary card verification, with:
- Stage 5 satisfied by the notary card's `PressAuthorizations` entry under `T`;
- `expires_at` enforced against chain time;
- algorithm G on the notary card's `genesis_attestation`, with `t_eval` set to the notary card's `issued_at`. This shows the signing key was born in an accepted runtime.

A verifier that needs one card per person per period also compares `dup_tag`s.

---

## §4 The anonymity-set rule

The enclave can't count how many **source** cards share a value: card contents are encrypted under keys only their holders have. It counts where the risk actually is, among **derived-card holders**.

A derived card reveals:
- its issuer (the notary card);
- `source_policy`;
- `projected`;
- its period (through `expires_at`).

Those four values define a card's **group**. A card is released only once at least `min_anonymity_set` distinct `dup_tag`s are in its group. A second floor also applies: the source-policy snapshot must list at least `min_anonymity_set` cards. Groups with rare values wait, and are dropped at period end if they never qualify (§3 step 10).

---

## §5 Mode `expiry_only` (v1)

1. **Enclave.** Keeps **no** link between source and derived cards. It keeps only the issued `dup_tag`s for open periods.
2. **When the source card is revoked,** the holder can't renew: B7 fails at the next presentation. The derived card lapses at `expires_at`.
3. **Worst-case lag** between a source revocation and the derived card ceasing to be valid: one `nullifier_period`, plus `renewal_window` if the holder renewed just before the revocation.
   - *Threat note:* there is nothing for the host to learn or block. Expiry needs no on-chain event.

---

## §6 Mode `sealed_link` (v1)

**What the enclave keeps.** A link entry `{ derived_address, source_address, source_pubkey, expires_at }` in the notary's encrypted state blob. `source_pubkey` lets the enclave decrypt the source card's future log entries. An entry is erased when its derived card expires. The blob is versioned and handed between enclaves as described in `notary_replication_and_recovery.md` §8. It is never written anywhere readable outside an enclave.

**Watch loop.**

1. **Host → enclave.** Snapshot updates for every source policy with live links: every `CardHeadUpdated` under that policy, with the new head's bytes (§2).
   - *Threat note:* the host learns only which source policies have live derived-card jobs, which is already public from the jobs. It doesn't learn which source cards are linked, which were ever presented, or which update caused a propagation. The host can withhold updates, which delays propagation (L1). Expiry still bounds the delay.
2. **Enclave, for every update in the stream.** Looks up the address among its links. If found, it decrypts the new entry with the stored `source_pubkey` and reads `code`. It does the same lookup for every update, so nothing it requests from the host depends on the link set.
   - *Amended 2026-11-19 (6.5, E4, decided by David; `plans/notary-questions-6.5.md`):* decrypting proves little, because the content key comes from the source card's **public** key, which the holder's presses and verifiers also know. A linked entry is acted on (a successor noted, a revocation queued) only if its `press_signature` verifies over the entry and its key belongs to a **certified press** of the source policy: a press card listed in the policy's current `approved_presses` (by the CID of the press card's published document; a card pointer is accepted only where that card's first registry entry is the plain published document, and a listed pointer whose card cannot be read is `PRESS_UNREADABLE` for the whole list), registered, chaining to a trusted root and not revoked. Any such press will do. The enclave reads the policy's certified presses per watched source policy, on each snapshot or update message and at most every 10 minutes, whatever is linked; checking an entry reads nothing, so the rule above still holds. A refused entry raises an operator alert (`SOURCE_UPDATE_UNCERTIFIED`) that names no card. The entry's `intent_signature` isn't checked: a stored `LogEntry` doesn't carry the intent's `target_card`, `updater_card` and `timestamp` (protocol-objects §3, §4), so no reader can rebuild what it signs, and `revocation_permissions` stays the press's check at submission. A forger therefore needs a certified press's key, not just the source card's public key. Limit: the policy head and registry reads come from the host (L4), so a host could hide a press card's revocation.
3. **Successor rule.** If the source card has an effective `successor` (codes 100–102, `key_rotation.md`) whose chain is under the same source policy, the link moves to the successor and is checked there. A revocation of the old card, typically 801, is **not** propagated.
   - *Amended 2026-11-19 (6.5, E2, decided by David; `plans/notary-questions-6.5.md`):* the enclave can't read the successor's entries (they are under the new key) or the holder's rotation statement, and `successor` is holder-editable. So:
     - a successor counts only from a **100 or 101** entry (the holder's rotation, `key_rotation.md` §2.4–2.5), registered under the same source policy. A **102** (the issuer's recovery rotation, pending 72 hours and cancellable by 103, §2.6) sets none;
     - after it, only the rotation flow's own revocations are not propagated: **801** (voluntary surrender) and **810** (signing key compromised). The link then ends and the derived card lapses at its expiry;
     - every other revocation is propagated, including an issuer's **800** after a successor, and every 9xx. A holder can't dodge an issuer's revocation by pointing `successor` at another card;
     - since E4, a successor entry counts only if a certified press signed it, so only the holder (or, for 102, the issuer) can write one.
4. **Propagation test.** If `code` matches `revocation_propagation.propagated_codes` (default `["8xx","9xx"]`), the enclave queues a revocation of the derived card (§7).

**Code mapping.**

| `derived_code` | Source code | Code posted on the derived card |
|---|---|---|
| `"range"` (default) | any 8xx | **820**, propagated revocation: source credential ended (quiet) |
| `"range"` | any 9xx | **920**, propagated revocation: source credential revoked (loud) |
| a fixed integer (an 8xx or 9xx code) | any propagated code | that code |

The exact source subcode is never copied: 9xx subcodes say why someone was revoked, which a reduced card is meant to withhold. The `"range"` default keeps the quiet/loud distinction, because a loud revocation is a safety signal other communities rely on (`update_codes.md` 9xx). A template may set a fixed code to hide even that.

**Total loss.** If every identity holder of the notary card dies, the links are lost and its derived cards fall back to `expiry_only` (`notary_replication_and_recovery.md` §8).

---

## §7 Releasing propagated revocations: timing defenses

**The threat.** Source revocations are public `CardHeadUpdated` events under the source policy. A derived-card revocation that followed soon after, on its own, would let an observer match the two cards.

1. **Eligibility.** A queued revocation becomes **eligible** at `source_effective_time + min_delay`, where `source_effective_time` is the block timestamp of the source card's update. *(Amended 2026-11-19 (6.5), for David's review, `plans/notary-questions-6.5.md` E3: the later of that timestamp, which the host supplies, and the enclave's attested time when the update arrived; a host can delay eligibility, never advance it.)*
2. **Release.** At each `batch_window` boundary, the enclave releases every eligible revocation **if** at least `min_revocation_batch` are eligible. Otherwise it holds them all.
3. **Dropping.** A held revocation whose derived card expires before release is dropped, because expiry achieves the same result without an event. Holding is therefore bounded by the period.
4. **The release.** One `BatchUpdateCardHeads` transaction under `T` (`registry_contract.md §4.15`), built from a `PropagationBatch` (`protocol-objects.md §32`), with entries in shuffled order. Each entry's `LogEntry` has:
   - the mapped code;
   - `intent_signature` and `press_signature` both by `K_id`. The notary card satisfies `T.revocation_permissions` through `card_field_matches` on its `operator_card`.
   - `effective_date` equal to the release time;
   - no `revocation.note`;
   - `notify_holder: true`.

   The identity leader signs the chain payload with `K_chain`.
   - *Threat note:* the host can withhold the transaction, which delays the revocation (expiry still applies). After the write-gate fix it cannot alter the entries. It cannot learn which source revocation caused which entry.
5. **Mixing across communities.** `T` holds derived cards from every source policy, so a batch mixes revocations from many communities.

**Residual linkage, stated to users.** An observer who matches source-revocation events with derived-revocation batches can narrow a derived revocation to the source revocations within the window. That is at least `min_revocation_batch` events, and more when the window is busy. Small communities with rare revocations get the weakest protection (L8). The consent screen says so (§8).

---

## §8 Wallet disclosures

The wallet builds these lines from `T` and the job, and shows them before the holder consents:

| Mode | Line |
|---|---|
| `expiry_only` | "This card lasts until {expires_at}. If your {source policy name} card is revoked, this card won't be renewed." |
| `sealed_link` | "The notary keeps a sealed link between this card and your {source policy name} card, so it can revoke this card if that one is revoked. The link is held only inside the secure enclave and is lost if every copy of the notary fails. In small communities, the timing of a revocation may hint at the link." |
| `expiry_only`, or `sealed_link` whose `propagated_codes` include an 8xx code | "{source policy name} can end this card by ending your {source policy name} card. It can see that this job exists, but not who took part." |
| `sealed_link` whose `propagated_codes` name 9xx codes only | "{source policy name} cannot end this card by ending your card (leaving, being let go). It can end it only by revoking your card for fraud or compromise. It can see that this job exists, but not who took part." |
| any | "Cards are issued in batches every {issuance_batch_interval}, and only once at least {min_anonymity_set} people share the same values. Yours may take longer." |
| any | "Anyone who sees this card learns: {source policy name}, {projected field names and values}, the issuing notary, and the expiry date." |

---

## Mode `escrowed_link` (specified, not implemented in v1)

1. At issuance, the enclave encrypts the link `{ derived_address, source_address }` to a t-of-n threshold of escrow holders named by `T`, and publishes the ciphertext with the `issued` record.
2. The link is decrypted only by the challenge process defined in the template holder's governance text: for example, when a derived card is used in a way that requires identifying its source.
3. On a successful challenge, the template holder posts the revocation.

v1 runtimes refuse a policy with `mode: "escrowed_link"`. The mode is specified so a template can be written against it later.

---

## §9 Parameters

These are `T.notary` fields (`protocol-objects.md §2.1`). A template may change the defaults within the bounds shown.

| Parameter | Field | Default | Bounds | Defends against |
|---|---|---|---|---|
| Source kind | `derived_card.source_kind` | `"card"` | `"card"` only in v1; `"web_evidence"` reserved | Not a defense. It fixes what this document applies to: source-card templates only |
| Period (also the card's validity) | `derived_card.nullifier_period` | `P7D` | 1–90 days | Long-lived linkability; how long a card stays valid after its source is revoked under `expiry_only`. For a "member as of date" card (§10) it is also the longest a fired holder keeps the card |
| Renewal window | `derived_card.renewal_window` | `P2D` | ≤ half the period | Gaps at period boundaries |
| Issuance batch interval | `derived_card.issuance_batch_interval` | `PT6H` | 1–24 h | Linking request time to registration time |
| Minimum batch size | `derived_card.min_batch_size` | 5 | ≥ 2 | Same |
| Anonymity set | `derived_card.min_anonymity_set` | 10 | ≥ 2 | Rare projected values identifying a holder |
| Propagated codes | `revocation_propagation.propagated_codes` | `["8xx","9xx"]` | Any subset | — |
| Derived code | `revocation_propagation.derived_code` | `"range"` | `"range"`, or one 8xx/9xx code | Revealing the reason for a revocation |
| Revocation minimum delay | `revocation_propagation.min_delay` | `PT24H` | ≥ 1 h | Timing correlation of revocations |
| Revocation batch window | `revocation_propagation.batch_window` | `PT24H` | 1 h – 7 days | Same |
| Minimum revocation batch | `revocation_propagation.min_revocation_batch` | 3 | ≥ 1 | Same |

---

## §10 Field control and the "member as of date" template

*(Added 2026-11-21, 6.5a; decided by David, `plans/notary-derived-card-issuer-control.md` options C and D.)*

**Field control (C).** A source policy's field definitions may mark a field `derivable: false` (`card_protocol_spec.md §1`). A job may project only derivable fields, checked at job open (W6b, step 17) and on every input (D5). The bare claim "holds a card under this policy" (an empty `projected_fields`) can't be refused by the source issuer.

**"Member as of date" template (D).** A governance-registered template over the same `derive` program whose card shows past membership and that a source issuer can't end by ending the card for a reason other than fraud:

| Parameter | Value |
|---|---|
| `revocation_propagation.mode` | `sealed_link` |
| `revocation_propagation.propagated_codes` | `["9xx"]` |
| `revocation_propagation.derived_code` | `"range"` |
| `derived_card.nullifier_period` | `P90D` |
| `derived_card.renewal_window` | `P30D` |

The other fields are those of the default template. A relying party reads `issued_at` and `expires_at`: the card shows membership as of `issued_at`, not current membership, and it lapses at `expires_at` whatever happens to the source card. A fired holder therefore keeps it for at most one period (90 days), unless they renewed before being let go.

---

## Postconditions

- Every issued derived card verifies as an ordinary card, carries `expires_at` and `dup_tag`, and has no `PressIssuanceRecord`.
- The host's records (ciphertext arrivals, snapshot traffic, registrations, batch transactions) don't link any derived card to its source card, beyond the residual timing linkage stated in §7.
- Under `sealed_link`, a propagated revocation lands within `min_delay + batch_window` of eligibility. If the batch threshold isn't reached first, the card simply expires.

---

## Error Paths

| Code / event | Raised by | Handling |
|---|---|---|
| `DERIVE_PERIOD_INVALID` | D1 | Rejected in the receipt; the wallet requests the correct period |
| `DERIVE_KEY_REUSED` | D2 | Rejected; the wallet generates a new key |
| `DERIVE_DUPLICATE` | D3 | Rejected; the holder already has a card for this period |
| `OUTPUT_SCHEMA_VIOLATION` | D4 | Rejected; the template program is faulty, so the operator alerts governance |
| `INPUT_*` | B1–B11 | As in `notary_lifecycle.md` |
| Group never qualifies | §3 step 10 | Dropped at period end; the wallet tells the holder |
| Countersign never arrives | §3 step 5 | The pooled offer expires at period end |
| Registration withheld | Host | The holder has receipts. Attributable to the operator (L1). |
| Snapshot updates withheld | Host | Propagation is delayed, and expiry bounds the delay (L1) |
| Identity total loss | Replication §8 | Links are lost; affected cards fall back to `expiry_only` |
| `DERIVE_FIELD_NOT_DERIVABLE` | D5 | Rejected; the holder's wallet shows the field is no longer available. Issued cards run to expiry |
| `JOB_FIELD_NOT_DERIVABLE` | W6b, job open | Job refused (`notary_lifecycle.md`) |
| `DERIVE_OFFER_MISSING` | Wallet, §3 step 5 | The receipt carried no offer; nothing is countersigned and the holder is told the request did not complete |
| `DERIVE_OFFER_INVALID` | Wallet, §3 steps 5 and 8 | The offer differs from what was consented to, or its signature fails; not countersigned |
| `escrowed_link` policy | Runtime | Refused in v1 |

---

## Related Specs

- `process_specs/notary_lifecycle.md`: phases, algorithms W, G, N, input checks B1–B11, threat model
- `process_specs/notary_replication_and_recovery.md`: identity and template handoffs, the state blob
- `protocol-objects.md` §1 (`expires_at`), §2.1, §2.2, §11 (exception), §20–§24, §26, §28, §31, §32
- `update_codes.md`: codes 820 and 920
- `object_specs/card_verifier.md`: derived-card verification
- `object_specs/registry_contract.md` §4.1, §4.15, §6.1 (write gate)
- `key_rotation.md`: `successor` and `past_keys`
- `ARCHITECTURE.md` ADR-013, ADR-006 (content encryption)
