# Sub-Card Creation — Red-Team Plan

**Version:** 0.1 (draft)
**Date:** 2026-05-25
**Status:** Draft
**Companion spec:** [specs/subcards.md](../specs/subcards.md)
**Related policy:** [policies/subcard_creation_policy.md](../policies/subcard_creation_policy.md)

---

## Overview

This red-team plan analyzes attack scenarios against the sub-card creation flow and lifecycle. It covers four distinct adversary roles, each with different goals, capabilities, and attack surfaces. For each adversary, we enumerate specific attack vectors, assess severity and likelihood, and propose mitigations.

The sub-card flow introduces new attack surfaces not present in the baseline card protocol: the per-installation card, the wallet-to-app offer exchange, the trust-and-safety registry gate, and the capability delegation model. Each of these surfaces is examined below.

---

## Adversary 1: Malicious Application

**Goal:** Sign false statements or gain illicit access using users' cards.

**Attacker profile:** An application developer who has published an app through legitimate distribution channels (App Store, Play Store) with the intention of exploiting the sub-card mechanism to forge statements, harvest credentials, or access services the user did not intend to authorize.

### Attack Vectors

#### 1.1 — Capability Escalation After Issuance

**Description:** The app is granted limited capabilities at sub-card issuance (e.g., note-writing only). After the sub-card is live, the app attempts to sign statements with scopes beyond what was granted — presenting the sub-card as if it had full signing authority.

**Analysis:** The sub-card's capability set is committed to in the sub-card document and signed by both the wallet and the app at issuance. Verifiers who check the sub-card's capability fields will reject signatures for operations the sub-card was not authorized to perform. However, verifiers who trust the sub-card's existence without checking capability fields are vulnerable.

**Severity:** High — a verifier that does not check sub-card capabilities will accept false statements.
**Likelihood:** Medium — requires that verifiers omit capability checks, which is an implementation gap.
**Mitigation:** The verification library MUST surface sub-card capabilities as part of the structured verification result. Verifiers MUST check `can_sign_statements` and scope-specific capability fields before accepting a signature. The npm package documentation should make this mandatory, not optional.

#### 1.2 — Re-use of Installation Card Across Multiple Sub-Card Requests

**Description:** An app generates a single installation card, uses it to obtain a sub-card from one user, and then presents the same installation card to a second user to request a sub-card — effectively linking two users' delegated cards to the same installation identity.

**Analysis:** The installation card is per-installation, not per-user. If two users happen to use the same installation (shared device, enterprise deployment), both sub-cards would chain to the same installation card. This is a privacy issue (cross-user correlation), not a forgery issue, but a malicious app on a multi-user device could intentionally exploit it.

**Severity:** Medium — enables correlation of multiple users' sub-cards.
**Likelihood:** Low — most app installs are single-user.
**Mitigation:** The wallet should warn users when an installation card has previously been associated with another user's sub-card. The sub-card spec should recommend that apps generate new installation cards on user account switch, not just on app reinstall.

#### 1.3 — Bypassing the Trust-and-Safety Gate via Version Pinning

**Description:** The app is registered and audited at version 1.0 (which uses the approved keystore library). At version 1.1, the app introduces a second, undeclared keystore interaction path. The trust-and-safety annotation board still shows the app as "audited" because the 1.0 audit status was not invalidated.

**Analysis:** The wallet checks for an audit status annotation on the app's EAS record. If the trust-and-safety scanning pipeline does not automatically invalidate prior audit status when a new version is published, a malicious app can escape scrutiny by shipping a clean audited version first and a malicious version later.

**Severity:** High — an undetected keystore bypass in a new version could enable key exfiltration or unauthorized signing.
**Likelihood:** Medium — requires that the scanning pipeline fail to re-audit on new version.
**Mitigation:** Audit status annotations MUST be version-specific. The wallet MUST check the audit annotation for the currently installed version, not just for any version of the app. The trust-and-safety governance body MUST set a policy requiring new audits for any version increment that touches cryptographic code paths. The annotation record should include an `audited_version` field; the wallet checks that `audited_version` matches `app_version` in the request.

