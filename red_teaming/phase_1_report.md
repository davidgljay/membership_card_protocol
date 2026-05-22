# Phase 1 Red-Team Report — Mark Protocol v0.3
## Zero-Click Infrastructure Attacks

**Date:** 2026-05-22  
**Scope:** Steps 1.1–1.4 per `plans/implementation-plan.md`  
**Sources reviewed:** `specs/ARCHITECTURE.md`, `specs/chitt_protocol_spec.md`, `specs/protocol-objects.md`, `mark-validator/src/`, `plans/strategic-plan.md`, `raw_notes/`

---

## ⚠ Critical Finding Alert

**One finding is flagged as requiring author review before Phase 2 proceeds.**

> **Finding 1.1-A — `approved_presses` On-Chain Enforcement Mechanism Is Under-Specified**
>
> The specification states that the Arbitrum One registry contract must reject writes from presses not in the policy's `approved_presses` field, but `approved_presses` is stored in the IPFS policy chitt — which the Stylus contract cannot read. The on-chain mechanism that enforces this gate is not specified, and the closest description in the spec ("checks the press sub-chitt's own registry entry and confirms it is not revoked") describes only revocation checking, not membership checking. If the contract implementation relies solely on revocation status rather than an explicit `approved_presses` membership check, any non-revoked press sub-chitt could write to any policy's registry entries — a Critical vulnerability.
>
> **Recommended action:** Author should clarify the on-chain enforcement mechanism for `approved_presses` membership before Phase 2 begins. See §1.1 for full analysis.

---

## Executive Summary

Phase 1 assessed four infrastructure attack surfaces: the Arbitrum One Stylus contract, the IPFS content layer, the Nym mixnet gateway, and the press service. Sixteen distinct findings emerged across the four steps, with the following severity distribution:

| Severity | Count |
|---|---|
| Critical (requires author clarification) | 1 (conditional) |
| High | 8 |
| Medium | 6 |
| Low | 1 |

The protocol's strongest structural protection is its dual-signature model: because the holder generates their own keypair and countersigns every issued mark, a compromised press cannot forge credentials that bind to an existing holder's identity. This is a meaningful and well-implemented constraint that limits the blast radius of most press-layer attacks.

The protocol's most significant weakness at the infrastructure layer is the combination of (a) undocumented on-chain enforcement of `approved_presses` membership, (b) IPFS pinning having no protocol-level enforcement or verification, and (c) the Nym gateway address being a stable, observable endpoint tied to the holder's identity. These three weaknesses compound: a coerced or compromised press can create a "soft revocation" effect through de-pinning without posting a formal 9xx entry, and a state actor who observes the Nym gateway can correlate mark identity to physical location with high precision.

The `notify_holder: false` feature — confirmed as an intentional design choice — is a High-severity finding in the press key exfiltration scenario. A compromised or compelled press can silently post a backdated 9xx revocation against any mark in its policy scope, with the holder discovering the revocation only on their next authentication attempt.

---

## Findings Table

| Step | ID | Finding | Severity | State Actor | Criminal Org | Individual Abuser |
|---|---|---|---|---|---|---|
| 1.1 | 1.1-A | `approved_presses` on-chain enforcement under-specified | **Critical (conditional)** | High | High | Low |
| 1.1 | 1.1-B | Gas griefing via valid-signature / invalid-calldata transactions | Medium | Medium | Low | Theoretical |
| 1.1 | 1.1-C | Serialization BINARY_FIELDS gaps in mark-validator | Medium | Low | Low | Low |
| 1.1 | 1.1-D | ML-DSA-44 Stylus conformance not yet validated | Low | Low | Low | Low |
| 1.2 | 1.2-A | De-pinning as soft revocation — verification denial | **High** | High | Medium | Low |
| 1.2 | 1.2-B | Policy chitt unavailability cascades to all issued marks | **High** | High | Medium | Low |
| 1.2 | 1.2-C | Selective revocation record suppression via split-view IPFS | Medium | High | Medium | Theoretical |
| 1.3 | 1.3-A | DoS flooding forces privacy-degrading transport fallback | **High** | High | High | Medium |
| 1.3 | 1.3-B | State-actor traffic correlation: IP → mark identity → site | **High** | High | Theoretical | Theoretical |
| 1.3 | 1.3-C | Criminal org targeted de-anonymization via relying-party control | **High** | N/A | High | Low |
| 1.3 | 1.3-D | Gateway endpoint as stable activity oracle | **High** | High | Medium | Medium |
| 1.3 | 1.3-E | De-anonymization consequence: full authentication context exposure | **High** | High | High | Low |
| 1.4 | 1.4-A | Press key compromise enables backdated silent 9xx revocation | **High** | High | High | Medium |
| 1.4 | 1.4-B | Legal compulsion produces rich metadata stream despite encrypted audit log | **High** | High | Low | Low |
| 1.4 | 1.4-C | Press as single point of failure blocks 810 self-revocations | Medium | Medium | Medium | Medium |
| 1.4 | 1.4-D | Selective censorship of update intents is undetectable without multi-press | Medium | Medium | High | Medium |

---

## Step 1.1 — Arbitrum One Stylus Contract Audit

### Context

