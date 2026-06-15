# Phase 2 Red-Team Report — Card Protocol v0.3
## Key Compromise Scenarios

**Date:** 2026-05-22  
**Scope:** Steps 2.1–2.5 per `plans/implementation-plan.md`  
**Sources reviewed:** `specs/ARCHITECTURE.md` (including ADR-011), `specs/card_protocol_spec.md`, `specs/protocol-objects.md`, `red_teaming/phase_1_report.md`, `plans/strategic-plan.md`

---

## ⚠ Clarification Checkpoint Alert

**Finding 2.2-A triggers the Phase 2 clarification checkpoint and requires author input before Phase 3 proceeds.**

> **Finding 2.2-A — Compromised Press Key Enables Backdated Silent Revocation Against Any Card in Its Scope**
>
> A press key holder can post a 9xx log entry with any past `effective_date` and `notify_holder: false` against any card governed by that press's authorized policies. The spec explicitly supports backdated effective dates as a design feature. There is no technical counter in the protocol that prevents a press with a valid key from doing this silently. Holders learn of the revocation only when they attempt to authenticate and are rejected — potentially days to weeks after the entry was posted.
>
> Under ADR-011, revoking a compromised press key also requires governance quorum (`RevokePress`), introducing additional delay in the response window. A fast-moving attack can post dozens of silent backdated revocations against activists or journalists before the governance body can act.
>
> **Recommended author action:** Determine whether any of the three proposed mitigations (holder log polling, two-party authorization for silent 9xx entries, or verifier-side log-head freshness caching) should be elevated to a protocol requirement rather than a suggested mitigation before Phase 3 begins. This is the most direct mechanism by which the protocol can be weaponized against its intended beneficiaries.

---

## Executive Summary

Phase 2 assessed five key tiers in the Card Protocol's trust hierarchy: the policy authorizer, the press sub-card, the holder (at both sub-card and master key levels), the auditor, and the backup service. Thirteen distinct findings emerged across the five steps, with the following severity distribution:

| Severity | Count |
|---|---|
| High | 6 |
| Medium | 5 |
| Low | 2 |

**The blast-radius hierarchy, from widest to narrowest:**

1. **Press sub-card key** (widest): Write authority to the on-chain registry for all cards under the press's authorized policies. Enables backdated silent revocation of any card in scope. Requires governance quorum to revoke, introducing response latency.
2. **Policy authorizer key**: Can modify the policy's IPFS content (field definitions, predicates, revocation permissions) and escalate to mass 9xx revocation of all cards under the policy. The mass-9xx path is detectable — a flood of evidenceless revocations is immediately suspicious — and the protocol's successor card mechanism enables trust chain reconstruction, but recovery is operationally costly. Cannot authorize or revoke presses on-chain without governance quorum (ADR-011).
3. **Auditor key**: Exposes the complete issuance history for every card issued under the policy since the auditor was registered. No forward secrecy — all historical entries are decryptable.
4. **Holder full keyring** (full keyring compromise): Complete identity takeover for one holder, but scoped to that individual. Mitigated by the 72-hour cancellation window — unless the attacker also controls the holder's notification channels.
5. **Holder sub-card key only** (narrowest): Attacker can sign as the holder from one device. Real holder can recover via master key if it is not also compromised.

**ADR-011 update note:** Between Phase 1 and Phase 2 execution, the author issued ADR-011 (On-Chain Press Authorization and Protocol Governance), which directly addressed Phase 1 Finding 1.1-A. The `approved_presses` gap is closed: press authorization is now enforced via two on-chain tables (`PolicyAuthorizerKeys`, `PressAuthorizations`) rather than the IPFS-stored field. This change also affects Phase 2's analysis: policy authorizer key compromise no longer directly enables new press authorization on-chain (that now requires governance quorum), and press key revocation also requires governance quorum, adding response latency to incidents.

---

## Findings Table

| Step | ID | Finding | Severity | State Actor | Criminal Org | Individual Abuser |
|---|---|---|---|---|---|---|
| 2.1 | 2.1-A | Authorizer key enables mass 9xx revocation or silent field-change invalidation; recovery via successor chain is feasible but operationally costly | **High** | High | Medium | Low |
| 2.1 | 2.1-B | Policy authorizer compromise is limited by ADR-011 governance gate — blast radius reduced | Medium | Medium | Medium | Low |
| 2.1 | 2.1-C | Detection requires active log monitoring; attacker operates freely until first check | Medium | Medium | Medium | Medium |
| 2.2 | 2.2-A | Compromised press key enables backdated silent 9xx revocation against any card in scope | **High** | High | High | Medium |
| 2.2 | 2.2-B | Governance-controlled press revocation adds response latency in fast-moving incident | **High** | High | Medium | Low |
| 2.2 | 2.2-C | Press can issue cards with attacker-controlled holder keys (fake credentials) | Medium | Medium | High | Low |
| 2.3 | 2.3-A | Sub-card key compromise: holder can recover via master key; gap is press availability | Medium | Medium | Low | Medium |
| 2.3 | 2.3-B | Full keyring compromise + notification channel control bypasses 72-hour window | **High** | High | High | Medium |
| 2.3 | 2.3-C | Physical device access allows keyring blob exfiltration; Secure Enclave limits sub-card key extraction | Medium | Low | Low | **High** |
| 2.4 | 2.4-A | Auditor key compromise exposes complete historical issuance record with no forward secrecy | **High** | High | Low | Low |
| 2.4 | 2.4-B | Auditor key rotation does not protect past entries; policy authorizer may not know a breach occurred | **High** | High | Low | Low |
| 2.5 | 2.5-A | Backup service breach alone is insufficient; attacker still needs YubiKey + PIN | Low | Low | Low | Low |
| 2.5 | 2.5-B | State compulsion + YubiKey seizure can complete recovery without holder knowledge | Low | Medium | Low | Low |

---

## Step 2.1 — Policy Authorizer Key Compromise

### Context

The policy authorizer holds the key that signed the policy card at inception. In the two-tier governance model added by ADR-011, the on-chain `PolicyAuthorizerKeys` table maps each registered root policy to its authorizer's ML-DSA-44 public key. Prior to ADR-011, a compromised authorizer key would have directly enabled arbitrary press authorization changes on-chain. ADR-011 moved press authorization under governance quorum control, substantially reducing the blast radius.

