# Update Codes — Canonical Registry

**Version:** 0.1 (draft)
**Date:** 2026-06-14
**Status:** Canonical

This is the authoritative registry of update codes for the Card Protocol. All other documents that reference specific codes cross-reference this registry. Before using any new code in a specification, add it here first.

---

## Code Ranges

| Range | Semantics | Entry type | Card status after |
|---|---|---|---|
| 1xx | Positive update — the holder has earned additional standing, often by linking to a new card (e.g. a promotion). | `field_update` | Active |
| 2xx | Positive context — an annotation indicating the holder is deserving of additional trust; no field changes implied. | `field_update` | Active |
| 3xx | Neutral update — a field change with no trust implication (e.g. a `valid_until` refresh). | `field_update` | Active |
| 4xx | Neutral context — pertinent information added for verifiers that carries no positive or negative trust signal. | `field_update` | Active |
| 5xx | Programmatic update — an automated field change triggered by protocol or policy logic, not relevant yo the trustworthiness of the card. | `field_update` | Active |
| 6xx | Negative context — an annotation suggesting reduced trustworthiness that does not yet warrant revocation. | `field_update` | Active |
| 7xx | Negative update — a field change that reduces the holder's privileges (e.g. removing admin rights). Within the 7xx range, lower subcodes indicate the reduction is honorable (retiring with distinction); higher subcodes indicate it is less so. | `field_update` | Active |
| 8xx | Quiet revocation — the card is revoked; the holder is not considered an active risk to other communities. The holder's standing in other contexts is unaffected by this revocation alone. | `revocation` | Revoked |
| 9xx | Loud revocation — the card is revoked and the holder may pose risks to other communities. Verifiers operating multi-card communities may wish to notify issuers of other cards they have seen this holder use. | `revocation` | Revoked |

Entries with codes 1xx–7xx use `field_updates` and do not carry an `effective_date`; the update takes effect at the time it is posted. Entries with codes 8xx–9xx are revocations and carry an `effective_date` that may be earlier than the posting date — the updater is asserting when the relevant condition began.

---

## Defined Codes

### 1xx — Positive Updates

| Code | Meaning | Authority |
|---|---|---|
| 100 | Linked successor — planned key rotation or advancement (holder-initiated); sets the `successor` field with a mutable pointer to the new card | `{ "is_holder": true }` |
| 101 | Linked successor — emergency rotation (holder-initiated; prior key potentially compromised); sets the `successor` field | `{ "is_holder": true }` |
| 102 | Linked successor — issuer-initiated card recovery; sets the `successor` field with a 72-hour pending window | `{ "is_issuer": true }` |
| 103 | Issuer-initiated recovery rotation cancelled by holder; references the pending code-102 entry by log CID | `{ "is_holder": true }` |

**Notes on 1xx:**
- Codes 100 and 101 are holder-initiated; code 102 is issuer-initiated; code 103 is holder cancellation of a pending issuer-initiated rotation.
- A code-102 entry carries a `pending_until` field and is not effective until that timestamp elapses without a code-103 cancellation.
- Codes 100 and 101 are used for master card key rotation; see `key_rotation.md §2.3` and `§2.4`. Codes 102 and 103 are used for the issuer-recovery flow; see `key_rotation.md §2.6`.

### 2xx — Positive Context

| Code | Meaning |
|---|---|
| 200 | Positive annotation — general commendation or trust endorsement |

### 3xx — Neutral Updates

| Code | Meaning |
|---|---|
| 300 | Neutral field update — general |
| 301 | Valid-until refresh |

### 4xx — Neutral Context

| Code | Meaning |
|---|---|
| 400 | Neutral annotation — informational note for verifiers |

### 5xx — Programmatic Updates

| Code | Meaning |
|---|---|
| 500 | Programmatic field update |
| 510 | Subcard addition |
| 511 | Subcard removal |
| 512 | Subcard key rotation |

### 6xx — Negative Context

| Code | Meaning |
|---|---|
| 600 | Negative annotation — concern noted; revocation not yet warranted |

### 7xx — Negative Updates

Within the 7xx range, lower subcodes indicate more honorable circumstances; higher subcodes indicate less so. A 700 is a dignified retirement; a 760 is rights removed following misconduct.

| Code | Meaning |
|---|---|
| 700 | Privilege reduction, honorable — retiring from a role after exemplary service |
| 750 | Privilege reduction, procedural — termed out of a responsibility; no negative implication |
| 760 | Privilege reduction, unfavorable — rights removed following misconduct, short of revocation |

### 8xx — Quiet Revocations

| Code | Meaning |
|---|---|
| 800 | Quiet revocation — role ended; departed in good standing |
| 801 | Quiet revocation — voluntary surrender by holder |
| 810 | Quiet revocation — this card's signing key compromised |
| 811 | Quiet revocation — sub-card lost or stolen (this card only) |

**Notes on 8xx:**
- Code 811 applies to a specific sub-card (device-bound, app-specific credential). It does not revoke the holder's primary card or other sub-cards. See `key_rotation.md §1.3`.
- Code 810 applies when the master signing key of a card is believed compromised. See `key_rotation.md §2.5`.
- Code 801 is holder-initiated voluntary surrender, e.g. when performing a planned key rotation (the old card is surrendered after the successor is established).

### 9xx — Loud Revocations

| Code | Meaning |
|---|---|
| 900 | Loud revocation — credential obtained under false pretenses |
| 901 | Loud revocation — policy violation identified post-issuance |
| 910 | Loud revocation — full wallet compromise suspected |
| 911 | Loud revocation — bad actor or harmful conduct |

**Notes on 9xx:**
- Code 910 signals that both the master key and one or more sub-card keys may be compromised. See `key_rotation.md §5`.
- 9xx revocations are a signal, not an automatic action, against other cards held by the same identity. Propagation is a social protocol, not cryptographic enforcement.
- The default `revocation_permissions` allows issuers to issue any 9xx code; holders may only issue 910 (self-compromise) if the policy explicitly permits it. See `card_protocol_spec.md §1`.

---

## Historical Signature Semantics

| Range | Historical signatures |
|---|---|
| 1xx–7xx | Fully trusted; the card was not revoked at any point. |
| 8xx | Trusted before effective date. The revocation signals a change of state, not a claim that prior actions were invalid. |
| 9xx | Trusted before effective date; suspect or invalid on or after it. Verifiers should apply judgment based on the subcode and context. |

---

## Adding New Codes

To define a new code:
1. Choose a code in the appropriate range (1xx–9xx).
2. Add it to the relevant table in this document with a clear, unambiguous meaning.
3. Update any specification documents that use the new code to reference this document.
4. Within each hundred, use lower numbers for more favorable outcomes and higher numbers for less favorable ones (consistent with the 7xx convention).

---

## Cross-References

- `card_protocol_spec.md §Background Concepts — The Update & Revocation Code System` — range descriptions, verification semantics, and historical signature semantics
- `key_rotation.md §8.2` — 1xx codes (100–103) for key rotation
- `key_rotation.md §1.3` — code 811 for sub-card emergency rotation
- `key_rotation.md §2.5` — code 810 for master key compromise
- `key_rotation.md §5` — code 910 for full wallet compromise
