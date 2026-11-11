# AppCertificationBody

**Status:** Active  
**Parent body:** Root Policy Body  
**Amended 2026-11-08 (card login):** second mandate — certifying login services through a login service branch (`login_service_certification.md`); wallet operators publish login-router metadata.  
**Context:** `specs/ARCHITECTURE.md` ADR-011 (governance framing), `specs/protocol-objects.md §16` (app_card / app_card_pubkey semantics)

---

## Role and Mandate

The AppCertificationBody is the governance body responsible for certifying applications in the Card Protocol. *(Revised 2026-11-09.)* It certifies three kinds of software, each through its own branch under the app-certification root: **wallets** (wallet cards), **apps** that act for users through delegated sub-cards (app cards), and **login services** (login service cards). Certification means issuing a card that can be referenced as `app_card` in sub-card documents. Only app cards whose chain reaches the governance authority's app-certification policy root are accepted by runtime verifiers.

**Second mandate (2026-11-08): login services.** The body also certifies websites that offer card login, through a separate **login service branch** under the same root. That mandate, its trust chain, and its obligations are in `login_service_certification.md`. Everything below this paragraph concerns wallet cards and app cards.

For wallets and apps, the body's core mandate is to ensure that certified applications do not abuse or leak the sub-cards they create on behalf of holders. A wallet application that holds an `app_card` is trusted to co-sign sub-cards, which grant the app the ability to produce protocol-valid signatures on behalf of a cardholder within defined capability bounds. That trust must be earned, documented, and revocable.

---

## Trust Chain Structure

No new on-chain mechanism is required. The existing `PolicyAuthorizerKeys` registry and card issuance model are sufficient:

1. **App-certification policy root.** The Root Policy Body registers an address in `PolicyAuthorizerKeys` on Arbitrum One designated as the app-certification policy root. This address is what verifier operators configure as `VerifierConfig.appCertificationRoot`. The root itself carries no `ancestry_pubkeys` ancestors — it is a self-rooted entry.

2. **AppCertificationBody member cards.** The Root Policy Body issues cards to AppCertificationBody members from the app-certification policy root. Each member card's `ancestry_pubkeys` chain terminates at the app-cert policy root address.

3. **Wallet and app branches.** The AppCertificationBody issues two branch-node cards from the root — the **wallet branch** and the **app branch** — and certifiers under each issue **wallet cards** to wallet operators and **app cards** to third-party application operators. These are ordinary cards in the on-chain registry whose `ancestry_pubkeys` chain eventually reaches the app-cert policy root — through their branch node and any intermediate certifier cards. Existing app cards issued directly under the root before the branches existed must be reissued under the right branch; the login router lists only wallet-branch cards.

3a. **Login service branch.** A separate node under the root, configured by verifiers as `VerifierConfig.loginServiceCertificationRoot`, holds login service cards for login services (`login_service_certification.md`). A login-service-branch card can act as `app_card` only for its own server cards.

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

- **Publish login-router metadata** *(wallets only)*. Provide the name, icon, login handler URL, and app-store links the login router lists for certified wallets (`specs/object_specs/login_router.md §5`), and serve a signed `WalletRegistrationToken` at `/.well-known/membership-wallet` (`specs/protocol-objects.md §19`). Register with the router only through `/register`, never replacing a user's default wallet.

- **Surface the app card address publicly.** The application must publish its `app_card` address (the keccak256 address of its `app_card_pubkey`) in its documentation or public metadata so that cardholders and independent auditors can verify certification status without relying solely on the application's own claims.