The remaining question is what an attacker with the authorizer key can still do — primarily through modifications to the IPFS-stored policy card content.

### Finding 2.1-A — Authorizer Key Compromise Can Halt a Trust Chain; Recovery Path Exists

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (Medium), Individual abuser (Low)

The policy authorizer key can update any field in the policy card whose `update_policy` allows it. The default update policy for `field_definitions` is `{ "is_issuer": true }`, and for `revocation_permissions` likewise. This opens two distinct attack paths, with meaningfully different detectability and recovery profiles.

---

**Attack path 1 — Silent invalidation via field definition changes.**

**(a) Adding a new required field.** ~~The policy's `field_definitions` now lists a field marked `required: true` that did not exist when prior cards were issued. Those cards lack this field. Verifiers performing full policy compliance checks (§7, stage 5a) will flag them non-compliant. Depending on how services apply verifier tolerance policy, this is functionally equivalent to mass credential invalidation without posting a single 9xx entry, and without any record in individual cards' logs.~~

> **Mitigated by spec change (2026-05-22).** The spec now requires that compliance verification (§7 stage 5a) use the `policy_id` CID snapshot embedded in each card at issuance — not the current live policy. A new required field added after issuance does not affect cards issued before the change. This path is closed for field definition changes that affect previously-issued cards. It remains valid for newly-issued cards during an attack window before the compromise is detected.

**(b) Tightening a field's regex constraint.** ~~A `recipient_predicate` or a field validation regex can be updated to a more restrictive pattern. Cards whose field values satisfied the original regex but not the new one are now non-conforming under the current policy. Same effect as (a): silent compliance failure.~~

> **Mitigated by spec change (2026-05-22).** Same anchor rule applies: verifiers use the `policy_id` CID snapshot, so a tightened regex in the live policy cannot retroactively invalidate cards that satisfied the original regex at issuance. As with (a), the path remains active for newly-issued cards during the attack window.

**(c) Removing holder self-revocation rights.** The authorizer can update `revocation_permissions` to remove `{ "is_holder": true }` from the 8xx predicate, stripping holders of the ability to submit 810 self-revocation intents. Combined with a press-side attack (Finding 2.2-A), this prevents a holder from responding to a key compromise.

> **Not mitigated.** The spec's explicit carve-out states that update authorization — including evaluation of `revocation_permissions` for new intents — uses the **current live policy**, not the `policy_id` CID snapshot. Whether a party may submit an update intent today is determined by the policy's current state. A compromised authorizer who modifies `revocation_permissions` changes what the press accepts going forward. This path remains open.

---

**Attack path 2 — Mass 9xx revocation via permission escalation.**

The authorizer key can update `revocation_permissions` to grant 9xx revocation authority to the authorizer itself (or to any key they control), then submit mass 9xx revocation intents to an approved press. The press validates that the signer satisfies the current `revocation_permissions` — which the attacker just updated to include themselves — and posts the entries.

This brings a large portion of the trust chain to a halt simultaneously. Every card under the policy is now flagged revoked with a 9xx code.

**The evidence gap makes this attack visible.** Unlike the press key's backdated silent 9xx path (Finding 2.2-A), an authorizer-driven mass 9xx attack has no per-holder evidence. The `note` field in each revocation entry is free text; a legitimate 9xx entry against a bad actor typically includes context (what they did, when, who reported it). A flood of 9xx revocations with identical or sparse notes, all posted in rapid succession, is immediately suspicious to any human reviewing the verification output. Verifiers are not required to accept 9xx entries uncritically — the spec notes that 9xx revocations are a signal that requires interpretation, not an automatic authority.

**What the attack achieves in practice:** Not mass permanent removal from all services, but a disruption: a large community of credential holders suddenly shows as revoked, services must decide how to handle the revocation signal, and the community faces the overhead of response. The disruption is real even if sophisticated services treat the entries skeptically.

---

**Recovery path: successor cards and parallel trust chain reconstruction.**

The key protocol property that limits long-term harm here: revoked cards are still presentable. A 9xx revocation is a signal in the log, not a deletion of the card or its history. The card's log — including the suspicious mass revocation entries — is publicly auditable. This creates a viable recovery path that the protocol already partially supports.

**Successor card chain reconstruction:**

1. The legitimate community establishes a new policy under a clean authorizer key (or restores the old key if it can be recovered and the attack entries rolled back via a correcting update).
2. The new policy can be configured with `supersedes` semantics — or a service-level policy — that says: "present a card that was revoked under the compromised authorizer, and if its log shows no issues other than the attack-period mass revocation entries, we will issue a successor card in the new chain."
3. The successor card's `supersedes` field points to the old card's mutable pointer, with a `supersession_note` documenting the compromise and the clean history. The old revocation remains visible for auditability; the new card has a clean forward history.
4. Verifiers who trust the new chain see a clean active credential. Verifiers who also walk the old chain see the documented history of compromise and recovery.

**Using cards with revocation flags where context is known:** For many services — particularly those operated by the community itself — the revocation flags can be contextually ignored during a known attack and recovery period. A community platform that knows a mass-9xx attack occurred can apply a grace policy: "cards revoked on [attack date] under [policy ID] are treated as active pending reissuance." The protocol's verifier tolerance policy mechanism (§7 structured result) explicitly supports this — the result surfaces `revocation.code` and `revocation.effective_date`, and the application layer decides how to act.

**Assessment of recovery effort:** Reconstruction is possible but is a real operational burden — it requires:
- Clean establishment of a new policy and authorizer key (or key rotation with governance cooperation)
- Coordination with approved presses to issue successor cards
- Community communication so holders know to claim successor cards
- Tooling to automate the "show your revoked card, receive a successor" flow

For a small community with limited technical resources, this recovery process could take days. For a larger, well-resourced community with the right tooling, it could be hours.

---

**Detection and reversibility:** The policy card's append-only log means all changes are cryptographically visible. A monitoring agent watching the policy card's on-chain head CID would detect a change. The attacker acts before detection, but the attack window for path 2 (mass 9xx) is short before the community notices — mass revocations are loud. Path 1 (field definition changes) is quieter and may take longer to detect.

