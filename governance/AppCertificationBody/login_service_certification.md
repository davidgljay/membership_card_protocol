# AppCertificationBody — Login Service Certification (Login Services)

**Status:** Draft (2026-11-08) — pending review at checkpoint CP2; publishing is checkpoint CP5  
**Parent body:** AppCertificationBody (`app_certification_body.md`)  
**Context:** `specs/process_specs/card_login.md`, `specs/subcards.md §Server Cards`, `specs/protocol-objects.md §17`, `specs/dns_resolution.md §5.3`

---

## Role and Mandate

Card login lets websites ask people to log in with a membership card. A login prompt is the most phishable thing a wallet shows, so the protocol requires every login request to be signed by a site that a certifier has vouched for and that is tied to a domain.

The AppCertificationBody's second mandate is **certifying login services**: issuing **login service cards** to organizations that run websites offering card login. A login service card lets its holder create **server cards** (sub-cards their web servers use to sign login requests) and, once bound to a domain by that domain's DNS admin, lets wallets show users which domain is asking.

This mandate is run as a separate branch so it can later move to its own governance body without changing any card chains: the branch node stays where it is; only who holds it changes.

---

## Trust Chain Structure

No new on-chain mechanism is required.

1. **Login service branch node.** The AppCertificationBody issues a card from the app-certification policy root to act as the login service branch node. Its address is what verifier operators configure as `VerifierConfig.loginServiceCertificationRoot` (`card_verifier.md §5`). It sits alongside the wallet branch and the app branch (`app_certification_body.md`).
2. **Login service certifier cards.** Issued from the branch node to AppCertificationBody members (or delegated certifiers) who review login services.
3. **Login service policy and cards.** Certifiers issue login service cards under a login service policy whose chain passes through the branch node. Login service cards are ordinary cards; certifiers are listed as auditors on the login service policy, as for app cards.
4. **Domain binding.** After issuance, the domain's full-domain DNS admin card signs a `DomainBindingAttestation`, which the site operator adds to the card with a code-520 update. A login service card without a binding cannot be used for login.
5. **Server cards.** The site operator creates sub-cards of the login service card with the login service card as their own `app_card` (`attestation_level: "S1"`). A login service card cannot act as `app_card` for anyone else's sub-cards; presses (`P-26`) and verifiers (`LOGIN_SERVICE_SCOPE`) reject it.

---

## Issuance Requirements

Before issuing a login service card, a certifier confirms:

- The applicant is an identifiable organization or person who operates the site(s) the card will be used for.
- The applicant controls the domain, or has a written delegation from the domain owner. (The DNS admin's attestation is the technical proof; this is the human check that precedes it.)
- The applicant has read and agreed to the obligations below.
- The applicant keeps this card dedicated to login: no personal-device sub-cards on it (login responses are delivered to every sub-card of the login service card).

---

## Login Service Obligations

Certified login services must:

- **Ask honestly.** A login request's `purpose` and `statement` must describe what the user is doing. No requests designed to collect signatures for other uses.
- **Bind sessions correctly.** Implement the `state` cookie and one-time code rules in `card_login.md`. Do not complete logins by polling.
- **Protect server card keys.** Keep them in a key provider (KMS, HSM, or protected storage); set `valid_until`; deregister server cards for decommissioned servers.
- **Use one login service card per domain owner.** Do not share a login service card or its server cards across unrelated organizations.
- **Report domain changes.** If the domain is sold, lapses, or changes hands, stop using the login service card. (Wallets will reject its bindings once the domain's admin card changes, but the site operator must not try to work around that.)
- **Publish metadata.** Serve a signed `/.well-known/membership-login` that accurately lists the card policies the service accepts.

---

## Revocation Triggers

A certifier or the AppCertificationBody posts a revocation on a login service card for:

| Situation | Code |
|---|---|
| Operator leaves the program in good standing | 800 |
| Login service card key compromised | 810 |
| Domain lost or transferred | 800 (or 901 if the site operator kept using it) |
| Phishing, deceptive requests, or misuse of collected statements | 911 |
| Certification obtained under false pretenses | 900 |

Concerns short of revocation are recorded with 6xx annotations, which wallets show as warnings at login (`card_login.md` step 16).

---

## Accountability Model

The same as for app cards (`app_certification_body.md §Accountability Model`): certifiers are listed as auditors on the login service policy, so every login service card they issue is traceable to them, and the Root Policy Body can revoke a certifier's card to stop new certifications.
