# Sub-Mark Creation — Red-Team Plan

**Version:** 0.1 (draft)
**Date:** 2026-05-25
**Status:** Draft
**Companion spec:** [specs/submarks.md](../specs/submarks.md)
**Related policy:** [policies/submark_creation_policy.md](../policies/submark_creation_policy.md)

---

## Overview

This red-team plan analyzes attack scenarios against the sub-mark creation flow and lifecycle. It covers four distinct adversary roles, each with different goals, capabilities, and attack surfaces. For each adversary, we enumerate specific attack vectors, assess severity and likelihood, and propose mitigations.

The sub-mark flow introduces new attack surfaces not present in the baseline mark protocol: the per-installation mark, the wallet-to-app offer exchange, the trust-and-safety registry gate, and the capability delegation model. Each of these surfaces is examined below.

---

## Adversary 1: Malicious Application

**Goal:** Sign false statements or gain illicit access using users' marks.

**Attacker profile:** An application developer who has published an app through legitimate distribution channels (App Store, Play Store) with the intention of exploiting the sub-mark mechanism to forge statements, harvest credentials, or access services the user did not intend to authorize.

### Attack Vectors

#### 1.1 — Capability Escalation After Issuance

**Description:** The app is granted limited capabilities at sub-mark issuance (e.g., note-writing only). After the sub-mark is live, the app attempts to sign statements with scopes beyond what was granted — presenting the sub-mark as if it had full signing authority.

**Analysis:** The sub-mark's capability set is committed to in the sub-mark document and signed by both the wallet and the app at issuance. Verifiers who check the sub-mark's capability fields will reject signatures for operations the sub-mark was not authorized to perform. However, verifiers who trust the sub-mark's existence without checking capability fields are vulnerable.

**Severity:** High — a verifier that does not check sub-mark capabilities will accept false statements.
**Likelihood:** Medium — requires that verifiers omit capability checks, which is an implementation gap.
**Mitigation:** The verification library MUST surface sub-mark capabilities as part of the structured verification result. Verifiers MUST check `can_sign_statements` and scope-specific capability fields before accepting a signature. The npm package documentation should make this mandatory, not optional.

#### 1.2 — Re-use of Installation Mark Across Multiple Sub-Mark Requests

**Description:** An app generates a single installation mark, uses it to obtain a sub-mark from one user, and then presents the same installation mark to a second user to request a sub-mark — effectively linking two users' delegated marks to the same installation identity.

**Analysis:** The installation mark is per-installation, not per-user. If two users happen to use the same installation (shared device, enterprise deployment), both sub-marks would chain to the same installation mark. This is a privacy issue (cross-user correlation), not a forgery issue, but a malicious app on a multi-user device could intentionally exploit it.