**Adversary application by tier:**
- *State actor*: Uses path 1 (field definition change) for deniable long-duration credential degradation, or path 2 (mass 9xx) as a disruptive strike timed to a specific organizing event, knowing the community will be occupied with recovery rather than the event itself.
- *Criminal org*: Could weaken predicates (path 1) to allow cards to be issued to targets who previously did not qualify, bootstrapping a fraudulent credential chain.

**Mitigation options:**
1. Policy card change monitoring: clients and presses should treat any policy card log update as a high-signal event, alerting the community administrator.
2. Require multi-party authorization for `revocation_permissions` updates: the default `update_policy` for this field should require co-sign from a second key. (The `field_definitions` retroactive invalidation path is closed by the spec's `policy_id` anchor rule, but multi-party authorization remains valuable as defense-in-depth, particularly against path (c) — stripping holder self-revocation rights — which is not mitigated by the anchor rule.)
3. ~~Document that field definition changes can invalidate existing cards — this consequence is not currently called out in the spec.~~ **Resolved by spec change**: the `policy_id` anchor rule means field definition changes on the live policy cannot retroactively invalidate existing cards. The spec now explicitly documents this protection.
4. The spec should describe the successor card chain reconstruction flow explicitly as the standard recovery path for authorizer key compromise (particularly path 2, mass 9xx), so communities know how to respond before an incident occurs.

---

### Finding 2.1-B — ADR-011 Governance Gate Substantially Limits On-Chain Blast Radius

**Severity:** Medium (note: this is a partially-positive finding)  
**Feasibility:** N/A — this finding records a design property, not an attack  
**Adversary relevance:** All adversary types (Medium — the constraint meaningfully limits what they can do)

Prior to ADR-011, a policy authorizer key compromise would have allowed the attacker to add attacker-controlled presses to `approved_presses` in the IPFS policy card content and begin issuing fraudulent cards immediately.

Under ADR-011, press authorization on-chain requires a call to `AuthorizePress` with a governance quorum signature from the Press Registry Governance Body. An attacker with only the policy authorizer key:

- **Cannot** add a new press to `PressAuthorizations` on-chain.
- **Can** add a press pointer to the IPFS-stored `approved_presses` array, but this has no effect on contract enforcement ("on-chain state is authoritative").
- **Cannot** revoke a legitimate press on-chain (requires governance quorum for `RevokePress`).
- **Can** remove a press from the IPFS `approved_presses` array, creating an IPFS/on-chain discrepancy that serves as a monitoring signal but does not affect the press's actual write authority.

The press authorization attack path — which would have been the most damaging consequence of authorizer key compromise — now requires either (a) compromising the governance body's keys in addition, or (b) social-engineering the governance body into authorizing an attacker-controlled press. This is a meaningful improvement and reduces the authorizer key's blast radius from Critical to High.

**Residual risk:** The governance model introduces two trusted third parties (Root Policy Governance Body, Press Registry Governance Body). These bodies are themselves attack surfaces, particularly for state actors (see Phase 3, Step 3.1). The red-team analysis treats both bodies as trusted per the scope note in ADR-011, but flags this as a deferred analysis area.

---

### Finding 2.1-C — Detection Requires Active Log Monitoring; Attacker Operates Freely Until First Check

**Severity:** Medium  
**Feasibility:** Practical  
**Adversary relevance:** State actor (Medium), Criminal org (Medium), Individual abuser (Medium)

The policy authorizer compromise is visible in the append-only log — every malicious update is signed and posted. But the protocol has no push notification mechanism for policy changes. A verifier, press, or holder who last cached the policy card before the compromise will not see the malicious updates until they re-fetch.

**Minimum time-to-detection:** Detection requires one of:
- A monitoring agent that continuously watches the policy's on-chain head CID and alerts on changes.
- A holder or verifier who happens to re-fetch the policy during or after the attack.
- A press that re-runs its pre-flight policy compliance check (recommended but not triggered automatically).

Under realistic conditions — particularly for small community deployments where there is no dedicated monitoring infrastructure — the attack window could be days to weeks. The attacker can post malicious field definition changes that degrade community credentials and observe their effect before the community notices and responds.

**Mitigation options:**
1. Presses should subscribe to on-chain events for policy card registry pointer updates and re-run pre-flight checks when the policy card changes.
2. The spec should recommend that communities operate a monitoring agent on their policy card's on-chain registry entry.
3. Client-side policy caching should have a configurable TTL; "use cached policy card indefinitely" is a reasonable default for verification speed but creates vulnerability to undetected policy changes.

---

## Step 2.2 — Press Sub-Card Key Compromise

### Context

The press sub-card key is registered in the on-chain `PressAuthorizations` table and has write authority to the Arbitrum One registry for all cards under the press's authorized policies. Every registry write — new card registration, log head update, revocation entry — requires a valid ML-DSA-44 signature from this key. This is the single most consequential key in the protocol below the governance layer.

ADR-011 adds an important constraint: revoking a compromised press key now requires a governance quorum call to `RevokePress`. The press cannot self-revoke, and the legitimate press operator cannot revoke alone.

### Finding 2.2-A — Compromised Press Key Enables Backdated Silent 9xx Revocation Against Any Card in Scope

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (High), Individual abuser (Medium)

> **⚠ This finding triggers the Phase 2 clarification checkpoint per `plans/implementation-plan.md`.**

An attacker with the press's sub-card key can post a `LogEntry` with:
- `code: 911` ("bad actor or harmful conduct")
- `revocation.effective_date`: set to any past date — even months before the attack
- `notify_holder: false`
- `press_signature`: valid, signed with the compromised key

The result: the target's card is now formally revoked, with the revocation backdated to appear as though the holder was a known bad actor before any specific event. The holder is not notified. The entry is a signed, cryptographically valid log entry — it will pass verification.

**What the spec explicitly enables:**

The spec (§5, update flow) states: "The `effective_date` in a revocation entry may be earlier than the posting date. The updater is asserting when the relevant condition began." The `notify_holder: false` feature is described as intentional "for adversarial scenarios — such as a 9xx revocation where tipping off the holder would be harmful" (confirmed in the strategic plan's Resolved Design Questions).

Both mechanisms are working as designed. The attack exploits no bug. It uses the protocol exactly as specified.

**What the attacker CANNOT do:**

- **Forge a card that appears to bind to an existing holder's real identity**: A CardDocument requires both `offer_signature` (press) and `holder_signature` (holder's private key). The press never holds the holder's private key. A "forged" card with an attacker-controlled holder key will not match the holder's known public key in any prior authentication session or associated keychain.
- **Decrypt the audit log**: The press log is encrypted to auditor public keys via ML-KEM; the press never holds decryption material.
- **Self-revoke**: Revoking the compromised press entry requires `RevokePress` with governance quorum (ADR-011).

**The boundary between "cannot forge" and "can weaponize":**

The dual-signature model prevents the press from issuing new cards that appear to come from an existing, known holder. However, it does not prevent the press from revoking that holder's actual card. The protection and the weapon are in different domains. A careful verifier will not accept a forged issuance; every verifier must accept a press-signed revocation entry (that is the point of the press having write authority).

**Time-to-detection for the victim:**

A holder with `notify_holder: false` on their revocation will not receive a Nym notification. They learn of the revocation when:
1. They attempt to authenticate somewhere and are rejected.
2. They proactively poll the Arbitrum One registry for their card's log-head CID.
3. Another holder in the community notices the revocation entry while walking the log.

Under realistic conditions, a holder who authenticates infrequently may not discover the revocation for days or weeks. The backdated `effective_date` means that even after discovery, authentication history during the backdated period will be flagged as `was_valid_at_signing_time: false` (for 9xx revocations, things on or after `effective_date` are invalid or suspect) — creating retroactive questions about the holder's credibility during that period.

**Adversary application by tier:**

- *State actor (legal compulsion or technical compromise)*: Posts 9xx revocations with `notify_holder: false` and backdated effective_date against specific activists or journalists. The official revocation provides legal cover. The backdated date allows the state to claim the person was a known bad actor before any specific organizing event, undermining their testimony or community standing. After revoking, the governance body must convene to execute `RevokePress` — during which window the attacker may post additional entries.
- *Criminal org (self-operated or infiltrated press)*: Revokes legitimate credential holders from a community to disrupt trust relationships, clear the field for fraudulent cards, or respond to a member who is about to expose the operation. Can also post 9xx entries against business competitors or their customers.
- *Individual abuser (small community press operator)*: Has the highest relative access (small community presses are less likely to have strong key security) and a specific personal motivation. Can post 9xx entries against a specific victim within their press's scope with a 911 code, permanently damaging their standing in the community. Detection requires the victim to notice — which may take weeks if they are not an active authenticator.

**Mitigation options (per implementation plan direction):**

1. **Holder-initiated log polling**: Clients should periodically compare the on-chain log-head CID to their cached version. Any change triggers re-verification and notification, regardless of `notify_holder`. This is a client-side mitigation that does not require a protocol change.
2. **Two-party authorization for silent 9xx entries**: The policy's `revocation_permissions` can be configured to require co-sign from a second authorized party for 9xx revocations (the spec supports compound predicates). Communities serving high-risk populations should be strongly recommended to require this. The spec should call this out as a specific recommendation rather than leaving it implicit.
3. **Verifier-side log-head freshness**: Relying parties that have previously verified a card should record the log-head CID at that time. A subsequent authentication attempt should re-verify the log head; a changed head triggers full re-verification before issuing a confirmation code. This protects against attacks that happen between authentication sessions.
4. **Governance response SLA**: The protocol should specify an expected response time for `RevokePress` actions in the governance charter. A governance body with a 48-hour quorum process cannot contain a fast-moving revocation attack; the charter should specify emergency escalation procedures.

---

### Finding 2.2-B — Governance-Controlled Press Revocation Adds Response Latency in Fast-Moving Incidents

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (Medium), Individual abuser (Low)  
**Author disposition:** Accepted as designed — see note below.

> **Author note:** This tradeoff is intentional and acceptable. The worst a compromised press can do is spam the chain with easily detectable fraudulent cards. Because every issued card requires a valid holder countersignature (which the press cannot forge), fake cards are structurally detectable — the holder key in any press-forged card has no prior history, no associated keyring, and no attestation chain. The governance latency window is real but the damage during that window is limited to revocations (Finding 2.2-A) and structurally detectable fake cards; neither constitutes an unrecoverable state. The finding stands as documented for completeness, but requires no protocol change.

ADR-011's governance gate on `RevokePress` is the right design for preventing unauthorized press deregistration. It introduces a consequence that the red-team must flag: **press key revocation now depends on the governance body's operational tempo**.

In a fast-moving incident where an attacker has a compromised press key and is actively posting malicious log entries:

1. The legitimate press operator detects the compromise (time varies; see Finding 2.2-A detection window).
2. The operator escalates to the Press Registry Governance Body.
3. The governance body assembles quorum — which requires multiple key holders to coordinate, sign, and submit `RevokePress`.

If the governance body requires 24–48 hours to assemble quorum (a reasonable baseline for any multi-party governance process), an attacker has a window of potentially hundreds of malicious registry writes before the press key is revoked. Each write can revoke a card.

**The pre-ADR-011 comparison:** In the original design, a press could self-revoke (revoke its own sub-card via normal revocation flow). Under ADR-011, this path is gone — all press revocations go through governance. The tradeoff (governance accountability vs. operational speed) was accepted consciously; the author confirms the acceptable blast radius (detectable fake cards) justifies the governance accountability gain.

**Mitigation options (informational; not required per author disposition):**
1. Define a fast-track governance process for incident response that can assemble quorum in under 1 hour with pre-authorized key holders.
2. The governance charter should enumerate "emergency revocation" as a specific procedure, distinct from routine press deregistration.
3. If governance response time cannot be guaranteed to be under 1 hour, consider whether presses themselves should be able to register a "self-halt" — a signed declaration that stops the press from accepting write authorization while the governance body deliberates. This does not require the press to deregister; it temporarily suspends write authority pending governance action.

---

### Finding 2.2-C — Press Can Issue Fake Cards With Attacker-Controlled Holder Keys

**Severity:** Medium  
**Feasibility:** Practical  
**Adversary relevance:** State actor (Medium), Criminal org (High), Individual abuser (Low)

A press with write authority can register a new card entry on-chain by: assembling a CardDocument, signing it as the press (`offer_signature`), generating an attacker-controlled ML-DSA-44 keypair, adding the attacker's public key as `recipient_pubkey`, and countersigning with the attacker's private key (`holder_signature`).

The resulting CardDocument has both valid signatures and will pass structural verification. It will appear as a legitimately-issued card for the attacker-controlled keypair.

**Why this is Medium, not High:**

A careful verifier can detect this. The fake card's holder key has no prior history: it has never been seen in a prior authentication session, is not in any known holder's keyring, and has no associated sub-card registrations. A verifier who cross-references the presented key against prior authentication context will find no match. Additionally, the holder key in the fake card is entirely new — it has no attestation chain of its own.

However, many verifiers in practice do not maintain session-level key history. They verify the card's signatures and chain, confirm the press is authorized, and accept the result. For these verifiers, the fake card is indistinguishable from a genuine one.

**Adversary application by tier:**
- *Criminal org*: Uses fake credentials to gain access to community services, satisfy predicates for downstream credential issuance (bootstrapping a fraudulent credential chain), or impersonate legitimate community members in dispute resolution contexts.
- *State actor*: Issues credentials to informants under the compromised policy, giving those informants legitimate-appearing access to communities served by that policy.

**Mitigation options:**
1. Relying parties that store prior authentication sessions should verify that the `card_pointer` and corresponding public key match what was seen in prior sessions. A new key for a returning holder is a red flag.
2. The spec could recommend that community platforms track card pointer-to-key bindings across sessions to detect unexpected key changes.

---

## Step 2.3 — Holder Master Key and Sub-Card Key Compromise

### Context

The holder's key arcardecture is two-tier: a master card key (cold, stored in an encrypted IPFS keyring blob) and per-device sub-card keys (hot, stored in Secure Enclave on Apple devices, TPM on others). The three compromise scenarios are: sub-card key only, master key only, and the full keyring (passkey + service_secret).

### Finding 2.3-A — Sub-Card Key Compromise: Holder Can Recover via Master Key, Gap Is Press Availability

**Severity:** Medium  
**Feasibility:** Practical  
**Adversary relevance:** State actor (Medium), Criminal org (Low), Individual abuser (Medium)

A holder whose device sub-card key is compromised (via device theft, malware, or physical access at an unlocked moment) faces the following situation:

**What the attacker gains:** The sub-card key can sign messages and authentication responses that appear to come from the holder's device card. The attacker can impersonate the holder for authentication flows. They can sign messages attributed to the holder's identity. For a journalist or activist, this could mean sending fraudulent statements that appear to come from their identity.

**What the attacker cannot do with a sub-card key alone:**
- Create new sub-cards (requires master key).
- Post a self-revocation (810) of this sub-card — because submitting an 810 via the press requires the holder's key to sign the update intent, and the attacker already has that key. So actually: the attacker could submit an 810 for the compromised sub-card, but their incentive is the opposite — they want to keep using the key, not revoke it.
- Access the master key (which is cold and encrypted separately).

**The holder's recovery path:**
1. Holder accesses their master key (from the encrypted keyring, decrypted with passkey + service_secret).
2. Holder registers a new sub-card key under the master card (master key signs the sub-card registration).
3. Holder submits an 810 intent for the compromised sub-card key, signed with the new sub-card key (which satisfies `is_holder: true` for the master card).
4. Press processes the 810, posts the log entry, notifies other community members.

**Critical dependency:** Step 3 requires an available approved press. If the only approved press is unavailable (Finding 1.4-C), the holder cannot post the 810. The attacker continues to use the compromised key indefinitely. The spec's recommendation to list multiple presses in `approved_presses` is the primary mitigation.

**Individual abuser scenario:** An abuser who gains temporary physical access to a victim's unlocked device (intimate partner scenario) can exfiltrate the sub-card key from app-level storage. However, if the sub-card private key is stored in a Secure Enclave/TPM (as specified), it cannot be read or copied from the hardware. The abuser cannot exfiltrate what cannot be read; they can only sign in the moment of device access. This is a meaningful security property that the spec should state explicitly: sub-card keys in Secure Enclave storage cannot be exfiltrated, only used during unlocked device access.

**Mitigation options:**
1. The spec should explicitly state that Secure Enclave/TPM storage makes sub-card key exfiltration impractical — not just inconvenient — for the individual abuser threat model.
2. The prompt-on-sign behavior (requiring biometric confirmation for each sub-card signature) should be recommended as a default for high-sensitivity deployments, limiting what an abuser can do during a brief period of device access.
3. Resolving OQ-4 (holder-direct writes via paymaster) would allow 810 self-revocations without press mediation, removing the press-availability dependency from the most time-critical recovery path.

---

### Finding 2.3-B — Full Keyring Compromise Plus Notification Channel Control Bypasses 72-Hour Window

**Severity:** High  
**Feasibility:** Practical for state actors and sophisticated criminal organizations; Medium for individual abusers with relationship access  
**Adversary relevance:** State actor (High), Criminal org (High), Individual abuser (Medium)

The full keyring compromise scenario: an attacker obtains both the encrypted keyring blob (from IPFS, publicly accessible for public cards or obtainable from device storage) and the decryption credentials (passkey + service_secret). This gives the attacker the holder's master private keys. To also use the YubiKey recovery path without the holder knowing, the attacker needs the YubiKey and the holder's notification channels suppressed.

**Keyring blob acquisition:** The keyring is stored on IPFS. For public cards, the keyring's IPFS address may be derivable from the card's public key. For private cards, the keyring address requires the address secret. In either case, a device backup, iCloud sync, or unencrypted device storage may give an attacker the blob without IPFS access.

**Decryption credential acquisition:** The keyring is encrypted with `passkey + service_secret`. The service holds `service_secret` (but not in plaintext). The passkey is held by the holder's device (biometric/PIN-derived). An attacker with device access at an unlocked moment may have access to an active decrypted session — but the master key is not in active memory unless a high-stakes operation (new sub-card, key rotation) was just performed. In practice, this attack requires more than device access: it requires a moment when the master key is in use.

**The YubiKey recovery path attack:**

An attacker who has:
1. The holder's YubiKey (stolen, or possessed during a border crossing / detention)
2. Control over the holder's notification channels (SIM swap → SMS; email account takeover → email; physical access → all)

Can:
1. Initiate the 72-hour recovery window at the backup service.
2. Intercept all notifications sent to the holder's configured channels.
3. Wait 72 hours without the holder receiving or being able to submit a cancellation.
4. Receive the wrapped decryption key blob from the backup service.
5. Present the YubiKey (PIN required); YubiKey unwraps the blob locally.
6. Decrypt the IPFS keyring → extract master private keys.
7. Register new sub-cards under the master card, effectively taking over the identity.

**The PIN barrier:** The YubiKey requires a PIN to unwrap the blob. A simple 4–6 digit PIN is vulnerable to physical coercion (rubber hose attack) or brute force if the YubiKey's attempt limit is not configured. A longer PIN or passphrases significantly raise the bar.

**Notification channel control assessment by adversary tier:**

| Adversary | SIM swap feasibility | Email takeover feasibility | Physical channel interception |
|---|---|---|---|
| State actor | High (telecom legal compulsion) | High (legal compulsion or technical access) | High (detained holder) |
| Criminal org | Medium (SIM swap fraud is common) | Medium (phishing, account takeover) | Low |
| Individual abuser | Medium (partner with phone access) | Medium (known email credentials) | High (cohabitant) |

**What full identity takeover enables:**

With the master key and newly-registered sub-cards, the attacker:
- Can sign messages attributed to the holder's identity.
- Can submit update intents (field updates, self-annotations) for the holder's cards.
- Can register the holder's cards under a new primary service, potentially locking the original holder out.
- For a journalist: can sign statements attributed to the journalist's identity, creating false content.
- For an activist: can authenticate to community platforms as the activist, observing their private communications.

**Mitigation options:**
1. Offer a configurable notification window beyond 72 hours for high-stakes deployments (mentioned as P1 in §3). Communities serving journalists or activists should default to 7 days.
2. Add a backup notification channel that is independent of the holder's device channels — a trusted secondary contact who can receive recovery alerts even if all primary channels are compromised.
3. Require multi-factor cancellation for the YubiKey recovery: not just "submit a cancellation before 72 hours" but also "confirmation from a pre-registered secondary contact."
4. Alert on notification delivery failures: if all configured notification channels fail to deliver during recovery initiation, treat this as a cancellation signal rather than continuing.

---

### Finding 2.3-C — Physical Device Access Allows Keyring Blob Exfiltration; Secure Enclave Limits Sub-Card Key Extraction

**Severity:** Medium (for state/criminal); High for individual abuser  
**Feasibility:** Practical with physical device access  
**Adversary relevance:** State actor (Low), Criminal org (Low), Individual abuser (High)

The individual abuser in an intimate partner scenario has intermittent physical access to the holder's device. The threat model differs from the other adversary types because the abuser can observe or interact with the device at a natural, trusted moment.

**What Secure Enclave/TPM prevents:** Sub-card private keys stored in secure hardware cannot be read from memory or exported from the device. The hardware enforces this boundary. An abuser with device access cannot exfiltrate a sub-card private key — they can only sign in the moment of access. This is a meaningful protection for the routine signing case.

**What Secure Enclave does NOT prevent:**
- **Signing in the moment**: The abuser can, during a period of unlocked device access, open the wallet app and sign messages or authentication responses using the device's sub-card. The app would require the holder's authentication (biometric/PIN) first — but an abuser with cohabitant access may observe the PIN or use the holder's fingerprint during sleep.
- **Keyring blob exfiltration**: If the wallet app stores the IPFS keyring blob address locally (likely, for offline access), the abuser can copy it. The blob is encrypted, so they need `passkey + service_secret` to decrypt. If the service is the wallet service's backend, the `service_secret` is not accessible without the service's cooperation. But if the passkey is derivable from a PIN they have observed, and the `service_secret` is stored on the device (some implementations might cache it), the blob might be decryptable.
- **Installing monitoring software**: With OS-level access (device unlocked, abuser with technical skill), the abuser can install a monitoring application that captures signing events, authentication responses, and — crucially — the wallet app's UI interactions. This converts the phone into a surveillance device.

**Recovery path for a discovered intimate-partner compromise:**
1. Holder should reset their passkey (if the device OS supports it, this involves re-encrypting the keyring under a new passkey).
2. Holder should register a new primary service, obtaining a new `service_secret`, and re-encrypt the keyring.
3. Holder should submit 810 intents for any sub-card keys that may have been used by the abuser.
4. For the monitoring app case: factory reset is the only reliable recovery.

**Mitigation options:**
1. The spec should recommend that wallet implementations require a fresh biometric confirmation for each signing event (not just unlocking the app). This limits the abuser's ability to use a sleeping holder's finger.
2. In-app signing logs: the wallet should maintain a local record of every signing event, notification, and authentication request, so the holder can review whether any activity they did not initiate occurred.
3. The spec should call out this threat model explicitly in the key management section (§3), noting that sub-card keys in Secure Enclave resist exfiltration but not in-session misuse.

---

## Step 2.4 — Auditor Key Compromise

### Context

Auditor cards receive ML-KEM-encrypted copies of every issuance log entry posted by the press. Each auditor's current public key (resolved via the policy card's `auditors` array) is used by the press to encapsulate a fresh shared secret per entry, then encrypt the issuance record. The auditor's private key is required to decapsulate and read the entries.

