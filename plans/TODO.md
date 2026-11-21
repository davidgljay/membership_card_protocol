# TODO

Cross-cutting follow-ups that don't belong to one plan.

## Rename `master` identifiers to `primary` in code

- **Why.** The specs and docs say "primary card" and "primary card key" (decided by David, 2026-11-20; see the terminology note in `specs/card_protocol_spec.md`). The code still uses "master" for the same thing. That name is an artifact of Claude's design process, not a deliberate choice.
- **What.** Rename identifiers, comments and strings that mean the primary card: for example `masterSecretKey`, `masterCard`, `master_pubkey`, `verifyMasterCardSignature` and `src/auth/master-card-signature.ts`. They appear in about 95 files across wallet-sdk, wallet-service, client-sdk-old, membership_card_verifier, press, notary, governance, the test suites and their fixtures.
- **Needs a CP7 approval.** `master_card_address` (on-chain `SubCardEntry`, `AdminAuthorizeSubCardPayload`), `master_signature` and `master_sig_payload` are stored on chain or in signed payloads. Renaming them changes the contract and the payload format, so it should ride a logic-contract upgrade (for example with 6.4a/6.4b at W8), or stay as is.
- **Leave alone.** Uses of "master" that don't mean the primary card: the wallet service's secrets-backend key (`WEBCRYPTO_MASTER_KEY`), the master deployment script, paymaster.
- **Done when.** No identifier, comment or string outside the on-chain/payload fields uses "master" for the primary card, and every test suite passes.