The Arbitrum One registry contract is the protocol's write gate. Every new mark entry and every log-head update must be signed by a press sub-chitt key, verified on-chain via a Stylus (WASM) implementation of ML-DSA-44. The contract enforces that only presses listed in the governing policy's `approved_presses` may write to marks under that policy. ML-DSA-44 keys are 1,312 bytes; signatures are 2,420 bytes. Full on-chain verification was explicitly chosen over a hash-commitment shortcut.

### Finding 1.1-A — `approved_presses` On-Chain Enforcement Mechanism Is Under-Specified

**Severity:** Critical (conditional) — depends on implementation  
**Feasibility:** Theoretical pending spec clarification; Practical if incorrectly implemented  
**Adversary relevance:** State actor (High), Criminal org (High), Individual abuser (Low)

The acceptance criterion states: "A press sub-chitt whose mutable pointer does not appear in `approved_presses` is rejected by the Arbitrum One registry contract." However, `approved_presses` is a `chitt-pointer-array` field inside the policy chitt document, which is stored on IPFS — not on-chain. A Stylus contract running in the EVM cannot fetch IPFS content.

The architectural description in `ARCHITECTURE.md` says the contract "verifies this by checking the press sub-chitt's own registry entry (which is on-chain) and confirming it is not revoked." This description covers only revocation status, not `approved_presses` membership. If this is the actual implementation, the write gate checks only that the signing press sub-chitt's on-chain entry exists and is not revoked — but does not verify that the policy authorizer has approved that press for the specific policy being written to. Under this implementation, any valid, non-revoked press sub-chitt could write registry entries for any policy, including policies whose authorizer has never approved that press.

**Three possible implementations, only one of which is safe:**

1. **On-chain `approved_presses` registry (safe):** The policy authorizer submits a transaction registering approved press addresses in a contract-side mapping (`policyAddress → [approvedPressAddresses]`). Writes are checked against this mapping. This requires a separate "register press" transaction flow not described in the spec.
2. **Calldata-provided `approved_presses` with CID verification (safe but expensive):** The press provides the full policy chitt content as calldata; the contract verifies the CID matches the on-chain head pointer for the policy, then checks `approved_presses`. Expensive in calldata terms but correct.
3. **Revocation-only check (unsafe):** The contract only verifies that the press sub-chitt is not revoked on-chain, without checking `approved_presses` membership. This is the interpretation supported by the current spec text.

**If implementation option 3 is deployed:** any party who obtains any valid, non-revoked press sub-chitt — even one authorized for a different policy or issued for a test deployment — can write arbitrary log entries to any chitt in the registry. This includes posting fraudulent 9xx revocations against marks in policies that never authorized the attacker's press.

**Mitigation:** The spec must explicitly describe the on-chain mechanism for `approved_presses` enforcement before the contract is deployed. Recommend option 1 (explicit on-chain press registry per policy, maintained by the policy authorizer key). This is a blocking issue per the Phase 1 milestone review criteria.

---

### Finding 1.1-B — Gas Griefing via Valid-Signature / Invalid-Calldata Transactions

**Severity:** Medium  
**Feasibility:** Practical  
**Adversary relevance:** State actor (Medium), Criminal org (Low), Individual abuser (Theoretical)

An attacker with a valid press sub-chitt key (even for an unrelated policy) can construct transactions that pass ML-DSA-44 signature verification but fail subsequent checks (wrong policy, revoked target chitt, expired offer). Because Stylus runs ML-DSA-44 verification before any application-level checks, each such transaction burns the full verification cost (~expensive WASM computation over 2,420-byte signatures + 1,312-byte keys) before reverting.

On Arbitrum One, gas costs per transaction are approximately 10–50x cheaper than Ethereum mainnet (~$0.02–$0.25 per write). A sustained griefing attack requires the attacker to fund many transactions. For the current low-volume deployment, this is not an existential threat, but it could create gas spikes during time-sensitive operations (e.g., a press needing to post a revocation during an incident).

**Severity rationale:** Medium rather than High because Arbitrum One's low gas costs limit the attack's leverage. The attacker spends real ETH to cause modest disruption.

**Mitigation:** Move application-level checks (press authorization, policy match) before the ML-DSA-44 verification step in the Stylus contract. Cheap integer comparisons and mapping lookups should gate the expensive cryptographic computation.

---

### Finding 1.1-C — Serialization BINARY_FIELDS Gaps in mark-validator

**Severity:** Medium  
**Feasibility:** Practical (exists today in the codebase)  
**Adversary relevance:** Low for all adversary types (correctness bug, not security hole)

The `mark-validator/src/serialization.ts` BINARY_FIELDS set is missing several chitt-pointer fields that Appendix A of the spec requires to be encoded as CBOR byte strings rather than text strings. Missing fields:

- `target_chitt` — present in `UpdateIntentPayload`, signed by the updater
- `updater_chitt` — present in `UpdateIntentPayload`, signed by the updater
- `requester_chitt` — present in `AuthenticationRequest`, signed by the requester
- `chitt_pointer` — present in `AuthenticationResponse`

When the validator canonicalizes an `UpdateIntentPayload` for intent signature verification, `target_chitt` and `updater_chitt` are encoded as CBOR text strings (major type 3) instead of byte strings (major type 2). This means:

1. The bytes being verified differ from the bytes the spec mandates.
2. A press implementation built from the spec (rather than from the validator code) would produce incompatible signatures.
3. Intent signature verification would fail across independent implementations even when the signatures are actually valid.
4. An attacker who knows about this discrepancy could craft inputs that verify under the buggy implementation but not under a correct one, potentially enabling cross-implementation inconsistency.

This is a conformance bug, not a signature forgery vector — the validator consistently uses the wrong encoding in both signing and verification, so it is internally consistent. But it breaks cross-implementation interoperability and violates the spec.

**Mitigation:** Add `target_chitt`, `updater_chitt`, `requester_chitt`, and `chitt_pointer` to `BINARY_FIELDS` in `serialization.ts`. Add conformance test cases for `UpdateIntentPayload` and `AuthenticationRequest` to the corpus.

---

### Finding 1.1-D — ML-DSA-44 Stylus Conformance Not Yet Validated

**Severity:** Low  
**Feasibility:** Theoretical  
**Adversary relevance:** Low for all adversary types

The spec notes (OQ-2, action items in ADR-010) that the Stylus WASM CBOR implementation has not been validated against the serialization conformance corpus. If the Stylus verifier uses slightly different CBOR encoding rules (e.g., different binary field handling, different map key sorting), it will fail to verify legitimately signed transactions. This is a correctness risk (legitimate transactions rejected) rather than a security risk (unauthorized transactions accepted), because a serialization mismatch would cause valid signatures to appear invalid, not vice versa.

**Mitigation:** Complete the action item from ADR-010: "Validate Stylus WASM CBOR implementation against the full conformance test corpus before contract deployment." This is listed as a blocking pre-deployment task.

---

## Step 1.2 — IPFS Content Availability Attacks

### Context

The on-chain registry holds only the current log head CID per mark. All content — the genesis ChittDocument, every LogEntry, the policy chitt, and the press issuance log — lives on IPFS and persists only while someone is pinning it. Presses are contractually responsible for pinning but the protocol has no on-chain mechanism to verify pinning status or to prevent targeted de-pinning. The `mark-validator` fetches IPFS content in `getAllLogEntries()` and propagates fetch failures as errors.

### Finding 1.2-A — De-Pinning as Soft Revocation: Verification Denial

**Severity:** High  
**Feasibility:** Practical (requires control of the press or its pinning infrastructure)  
**Adversary relevance:** State actor (High), Criminal org (Medium), Individual abuser (Low)