### Finding 2.4-A — Auditor Key Compromise Exposes Complete Historical Issuance Record With No Forward Secrecy

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (Low), Individual abuser (Low)  
**Disposition:** Mitigated by spec change (2026-05-22) — see note below.

> **Spec change:** The protocol now uses an epoch-based audit encryption model. Each epoch has a single Audit Encryption Key (AEK) generated by the press and wrapped (via ML-KEM) under each auditor's public key. Issuance records are encrypted under the shared AEK. When an epoch closes, the auditor produces a signed `AuditEpochCommitment` and destroys the AEK. Entries from closed epochs are permanently undecryptable. This provides epoch-scoped forward secrecy: compromise of the current auditor key exposes only the current open epoch's records; closed epochs are protected by key deletion. See `card_protocol_spec.md` §2 Audit Epoch Lifecycle and `protocol-objects.md` §§12–13.

ML-KEM is a Key Encapsulation Mechanism. In the protocol's original design, the press performed the following per entry:

1. Generated a random KEM ciphertext bound to the auditor's current public key.
2. Extracted the shared secret from the encapsulation.
3. Encrypted the issuance record with the shared secret (AEAD).
4. Stored (KEM ciphertext, encrypted issuance record) in the press log.

**The original forward secrecy gap:** Every entry encrypted to the same auditor public key used the same long-term private key for decapsulation. Compromise of the private key made all historical entries decryptable — from the auditor's registration date to the present. This finding prompted the epoch-based redesign described above.

