# AppCertificationBody

**Status:** Active  
**Parent body:** Root Policy Body  
**Context:** `specs/ARCHITECTURE.md` ADR-011 (governance framing), `specs/protocol-objects.md §16` (app_card / app_card_pubkey semantics)

---

## Role and Mandate

The AppCertificationBody is the governance body responsible for certifying wallet applications in the Card Protocol. Certification means issuing an `app_card` — a card held by the wallet application operator — that can be referenced in sub-card documents created on behalf of cardholders. Only app cards whose chain reaches the governance authority's app-certification policy root are accepted by runtime verifiers.

The body's core mandate is to ensure that certified wallet applications do not abuse or leak the sub-cards they create on behalf of holders. A wallet application that holds an `app_card` is trusted to co-sign sub-cards, which grant the app the ability to produce protocol-valid signatures on behalf of a cardholder within defined capability bounds. That trust must be earned, documented, and revocable.

---

## Trust Chain Structure

No new on-chain mechanism is required. The existing `PolicyAuthorizerKeys` registry and card issuance model are sufficient:

1. **App-certification policy root.** The Root Policy Body registers an address in `PolicyAuthorizerKeys` on Arbitrum One designated as the app-certification policy root. This address is what verifier operators configure as `VerifierConfig.appCertificationRoot`. The root itself carries no `ancestry_pubkeys` ancestors — it is a self-rooted entry.

2. **AppCertificationBody member cards.** The Root Policy Body issues cards to AppCertificationBody members from the app-certification policy root. Each member card's `ancestry_pubkeys` chain terminates at the app-cert policy root address.

3. **App cards issued to wallet operators.** AppCertificationBody members issue `app_card`s to wallet application operators. These are ordinary cards in the on-chain registry whose `ancestry_pubkeys` chain eventually reaches the app-cert policy root — either directly (one hop: member → root) or through intermediate member cards.

4. **Runtime verification.** When a verifier encounters a sub-card signature, it performs Stage 2 verification: it walks the `app_card` chain from `app_card_pubkey` up through `ancestry_pubkeys` hop by hop until it reaches `VerifierConfig.appCertificationRoot`. If the chain is missing, broken, or terminates at a different address, the sub-card is rejected with `APP_CARD_CHAIN_NOT_TRUSTED` and `scope_clean: false`.

The press also performs this check as an early gate before submitting `RegisterSubCard` (see `specs/object_specs/press.md §5.4`), but the verifier's Stage 2 check is the binding enforcement layer. A compromised press that registers a sub-card with an uncertified `app_card` will be caught at verification time.

---

## Accountability Model

AppCertificationBody members are listed as auditors on every `app_card` they certify. This makes the certification chain visible in the on-chain audit trail via EAS annotations. Each issued `app_card` carries the certifying member's address in its auditor list, so the chain of accountability from wallet operator → certifying member → Root Policy Body is traceable on-chain.

If a member is compromised or acts in bad faith, their certifications can be identified by scanning the on-chain registry for `app_card`s that list the member as auditor. Those cards can be revoked card-by-card. The Root Policy Body retains the authority to revoke the member's own card, which provides a governance backstop: once the member card is revoked, no new certifications from that member are valid, and existing certifications can be reviewed for revocation as appropriate.

---

## App Obligations

Certified wallet applications must:

- **Implement holder-consented sub-card creation.** A holder's explicit consent is required for each sub-card. The application must not create sub-cards without the holder's knowledge and signature (the `holder_signature` field in `SubCardDocument`).

- **Protect sub-card private keys.** The application must not export or share sub-card private keys with third parties. Sub-card keys are scoped credentials; their value depends on remaining under the control of the issuing application.

- **Honor holder revocation requests promptly.** When a holder requests revocation of a sub-card, the application must deregister the relevant sub-card on-chain (via the registry's deactivation mechanism) without unreasonable delay.

- **Implement the full sub-card lifecycle.** The application must support creation, active use, and deactivation/rotation of sub-cards per the protocol spec (`specs/protocol-objects.md §16`). Abandoned or orphaned sub-cards that cannot be deactivated are a protocol violation.

- **Surface the app card address publicly.** The application must publish its `app_card` address (the keccak256 address of its `app_card_pubkey`) in its documentation or public metadata so that cardholders and independent auditors can verify certification status without relying solely on the application's own claims.