**Severity:** Medium — enables correlation of multiple users' sub-marks.
**Likelihood:** Low — most app installs are single-user.
**Mitigation:** The wallet should warn users when an installation mark has previously been associated with another user's sub-mark. The sub-mark spec should recommend that apps generate new installation marks on user account switch, not just on app reinstall.

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
**Mitigation:** The wallet MUST verify that the attestation is fresh (contains the sub-mark request's timestamp or nonce as the challenge). Attestations older than a defined TTL (recommended: 5 minutes) MUST be rejected. The wallet MUST send a wallet-generated nonce to the app for inclusion in the attestation challenge.

#### 1.5 — Silent Mark Exfiltration via Encrypted Backup Channel

**Description:** The app requests the `can_receive_encrypted_backup` capability. After receiving it, the app exports the encrypted backup to an app-controlled server, then attempts to brute-force the passphrase offline.

**Analysis:** The encrypted backup is protected by the user's passphrase. If the passphrase is strong, offline brute-force is infeasible. However, the `can_receive_encrypted_backup` capability represents a meaningful data exfiltration risk even if the contents are currently encrypted.

**Severity:** Medium — encrypted backup is useless without the passphrase, but its exfiltration is still a meaningful indicator of malicious intent.
**Likelihood:** Medium — the capability is optional, but a malicious app would request it.
**Mitigation:** The `can_receive_encrypted_backup` capability MUST default to `false` and MUST require explicit user acknowledgment of what "encrypted backup" means before granting. The wallet SHOULD recommend against granting this capability to apps that are not the user's own backup app. Trust-and-safety auditors SHOULD flag apps that request this capability without a documented legitimate use case.

---

## Adversary 2: Malicious User

**Goal:** Use the sub-mark protocol to attack a benign application — e.g., to exhaust the app's rate limits, impersonate other users, or abuse the app's reliance on mark-signed statements.

**Attacker profile:** A user who holds a legitimate mark and installs a benign app, but uses the sub-mark mechanism as a vector to disrupt or attack the app's functionality.

### Attack Vectors

#### 2.1 — Sub-Mark Issuance Spam

**Description:** The user generates many sub-mark requests for the same app, creating a large number of sub-marks and associated on-chain registrations. This could exhaust the app's tolerance for managing many active sub-marks, or could be used to fill the registry with noise.

**Analysis:** Each sub-mark registration requires the app to pay gas. A user cannot force the app to pay gas; the app pays only when it submits a completed sub-mark to the press. A user who sends many sub-mark requests that the app never accepts creates no on-chain cost and no registry noise.

**Severity:** Low — the cost model prevents this attack.
**Likelihood:** Low.
**Mitigation:** The spec already places gas cost on the app. No additional mitigation needed, but the spec should explicitly note that the app is not required to submit all offers it receives.

#### 2.2 — Sub-Mark Flooding to Degrade App Performance

**Description:** The user sends a flood of sub-mark requests to the app's delivery endpoint, attempting to overwhelm the app's offer-processing queue or trigger crashes.

**Analysis:** Sub-mark request delivery is over Nym or HTTPS. The app's delivery endpoint is an implementation detail not specified by the protocol; standard rate-limiting and queue management apply.

**Severity:** Low — standard DoS risk, not sub-mark-specific.
**Likelihood:** Low.
**Mitigation:** Apps SHOULD implement per-user rate limiting on sub-mark requests. The spec should recommend this as a best practice.

#### 2.3 — Using a Sub-Mark to Sign False Statements Against the App

**Description:** The user obtains a sub-mark and uses it to sign false statements (e.g., in a forum, a review, or a complaint record) that harm the app's reputation or its other users.

**Analysis:** The sub-mark is a delegation of the user's mark. The user's mark is the identity unit. False statements signed with a sub-mark are attributable to the parent mark holder. The app (verifier) evaluates statements by walking the sub-mark's chain to the parent mark; the user's identity is visible at the chain's root. This is not qualitatively different from the baseline mark-based false statement risk — it is the same user making the same false statement, just via a different signing key.

**Severity:** Medium — but this is a baseline mark protocol risk, not a sub-mark-specific one.
**Likelihood:** Medium.
**Mitigation:** The sub-mark spec should clarify that sub-mark signatures are attributable to the parent mark holder. Verifiers MUST surface the parent mark identity (not just the sub-mark identity) when displaying the source of a signed statement. The chain walk surfaces the user's identity; apps that display only the sub-mark identifier without the parent mark context are creating a misleading UI.

#### 2.4 — Revocation Harassment

**Description:** The user repeatedly grants and revokes sub-marks to the same app, creating log noise and potentially disrupting the app's per-user state management.

**Analysis:** 8xx revocations are legitimate operations. The cost of revocation is borne by the revocation submitter (the user, who pays gas via the press). Repeated revoke-and-reissue cycles create on-chain cost for the user, not the app.

**Severity:** Low — economically self-limiting for the user.
**Likelihood:** Low.
**Mitigation:** The press may impose a minimum interval between revocation and re-issuance for the same (user, app) pair. Apps may also decline to process new sub-mark requests from users who have exceeded a revocation frequency threshold.

---

## Adversary 3: Third-Party Observer

**Goal:** Upon encountering a sub-mark, identify sensitive data about the mark holder — their identity, other marks they hold, behavioral patterns, or affiliations.

**Attacker profile:** A verifier, a network observer, or a data aggregator who sees sub-mark signatures in the wild and attempts to de-anonymize or profile the mark holder.

### Attack Vectors

#### 3.1 — Cross-App Sub-Mark Correlation

**Description:** An observer collects sub-mark signatures from multiple services. Each sub-mark chains to the same parent mark. If the same parent mark mutable pointer appears in sub-marks for App A and App B, the observer knows the same person uses both apps.

**Analysis:** This is an inherent property of the mark model. The parent mark mutable pointer is a stable pseudonymous identifier; its presence in multiple sub-marks is a direct cross-app correlation signal. This is the same unlinkability limitation noted in the baseline protocol's authentication spec.

**Severity:** High — enables cross-app behavioral profiling.
**Likelihood:** Medium — requires an observer with access to signed content from multiple services.
**Mitigation:** The sub-mark spec should note this explicitly and recommend that users who require strong unlinkability use separate parent marks per service. The wallet SHOULD offer an "isolated sub-mark" option that issues a fresh parent mark as the delegation root for a specific app, so the app's sub-mark does not chain to the user's primary marks. This adds issuance cost but breaks the correlation.

#### 3.2 — Sub-Mark as a Mark Inventory Inference Attack

**Description:** An observer who sees that a user holds sub-marks for App A, App B, and App C can infer the full set of contexts in which the user is active, even without seeing the parent mark or its content.

**Analysis:** Sub-marks are created at user initiative (the user chose to grant them). Each sub-mark's existence in the registry is public (or at least visible to anyone who resolves the mutable pointer). An adversary who has enumerated a user's mutable pointers can build a behavioral profile from the set of apps they have granted sub-marks to.

**Severity:** Medium — this is a structural privacy issue with the public registry model.
**Likelihood:** Medium — requires the adversary to know the user's parent mark mutable pointer (which may already be public).
**Mitigation:** The "Selectively shared" and "Fully private" privacy modes from `ARCHITECTURE.md §ADR-006` apply to sub-marks as well. Users who hold privacy-sensitive marks SHOULD issue sub-marks in private mode, where the registry address is derived from a secret and the CID is encrypted. Verifiers must hold the capability bundle to resolve these sub-marks. The sub-mark spec should explicitly recommend private mode for sensitive use cases.

#### 3.3 — Timing and Network Correlation

**Description:** An observer on the network sees Arbitrum One transactions and Nym traffic patterns correlated with sub-mark issuance. Even if the content is encrypted, the timing and volume of transactions can be correlated with known user activity.

**Analysis:** The Nym mixnet is specifically designed to obscure timing and volume, but persistent traffic analysis at scale is a known limitation of mix networks. On-chain transactions are public; their timing is visible even if their content is encrypted.

**Severity:** Low — this is a baseline Nym and public chain risk, not sub-mark-specific.
**Likelihood:** Low — requires a sophisticated, large-scale traffic analysis adversary.
**Mitigation:** No sub-mark-specific mitigation. The general Nym and privacy posture mitigations in `ARCHITECTURE.md` apply.

---

## Adversary 4: Malicious App Installer / Data Harvester

**Goal:** Use the sub-mark protocol as a data collection mechanism to harvest and aggregate sensitive information about users — specifically, the set of marks they hold.

**Attacker profile:** An app developer (or an app that has been compromised by a data broker) that uses the sub-mark request flow as a mechanism to learn about the user's credential holdings, which may reveal their affiliations, employment, community memberships, or identity.

### Attack Vectors

#### 4.1 — Predicate-Based Mark Inventory Discovery

**Description:** The app sends sub-mark requests with predicates that enumerate a large space of possible mark types. By observing whether the wallet shows each predicate as satisfied (wallet shows the user a consent prompt with matching marks) or unsatisfied (no prompt), the app learns which marks the user holds.

**Analysis:** The wallet presents a consent screen only when a predicate is satisfied. If the app can distinguish "predicate satisfied" from "predicate unsatisfied" responses, it can run a binary search over mark types to enumerate the user's holdings. However, the consent flow is user-mediated: the user sees all requests and must actively approve or dismiss each one. An app cannot make requests silently without user visibility.

**Severity:** High — can reveal highly sensitive identity information if the user approves predicates without careful review.
**Likelihood:** Medium — requires user interaction per request, limiting automation, but a cleverly framed UX could obscure the enumeration.
**Mitigation:** The wallet MUST NOT reveal predicate satisfaction to the app until the user explicitly approves the sub-mark. A "no matching marks" response must be indistinguishable (from the app's perspective) from "user declined." The wallet SHOULD rate-limit sub-mark requests from the same app, both per-session and across sessions, to prevent enumeration through repeated requests.

#### 4.2 — Sub-Mark Request as Profile-Building Mechanism

**Description:** The app requests sub-marks for many different mark types in a single session, each with a human-readable justification that obscures the true purpose. The user approves a subset. The app learns from the user's approval/denial pattern which marks the user holds and which they are sensitive about.

**Analysis:** Even if the app cannot directly enumerate marks, the approval pattern itself is informative. An app that sends 20 predicate requests and observes which 5 the user approved has learned something about the user's credential holdings.

**Severity:** Medium — the approval pattern leaks information even without direct predicate satisfaction disclosure.
**Likelihood:** Medium.
**Mitigation:** The wallet SHOULD aggregate all requested predicates from a single sub-mark request into a single consent screen, presented simultaneously, rather than sequentially. This prevents the app from using sequential approval/denial timing as a signal. The wallet SHOULD also limit the number of predicates per sub-mark request to a protocol-defined maximum (recommended: 5).

#### 4.3 — Sub-Mark Log as Behavioral Data Source

**Description:** The app uses its 4xx note-writing privilege to annotate the sub-mark log with timestamped records of every user action within the app (e.g., "user viewed article X", "user made purchase Y"). These notes are appended to the mark's public append-only log, permanently recording behavioral data in a user-controlled but publicly-readable record.

**Analysis:** The 4xx note-writing privilege is intentionally available to the app (per the submark_creation_policy). However, the policy does not constrain what the notes contain. An app could use this as a surveillance mechanism, writing detailed behavioral logs to the user's mark.

**Severity:** High — this creates a permanent, public behavioral record tied to the user's identity.
**Likelihood:** Medium — the app has an incentive to use this mechanism for data persistence.
**Mitigation:** The policy SHOULD specify a maximum note size and a minimum semantic constraint (notes must be user-facing, not raw behavioral telemetry). The wallet SHOULD preview any note the app intends to write before it is submitted, requiring explicit user acknowledgment for notes above a size threshold or with suspicious content patterns. The trust-and-safety audit process SHOULD flag apps that write behavioral telemetry to sub-mark logs.

#### 4.4 — Cross-Device Sub-Mark Re-Use to Track User Location

**Description:** The app collects the installation mark public keys and the sub-mark mutable pointers from all of its users. Because the installation mark is per-install (not per-device), and sub-marks chain to the parent mark, the app can correlate all of a user's installations with a single identity — including tracking when the user installs the app on a new device.

**Analysis:** The installation mark is used only during the offer exchange and does not appear in the final registered sub-mark. The sub-mark's parent mark pointer is the correlation vector. If the user uses the same parent mark across devices, all sub-marks on all devices chain to the same parent pointer.

**Severity:** Medium — enables cross-device tracking, but only within the same app.
**Likelihood:** High — this is a natural consequence of the architecture and requires no adversarial intent.
**Mitigation:** This is a known limitation of the parent mark correlation model (see Adversary 3, Attack 3.1). For users who install the same app on multiple devices, the isolated sub-mark option (separate parent mark per app) is the strongest mitigation. The wallet SHOULD recommend this for apps that have cross-device data collection in their privacy policy.

---

## Summary: Risk Matrix

| ID | Adversary | Attack | Severity | Likelihood | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| 1.1 | Malicious App | Capability escalation | High | Medium | Capability fields in spec | Verification library must enforce |
| 1.2 | Malicious App | Installation mark reuse | Medium | Low | Per-install key design | Wallet warning needed |
| 1.3 | Malicious App | Version-pinned audit bypass | High | Medium | EAS annotations | Audit must be version-specific |
| 1.4 | Malicious App | Forged/replayed attestation | High | Medium | Platform attestation required | Fresh nonce required in attestation |
| 1.5 | Malicious App | Encrypted backup exfiltration | Medium | Medium | Encryption protects contents | Capability should default off + explicit consent |
| 2.1 | Malicious User | Sub-mark issuance spam | Low | Low | Gas cost on app | No additional action needed |
| 2.3 | Malicious User | False statements | Medium | Medium | Chain attribution | Verifiers must surface parent mark |
| 3.1 | Observer | Cross-app correlation | High | Medium | Baseline limitation | Isolated sub-mark option needed |
| 3.2 | Observer | Mark inventory inference | Medium | Medium | Private mode available | Private mode recommended in spec |
| 4.1 | Data Harvester | Predicate enumeration | High | Medium | User-mediated consent | "Unsatisfied" must be undisclosed |
| 4.2 | Data Harvester | Approval pattern profiling | Medium | Medium | Partial | Aggregate predicates in single screen |
| 4.3 | Data Harvester | Behavioral log via notes | High | Medium | None | Note size limits + wallet preview needed |
| 4.4 | Data Harvester | Cross-device tracking | Medium | High | Baseline limitation | Isolated sub-mark for multi-device users |

---

## Priority Findings

The following findings represent the highest-priority gaps to address before the sub-mark spec is finalized:

**Finding S-1 (Critical):** The verification library must enforce sub-mark capability checks. This is a silent failure mode if omitted — verifiers accept unauthorized statements without error.

**Finding S-2 (Critical):** Platform attestations must include a wallet-generated nonce to prevent replay. Without this, a captured attestation can authorize a sub-mark for a different user.

**Finding S-3 (High):** Trust-and-safety audit status must be version-specific. The annotation record must include `audited_version`; the wallet must check it matches the requesting app version.

**Finding S-4 (High):** Predicate enumeration via consent-flow observation must be blocked. The wallet must not reveal predicate satisfaction to the app before user approval; "unsatisfied" and "declined" must be indistinguishable from the app's perspective.

**Finding S-5 (High):** Note-writing abuse as behavioral surveillance needs explicit mitigation. A note size limit and wallet preview requirement should be added to the sub-mark creation policy.

**Finding S-6 (High):** Cross-app correlation via parent mark pointer is a structural risk. The spec should prominently document this and describe the isolated sub-mark option as the mitigation for users requiring strong unlinkability.