**Residual exposure under the epoch model:** A compromised auditor key exposes the current open epoch's AEK, making entries since the last epoch open decryptable. The maximum exposure window equals the epoch duration (annual by default). Communities serving high-risk populations should use shorter epoch durations (quarterly or monthly) to reduce this window.

**What a compromised current-epoch AEK gives an attacker:**

The `PressIssuanceRecord` (§11 of `protocol-objects.md`) contains: the new card's CID, the requester's identity, the recipient's public key, timing metadata, and field values. This is:

- **For a state actor:** A ledger of who joined a community, when, who vouched for them, and the exact contents of their credential during the exposed epoch. For an activist community, this is a surveillance target — but now bounded to one epoch rather than all-time.
- **For a state actor with multiple auditor compromises:** Cross-referencing issuance records across multiple policies' current epochs allows building partial social graph maps. Prior epochs' records are inaccessible.

**Correlation attack (residual):** Timing metadata in current-epoch records still allows correlation of issuance events to real-world activities within the exposure window.

**The high-value targeting implication (unchanged):** The `auditors` field in the policy card is publicly visible for public policy cards. An adversary targeting a widely-used auditor key (one appearing in many policies) can gain access to all of those policies' current-epoch records simultaneously. Epoch model does not mitigate this targeting; it bounds the damage per compromise.