#### 1.4 — Forged App Attestation

**Description:** The app constructs a fake or replayed platform attestation (iOS App Attest certificate / Android Play Integrity token) to bypass the wallet's attestation check.

**Analysis:** Both iOS App Attest and Android Play Integrity are attested by Apple/Google respectively. Forging these requires compromising Apple's or Google's attestation infrastructure, which is beyond typical adversary capability. However, replayed attestations from a prior session are a realistic concern.

**Severity:** High if successful — an app that bypasses attestation check can masquerade as a legitimate app.
**Likelihood:** Low (forged) to Medium (replayed).
**Mitigation:** The wallet MUST verify that the attestation is fresh (contains the sub-card request's timestamp or nonce as the challenge). Attestations older than a defined TTL (recommended: 5 minutes) MUST be rejected. The wallet MUST send a wallet-generated nonce to the app for inclusion in the attestation challenge.

#### 1.5 — Silent Card Exfiltration via Encrypted Backup Channel

**Description:** The app requests the `can_receive_encrypted_backup` capability. After receiving it, the app exports the encrypted backup to an app-controlled server, then attempts to brute-force the passphrase offline.

**Analysis:** The encrypted backup is protected by the user's passphrase. If the passphrase is strong, offline brute-force is infeasible. However, the `can_receive_encrypted_backup` capability represents a meaningful data exfiltration risk even if the contents are currently encrypted.

**Severity:** Medium — encrypted backup is useless without the passphrase, but its exfiltration is still a meaningful indicator of malicious intent.
**Likelihood:** Medium — the capability is optional, but a malicious app would request it.
**Mitigation:** The `can_receive_encrypted_backup` capability MUST default to `false` and MUST require explicit user acknowledgment of what "encrypted backup" means before granting. The wallet SHOULD recommend against granting this capability to apps that are not the user's own backup app. Trust-and-safety auditors SHOULD flag apps that request this capability without a documented legitimate use case.

---

## Adversary 2: Malicious User

**Goal:** Use the sub-card protocol to attack a benign application — e.g., to exhaust the app's rate limits, impersonate other users, or abuse the app's reliance on card-signed statements.

**Attacker profile:** A user who holds a legitimate card and installs a benign app, but uses the sub-card mechanism as a vector to disrupt or attack the app's functionality.

### Attack Vectors

#### 2.1 — Sub-Card Issuance Spam

**Description:** The user generates many sub-card requests for the same app, creating a large number of sub-cards and associated on-chain registrations. This could exhaust the app's tolerance for managing many active sub-cards, or could be used to fill the registry with noise.

**Analysis:** Each sub-card registration requires the app to pay gas. A user cannot force the app to pay gas; the app pays only when it submits a completed sub-card to the press. A user who sends many sub-card requests that the app never accepts creates no on-chain cost and no registry noise.

**Severity:** Low — the cost model prevents this attack.
**Likelihood:** Low.
**Mitigation:** The spec already places gas cost on the app. No additional mitigation needed, but the spec should explicitly note that the app is not required to submit all offers it receives.

#### 2.2 — Sub-Card Flooding to Degrade App Performance

**Description:** The user sends a flood of sub-card requests to the app's delivery endpoint, attempting to overwhelm the app's offer-processing queue or trigger crashes.

**Analysis:** Sub-card request delivery is over Nym or HTTPS. The app's delivery endpoint is an implementation detail not specified by the protocol; standard rate-limiting and queue management apply.

**Severity:** Low — standard DoS risk, not sub-card-specific.
**Likelihood:** Low.
**Mitigation:** Apps SHOULD implement per-user rate limiting on sub-card requests. The spec should recommend this as a best practice.

#### 2.3 — Using a Sub-Card to Sign False Statements Against the App

**Description:** The user obtains a sub-card and uses it to sign false statements (e.g., in a forum, a review, or a complaint record) that harm the app's reputation or its other users.

**Analysis:** The sub-card is a delegation of the user's card. The user's card is the identity unit. False statements signed with a sub-card are attributable to the parent card holder. The app (verifier) evaluates statements by walking the sub-card's chain to the parent card; the user's identity is visible at the chain's root. This is not qualitatively different from the baseline card-based false statement risk — it is the same user making the same false statement, just via a different signing key.

**Severity:** Medium — but this is a baseline card protocol risk, not a sub-card-specific one.
**Likelihood:** Medium.
**Mitigation:** The sub-card spec should clarify that sub-card signatures are attributable to the parent card holder. Verifiers MUST surface the parent card identity (not just the sub-card identity) when displaying the source of a signed statement. The chain walk surfaces the user's identity; apps that display only the sub-card identifier without the parent card context are creating a misleading UI.

#### 2.4 — Revocation Harassment

**Description:** The user repeatedly grants and revokes sub-cards to the same app, creating log noise and potentially disrupting the app's per-user state management.

**Analysis:** 8xx revocations are legitimate operations. The cost of revocation is borne by the revocation submitter (the user, who pays gas via the press). Repeated revoke-and-reissue cycles create on-chain cost for the user, not the app.

**Severity:** Low — economically self-limiting for the user.
**Likelihood:** Low.
**Mitigation:** The press may impose a minimum interval between revocation and re-issuance for the same (user, app) pair. Apps may also decline to process new sub-card requests from users who have exceeded a revocation frequency threshold.

---

## Adversary 3: Third-Party Observer

**Goal:** Upon encountering a sub-card, identify sensitive data about the card holder — their identity, other cards they hold, behavioral patterns, or affiliations.

**Attacker profile:** A verifier, a network observer, or a data aggregator who sees sub-card signatures in the wild and attempts to de-anonymize or profile the card holder.

### Attack Vectors

#### 3.1 — Cross-App Sub-Card Correlation

**Description:** An observer collects sub-card signatures from multiple services. Each sub-card chains to the same parent card. If the same parent card mutable pointer appears in sub-cards for App A and App B, the observer knows the same person uses both apps.

**Analysis:** This is an inherent property of the card model. The parent card mutable pointer is a stable pseudonymous identifier; its presence in multiple sub-cards is a direct cross-app correlation signal. This is the same unlinkability limitation noted in the baseline protocol's authentication spec.

**Severity:** High — enables cross-app behavioral profiling.
**Likelihood:** Medium — requires an observer with access to signed content from multiple services.
**Mitigation:** The sub-card spec should note this explicitly and recommend that users who require strong unlinkability use separate parent cards per service. The wallet SHOULD offer an "isolated sub-card" option that issues a fresh parent card as the delegation root for a specific app, so the app's sub-card does not chain to the user's primary cards. This adds issuance cost but breaks the correlation.

#### 3.2 — Sub-Card as a Card Inventory Inference Attack

**Description:** An observer who sees that a user holds sub-cards for App A, App B, and App C can infer the full set of contexts in which the user is active, even without seeing the parent card or its content.

**Analysis:** Sub-cards are created at user initiative (the user chose to grant them). Each sub-card's existence in the registry is public (or at least visible to anyone who resolves the mutable pointer). An adversary who has enumerated a user's mutable pointers can build a behavioral profile from the set of apps they have granted sub-cards to.

**Severity:** Medium — this is a structural privacy issue with the public registry model.
**Likelihood:** Medium — requires the adversary to know the user's parent card mutable pointer (which may already be public).
**Mitigation:** The "Selectively shared" and "Fully private" privacy modes from `ARCHITECTURE.md §ADR-006` apply to sub-cards as well. Users who hold privacy-sensitive cards SHOULD issue sub-cards in private mode, where the registry address is derived from a secret and the CID is encrypted. Verifiers must hold the capability bundle to resolve these sub-cards. The sub-card spec should explicitly recommend private mode for sensitive use cases.

#### 3.3 — Timing and Network Correlation

**Description:** An observer on the network sees Arbitrum One transactions and Nym traffic patterns correlated with sub-card issuance. Even if the content is encrypted, the timing and volume of transactions can be correlated with known user activity.

**Analysis:** The Nym mixnet is specifically designed to obscure timing and volume, but persistent traffic analysis at scale is a known limitation of mix networks. On-chain transactions are public; their timing is visible even if their content is encrypted.

**Severity:** Low — this is a baseline Nym and public chain risk, not sub-card-specific.
**Likelihood:** Low — requires a sophisticated, large-scale traffic analysis adversary.
**Mitigation:** No sub-card-specific mitigation. The general Nym and privacy posture mitigations in `ARCHITECTURE.md` apply.

---

## Adversary 4: Malicious App Installer / Data Harvester

**Goal:** Use the sub-card protocol as a data collection mechanism to harvest and aggregate sensitive information about users — specifically, the set of cards they hold.

**Attacker profile:** An app developer (or an app that has been compromised by a data broker) that uses the sub-card request flow as a mechanism to learn about the user's credential holdings, which may reveal their affiliations, employment, community memberships, or identity.

### Attack Vectors

#### 4.1 — Predicate-Based Card Inventory Discovery

**Description:** The app sends sub-card requests with predicates that enumerate a large space of possible card types. By observing whether the wallet shows each predicate as satisfied (wallet shows the user a consent prompt with matching cards) or unsatisfied (no prompt), the app learns which cards the user holds.

**Analysis:** The wallet presents a consent screen only when a predicate is satisfied. If the app can distinguish "predicate satisfied" from "predicate unsatisfied" responses, it can run a binary search over card types to enumerate the user's holdings. However, the consent flow is user-mediated: the user sees all requests and must actively approve or dismiss each one. An app cannot make requests silently without user visibility.

**Severity:** High — can reveal highly sensitive identity information if the user approves predicates without careful review.
**Likelihood:** Medium — requires user interaction per request, limiting automation, but a cleverly framed UX could obscure the enumeration.
**Mitigation:** The wallet MUST NOT reveal predicate satisfaction to the app until the user explicitly approves the sub-card. A "no matching cards" response must be indistinguishable (from the app's perspective) from "user declined." The wallet SHOULD rate-limit sub-card requests from the same app, both per-session and across sessions, to prevent enumeration through repeated requests.

#### 4.2 — Sub-Card Request as Profile-Building Mechanism

**Description:** The app requests sub-cards for many different card types in a single session, each with a human-readable justification that obscures the true purpose. The user approves a subset. The app learns from the user's approval/denial pattern which cards the user holds and which they are sensitive about.

**Analysis:** Even if the app cannot directly enumerate cards, the approval pattern itself is informative. An app that sends 20 predicate requests and observes which 5 the user approved has learned something about the user's credential holdings.

**Severity:** Medium — the approval pattern leaks information even without direct predicate satisfaction disclosure.
**Likelihood:** Medium.
**Mitigation:** The wallet SHOULD aggregate all requested predicates from a single sub-card request into a single consent screen, presented simultaneously, rather than sequentially. This prevents the app from using sequential approval/denial timing as a signal. The wallet SHOULD also limit the number of predicates per sub-card request to a protocol-defined maximum (recommended: 5).

#### 4.3 — Sub-Card Log as Behavioral Data Source

**Description:** The app uses its 4xx note-writing privilege to annotate the sub-card log with timestamped records of every user action within the app (e.g., "user viewed article X", "user made purchase Y"). These notes are appended to the card's public append-only log, permanently recording behavioral data in a user-controlled but publicly-readable record.

**Analysis:** The 4xx note-writing privilege is intentionally available to the app (per the subcard_creation_policy). However, the policy does not constrain what the notes contain. An app could use this as a surveillance mechanism, writing detailed behavioral logs to the user's card.

**Severity:** High — this creates a permanent, public behavioral record tied to the user's identity.
**Likelihood:** Medium — the app has an incentive to use this mechanism for data persistence.
**Mitigation:** The policy SHOULD specify a maximum note size and a minimum semantic constraint (notes must be user-facing, not raw behavioral telemetry). The wallet SHOULD preview any note the app intends to write before it is submitted, requiring explicit user acknowledgment for notes above a size threshold or with suspicious content patterns. The trust-and-safety audit process SHOULD flag apps that write behavioral telemetry to sub-card logs.

#### 4.4 — Cross-Device Sub-Card Re-Use to Track User Location

**Description:** The app collects the installation card public keys and the sub-card mutable pointers from all of its users. Because the installation card is per-install (not per-device), and sub-cards chain to the parent card, the app can correlate all of a user's installations with a single identity — including tracking when the user installs the app on a new device.

**Analysis:** The installation card is used only during the offer exchange and does not appear in the final registered sub-card. The sub-card's parent card pointer is the correlation vector. If the user uses the same parent card across devices, all sub-cards on all devices chain to the same parent pointer.

**Severity:** Medium — enables cross-device tracking, but only within the same app.
**Likelihood:** High — this is a natural consequence of the arcardecture and requires no adversarial intent.
**Mitigation:** This is a known limitation of the parent card correlation model (see Adversary 3, Attack 3.1). For users who install the same app on multiple devices, the isolated sub-card option (separate parent card per app) is the strongest mitigation. The wallet SHOULD recommend this for apps that have cross-device data collection in their privacy policy.

---

## Summary: Risk Matrix

| ID | Adversary | Attack | Severity | Likelihood | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| 1.1 | Malicious App | Capability escalation | High | Medium | Capability fields in spec | Verification library must enforce |
| 1.2 | Malicious App | Installation card reuse | Medium | Low | Per-install key design | Wallet warning needed |
| 1.3 | Malicious App | Version-pinned audit bypass | High | Medium | EAS annotations | Audit must be version-specific |
| 1.4 | Malicious App | Forged/replayed attestation | High | Medium | Platform attestation required | Fresh nonce required in attestation |
| 1.5 | Malicious App | Encrypted backup exfiltration | Medium | Medium | Encryption protects contents | Capability should default off + explicit consent |
| 2.1 | Malicious User | Sub-card issuance spam | Low | Low | Gas cost on app | No additional action needed |
| 2.3 | Malicious User | False statements | Medium | Medium | Chain attribution | Verifiers must surface parent card |
| 3.1 | Observer | Cross-app correlation | High | Medium | Baseline limitation | Isolated sub-card option needed |
| 3.2 | Observer | Card inventory inference | Medium | Medium | Private mode available | Private mode recommended in spec |
| 4.1 | Data Harvester | Predicate enumeration | High | Medium | User-mediated consent | "Unsatisfied" must be undisclosed |
| 4.2 | Data Harvester | Approval pattern profiling | Medium | Medium | Partial | Aggregate predicates in single screen |
| 4.3 | Data Harvester | Behavioral log via notes | High | Medium | None | Note size limits + wallet preview needed |
| 4.4 | Data Harvester | Cross-device tracking | Medium | High | Baseline limitation | Isolated sub-card for multi-device users |

---

## Priority Findings

The following findings represent the highest-priority gaps to address before the sub-card spec is finalized:

**Finding S-1 (Critical):** The verification library must enforce sub-card capability checks. This is a silent failure mode if omitted — verifiers accept unauthorized statements without error.

**Finding S-2 (Critical):** Platform attestations must include a wallet-generated nonce to prevent replay. Without this, a captured attestation can authorize a sub-card for a different user.

**Finding S-3 (High):** Trust-and-safety audit status must be version-specific. The annotation record must include `audited_version`; the wallet must check it matches the requesting app version.

**Finding S-4 (High):** Predicate enumeration via consent-flow observation must be blocked. The wallet must not reveal predicate satisfaction to the app before user approval; "unsatisfied" and "declined" must be indistinguishable from the app's perspective.

**Finding S-5 (High):** Note-writing abuse as behavioral surveillance needs explicit mitigation. A note size limit and wallet preview requirement should be added to the sub-card creation policy.

**Finding S-6 (High):** Cross-app correlation via parent card pointer is a structural risk. The spec should prominently document this and describe the isolated sub-card option as the mitigation for users requiring strong unlinkability.