A press operator (or anyone who has compromised or coerced the press's pinning infrastructure) can stop pinning a specific holder's mark log. The on-chain head CID pointer remains intact, but when a verifier calls `getAllLogEntries()`, the IPFS fetch fails. The validator propagates this as "Chain walk failed" — the mark is unverifiable, not definitively valid or revoked.

In practice, how services handle "unverifiable" depends on their implementation. A conservative service treats unverifiable as a denial (the holder cannot authenticate). A permissive service treats it as a pass (the holder authenticates anyway). For security-critical deployments serving the protocol's target populations (activists, journalists), the conservative posture is correct — and thus de-pinning becomes a soft revocation.

This attack has several properties that make it attractive over a formal 9xx revocation:
- **No signed evidence**: There is no on-chain log entry. The attack leaves no cryptographic trace attributable to the press.
- **Deniable**: The press can claim IPFS content was unavailable due to technical issues rather than deliberate suppression.
- **Targeted**: The press can de-pin specific holders' mark logs while leaving others intact, enabling selective credential invalidation.
- **No 72-hour window**: Unlike key recovery, there is no notification window. The victim discovers the problem only when they try to authenticate.

**Adversary application by tier:**
- *State actor*: Compels the press (or the press's IPFS pinning service) to stop pinning marks associated with specific activists or journalists. Targeted, deniable, leaves no formal revocation record.
- *Criminal org*: If operating a press, can de-pin competitor community members' credentials to disrupt rival schemes.
- *Individual abuser*: Would need to compromise press infrastructure — unlikely without elevated access.

**Mitigation options:**
1. Require holders to operate their own IPFS pins (self-pinning) alongside the press pin. The client caches recently-fetched CIDs locally, providing short-term resilience.
2. Filecoin archival (mentioned in ADR-002 as optional) should be promoted to a recommended requirement for any policy serving high-risk populations.
3. A protocol-level "content freshness" check — verifiers that receive IPFS timeouts should flag the mark as unverifiable-pending rather than invalid, and retry from multiple gateways before concluding unavailability.

---

### Finding 1.2-B — Policy Chitt Unavailability Cascades to All Issued Marks

**Severity:** High  
**Feasibility:** Practical (same pinning control as 1.2-A)  
**Adversary relevance:** State actor (High), Criminal org (Medium), Individual abuser (Low)

If the policy chitt's IPFS content is de-pinned or becomes unavailable, the consequences are broader than de-pinning an individual mark:

- Verifiers cannot evaluate the `field_definitions` to confirm a mark's fields are policy-compliant.
- Verifiers cannot resolve `approved_presses` to confirm the issuing press was authorized.
- The policy creation compliance check (§7, stage 5a) fails entirely.
- Auditors cannot read the press issuance log (which is anchored to the policy chitt's log).
- Any mark issued under the policy is now unverifiable for policy-compliance purposes, even if the mark's own log is still pinned.

The on-chain head CID for the policy still exists, so the policy is not formally revoked. But any service that performs full verification (including policy compliance) will reject all marks under the policy.

This is effectively a community-wide credential disruption achievable by targeting a single IPFS entry (the policy chitt content), rather than de-pinning each holder's mark individually.

**Adversary application by tier:**
- *State actor*: Targeting a community's policy chitt content disrupts all credentials for that community simultaneously, without any formal action that could be legally contested.
- *Criminal org*: Less motivated, but could disrupt a competitor's trust ecosystem.

**Mitigation options:**
1. Require that policy chitt content be replicated across at least N IPFS nodes before the Arbitrum One registry pointer is updated (OQ-3 in ARCHITECTURE.md is the open question for this threshold).
2. Filecoin archival for policy chitts specifically should be treated as mandatory for any policy with real-world consequences.
3. Client-side caching of policy chitt content, with explicit version tracking to detect when cached content has gone stale.

---

### Finding 1.2-C — Selective Revocation Record Suppression via Split-View IPFS

**Severity:** Medium  
**Feasibility:** Theoretical (requires sophisticated IPFS infrastructure control)  
**Adversary relevance:** State actor (High), Criminal org (Medium), Individual abuser (Theoretical)

The on-chain head CID points to the most recent log entry. A posted 9xx revocation becomes the new head. An attacker cannot modify the head without the press key. However, a sophisticated attacker who controls IPFS gateway infrastructure can attempt a split-view attack:

**Attack mechanics:** After a 9xx revocation is posted (on-chain head now points to the 9xx entry), the attacker operates IPFS gateways that selectively serve either:
- The full chain including the 9xx entry (what honest verifiers see), or
- A crafted response that times out at the 9xx entry, causing verifiers to see "unverifiable" rather than "revoked."

Because IPFS content is content-addressed, the attacker cannot serve fake content at the correct CID — a hash mismatch would be detected. They can only refuse to serve the correct content. The result is "verification failure" at the revoked entry, not "mark appears valid."

This does not make the revoked mark appear valid to a correct implementation. It causes `chain walk failed` — not a clean validation pass. However, a permissive verifier that treats chain-walk failures as non-blocking would effectively be fooled.

**Distinction from Finding 1.2-A:** Finding 1.2-A (de-pinning before a 9xx) makes a non-revoked mark unverifiable. Finding 1.2-C (de-pinning the 9xx itself) makes a revoked mark appear unverifiable rather than revoked. The practical difference depends on verifier policy: conservative implementations reject both; permissive ones may pass both.

**Mitigation:** Verifier implementations must treat chain-walk failures as equivalent to revocation, not as verification passes. The `mark-validator` currently propagates chain-walk failures as errors (not as "valid"), which is the correct behavior. Services consuming the validator must treat error responses as denial-of-authentication.

---

## Step 1.3 — Nym Gateway Attack Surface

### Context

Each mark's metadata includes a Nym gateway address. Senders route encrypted payloads through the Nym mixnet to this gateway. For "fully public" marks the gateway address is plaintext; for private marks it is visible only to capability bundle holders. The authentication flow prefers Nym > OHTTP > HTTPS for response delivery. The gateway address is the Nym-side endpoint, held by the message server; the message server can observe when messages arrive but not their content.

### Finding 1.3-A — DoS Flooding Forces Privacy-Degrading Transport Fallback

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (High), Individual abuser (Medium)

The Nym gateway address is a real-time network endpoint. For public marks, it is plaintext in mark metadata and enumerable by any verifier. An attacker who knows the gateway address can flood it with traffic, overwhelming the gateway and preventing legitimate message delivery.

**Consequence:** When the Nym gateway is unavailable, the authentication flow falls back: Nym → OHTTP → HTTPS. The HTTPS fallback (`callbacks.https`) requires the wallet to POST the signed authentication response directly to the requesting site. The requesting site can observe the wallet service's server IP from this connection.

This is exactly the metadata exposure Nym is designed to prevent. The DoS attack does not require the attacker to read any content — it only needs to prevent the Nym transport from working. The attacker learns the wallet service's IP by observing the fallback connection (if they control or can observe the requesting site) or forces the fallback in hopes that subsequent traffic correlation is easier over HTTPS.

**Adversary application by tier:**
- *State actor*: Can target specific known gateway addresses. For a journalist or activist with a public mark, the gateway address is discoverable. A targeted DoS forces the HTTPS fallback, revealing the wallet service IP. Combined with §1.3-B correlation techniques, the IP links mark identity to physical location.
- *Criminal org*: Botnet-based flooding is straightforward. If the criminal controls the requesting site, they force the HTTPS fallback on any target who tries to authenticate to their service.
- *Individual abuser*: Needs meaningful bandwidth. Residential internet connections can sustain DoS against small gateway operators. More sophisticated abusers can use amplification attacks.

**Mitigation options:**
1. Require wallet services to implement OHTTP as the minimum fallback rather than plain HTTPS — this removes the IP exposure at the cost of slightly higher latency.
2. The spec should document that services cannot require the HTTPS fallback as a deliberate policy (i.e., if OHTTP fails, the wallet should retry Nym rather than fall back to HTTPS).
3. Gateway address rotation: allowing holders to update their Nym gateway address (already possible via the append-only log) and encouraging rotation as a counter to persistent gateway targeting.
4. Rate limiting at the Nym gateway level.

---

### Finding 1.3-B — State-Actor Traffic Correlation: IP → Mark Identity → Authentication Context

**Severity:** High  
**Feasibility:** Practical for state actors with significant Nym infrastructure  
**Adversary relevance:** State actor (High), Criminal org (Theoretical), Individual abuser (Theoretical)

Nym provides anonymity only as long as the adversary cannot correlate message entry and exit timing across enough mix nodes. A state actor with significant Nym node infrastructure — or with global passive surveillance capability over internet backbone traffic — can perform traffic correlation.

**De-anonymization mechanics:** The Nym mixnet introduces latency via mixing (layered encryption across multiple hops with Poisson-distributed delays). An adversary who observes:
- Entry: the sender's IP submitting a packet to their Nym entry node at time T
- Exit: traffic arriving at a target gateway at time T + (mixing latency), matching timing patterns

...can probabilistically correlate the message to its sender. The probability of correct correlation increases with: (a) adversary's share of Nym nodes, (b) volume of traffic analyzed, (c) predictability of when the target will send (e.g., the adversary controls the relying party site and can observe authentication request issuance time).

**What de-anonymization reveals in the authentication context:**

An authentication response sent via Nym contains:
```json
{
  "session_id": "...",
  "signed_statement": { ... "chitt_pointer": "..." },
  "chitt_pointer": "<holder's mark identity>"
}
```

A de-anonymized authentication response links:
- **Physical IP address** → device and approximate geographic location
- **Chitt pointer** → the holder's community membership identity
- **Requester's chitt** → the site being authenticated to
- **Timestamp** → when the authentication occurred

For a journalist or activist, this is: "At 14:32 on [date], IP address 192.0.2.X — geolocated to [city], used by [ISP subscriber] — presented a [community] credential to authenticate to [coordination platform]." This represents a severe privacy violation even when all cryptographic protections are functioning correctly.

**Minimum node fraction for practical de-anonymization:** Academic research on Loopix/Nym-style mixnets suggests that an adversary controlling ~20–30% of mix nodes and observing entry/exit traffic can de-anonymize specific messages with high probability over time, particularly when the adversary can generate or observe authentication requests (thus knowing when to look). State actors with significant internet infrastructure may approach this threshold.

**Mitigation options:**
1. Document explicitly in the spec that Nym provides probabilistic, not absolute, anonymity against state-level adversaries.
2. Encourage holders serving high-risk populations to use separate marks per service (as noted in the authentication spec's unlinkability section), limiting correlation to individual service pairs rather than cross-service activity patterns.
3. Future consideration: Nym gateway address rotation keyed to session, so a single IP correlation event reveals a single authentication event rather than enabling ongoing monitoring of a stable endpoint.

---

### Finding 1.3-C — Criminal Organization Targeted De-Anonymization via Relying Party Control

**Severity:** High  
**Feasibility:** Practical for well-resourced criminal organizations  
**Adversary relevance:** Criminal org (High), others (lower)

Unlike state-level traffic correlation, a criminal organization targeting a specific individual does not need global Nym node coverage. If the criminal organization controls the relying party site (the service requesting authentication), they have a timing oracle: they know exactly when they issued the authentication request, and they can observe when their HTTPS callback is called or their Nym gateway receives the response.

**Attack flow:**
1. Criminal org operates a service that community members authenticate to (e.g., a compromised community platform, or a honeypot service).
2. When a specific target authenticates, the org observes: "authentication response arrived at T" and "Nym gateway traffic from gateway address G arrived at ~T - mixing_latency."
3. Combined with Nym node operation (even partial), this narrows the entry points from which the target's Nym message could have originated.
4. Repeat across multiple authentication events to increase de-anonymization certainty.

For a determined criminal organization targeting one specific individual (e.g., a witness in a fraud case, a community leader in a community they are infiltrating), this targeted approach is more feasible than broad infrastructure-level attack.

**Mitigation:** The authentication flow's OHTTP fallback (`callbacks.ohttp`) breaks this attack if the relying party cannot observe the wallet's IP via the OHTTP relay. Encouraging OHTTP as the standard middle ground between Nym and HTTPS would reduce the criminal org's timing oracle advantage.

---

### Finding 1.3-D — Nym Gateway Address as Stable Activity Oracle

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (Medium), Individual abuser (Medium)

The Nym gateway address is a stable field in mark metadata — for public marks, it is plaintext and discoverable by anyone. Even without de-anonymizing Nym traffic, an observer who knows a mark's gateway address can learn:

- **Activity patterns**: Messages arrive at the gateway when the holder receives offers, SCIPs, authentication responses, and notifications. A spike in message arrivals may correlate with community activity events.
- **Relative timing**: The message server (which holds the gateway) "observes that messages arrived and approximately when" — per the spec. An adversary who compels or compromises the message server learns the same.
- **Liveness**: A gateway that receives no traffic may indicate the holder's mark is inactive; a surge indicates renewed activity.

The press also learns the holder's Nym gateway address from Nym-routed submission metadata. A compelled press can provide this address to a state actor, who then targets the gateway for monitoring.

**Additional concern — cross-mark correlation via shared gateway:** If a holder uses the same Nym gateway address for multiple marks (across different policies or communities), an observer who knows two of the holder's marks can confirm they share a gateway, linking otherwise pseudonymous identities.

**Mitigation options:**
1. Recommend that high-risk holders rotate their Nym gateway address periodically using the append-only log update mechanism.
2. Allow different marks to use different gateway addresses, decoupling community identities at the transport level.
3. The message server architecture (UMBRAL proxy re-encryption) already supports per-sub-mark queuing; different marks routing to different gateways is architecturally feasible.

---

### Finding 1.3-E — De-Anonymization Consequence Assessment

**Severity:** High (consequence amplifier for 1.3-B and 1.3-C)  
**Feasibility:** Practical given successful de-anonymization  
**Adversary relevance:** State actor (High), Criminal org (High), Individual abuser (Low)

This finding summarizes what de-anonymization enables, distinct from the mechanics of how it occurs (covered in 1.3-B and 1.3-C). An adversary who successfully links a Nym message to an IP address and connects it to an authentication flow obtains:

| Layer | Information gained |
|---|---|
| IP address | Device; geographic location (city/ISP level); internet service subscriber |
| Chitt pointer | Community membership; which credential was used |
| Requester's chitt | Which specific service/platform was authenticated to |
| Timestamp | When the authentication occurred |
| `required_predicate` | What type of holder the requesting site was looking for |
| Session ID | Enables correlation across multiple authentications if session IDs are not per-request-random |

For a journalist or activist:
- "Person at IP X holds [community] credential and authenticated to [coordination platform] at [time]" is intelligence that can enable physical location, identification, and surveillance.
- Repeated authentication events build an activity timeline independent of the content of communications.
- The `chitt_pointer` exposed in authentication responses is the same identifier used as the account ID on the requesting site, so the attacker can potentially match it to service-level account records if they also have access to the service.

The authentication response is designed to reveal the chitt pointer to the requester (that's how authentication works). The privacy protection is in the transport — Nym is supposed to prevent the requester from learning the wallet service's IP. De-anonymizing the transport breaks this protection completely.

---

## Step 1.4 — Press Service Attacks

### Context

The press is a networked service holding a funded Arbitrum One wallet, a press sub-chitt key, and a Nym-capable submission endpoint. It is the protocol's write intermediary: all registry writes, log updates, and revocations flow through it. The press encrypts audit log entries to auditor keys (ML-KEM) and cannot decrypt them. A press's sub-chitt pointer must appear in `approved_presses` for its writes to be accepted.

### Finding 1.4-A — Press Key Compromise Enables Backdated Silent 9xx Revocation

**Severity:** High  
**Feasibility:** Practical  
**Adversary relevance:** State actor (High), Criminal org (High), Individual abuser (Medium)

An attacker with the press's sub-chitt private key inherits write authority to the Arbitrum One registry for all marks under the press's authorized policies. The capabilities and their impact:

**What the attacker CAN do with a compromised press key:**

1. **Post backdated 9xx revocations with `notify_holder: false`**: The `UpdateIntentPayload.revocation.effective_date` can be set to any past date. With `notify_holder: false`, no Nym notification is sent. The affected holder discovers the revocation only when they next attempt to authenticate and are rejected. The revocation entry is signed only by the press — no holder countersignature is needed for revocation — so this requires no holder interaction or cooperation.

   The attack's strategic value: a backdated 9xx with code 911 ("bad actor or harmful conduct") set to a date before any specific community event creates a false narrative that the victim was already a known bad actor before that event. This is particularly damaging for activists and journalists whose credibility depends on their credential history.

2. **Register new mark entries for attacker-controlled keypairs**: The press constructs a ChittDocument for a new mark, signs it as the press, and generates an attacker-controlled holder keypair to provide the countersignature. The resulting mark has a valid press signature and a valid holder countersignature — both from the attacker. Verifiers checking the mark would see valid signatures, but the "holder" keypair has no real identity backing. This allows issuing fake credentials under compromised policies.

3. **Suppress or delay legitimate update intents**: The press can drop 810 self-revocation intents (a holder trying to revoke a compromised key), blocking the holder from invalidating their stolen credential. The attacker who also holds the holder's key benefits doubly: they can continue using the compromised key while blocking the revocation.

**What the attacker CANNOT do:**

- **Forge a mark that appears to come from an existing real holder**: The holder countersignature requires the holder's private key, which the press never holds. A mark issued with the compromised press key but with an attacker-controlled holder key will have a "holder" public key that has no prior association with the real holder's identity. A careful verifier will not find this key in the real holder's keyring or associated with prior authentication sessions.
- **Decrypt the audit log**: The audit log is encrypted to auditor public keys via ML-KEM; the press never holds the decryption material.

**Adversary application by tier:**
- *State actor (via legal compulsion or technical compromise)*: Posts 9xx revocations with `notify_holder: false` and backdated `effective_date` against specific activists. The formal revocation provides legal cover ("this person was flagged as a bad actor before the protest"). Detection requires the holder to be notified (suppressed) and to inspect their log proactively.
- *Criminal org (via infiltrated or self-operated press)*: Issues fake credentials under compromised policies to facilitate fraud schemes. Revokes legitimate credential holders from competing communities.
- *Individual abuser (if they operate a small community press)*: Posts 9xx entries against specific targets within their press's scope. Detection is difficult without multi-press validation.

**Time-to-detection:** A holder whose mark has been silently revoked with `notify_holder: false` learns about it only when:
- They attempt to authenticate somewhere and are rejected.
- They proactively poll the Arbitrum One registry for changes to their log head CID.
- Another holder in the same community notices the revocation entry in the log.

Under realistic conditions, detection may take days to weeks, particularly if the holder authenticates infrequently.

**Mitigation options (per implementation plan):**
1. Holder-initiated log polling: clients should periodically check the on-chain head CID against the last known version, alerting the holder to any new log entries.
2. Require two-party authorization for 9xx entries: the policy can be configured to require both issuer and a second authorized party to sign a 9xx revocation intent.
3. Verifier-side "last checked" freshness indicators: relying parties that see a mark should record the log-head CID at last verification; a change triggers re-verification before the next authentication is accepted.

---

### Finding 1.4-B — Legal Compulsion Produces Rich Metadata Stream Despite Encrypted Audit Log

**Severity:** High  
**Feasibility:** Practical for state actors with jurisdictional reach over the press operator  
**Adversary relevance:** State actor (High), Criminal org (Low), Individual abuser (Low)

A state actor with legal authority over a press operator can compel the press to continue operating normally while simultaneously logging all submission metadata. The press's ML-KEM encryption of audit log entries means the state cannot hand over readable audit content — but the metadata stream the press observes is itself significant intelligence.

**What a compelled press observes and can be forced to provide:**

| Observable | Information revealed |
|---|---|
| Timing and frequency of issuance requests | Community activity level; when community is active |
| Which mark pointers submit update intents | Identity of active credential holders; who is aware of their credential status |
| IP addresses of HTTPS submissions | Direct identification of submitters who don't use Nym |
| Nym gateway addresses from Nym-routed submissions | The Nym endpoint associated with each submitting mark identity |
| Whether submissions include 810 self-revocations | Which holders suspect their keys are compromised (potential intelligence awareness signal) |
| Which offers are accepted vs. declined | Community vetting decisions |

The metadata stream does not include issuance record content (encrypted to auditor keys, unreadable by the press), but it does include the *timing and volume* of issuance activity. A state actor who knows "Policy X issued 47 marks over a 3-week period in [month]" can correlate this with real-world events to identify community organizing activity.

**The Nym-routed submission gap:** A holder who routes their update intent through Nym does not expose their IP to the press. However, the Nym message carries the holder's Nym gateway address (the source of the response channel). The compelled press provides this gateway address to the state actor, who then:
1. Knows the gateway address associated with each submitting mark identity.
2. Can attempt to correlate gateway activity with physical network traffic (see §1.3-B).

Nym-only submission to presses would materially reduce the IP exposure but not eliminate the gateway address correlation risk.

**What legal compulsion cannot achieve:** The state cannot read the audit log entries (ML-KEM encrypted to auditor keys, press holds no decryption material). The state cannot issue new marks or post revocations without the press's cooperation — or unless they also have the press's private key. The audit log encryption is effective for its stated purpose.

**Mitigation options:**
1. Recommend that presses serving high-risk populations operate in jurisdictions outside the reach of the likely state adversary.
2. Self-hosted presses: the spec's docker-compose reference stack enables community-controlled press deployment. Distributing press operations across jurisdictions reduces the single-jurisdiction compulsion risk.
3. The spec should document the metadata exposure clearly so communities can make informed decisions about which press to use.

---

### Finding 1.4-C — Press as Single Point of Failure Blocks 810 Self-Revocations

**Severity:** Medium  
**Feasibility:** Practical  
**Adversary relevance:** State actor (Medium), Criminal org (Medium), Individual abuser (Medium)

The spec recommends listing multiple presses in `approved_presses` but does not require it. For small community deployments (the protocol's intended primary use case: mutual aid networks, community organizations), operating multiple independent press instances is operationally challenging.

If a community lists only one press in `approved_presses`, that press becomes a single point of failure for:
- New mark issuance (no new marks can be issued while the press is down).
- All update intents, including 810 self-revocations.
- An 810 self-revocation (code 810: "this chitt's signing key compromised") cannot be submitted if the only approved press is unavailable or has been seized. The holder cannot post the revocation via the paymaster path either, because OQ-4 ("should the protocol support direct writes from the holder via paymaster?") is unresolved in v1.

**Attack scenario:** A state actor who seizes or takes down the only approved press for an activist community simultaneously prevents new issuance, update processing, and — critically — self-revocations. If community members discover their keys may have been compromised (e.g., after a device seizure), they cannot revoke those keys because the press is unavailable. The compromised keys remain active and usable by the state.

The spec's current wording ("presses are community infrastructure... issuers should list multiple presses in `approved_presses` to ensure availability") treats multi-press as a recommendation, not a requirement. This is insufficient for communities that face active adversaries.

**Mitigation options:**
1. Promote multi-press from a recommendation to a requirement in the spec for policies that include any 8xx or 9xx revocation permissions.
2. Resolve OQ-4 to allow holder-initiated direct writes for 810 self-revocations via paymaster, bypassing the press entirely for the most time-critical revocation type.
3. Add press availability to the policy's metadata, enabling clients to pre-discover alternative presses before a single press goes offline.

---

### Finding 1.4-D — Selective Censorship of Update Intents Is Undetectable Without Multi-Press

**Severity:** Medium  
**Feasibility:** Practical  
**Adversary relevance:** State actor (Medium), Criminal org (High), Individual abuser (Medium)

A malicious press operator can silently drop specific valid update intents without key compromise and without any cryptographic trace. The press's legitimate operational authority includes accepting or rejecting intents — and there is no mechanism for a holder to prove that the press received and dropped a valid intent.

**Censorship scenarios:**
- Dropping 810 self-revocation intents: Prevents a holder from revoking a compromised key. An attacker who holds both the press key and the compromised holder key benefits: they can continue using the stolen key while blocking its revocation.
- Suppressing positive updates (1xx/2xx codes): Prevents community recognition from appearing in a holder's credential log.
- Refusing issuance requests from specific requesters or recipients: Blocks certain people from obtaining marks without any visible denial — the press simply does not respond.

**Detection threshold:** If the policy lists multiple approved presses, the holder can submit to an alternative press if one is unresponsive. But:
- The holder has no way to prove the first press received the intent.
- The press can claim the intent was never received (denial).
- With a single approved press, there is no recourse at the protocol level.

**Adversary application by tier:**
- *Criminal org (operating a press)*: Selectively censors competing community members' credential updates, degrading the community's ability to recognize trustworthy members.
- *Individual abuser (operating a small community press)*: Targets a specific individual by blocking their 810 self-revocation, then uses the victim's credential for impersonation.

**Mitigation options:**
1. Resolve OQ-4 to allow holder-initiated direct 810 writes via paymaster — the most critical use case for bypass.
2. The spec should require multiple approved presses for any policy where revocation is a defined permission.
3. Add a "press acknowledgment receipt" mechanism (mentioned in the spec as a P1 item): a press returns a signed acknowledgment of receipt before posting. This doesn't prevent censorship but provides cryptographic evidence that the intent was received.

---

## Milestone Assessment

### Summary of Top Infrastructure Findings

The two highest-severity findings from Phase 1 are:

1. **Finding 1.1-A (Critical/conditional)** — The on-chain enforcement mechanism for `approved_presses` membership is under-specified. If the contract implementation only checks revocation status rather than explicit policy membership, any valid press sub-chitt could write to any policy's registry. This requires immediate author clarification.

2. **Finding 1.4-A (High) + Finding 1.2-A (High)** — The combination of press key compromise enabling backdated silent 9xx revocations (`notify_holder: false`) and IPFS de-pinning enabling soft revocation without any formal log entry creates two distinct paths by which a coerced or compromised press can effectively revoke a holder's credentials with no immediate notification and no cryptographically attributable trail.

### Phase 1 Milestone Determination

**Conditional: Phase 2 requires author clarification on Finding 1.1-A before proceeding.**

Per the clarification checkpoint criteria in `plans/implementation-plan.md`:

> "If any Phase 1 step surfaces a Critical finding — an attack that appears to allow arbitrary writes to the registry, mass revocation of marks, or complete suppression of revocation records — pause and notify the author before continuing."

Finding 1.1-A does not confirm that arbitrary writes are possible (the spec clearly intends for `approved_presses` to be enforced on-chain), but it identifies that the mechanism for doing so is not specified and the closest description in the spec text describes only revocation checking. If the Stylus contract is implemented based on the current spec text rather than the intended design, arbitrary writes would be possible.

**Recommended action:** Author should clarify, in writing or via a spec update, how the on-chain contract verifies `approved_presses` membership — specifically, what on-chain data structure stores this authorization mapping and what transaction(s) the policy authorizer must submit to register an approved press. Once clarified, Phase 2 may proceed.

All other Phase 1 findings are High or Medium severity and do not constitute the Critical threshold requiring an immediate halt. They should be addressed before v1 deployment and will inform the Phase 2 and Phase 3 analysis (particularly the press key compromise scenario in Step 2.2 and the state-actor coercion scenarios in Step 3.1).

### Cross-Phase Notes for Reviewers

The following Phase 1 findings have direct implications for later phases:

- **Finding 1.4-A** (backdated 9xx via press key) is the infrastructure precursor to Phase 2, Step 2.2. Phase 2 should expand on the blast radius and adversary-specific harm model for this finding.
- **Finding 1.3-B/E** (Nym de-anonymization and authentication context exposure) feed directly into Phase 3, Step 3.1 (state actor scenario under Condition A — government without trust root control).
- **Finding 1.2-A** (de-pinning as soft revocation) should be revisited in Phase 3, Step 3.3 (technical abuser) as the de-pinning attack requires only press-level access, which a former press operator or insider might retain.
- **Finding 1.4-D** (selective censorship of 810 self-revocations) is closely related to the Phase 2, Step 2.3 scenario of sub-mark key compromise combined with holder revocation attempt.