**Remaining recommendations:**
1. The spec should recommend that auditor keys be held in hardware (HSM, YubiKey) to make silent exfiltration impractical.
2. Shorter epoch durations (quarterly) for high-risk community policies to reduce maximum exposure window.
3. Avoid using the same auditor card across many high-value policies — diversifying auditor keys limits cross-policy blast radius from a single compromise.

---

### Finding 2.4-B — Auditor Key Rotation Does Not Protect Past Entries; Policy Authorizer May Not Know a Breach Occurred

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (Low), Individual abuser (Low)  
**Disposition:** Partially mitigated by spec change (2026-05-22) — see note below.

> **Spec change:** The epoch model changes the rotation story. An auditor key rotation now triggers an epoch close: the auditor produces a signed commitment covering all entries from the epoch, destroys the AEK, and the press opens a new epoch under the new key. Past epochs' AEKs are destroyed regardless of whether the rotation was proactive or reactive. If the rotation happens after a silent compromise, the attacker already has the old AEK — but the commitment procedure creates a public record (entry count + hash commitment over all CIDs) that enables post-hoc detection of whether any entries were missed or tampered with before the epoch closed.

Under the original design, when the policy's `auditors` array was updated to a new auditor key, the press began encrypting new entries to the new key. Past entries remained encrypted under the old key and there was no public record of what had been in them.

