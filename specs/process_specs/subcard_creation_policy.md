# Sub-Card Creation Policy

**Version:** 0.1 (draft)
**Date:** 2026-05-25
**Status:** Draft
**Applies to:** All sub-cards created under the card protocol

---

## Purpose

This policy governs the rights and constraints of the two parties involved in a sub-card's lifecycle: the **user** (the holder of the parent card, who authorized the sub-card) and the **application** (the installed app that holds the sub-card's private key). It specifies what each party may do to the sub-card's log after issuance.

This policy complements `specs/subcards.md`, which defines the sub-card creation flow. The creation flow specifies *how* sub-cards are established; this policy specifies *what may be done with them afterward*.

---

## Parties

**User:** The holder of the parent card. At issuance, the user authorized the sub-card via their wallet. After issuance, the user's wallet acts on the user's behalf for all sub-card lifecycle operations.

**Application:** The installed app that requested the sub-card and holds the sub-card private key in its hardware-scoped keystore. The application acts under the constraints of its approved keystore library and platform attestation.

---

## Privileges

### Note Writing

Both the **user** and the **application** have note-writing privileges on the sub-card.

Specifically, both parties may submit log entries with codes in the following ranges:

- **2xx** — Positive annotation (commendation, trust endorsement)
- **4xx** — Neutral annotation (informational note for verifiers)

These annotations are appended to the sub-card's append-only log and are visible to any verifier who reads the log. Notes do not change the sub-card's active status.

**Rationale:** Both parties have legitimate standing to annotate the sub-card's history. The user may note context about how the app is being used (e.g., "authorized for limited test use only"). The application may note its own operational events (e.g., "device migration initiated"). Neither party's note-writing privilege supersedes the other's; both are recorded and independently verifiable.

### Update Card Content

**Neither** the user nor the application has privileges to update the sub-card's content fields after issuance.

Specifically, neither party may submit log entries with codes in the following ranges for the purpose of modifying sub-card field values:

- **1xx** — Positive update (linked successor / additional card)
- **3xx** — Neutral field update
- **5xx** — Programmatic field update
- **7xx** — Privilege reduction / field change

**Rationale:** Sub-cards are intentionally immutable after issuance. Their capabilities (what the app may do, which parent card is delegated) are fixed at creation. Allowing post-issuance field updates would create ambiguity about what the user originally authorized and would undermine the auditable consent model. If the user wishes to change the capabilities granted to an app, the correct path is to revoke the existing sub-card (8xx) and create a new one with the desired capability set.

The one exception is `valid_until` refresh (code 301, neutral field update). This is explicitly **not permitted** under this policy. If a sub-card expires, it must be re-created through the full sub-card request flow; it cannot be silently extended.

**Disambiguation: 5xx on the sub-card vs. 510/511/512 on the parent card.** The prohibition above covers 5xx entries **on the sub-card's own log** — no party may post them there, full stop. This is a separate matter from codes 510 (subcard addition), 511 (subcard removal), and 512 (subcard key rotation), which are posted to the **holder's master/parent card's log** to maintain that card's `active_subcards` directory (`protocol-objects.md §1.1`). The holder posting a 510/511/512 entry on their own master card is not an exception to this policy — it is a different log entirely, governed by the hardcoded holder-only authorization rule in `update_codes.md §5xx`, not by this sub-card creation policy.

### Revocation — 8xx (Quiet)

Both the **user** and the **application** have 8xx (quiet) revocation privileges on the sub-card.

Either party may submit a revocation log entry with any code in the 8xx range:

| Code | Meaning in sub-card context |
|---|---|
| 800 | Sub-card authorization ended; app departed in good standing |
| 801 | Voluntary surrender by holder (user revoked the app's authorization) |
| 810 | Sub-card's signing key compromised |
| 811 | App installation lost or uninstalled; this sub-card only |

**Rationale:**

The user may revoke at any time without cause — this is equivalent to revoking an OAuth grant. The application may also revoke its own sub-card (e.g., on uninstall), which is a cooperative act that keeps the card ecosystem clean. An 8xx revocation signals "authorization has ended; the holder is not considered a risk." Historical statements signed with the sub-card before the revocation's `effective_date` remain trusted.

### Revocation — 9xx (Loud)

**Neither** the user nor the application has 9xx (loud) revocation privileges on the sub-card.

9xx revocations ("bad actor / harmful conduct") on sub-cards are reserved exclusively for the **trust-and-safety governance body** or the **parent card's policy authorizer**, not for the two direct parties.

**Rationale:**

A 9xx revocation is a loud public signal that may harm the reputations of other cards the holder uses. Neither the user nor the application is a neutral party: the user might issue a false 9xx against an app in retaliation, and an app might issue a false 9xx against a user to harm their reputation. Only the trust-and-safety governance body, operating under its published criteria, has the standing and accountability to make that determination. 9xx revocations for sub-cards are therefore governed exclusively by the trust-and-safety annotation escalation process (see `specs/subcards.md §Trust-and-Safety Integration`).

---

## Formal Policy Expression

The following is the machine-readable expression of the above privileges, in the predicate syntax defined in `card_protocol_spec.md §Background`:

```json
{
  "revocation_permissions": {
    "8xx": {
      "any_of": [
        { "is_holder": true },
        { "is_issuer": true }
      ]
    },
    "9xx": {
      "issued_under_template": "<trust-and-safety-governance-policy-id>"
    }
  },
  "field_definitions": [
    {
      "name": "notes",
      "type": "append-only-array",
      "item_type": "text",
      "required": false,
      "description": "Annotations from authorized parties (user or application).",
      "update_policy": {
        "any_of": [
          { "is_holder": true },
          { "is_issuer": true }
        ]
      }
    }
  ],
  "default_field_update_policy": "none"
}
```

**Notes:**
- `"is_holder": true` matches the user (the holder of the sub-card, which is the user's wallet acting for the parent card holder).
- `"is_issuer": true` matches the application (which signed the sub-card acceptance and submitted it to the press, and is therefore the issuance-time signatory for the sub-card's lifecycle operations).
- `"default_field_update_policy": "none"` means no other fields may be updated by any party after issuance unless explicitly defined here. This is not a standard field in the current spec and should be treated as a policy-level declaration that the press enforces.
- The 9xx revocation predicate references a dedicated trust-and-safety governance policy whose `policy_id` CID must be specified before this policy goes live.

---

## Enforcement

The press enforces this policy mechanically at update time:

- An 8xx revocation intent signed by either the user's active sub-card or the app's installation card satisfies the `revocation_permissions.8xx` predicate and is accepted.
- A 9xx revocation intent not signed by a card issued under the trust-and-safety governance policy is rejected.
- A field update intent (codes 1xx–7xx) for any field other than `notes` is rejected regardless of signer.
- A `notes` append intent signed by either the user or the application satisfies the `notes.update_policy` predicate and is accepted.

---

## Policy Lifecycle

This policy itself is a card, governed by the standard card update model. Changes to this policy require the policy authorizer's signature. Policy updates do not retroactively change the privileges of already-issued sub-cards; those cards are anchored to the `policy_id` CID at their time of issuance per the standard policy compliance rule in `card_protocol_spec.md §Background`.