**What the epoch model changes about detection:** After epoch close, the `AuditEpochCommitment` is publicly posted to IPFS and referenced in the policy log. It contains `entry_count` and `entries_hash` (a hash commitment over all decrypted entry CIDs in log order). A verifier can confirm that the commitment covers all entries in the log. If an attacker silently decrypted entries during the epoch, the commitment still reflects an honest count of what was in the log — the attacker's observation does not modify the commitment.

**What remains undetected:** The commitment proves the auditor processed all entries and recorded the count. It does not prove the auditor's private key was not observed by a third party during that epoch. Silent key exfiltration — where the attacker read entries as they were decapsulated without modifying anything — leaves no trace in the commitment.

**The high-value targeting implication:** Unchanged. A widely-used auditor remains a high-value single target. The epoch model bounds the damage per compromise to one epoch rather than all-time, but does not eliminate the targeting incentive for state actors with long-duration surveillance objectives.

**Remaining recommendations:**
1. Auditor key rotation after any suspected compromise closes the current epoch and produces a public commitment — this is now a protocol-required action, not a manual cleanup step.
2. The spec should recommend that auditor keys be held in hardware (HSM, YubiKey) to make silent exfiltration impractical.
3. The spec should recommend against using the same auditor card across multiple high-value policies.

---

## Step 2.5 — Backup Service and YubiKey-Specific Attacks

### Context

The backup service stores a blob containing the keyring decryption key, wrapped under a YubiKey-derived key. The service never sees the decryption key in plaintext. Recovery requires: presenting the YubiKey, passing the 72-hour notification window without a cancellation, and using the YubiKey PIN to unwrap the released blob locally.

### Finding 2.5-A — Backup Service Breach Alone Is Insufficient; Attacker Still Needs YubiKey and PIN

**Severity:** Low  
**Feasibility:** Theoretical without additional capabilities  
**Adversary relevance:** All adversary types (Low)

If an attacker gains access to the backup service's storage (database breach, insider threat, server compromise), they obtain the wrapped decryption key blob. The blob is encrypted under a YubiKey-derived key. Without the physical YubiKey and its PIN:

- The blob is cryptographically opaque.
- Brute-forcing a YubiKey-derived key offline is infeasible if the YubiKey uses a properly-derived key (e.g., PBKDF2 with a strong PIN against the YubiKey's key derivation hardware).

**The design is sound for this threat.** The backup service holding only the wrapped blob — and never the unwrapped decryption key — means that a breach of the backup service's storage alone is not a recovery path for an attacker. This is the intended security property and appears correctly implemented.

**Residual concern:** The backup service knows the holder's notification channels and cancellation credentials (to implement the 72-hour window). A breach of the backup service's metadata (not just the blob) leaks the holder's email, phone number, and secondary contacts — which could facilitate the notification suppression attack described in Finding 2.3-B.

**Mitigation options:**
1. The backup service should minimize the metadata it retains — specifically, consider whether notification channel information can be held client-side and submitted at recovery initiation rather than stored server-side.
2. The backup service should use separate encryption for blob storage vs. notification channel metadata, so a database breach does not expose both.

---

### Finding 2.5-B — State Compulsion Plus YubiKey Seizure Can Complete Recovery Without Holder Knowledge

**Severity:** Low (but Medium for state actors)  
**Feasibility:** Theoretical for most adversaries; Practical for state actors with detention authority  
**Adversary relevance:** State actor (Medium), Criminal org (Low), Individual abuser (Low)

A state actor with legal authority over the backup service and physical custody of the holder can:

1. **Compel the backup service** to accept a recovery request without sending notifications — or to cooperate fully with a recovery without starting the 72-hour window.
2. **Seize the YubiKey** during detention (border crossing, arrest, search).
3. **Compel the PIN** under legal or physical coercion.
4. Combine these to complete recovery silently, obtaining the keyring decryption key.

In this scenario, the 72-hour notification window provides no protection because the state has compelled the service to bypass it. The multi-channel notification is effective only if the state cannot also control those channels — which a state with legal compulsion authority over domestic telecom and email providers may be able to do.

**What this gives the state:** The keyring decryption key → decrypt the IPFS keyring blob → all of the holder's master private keys → ability to issue new sub-cards under the holder's identity and sign messages attributed to the holder.

**The practical limiting factor:** Physical custody of the holder is required for YubiKey seizure. Border crossings and detentions are the realistic scenarios. The attack is therefore targeted and labor-intensive — it cannot be applied at scale without physical confrontation.

**Mitigation options:**
1. The spec should recommend that high-risk holders (journalists, activists) use a YubiKey backup stored separately from their person (e.g., with a trusted third party in a different jurisdiction). A YubiKey that cannot be seized cannot be used.
2. The 72-hour window should be long enough that a detained holder can communicate their situation through a legal channel. The configurable window (mentioned as P1) is relevant here.
3. The spec should note the border crossing threat model explicitly in the key management section — YubiKey-based recovery is not a reliable protection against state actors with detention authority.

---

## Phase 2 Milestone Review

### Blast-Radius Hierarchy Confirmed

Across the five key tiers, the blast-radius ordering (widest to narrowest) is:

1. **Press sub-card key** — Write authority to the registry for all cards under the press's policies. Backdated silent 9xx revocations are the most severe weaponized attack path. Revocation of a compromised press now requires governance quorum under ADR-011, introducing response latency.

2. **Policy authorizer key** — Can modify IPFS policy content in ways that silently degrade all existing credentials. Cannot authorize new presses on-chain (ADR-011 governance gate), substantially limiting the previous worst-case blast radius.

3. **Auditor key** — Exposes all historical issuance records with no forward secrecy. High value for intelligence; no protocol-level control available to mitigate past exposure after compromise.

4. **Holder full keyring** — Complete identity takeover for one holder. Limited by the 72-hour window (which has a known bypass if notification channels are controlled).

5. **Holder sub-card key only** — Attacker can impersonate one device for the holder. Holder can recover via master key; recovery speed depends on press availability.

### Cross-Phase Notes for Reviewers

The following Phase 2 findings have direct implications for Phase 3:

- **Finding 2.2-A** (backdated silent 9xx revocation) feeds directly into Phase 3, Step 3.1-B2 (state actor with trust root control — retroactive de-platforming) and Step 3.3-B (abuser using credential revocation as harassment). The specific weaponization path is identical; the adversary type determines context and motivation.
- **Finding 2.1-A** (retroactive field definition changes) feeds into Phase 3, Step 3.1-B2. A government with trust root control can add required fields that existing activist credentials lack.
- **Finding 2.3-C** (physical device access / monitoring) feeds directly into Phase 3, Step 3.3-C (intimate partner keyring compromise). That step should reference this finding rather than re-deriving the threat model.
- **Finding 2.4-A** (auditor key forward secrecy gap) feeds into Phase 3, Step 3.1-A1 (state actor without trust root control — audit log as surveillance target). The issuance records are the most sensitive metadata the state could obtain without breaking the cryptography of the cards themselves.

### ADR-011 Impact Assessment for Phase 2

Finding 1.1-A from Phase 1 (the `approved_presses` on-chain enforcement gap) has been fully addressed by ADR-011. The Phase 2 analysis reflects the ADR-011 state of the spec. Reviewers should note that:

- The policy authorizer key's blast radius is now lower than Phase 1 analysis might have implied (the governance gate prevents new press authorization on-chain).
- A new risk has emerged from ADR-011: governance-controlled press revocation adds incident response latency (Finding 2.2-B). This is a consequence of the correct governance design, not a flaw — but the operational procedures for fast-track revocation must be defined in the governance charter.
- The IPFS `approved_presses` field is now an audit surface rather than an enforcement mechanism. Tooling that monitors for discrepancies between IPFS and on-chain state provides early warning of unauthorized press activity.

### Clarification Checkpoint Status

**Finding 2.2-A triggers the Phase 2 clarification checkpoint per `plans/implementation-plan.md`:**

> "If Step 2.2 finds that a compromised press key can issue a backdated 9xx revocation with `notify_holder: false` against any card in its scope — and the spec does not provide a technical counter to this — pause and flag this finding explicitly to the author."

**Confirmed:** The spec explicitly supports both backdated effective dates and `notify_holder: false` as intentional design features. There is no technical counter in the current protocol to prevent a press with a valid key from posting such an entry silently. Three mitigations are proposed (holder log polling, two-party authorization for silent 9xx, verifier-side log-head freshness), but none are currently required by the spec. Phase 3 may proceed, but this finding warrants design discussion before v1 deployment.
